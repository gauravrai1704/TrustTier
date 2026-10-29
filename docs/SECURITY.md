# TrustTier Security Review

A STRIDE-style pass over the real TrustTier codebase (not a generic
checklist), covering the contracts (`contracts/`), the off-chain router
(`off-chain/router/`), and the new bonded challenge-window mechanism. Each
finding below is a specific, concrete issue found in this project's actual
code, not a hypothetical. "Fixed" means the fix is already merged into the
code this document describes; "Accepted risk" and "Documented" mean the
issue is real but intentionally out of scope for a coursework deployment,
with the reasoning spelled out so it isn't silently forgotten.

## Summary table

| # | Finding | Category (STRIDE) | Severity | Status |
|---|---|---|---|---|
| 1 | Push-payment DoS in bond payouts | Denial of Service | High | **Fixed** |
| 2 | Check-ordering bug masking `AlreadyChallenged` | Information Disclosure (wrong error) | Low | **Fixed** |
| 3 | Single-owner (EOA) access control via `Ownable` | Elevation of Privilege | High (if deployed for real) | **Fixed** (multisig + timelock) |
| 4 | Challenge label convention not encoded per-model | Tampering | Medium | **Mitigated** (verifier bound to one model) |
| 5 | Self-generated SRS, not from a real trusted-setup ceremony | Tampering | Medium (N/A locally) | Documented |
| 6 | Hardcoded fallback test private key in `chain_client.py` | Spoofing | Critical (if misused) | **Fixed** |
| 7 | Reentrancy | Tampering | — | Confirmed safe |
| 8 | Front-running on `challengeDecision` | Tampering | Low | Accepted |
| 9 | Proof replay across positions | Tampering | Critical | **Fixed** |
| 10 | Tier-2 approval from a valid proof that says "low risk" | Tampering | High | **Fixed** |
| 11 | Verifier not bound to the model hash a decision cites | Spoofing | Medium | **Fixed** |
| 12 | Unsalted Tier-1 commitment (brute-forceable features) | Information Disclosure | Medium | **Fixed** |
| 13 | Revoking an already revoked model emits a duplicate event | Repudiation | Low | **Fixed** |
| 14 | Out-of-range inputs hang EZKL witness generation | Denial of Service | Medium | **Fixed** |
| 15 | Trust in the feature oracle | Spoofing | High | **Fixed** (features computed on-chain; oracle removed) |
| 16 | Timelock also delays emergency model revocation | Denial of Service | Low | Accepted trade-off |
| 17 | A cheap claim could lock a position forever | Denial of Service / Tampering | High | **Fixed** |
| 18 | Router posted Tier-1 claims its own model flags high-risk | Tampering | Medium | **Fixed** |
| 19 | Governance changes apply to claims already in their window | Tampering | Low | Accepted (timelocked) |
| 20 | The router, not the chain, chose the tier (δ computed off-chain) | Elevation of Privilege | High | **Fixed** (δ and tier enforced on-chain) |
| 21 | Residual trust: the lending protocol, Chainlink feeds and the position-source pointer | Spoofing | Medium | Accepted (explicit, timelocked) |
| 22 | A proof can go stale while it is being generated | Denial of Service | Low | Accepted (liveness, not safety) |
| 23 | Every msg.value bond writes the engine's shared ETH balance | Denial of Service (throughput) | Low | **Fixed** (deposit-funded bonds) |

---

## 1. Push-payment DoS in bond payouts (Fixed — High)

**Where:** `LiquidationEngine.sol`, `challengeDecision` / `reclaimBond`.

**The issue:** an early version of the bonded challenge-window design sent
ETH directly at the moment of slashing or reclaiming — `payable(x).transfer(...)`
or a raw `.call{value: ...}("")` straight to the recipient. If that
recipient were a contract with no payable fallback, or one that
deliberately reverts on receiving ETH, the slash/reclaim call itself would
revert — and because that call also updates shared position state
(`challenged[positionId]`, `bondOf[positionId]`), a single hostile or
broken recipient could permanently block the resolution of that position.

