# Krait Security Audit Report

**Target**: Covenza (covenza-backend)
**Commit**: `089ce71`
**Date**: 2026-10-25
**Auditor**: Krait by Zealynx Security (run by Claude for the project)
**Scope**: `contracts/Vault.sol`, `VaultFactory.sol`, `AssetRegistry.sol`, `InsurancePool.sol`, `KYCRegistry.sol`, `Timelocked.sol`, `OperatorControlled.sol`, `VaultLens.sol`, `libraries/SafeTransfer.sol`, `libraries/UniswapTwap.sol`, `interfaces/*` (2,107 nSLOC). Mocks, scripts and tests are out of scope.
**Methodology**: Recon → Detection (3 passes, rescan, per-contract) → State analysis → Verification (kill gates, impact premise, executed PoCs) → Report
**Status**: both findings fixed in the commit after `089ce71` (MAINNET-READINESS.md items 26 and 27; regression tests `test/OracleStarvation.test.js`, `test/TwapGuard.test.js`, `test/InKindSettlement.test.js`).
**Known issues excluded (Gate H)**: `MAINNET-READINESS.md` items 1–25, including the pre-freeze audit pass (M-1…M-3, L-1…L-7, I-1…I-5), and the README's Known limitations.

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 1 |
| Medium   | 0 |
| Low      | 1 |

Both findings were reproduced with executed proofs of concept. The High uses **real Uniswap V3** (`@uniswap/v3-core` factory and pool, `SwapRouter02`), not the repo's mocks, because the bug is in how a real pool stores its price history. Each proposed fix was tested against its PoC.

---

## [KRAIT-004] A lender can make the held asset unpriceable, block every exit, and take the borrower's whole position in kind — HIGH

**Files**: `contracts/Vault.sol:1009-1017` (`_priceHeld`), `1022-1048` (`_allocateInKind`), `1218-1223` (`_exitFloor`); `contracts/libraries/UniswapTwap.sol` (`canQuote`, `quote`)
**Category**: oracle manipulation / settlement DoS / value extraction
**Evidence**: PROVEN, executed PoC [POC-PASS] against real Uniswap V3.
**Condition**: the approved pool's observation ring has no more slots than the TWAP window has seconds (`observationCardinality <= twapWindow`). The repo's own Uniswap setup uses 64 slots, and production uses a 1,800-second window, so it qualifies.

**Description**:
Every price the vault uses comes from `pool.observe([twapWindow, 0])`. A Uniswap V3 pool keeps its history in a ring of `observationCardinality` slots and writes at most one observation per second. It writes one on any mint or burn of in-range liquidity, and on any swap that moves the tick. If all the slots hold observations younger than the window, `observe` reverts with `OLD`. Anyone can cause that by writing `cardinality` observations within the window, for example with dust full-range mints, which leave the price untouched. They then have to keep doing it.

While the history is starved:
- `swapBack`, early `settle()`, post-deadline `settle()` and keeper settlement all revert, because each one calls `_exitFloor` → `quote`.
- In `settleInKind()` the sale attempt fails and is caught. Then `_priceHeld` sees `canQuote == false`, so the asset counts as **unpriceable**, and `_allocateInKind` gives an unpriceable asset **wholly to the lender** whenever anything is still owed.

"Unpriceable goes to the lender" is a documented design choice for a pool that is genuinely dead. The problem is that anyone can make a healthy pool *look* unpriceable whenever they like. The lender gains the most from that, and during the 7-day lender-only period the lender is the only one who can call `settleInKind()`.

**Impact**:
The borrower loses their entire equity in the held position, meaning the deposit plus any gains, to the lender. In the PoC the lender is owed 10.019 WETH and receives 2.495 cash plus 8.972 X (worth about 8.97 WETH), **over-collecting 1.448 WETH**. That is essentially the whole 1.5 WETH deposit, and the borrower gets nothing. If X had risen, the borrower's gains go to the lender as well.

The borrower cannot get out first. Once the history is starved, `swapBack` and an early close revert too.

A second way to use it: in a loss, a borrower can starve the oracle to block `settle()` and push the loan into in-kind settlement, which never draws insurance. That costs the lender the draw of up to 10% of principal.

**Cost and feasibility**:
- **Sustained version** (block exits from just before the deadline until in-kind opens): about `cardinality` dust mints per 30 minutes for roughly 8.5 days (36 h grace plus 7 days). With 64 slots that is about 26,000 transactions, which is cheap on an Orbit L2 next to a large loan.
- **Short version**: if the in-kind path is reached anyway (a frozen equity, a pool that really is thin), the lender needs only `cardinality` mints just before calling `settleInKind()`.
- With a 1-slot pool, one write in the same transaction is enough.
- **Defence**: a borrower who understands the mechanism can raise the ring with `increaseObservationCardinalityNext` (permissionless) to more than 1,800 slots. Ordinary users will not.

**Exploit Trace** (`.audit/poc/KraitObservationPoC.test.js`, test 1; runs against `089ce71`):
```
Setup: real UniswapV3Factory + pool WETH/X (0.3%), deep full-range liquidity, ring = 64 slots,
       twapWindow = 1800 s. Lender originates P = 10 WETH, BlueChip, 7 days; borrower pays D;
       borrower swap(X, 9 WETH) passes every entry check.
1. deadline − 200 s: lender makes 64 dust full-range mints, one per second
   → pool.observe([1800, 0]) reverts "OLD"
   → borrower swapBack(X, all, 1) reverts; borrower settle() (early close) reverts
2. deadline + 10 s: lender repeats → settle() by borrower and by lender both revert
3. (lender keeps the ring fresh: 64 mints per 30 min; sampled in the PoC)
4. inKindFrom(): lender repeats, then settleInKind() during the lender-only period
   → sale of X fails (caught), _priceHeld: canQuote = false → unpriced → toLender = all X
Result: lender cash 2.495 + X 8.972 vs 10.019 owed → +1.448 WETH; borrower receives 0 X.
Control (test 2): same vault, healthy oracle → settleInKind sells X, borrower is paid the surplus.
```

