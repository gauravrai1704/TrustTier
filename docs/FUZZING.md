# Static analysis and fuzzing

## Slither (static analysis)

`slither .` (config: `slither.config.json`) analyses every TrustTier contract
except mocks, the fuzzing harness and the EZKL-generated verifier. It runs in
CI and fails the build on any finding. The first run reported 13 medium and
32 low findings; after triage:

| Finding | Verdict |
|---|---|
| `reentrancy-no-eth` (2): the verifier is called before `decideZkProof` / `_slash` write state | **Fixed**: state is written first and the call reverts on an invalid proof (checks-effects-interactions); the revert undoes the writes, and a re-entrant call would only see final state. No gas cost. |
| `divide-before-multiply` (1): demo pool's soft liquidation | **Fixed**: seized collateral is computed from the full debt. |
| `missing-zero-check` on the Aave adapter's feeds | **Fixed**: the constructor rejects zero addresses. |
| `uninitialized-local` (1) | False positive (a fixed-size memory array starts zeroed and is fully assigned); annotated. |
| `unused-return` (9) | Intended: Chainlink calls read only the fields used; the deprecated `answeredInRound` check is not required by Chainlink. Detector excluded. |
| `timestamp` (19) | By design: challenge windows, approval TTL, anchors and feed staleness are time-based. Detector excluded. |
| `missing-zero-check` on `setLiquidator` / `setSequencerUptimeFeed` | Intended: zero disables liquidations / means "no L2 sequencer". Detector excluded. |
| `reentrancy-events`, `reentrancy-benign` | Covered by the reordering above. Detectors excluded. |

Result: **0 findings**.

## Echidna (property-based fuzzing)

`contracts/echidna/EngineInvariants.sol` deploys the whole system (feeds,
lending pool, registry, audit log, verifier, engine, liquidator) and three
independent actors. Echidna calls its `act_*` functions in random order with
random arguments and random time jumps (up to 1 hour, so challenge windows
and approvals both open and expire): opening positions, moving prices,
refreshing feeds, toggling proof validity, Tier 0/1/2 decisions, reveals,
anchors, direct and commit-reveal challenges, bond settlement, liquidations,
deposits, withdrawals and reward funding. After every call it checks:

| Property | Meaning |
|---|---|
| `echidna_engine_is_exactly_solvent` | The engine's ETH balance equals exactly what it owes: pending payouts + open bonds + reward pool |
| `echidna_tier_bands_enforced` | No Tier-0 claim at delta <= 15%, no Tier-1 claim at delta <= 5% |
| `echidna_tier2_needs_valid_high_risk_proof` | A Tier-2 approval only with a valid proof labelled high risk |
| `echidna_slash_needs_valid_proof_on_snapshot` | A claim is slashed only by a valid high-risk proof on its own snapshot (an honest claim never is) |
| `echidna_liquidation_needs_fresh_unused_approval` | Every liquidation consumes an approval younger than 30 minutes, at most once |
| `echidna_bond_bookkeeping` | An open bond has a claimant; a slashed claim holds no bond |

```bash
npx hardhat compile
echidna . --contract EngineInvariants --config echidna.yaml --test-limit 100000
```

**Result:** all six hold over 100,139 calls (18,590 unique instructions).
The coverage report shows every outcome reached, including successful
slashes (direct and commit-reveal), honest and self-contradicting reveals,
forfeited and rewarded bonds, superseded claims, expired approvals and
executed liquidations.

**The properties have teeth.** Each of four planted bugs was caught within
50,000 calls by the property meant to catch it:

| Planted bug | Caught by |
|---|---|
| Tier 0 allowed at any delta | `echidna_tier_bands_enforced` |
| Approvals never expire | `echidna_liquidation_needs_fresh_unused_approval` |
| A challenge ignores the claim's snapshot | `echidna_slash_needs_valid_proof_on_snapshot` |
| A settled bond is not zeroed (paid twice) | `echidna_engine_is_exactly_solvent` |

CI runs 50,000 calls on every push.