**The fix:** both functions now only credit a `pendingWithdrawals[address]`
mapping; a separate `withdraw()` function (callable any time, by anyone,
for their own balance) does the actual ETH transfer. This is the standard
pull-payment pattern: a broken or hostile recipient can only ever strand
*its own* funds (claimable but unclaimed), never block anyone else's
claim or corrupt the position's state. See the NatSpec on `withdraw()` in
`LiquidationEngine.sol` for the in-code version of this explanation, and
`LiquidationEngine.test.js`'s "pull-payment pattern" test group for the
behavioral tests (payout correctness, double-withdraw rejection, etc.).

## 2. Check-ordering bug masking `AlreadyChallenged` (Fixed — Low)

**Where:** `LiquidationEngine.sol`, `challengeDecision`.

**The issue:** the function originally checked `bondOf[positionId] == 0`
(→ `NotChallengeable`) *before* checking `challenged[positionId]` (→
`AlreadyChallenged`). A successful challenge zeroes the bond as part of
slashing it — so a second challenge attempt against an already-resolved
position hit the more generic `NotChallengeable` error instead of the more
specific and more useful `AlreadyChallenged`. Not a security hole on its
own (the second challenge still correctly fails either way), but it is
exactly the kind of masked-error bug that makes a real incident harder to
diagnose after the fact — an auditor or monitoring tool reading
`NotChallengeable` would not immediately know *why* a challenge was
rejected.

**The fix:** reorder the checks so `challenged` is tested first. This was
actually caught by the test suite itself (a test asserting
`AlreadyChallenged` was getting a different revert reason back), not by
manual code review — a concrete point in favor of writing the negative-path
tests before considering a function done.

## 3. Single-owner (EOA) access control via `Ownable` (Fixed — High if deployed for real)

**Where:** `LiquidationEngine.setTier2Verifier` / `setPositionSource` / `setMaxFeedAges`, `ModelRegistry.registerModel`/`revokeModel`, `TierAuditLog.authorizeLogger`/`revokeLogger` - all `onlyOwner`.

**The issue:** with a single externally-owned owner, one lost or stolen key
could register a malicious model or - most seriously - point
`setTier2Verifier` at a verifier that approves every proof, silently
defeating Tier 2 and every challenge.

**The fix:** `contracts/governance/` adds `TrustTierMultisig` (a minimal
M-of-N wallet) and `TrustTierTimelock` (OpenZeppelin's audited
`TimelockController`). `scripts/deploy.js` with `GOVERNANCE_OWNERS` set
transfers ownership of all three contracts to the timelock, whose only
proposer and executor is the multisig. Every admin change therefore needs
M signatures *and* waits `TIMELOCK_DELAY` in public view before it can
execute. `test/Governance.test.js` (10 tests) checks that the deployer key
alone can no longer change anything, that a single owner cannot schedule,
that execution before the delay fails, and the full verifier-swap and
revocation flows; `scripts/governance.js` is the CLI owners use. The
multisig is deliberately small and readable; a production deployment would
use an audited wallet such as Safe as the timelock's proposer instead, with
no contract changes.

## 4. Challenge label convention not encoded per-model (Mitigated — Medium)

**Where:** the label check in `LiquidationEngine` (`publicInputs[INSTANCE_LABEL] == HIGH_RISK`).

**The issue:** "label 1 means high risk" is a property of one compiled
circuit. If a decision could cite any registered model while the verifier
encoded another, a model with a different output encoding would be
misinterpreted.

**Mitigation:** the instance layout is now named constants in the contract
(`INSTANCE_FEATURE_HASH`, `INSTANCE_LABEL`, `HIGH_RISK`), and the verifier
is bound to exactly one model hash (`tier2ModelHash`, finding 11), so the
label convention is always that of the circuit the verifier implements.
Changing model or encoding means deploying a new verifier and calling
`setTier2Verifier(newVerifier, newModelHash)` through governance. A
per-model `highRiskLabelValue` would only be needed if several Tier-2
models had to be live at once.

## 5. Self-generated SRS (Documented — Medium for real deployment, N/A locally)

**Where:** `circuits/build_circuit.py`, `ezkl.gen_srs`.