**Root Cause**: The vault treats "the TWAP cannot be read right now" as "this asset has no price", and anyone can bring that state about cheaply on a pool whose observation ring is not larger than the window.

**Recommendation**:
Refuse to open a position in a pool whose ring can be starved, that is, require `observationCardinality > twapWindow` at entry. At one write per second, a ring of more than `window` slots always holds an observation at least `window` seconds old, so `observe` can no longer be made to revert. Apply the same check in `AssetRegistry.setPoolFeeTier`, and make it part of the operator's listing procedure: grow every approved pool's ring to more than the window, and do not raise `twapWindow` above any approved pool's ring.

**Suggested Fix** (tested; as built, see `test/OracleStarvation.test.js`):
```solidity
// UniswapTwap.sol: add to IUniswapV3Pool
function slot0() external view returns (uint160, int24, uint16, uint16 observationCardinality, uint16, uint8, bool);

/// A ring of more than `window` slots always holds an observation at least
/// `window` seconds old (at most one is written per second), so it cannot be starved.
function cannotBeStarved(address factory, address tokenA, address tokenB, uint24 fee, uint32 window)
    public view returns (bool)
{
    address pool = IUniswapV3Factory(factory).getPool(tokenA, tokenB, fee);
    if (pool == address(0)) return false;
    (, , , uint16 cardinality, , , ) = IUniswapV3Pool(pool).slot0();
    return uint256(cardinality) > uint256(window);
}

// Vault.swap(), after the canQuote check:
require(
    UniswapTwap.cannotBeStarved(registry.uniswapFactory(), tokenOut, asset, poolFee, registry.twapWindow()),
    "Pool oracle history too short for the TWAP window"
);
```
Fix check:
- With 64 slots the borrower's entry is refused.
- With 1,801 slots the attacker's 64 writes leave `observe` working, and the loan settles normally with the borrower paid.

---

## [KRAIT-005] After the lender-only period, anyone can choose `settleInKind()` over `settle()` and cancel the lender's insurance draw — LOW

**File**: `contracts/Vault.sol:946-996`
**Category**: settlement path selection
**Evidence**: PROVEN, executed PoC [POC-PASS] (test 3).

**Description**:
`settleInKind()` tries to sell every held asset first. If every sale succeeds, nothing is left to hand over, but the function still finishes as a cash settlement. Compared with `settle()`, that settlement has **no insurance draw, no keeper bounty and no protocol fee**. Two things follow:
- **L-3, accepted:** a borrower with a dust position could pick it to skip the fee.
- **Not previously covered:** in a loss, anyone can pick it to deny the lender the draw.

A loss vault has no keeper incentive, because the bounty comes out of the borrower's residual and that residual is zero. So a passive lender's loss vault can still be open when the lender-only period ends.

**Impact**: The lender loses the insurance draw, up to `drawCapBps` (10%) of principal. The attacker gains nothing, so this is griefing. It requires the lender to have left the loan unsettled for about three weeks after the deadline.

**Exploit Trace** (PoC test 3, real Uniswap):
```
Setup: insurance pool funded with 100 WETH; X falls ~35% and the TWAP catches up; vault at a loss.
Control:  stranger calls settle()       → lender 9.227, insurance draw 1.0
Attack:   stranger calls settleInKind() → every sale succeeds, nothing in kind → lender 8.227, draw 0
```

**Root Cause**: `settleInKind()` does not check that anything actually had to be handed over in kind.

**Recommendation / Suggested Fix** (tested): after the sale loop, add

```solidity
require(heldAssets.length > 0, "Everything sold - use settle()");
```

This makes the in-kind path reachable only when an asset really cannot be sold, which also closes L-3's dust route completely.

---

## Candidates killed by verification

| Candidate | Gate | Note |
|---|---|---|
| `setTierConfig` leaves `insurancePremiumBps` unbounded and instant; a mandate fill charges the live premium with no borrower-side limit | E (admin trust) | Same family as L-6. The borrower's approval bounds it. Worth a sanity cap in operations. |
| `setInsuranceSkimRateBps` change applies to mandates already published | E | Owner action; the skim goes to the pool, not the owner. |
| Direct-path principal stays locked until the deadline if the borrower never pays the deposit | C (design) | Covered by a test ("Refuses to cancel before the deadline"). The lender chose the borrower. |
| Borrower extends keeper grace by buying a 24/5 asset just before the deadline | C | Parties can always settle during grace. |
| Re-entrancy via `claim()` during settlement | — | `owed` is zeroed before the transfer, and `isSettled` is set before any external call. |
| `settlementWindow` binary search boundaries | — | Re-traced: outages are time-ordered and never overlap; the run search is correct. |

## Areas verified safe

The new `_pay`/`owed`/`claim` accounting (Foundry invariant `settlementConserves`), the zero-skip, `trySafeTransfer`'s out-of-gas check, the held-asset bookkeeping across `swap`, `swapBack`, forced sale and the in-kind loop, mandate capacity, EIP-712 typehash against the encoding order, timelock queue and consume, and two-step roles.
