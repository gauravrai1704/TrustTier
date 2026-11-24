# Real parallel-EVM run (RISE pevm)

`trusttier.rs` is a harness for [RISE pevm](https://github.com/risechain/pevm)
(Block-STM for the EVM, in Rust). It executes TrustTier blocks exported by
`scripts/concurrency_trace.js` (`PEVM_EXPORT=1`) sequentially and in parallel,
checks that both agree with each other and with Hardhat's receipts, and times them.

```bash
git clone https://github.com/risechain/pevm && cd pevm
cp <this dir>/trusttier.rs crates/pevm/examples/
cargo build --release --example trusttier
REPS=15 ./target/release/examples/trusttier ../TrustTier/off-chain/evaluation/results/pevm_blocks/*.json
```