**The issue:** the KZG structured reference string backing every Tier-2
proof is generated locally rather than drawn from a public, audited
trusted-setup ceremony. A self-generated SRS means whoever generated it
technically retains the "toxic waste" that could be used to forge false
proofs for that specific SRS — a real concern for a production deployment
securing real funds.

**Why it's fine here:** this project's SRS never secures anything beyond
local testing and a Sepolia testnet demo (see the main README's documented
caveat), and the self-generation was a direct, noted consequence of this
sandboxed environment's network restrictions blocking the real params
server — not a judgment that self-generation is an acceptable general
practice. A real deployment must use a ceremony-audited SRS (e.g. the
Ethereum KZG ceremony's output, which EZKL supports pulling directly).

## 6. Hardcoded fallback test private key (Fixed — Critical if misused)

**Where:** `off-chain/router/chain_client.py`.

**The issue:** `ChainClient` fell back to Hardhat's publicly known account #0
key whenever no key was supplied - harmless locally, catastrophic on a real
network.

**The fix:** the key now comes from `TRUSTTIER_PRIVATE_KEY`, and the public
test key is only used when the connected chain ID is a local development
chain (31337 / 1337). On any other chain, `ChainClient` raises an error
instead of silently falling back.

## 7. Reentrancy (Confirmed safe)

Every state-changing function in `LiquidationEngine.sol` follows
checks-effects-interactions: state (`positionFinalized`, `bondOf`,
`challenged`, `pendingWithdrawals`) is updated *before* any external call
(`tier2Verifier.verifyProof`, or the ETH transfer in `withdraw`). The
verifier call is wrapped in `try/catch` so a reverting verifier is reported
as `InvalidZkProof`; it is a view-like computation with no callback into
the engine. `withdraw`
in particular zeroes `pendingWithdrawals[msg.sender]` before making the
external call, so a reentrant call from a malicious recipient's fallback
would see a zero balance and have nothing left to withdraw a second time.

## 8. Front-running on `challengeDecision` (Accepted — Low)

**The issue:** `challengeDecision` is public — anyone watching the mempool
could see a pending challenge transaction and submit their own copy with
higher gas to "steal" the slashed bond instead.

**Why it's low severity:** this doesn't threaten correctness — the
original false claim still gets challenged and slashed either way, which
is the property that actually matters (Tier 0/1's economic security is
restored). It only affects *who* collects the reward, which is a
MEV/fairness concern, not a safety one. Documented rather than fixed,
since a real fix (commit-reveal for challenges, or routing through a
private mempool) adds meaningful complexity for a property this project's
threat model doesn't prioritize.

## 9. Proof replay across positions (Fixed — Critical)

**Where:** `decideZkProof`, `challengeDecision`.

**The issue:** a proof's public instances (label and probabilities) said
nothing about *which* position it was for. One valid high-risk proof could
approve a liquidation of any position, and - worse with the challenge
window - slash every open Tier 0/1 bond.

**The fix (second version):** the circuit's five feature inputs are now
*public* instances, and the contract computes the same five integers itself
from the position's on-chain state (finding 15). `decideZkProof` requires
`publicInputs[0..4]` to equal the features it computes in the same
transaction; `challengeDecision` requires them to equal the snapshot taken
when the claim was made. A proof made for another position, or for this
position before its collateral, debt or price changed, reverts with
`ProofNotForPosition` - tested with real proofs and the real verifier
(`test/EzklIntegration.test.js`). The first version of this fix bound proofs
to a Poseidon hash committed by a feature oracle; it closed replay but
created the trust problem in finding 15.

## 10. Tier-2 approval from a valid proof that says "low risk" (Fixed — High)

**The issue:** `decideZkProof` approved a liquidation for *any* valid proof;
only `challengeDecision` checked the label. A genuine proof that the
position was safe would still have liquidated it.

**The fix:** `decideZkProof` reverts with `ProofDoesNotShowHighRisk` unless
the proven label is `HIGH_RISK`. The router no longer submits such
positions at all (outcome `NOT_LIQUIDATED`); in the evaluation, 9 of 144
boundary positions are protected this way. Tampering the public label from
0 to 1 on a real proof is rejected by the verifier (`InvalidZkProof`).

## 11. Verifier not bound to the model hash a decision cites (Fixed — Medium)

**The issue:** a verifier proves statements about one compiled model, but
`decideZkProof` accepted any registered `modelHash` next to it.

**The fix:** `setTier2Verifier(verifier, modelHash)` records the model the
verifier encodes (`tier2ModelHash`); Tier-2 decisions and challenges must
cite exactly that hash (`ModelNotBoundToVerifier`). Tier 1 may still cite
any authorized model.

## 12. Unsalted Tier-1 commitment (Fixed — Medium)

**The issue:** `keccak256(features, score)` over small-range values could be
brute-forced back into a borrower's features and score.

**The fix:** `router/commitment.py` adds a random 32-byte salt; the router
returns it with the result so revealing it later lets an auditor check the
claim (`verify_commitment`).

## 13. Duplicate revocation events (Fixed — Low)

`ModelRegistry.revokeModel` now reverts with `ModelAlreadyRevoked` instead
of emitting a second `ModelRevoked` event that would misstate when a model
stopped being trusted.

## 14. Out-of-range inputs hang EZKL (Fixed — Medium)

**The issue:** EZKL's witness generation *hangs* (rather than failing) on
inputs outside the range the circuit was calibrated on; account ages above
about 1,000 days did this with the original circuit, which would stall the
router.

**The fix:** features are min-max normalized to [0, 1] over declared bounds
(`FEATURE_BOUNDS`) and quantized to integers in [0, 1024]; values outside the
bounds are clamped (identically on-chain and off-chain), the prover refuses
anything outside [0, 1024],
the circuit is calibrated on the whole domain including every corner, and
`build_circuit.py` checks circuit/ONNX label agreement on 200 random
positions (0 disagreements).

## 15. Trust in the feature oracle (Fixed — High)

**The issue (as previously accepted):** binding proofs to positions through
an oracle-committed hash moved trust to whoever committed the features. The
oracle defaulted to the router's own key, so a dishonest router could commit
invented "safe" features and claim Tier 0/1 on them: no honest proof could
match the committed hash, so the claim could not be challenged.

**The fix: verified inputs instead of trusted inputs.** Nobody supplies
features any more. `LiquidationEngine.currentFeatures` reads them:

| Feature | On-chain source |
|---|---|
| LTV | the lending protocol (`IPositionSource`: Aave V3 `getUserAccountData`, or `MockLendingPool`) |
| 30-day volatility | a Chainlink realized-volatility feed |
| 24-hour momentum | the Chainlink price feed now vs. the round in effect 24 h ago (`getRoundData`; the caller names the round, the contract checks it was the one in effect) |
| days since top-up, account age | the lending protocol's (or adapter's) timestamps |

