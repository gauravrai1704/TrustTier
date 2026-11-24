//! Execute TrustTier blocks exported by scripts/concurrency_trace.js
//! (PEVM_EXPORT=1) with RISE pevm: sequentially and in parallel (Block-STM),
//! check both against each other and against Hardhat's receipts, and time them.
//!
//!   cargo run --release --example trusttier -- <block.json>... > results.jsonl

use std::{fs, num::NonZeroUsize, str::FromStr, sync::Arc, time::Instant};

use alloy_primitives::{Address, B256, Bytes, U256};
use pevm::{
    Bytecodes, ChainState, EvmAccount, InMemoryStorage, Pevm, chain::PevmEthereum,
    execute_revm_sequential,
};
use revm::{
    context::{BlockEnv, TxEnv},
    primitives::{TxKind, hardfork::SpecId},
    state::Bytecode,
};
use serde_json::Value;

fn u256(v: &Value) -> U256 {
    U256::from_str(v.as_str().unwrap()).unwrap()
}
fn u64v(v: &Value) -> u64 {
    match v {
        Value::Number(n) => n.as_u64().unwrap(),
        Value::String(s) => u64::from_str_radix(s.trim_start_matches("0x"), 16).unwrap(),
        _ => panic!("bad number {v}"),
    }
}

fn load(path: &str) -> (String, InMemoryStorage, BlockEnv, Vec<TxEnv>, Vec<u64>, Vec<bool>) {
    let j: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let mut state = ChainState::default();
    let mut bytecodes = Bytecodes::default();
    for (addr, a) in j["accounts"].as_object().unwrap() {
        let address = Address::from_str(addr).unwrap();
        let code_hex = a["code"].as_str().unwrap();
        let mut storage: Vec<(U256, U256)> = Vec::new();
        for (k, v) in a["storage"].as_object().unwrap() {
            storage.push((U256::from_str(k).unwrap(), u256(v)));
        }
        let mut acc = EvmAccount {
            balance: u256(&a["balance"]),
            nonce: u64v(&a["nonce"]),
            code_hash: None,
            code: None,
            storage: storage.into_iter().collect(),
        };
        if code_hex.len() > 2 {
            let bc = Bytecode::new_raw(Bytes::from_str(code_hex).unwrap());
            let h = bc.hash_slow();
            acc.code_hash = Some(h);
            bytecodes.insert(h, bc.clone().into());
            acc.code = Some(bc.into());
        }
        state.insert(address, acc);
    }
    let b = &j["block"];
    let block_env = BlockEnv {
        number: U256::from(u64v(&b["number"])),
        beneficiary: Address::from_str(b["coinbase"].as_str().unwrap()).unwrap(),
        timestamp: U256::from(u64v(&b["timestamp"])),
        gas_limit: u64v(&b["gasLimit"]),
        basefee: u64v(&b["baseFee"]),
        difficulty: U256::ZERO,
        prevrandao: Some(B256::from_str(b["prevrandao"].as_str().unwrap()).unwrap()),
        ..BlockEnv::default()
    };
    let _chain_id = j["chainId"].as_u64().unwrap();
    let txs = j["txs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| TxEnv {
            tx_type: 0,
            caller: Address::from_str(t["from"].as_str().unwrap()).unwrap(),
            gas_limit: u64v(&t["gas"]),
            gas_price: u64v(&t["gasPrice"]) as u128,
            kind: TxKind::Call(Address::from_str(t["to"].as_str().unwrap()).unwrap()),
            value: u256(&t["value"]),
            data: Bytes::from_str(t["input"].as_str().unwrap()).unwrap(),
            nonce: u64v(&t["nonce"]),
            chain_id: None, // pevm checks it against mainnet (1); our contracts never read block.chainid
            ..TxEnv::default()
        })
        .collect();
    let gas = j["receipts"].as_array().unwrap().iter().map(|r| r["gasUsed"].as_u64().unwrap()).collect();
    let ok = j["receipts"].as_array().unwrap().iter().map(|r| r["status"].as_u64().unwrap() == 1).collect();
    let storage = InMemoryStorage::new(state, Arc::new(bytecodes), Default::default());
    (j["name"].as_str().unwrap().to_string(), storage, block_env, txs, gas, ok)
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let chain = PevmEthereum::mainnet();
    let spec = match std::env::var("SPEC").as_deref() { Ok("prague") => SpecId::PRAGUE, _ => SpecId::OSAKA };
    let reps: usize = std::env::var("REPS").ok().and_then(|s| s.parse().ok()).unwrap_or(15);
    let max_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    for path in std::env::args().skip(1) {
        let (name, storage, block_env, txs, hh_gas, hh_ok) = load(&path);
        let seq = execute_revm_sequential(&chain, &storage, spec, block_env.clone(), txs.clone())
            .expect("sequential execution failed");
        // Correctness: pevm's sequential run must reproduce Hardhat's receipts.
        let mut prev = 0u64;
        let mut gas_match = true;
        let mut status_match = true;
        for (i, r) in seq.iter().enumerate() {
            let used = r.receipt.cumulative_gas_used - prev;
            prev = r.receipt.cumulative_gas_used;
            if used != hh_gas[i] && std::env::var("SHOW_GAS").is_ok() {
                eprintln!("{name} tx {i}: pevm {used} hardhat {} diff {}", hh_gas[i], used as i64 - hh_gas[i] as i64);
            }
            gas_match &= used == hh_gas[i];
            status_match &= r.receipt.status.coerce_status() == hh_ok[i];
        }
        let mut pevm = Pevm::default();
        let mut row = serde_json::json!({
            "block": name, "txs": txs.len(), "gas_used": prev,
            "matches_hardhat_gas": gas_match, "matches_hardhat_status": status_match,
        });
        let mut t_seq = Vec::new();
        for _ in 0..reps {
            let t0 = Instant::now();
            let r = execute_revm_sequential(&chain, &storage, spec, block_env.clone(), txs.clone()).unwrap();
            t_seq.push(t0.elapsed().as_secs_f64() * 1e3);
            assert_eq!(r.len(), txs.len());
        }
        let seq_ms = median(t_seq);
        row["sequential_ms"] = serde_json::json!(seq_ms);
        let mut par = serde_json::Map::new();
        for threads in 1..=max_threads {
            let n = NonZeroUsize::new(threads).unwrap();
            let check = pevm
                .execute_revm_parallel(&chain, &storage, spec, block_env.clone(), txs.clone(), n)
                .expect("parallel execution failed");
            assert_eq!(check, seq, "parallel result differs from sequential for {name}");
            let mut t = Vec::new();
            for _ in 0..reps {
                let t0 = Instant::now();
                let _ = pevm.execute_revm_parallel(&chain, &storage, spec, block_env.clone(), txs.clone(), n).unwrap();
                t.push(t0.elapsed().as_secs_f64() * 1e3);
            }
            let ms = median(t);
            par.insert(threads.to_string(), serde_json::json!({"ms": ms, "speedup": seq_ms / ms}));
        }
        row["parallel"] = Value::Object(par);
        row["results_equal_sequential"] = serde_json::json!(true);
        println!("{row}");
    }
}