Each is quantized exactly as the circuit expects (`q = round-down(x_norm *
1024)`), with stale-feed checks (`maxPriceAge`, `maxVolatilityAge`). The oracle
role, `commitPositionFeatures` and `MAX_POSITION_ID` are gone. The features
become public (they are public chain data anyway); only the model weights
stay private. `risk_model/onchain_features.py` mirrors the arithmetic and is
cross-checked against real proofs.

Tier 0/1 claims snapshot the five features they were made on
(`FeaturesSnapshotted`, `featureSnapshot`), so a challenge is judged on the
facts at claim time: an honest claimant is not slashed because prices moved
later, and a false claimant is slashed even if they top up afterwards (both
tested).

## 16. Timelock also delays emergency revocation (Accepted trade-off)

With governance enabled, `revokeModel` is delayed like every other admin
call, so a model found to be compromised stays authorized for the delay.
This is the price of preventing a malicious owner from revoking a model to
shield a colluding claimant during a challenge window. A production system
could add a narrowly scoped "guardian" role that can only *pause* Tier 1/2,
never change what is trusted.

## 17. A cheap claim could lock a position forever (Fixed — High)

**Found by:** an independent review of the binding change.

**The issue:** a decision used to be permanent (`positionFinalized` was never
cleared, and features could not be re-committed after a decision). Since
`decide*` is permissionless, a borrower could front-run the oracle's
feature refresh with a Tier-0 claim made on stale, safe features: the claim
was then judged against the stale hash (so it could not be challenged) and
the position could never be decided again - it escaped liquidation for
good. Even a *successful* challenge left the position finalized, so the
proven-risky position could not then be liquidated.

**The fix:** an explicit lifecycle. A Tier 0/1 claim freezes the features
only for its 1-hour challenge window (`ChallengeWindowStillOpen`). A
successful challenge re-opens the position immediately, and the
challenger's proof is valid for `decideZkProof` on it. After an unchallenged
window, the next decision re-opens the position (`PositionReopened`),
crediting the unreclaimed bond to the claimant and clearing a stale Tier-1
commitment; a new claim is challengeable again. Only a Tier-2 liquidation is
final (`liquidationFinal`).

**Follow-up (verified-inputs version):** a borrower could still post a cheap
claim while safe and so hold off a liquidation for up to an hour if the
position turned risky inside the window. Now a Tier-2 liquidation - a proof
of high risk on the position's *current* features - supersedes an open
Tier 0/1 claim (`ClaimSuperseded`). The superseded claim keeps its bond,
snapshot and window: if it was false when made it can still be slashed, and
if not its claimant reclaims the bond; a successful challenge no longer
re-opens a position that has since been liquidated. Only cheap claims are
blocked during a window, and since tiers are enforced on-chain (finding 20),
those are limited to what the position's δ allows. A source timestamp in the
future counts as zero days rather than reverting, so a misreporting source
cannot make a position undecidable. 4 tests cover these paths. 8 tests in
`test/LiquidationEngine.test.js` ("decision lifecycle") cover these paths.

## 18. Router posted Tier-1 claims its own model flags high-risk (Fixed — Medium)

**Found by:** the same review.

**The issue:** the router's Tier-1 path never checked the label, so about
12.5% of Tier-1 positions were submitted as cheap "safe" claims that the
router's own watcher endpoint could prove false and slash.

**The fix:** the router escalates such positions to Tier 2
(`router/processor.py`); `evaluation/evaluate.py` applies the same rule (21
of 374 positions escalated in the evaluation).

## 19. Governance changes apply to claims already in their window (Accepted — Low)

Revoking the Tier-2 model, or swapping the verifier, changes how claims
already inside their challenge window can be challenged. Both actions are
timelocked and public, so challengers see them coming; snapshotting the
verifier per claim would remove the effect at the cost of more storage.

## 20. The router, not the chain, chose the tier (Fixed — High)

**Found by:** the course review ("the router is an unaudited operator; the
chain cannot check δ").

**The issue:** δ was computed off-chain and the tier chosen by the router.
Any caller could submit a Tier-0 claim for a position at the liquidation
boundary; only the challenge window stood between that claim and a cheap
approval, and only if a watcher noticed.

**The fix:** every `decide*` computes δ = liquidation threshold - LTV from
the lending protocol's own numbers and enforces the bands: Tier 0 needs
δ > 15% (`TIER0_MIN_DELTA_BPS`), Tier 1 needs δ > 5%, Tier 2 is always
allowed. A weaker tier reverts with `TierNotAllowed(positionId, tier,
deltaBps)` and does not consume the position. The router's policy
(`router/tiering.decide_tier_bps`) mirrors the same constants (a test reads
them out of the Solidity source), so it never attempts a tier the chain would
refuse. The router can still choose a *stronger* tier than needed, which only
costs it gas. What remains optimistic is the model's judgement inside an
allowed cheap tier, which the challenge window covers.

## 21. Residual trust: protocol, feeds and source pointer (Accepted — Medium)

The engine now trusts exactly what a lending protocol already trusts: its
own accounting and its Chainlink feeds. Three specifics:
- **The position source** is an owner-set pointer (`setPositionSource`),
  behind the multisig + timelock, so a change is public a full delay ahead.
- **Feed manipulation and staleness:** Chainlink answers are rejected when
  non-positive or older than `maxPriceAge` / `maxVolatilityAge`. A realized-
  volatility feed may not exist on every network; the deployment can use a
  real price feed with a mock volatility feed on a testnet.
- **The Aave adapter's history:** Aave stores neither when an account opened
  nor when it last added collateral, so `AaveV3PositionSource` observes them:
  account age counts from registration, and anyone can `poke` an account to
  record a top-up when its aToken *scaled* balance grows. Both come from
  on-chain state, but an account registered late looks younger (riskier) than
  it is, and an un-poked top-up is recorded late. `MockLendingPool` lets
  anyone back-date positions; it is for demos only.

## 22. A proof can go stale while it is generated (Accepted — Low)

Proving takes ~16 s. If the price feed updates in between, the position's
features change and the proof no longer matches (`ProofNotForPosition`).
This affects liveness, not safety: the router re-reads and re-proves. On a
real feed with hourly heartbeats this is rare; a production deployment could
let a proof name a recent price round instead of the latest answer.

## 23. Every msg.value bond writes one shared balance (Fixed — Low)

**Found by:** the opcode-traced concurrency experiment
(`scripts/concurrency_trace.js`, `evaluation/parallel_exec.py`).

**The issue:** storage is keyed per position, but a bond sent as `msg.value`
also changes the engine's ETH balance. On an execution engine that treats a
balance change as a read-modify-write, every Tier 0/1 claim in a block then
conflicts with every other: in a traced 374-decision block, 209 claims
serialize and 16 threads reach only a 3.35x speedup instead of 15.3x.

**The fix:** `deposit()` pre-funds a claimant's balance in
`pendingWithdrawals`; a claim sent without ETH draws `MIN_BOND` from it (and
reclaimed or slashed bonds are recycled the same way). Such claims touch only
the claimant's own slot, and the traced block parallelizes to 15.3x at 16
threads under either balance model. It costs about 5,200 gas more per claim.
`msg.value` bonds still work for occasional claimants.

---

## The sentinel: closing the "nobody noticed" gap

Findings 1 and 2 are about the challenge mechanism behaving *correctly*
when it's used. But the bonded challenge window only provides real economic
security if someone actually submits a challenge inside the window — and
nothing in the base design calls attention to a challenge having happened,
or to suspicious patterns that might warrant closer review (e.g. one
address spamming Tier 0/1 claims to try to overwhelm challengers before
the window closes).

Real production systems address this with dedicated monitoring
infrastructure: **Forta Network** runs a decentralized network of
detection bots watching on-chain activity across many protocols in
real time, and **OpenZeppelin Defender** provides automated monitoring with
configurable response actions (alerts, pausing, etc.) for a project's own
contracts. `off-chain/sentinel/` is a real, working, prototype-scale
analogue of that pattern — explicitly not a claim of equivalent coverage,
audit rigor, or scale:

- `sentinel/detectors.py` — pure detection logic, fully unit-tested
  (`off-chain/tests/test_sentinel.py`, 13 tests): a `challenge_succeeded`
  rule (always critical — a successful challenge means a claim was proven
  false) and a `rate_anomaly` rule (flags an address submitting an
  unusually high rate of Tier 0/1 decisions in a sliding window, which
  could indicate an attempt to flood the challenge window faster than
  challengers can review).
- `sentinel/watch.py` — a live polling loop against a running node,
  reading `DecisionLogged` and `DecisionChallenged` events and running them
  through the detection rules in real time.

This was verified end-to-end against a live local Hardhat node: a real
Tier-0 decision was submitted with a bond, a second account submitted a
real `challengeDecision` call that successfully slashed it, and the
running sentinel loop printed:

```
[CRITICAL] (challenge_succeeded) Position 43 - a Tier 0/1 claim was
successfully challenged by 0x3C44...93BC and its bond (10000000000000000
wei) was slashed. The original claim was FALSE.
```

within one polling interval of the challenge transaction being mined — not
a canned/mocked log line, an actual alert generated from a real on-chain
event the sentinel observed live.

### What the sentinel is not

It is a single-process polling script, not a distributed network; its two
rules are simple and hand-written, not learned or adversarially tested;
and it only watches the two event types relevant to the bonded challenge
window, not the full surface a production monitor would cover (e.g.
anomalous gas usage, unexpected contract upgrades, cross-protocol
correlation). Extending it with more rules, a push notification channel
instead of stdout, and genuinely decentralized operation (multiple
independent sentinel instances, Forta-style) are natural next steps beyond
this project's scope.
