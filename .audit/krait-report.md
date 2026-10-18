# Krait Security Audit Report

**Target**: Covenza (lending-poc)
**Date**: 2026-10-01
**Auditor**: Krait by Zealynx Security
**Scope**: `contracts/Vault.sol`, `VaultFactory.sol`, `AssetRegistry.sol`, `InsurancePool.sol`, `KYCRegistry.sol`, `Timelocked.sol`, `OperatorControlled.sol`, `libraries/UniswapTwap.sol`, `interfaces/IERC20.sol` at `aee7316`. Known issues in MAINNET-READINESS.md items 1–15 are excluded.

---

## Executive Summary

The audit covered the full in-scope set, with the self-review items treated as known. Two of the three new findings let a single KYC'd wallet take funds. The custody claim fails because `Vault.swapBack` has no price floor, so a borrower can sell the vault's held assets into a pool they have moved and keep the difference. Separately, the insurance pool covers unpaid **interest** at whatever APR the lender sets, so one wallet acting as both lender and borrower can drain any reserve 10% of principal at a time. Both reproduce against the repo's own mocks, and each proposed fix stops its exploit.

**Finding Summary**:
| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 1 |
| Medium | 1 |
| Low | 0 (see Observations) |

---

## Findings

### [KRAIT-001] `swapBack` has no TWAP floor: a borrower can drain principal through a self-sandwich — CRITICAL

**File**: `contracts/Vault.sol:737-750`
**Category**: custody bypass / price manipulation
**Evidence**: PROVEN — executed PoC [POC-PASS]. The fix below stops the PoC.

**Description**:
`swap()` (into a foreign asset) is bounded by `_enforceEntryImpact`, and the forced swap-back at settlement is bounded by `twapToleranceBps`. `swapBack()`, the borrower's voluntary exit, is bounded only by the borrower's own `minAmountOut`, which merely has to be `> 0`. The deposit invariant only checks loan-asset **outflows**, and `swapBack` is an inflow, so nothing in the vault checks the price.

A borrower can move all of the principal into held assets at fair prices and then sell them back at any price. If the borrower is also on the other side of that trade, the value leaves the vault. That breaks the protocol's central claim that the borrower "cannot move value to any outside address while the loan is live".

**Impact**:
The lender loses principal down to the deposit plus the capped insurance draw. In the PoC (P = 10, D = 1.5), the lender is owed 10.02 and receives 4.58 (1.5 deposit + 2 unspent + 0.08 swap proceeds + 1.0 insurance), a loss of about 5.4 of 10. The borrower's profit is roughly P − D − pool fees. Speculative and Standard tiers cap the exposure per asset, but not in total, so a borrower spread across several held assets reaches the same result.

**Proof of Concept**:
```
.audit/poc/KraitPoC.test.js  —  npx hardhat test .audit/poc/KraitPoC.test.js
1. Lender originates P=10 WETH, BlueChip, 7 days; borrower pays D=1.5.
2. borrower: swap(USDX, 8 WETH, …) at TWAP 1:1 — entry-impact and exposure checks pass.
3. Borrower's own front-run moves the USDX→WETH spot price to 1:100 (TWAP unchanged).
4. borrower: swapBack(USDX, 8e18, minAmountOut = 1)  → succeeds, vault receives 0.08 WETH.
5. Borrower's back-run buys USDX back cheaply (on a real pool, the 7.92 WETH difference is the borrower's).
6. settle(): lender target 10.023, paid 4.58, insurance draw 1.0.
Harm assertion: target − lenderPaid > 5 WETH  ✔
```
On Robinhood Chain (FCFS sequencer, no public mempool) the sandwich needs to be atomic. A borrower address that is a contract or smart account (KYC binds an address, not an EOA), or a 7702-delegated EOA, can batch all three steps. The borrower can also skip sandwiching a public pool: create a pool at another fee tier where they are the only LP, give it enough observation history to pass `canQuote`, make a dust `swap()` through it so `swapFeeTierOf[X]` points at that pool, then `swapBack` the whole balance into their own liquidity at an off-market price.

**Root Cause**:
`swapBack` relies on the slippage floor supplied by the very party whose incentives it is meant to constrain.

**Recommendation**:
Give `swapBack` the same TWAP floor as the forced swap-back, as a floor the borrower can raise but not lower. Also consider no longer letting a single `swap()` overwrite the fee tier used for the whole balance (see KRAIT-003).

**Vulnerable Code**:
```solidity
uint256 amountOut = _executeSwap(heldAsset, asset, amountIn, minAmountOut, swapFeeTierOf[heldAsset]);
```

**Fixed Code** (applied temporarily; it stops the PoC with `Too little received`, and the full 250-test suite passes with this change alone):
```solidity
uint24 feeTier = swapFeeTierOf[heldAsset];
uint256 twapOut = UniswapTwap.quote(
    registry.uniswapFactory(), heldAsset, asset, feeTier, amountIn, registry.twapWindow()
);
uint256 floorOut = (twapOut * (10000 - registry.twapToleranceBps())) / 10000;
if (minAmountOut < floorOut) { minAmountOut = floorOut; }

uint256 amountOut = _executeSwap(heldAsset, asset, amountIn, minAmountOut, feeTier);
```

---

### [KRAIT-002] Insurance pays unpaid interest at a lender-chosen, unbounded APR; one wallet acting as both lender and borrower drains the reserve — HIGH

**File**: `contracts/Vault.sol:864-866`, `contracts/VaultFactory.sol:338-348`
**Category**: economic / insurance accounting
**Evidence**: PROVEN — executed PoC [POC-PASS]. Fix option (a) stops the PoC.

**Description**:
`_distribute` draws on the pool whenever `totalReturned < principal + accruedFee()`. Interest is therefore insured. `aprBps` has no upper bound, either in `_deployVault` or in a mandate's `baseAprBps`. Nothing stops `lender == borrower`, and the lender does not need to be KYC'd. A single KYC'd wallet can:

1. `deployVaultWithTier(asset, self, P, aprBps = 2e9, 60, useSeconds = true, D = 10% floor, 0, BlueChip)`
2. `payDeposit()`. The premium on a 60-second term is negligible (about 2e-7 of P).
3. Wait 61 seconds, then `settle()` (no held assets, so anyone may settle). The interest owed is far above the deposit, so the shortfall exceeds the cap and the pool pays `drawCapBps × P`.
4. As lender, the wallet receives P + D + draw. As borrower, it paid P + D + premium. Repeat.

**Impact**:
Each cycle moves 10% of P (the current `drawCapBps`) from the shared reserve to the attacker, every couple of blocks, until the reserve for that asset is empty. Those reserves exist to protect every other lender. In the PoC, five 10-WETH cycles drain 5 WETH, and the attacker's net gain is 4.999999.

This is not the aggregate-limit concern in item 8. That item is about honest correlated losses. Here no market loss happens at all.

**Proof of Concept**:
```
.audit/poc/KraitPoC.test.js — "KRAIT-002"
attacker net gain 4.99999904870624049, reserve drained 4.99999904870624049  ✔
```

**Root Cause**:
The lender sets the size of the insured claim (interest at any APR), and the pool cannot tell a priced risk from a self-dealt one.

**Recommendation** (pick one):
- (a) **Insure principal only.** Draw `principal - totalReturned` only when `totalReturned < principal`. This stops the PoC. It also changes documented behaviour: `GroupB "Loss beyond deposit: insurance pool draw makes the lender whole"` fails (expects 0.8 drawn, gets 0.5), because that test asserts interest is covered.
- (b) **Keep interest cover but bound it.** Compute the insured claim as `principal + fee at min(aprBps, MAX_INSURED_APR_BPS)`, with the cap set on the factory and snapshotted. Also enforce a minimum term (or no insurance when the term is below some floor), and require `lender != borrower`. That last check alone is not enough, because a second address costs nothing to the lender side.

```solidity
// (a)
if (!early && totalReturned < principal) {
    insuranceDraw = insurancePool.draw(asset, principal - totalReturned, principal);
}
```

---

### [KRAIT-003] Borrower can make forced swap-back revert at will, getting a free extension of a non-liquidating position — MEDIUM

**File**: `contracts/Vault.sol:663-667, 775-781, 939-956`
**Category**: settlement liveness / economic
**Evidence**: REASONED — code trace [CODE-TRACE]. The mock router has no pool depth, so this cannot be shown with the existing mocks.

**Description**:
`_forcedSwapBackAll` sells the vault's **entire** balance of each held asset in one `exactInputSingle` call, through `swapFeeTierOf[held]`, with a TWAP-tolerance floor. `_trackHeldAsset` overwrites `swapFeeTierOf` with the fee tier of the **most recent** `swap()`, however small that swap was. `_enforceEntryImpact` exists to stop positions too large to exit, but it checks only the swap being made, not the balance that settlement will sell.

1. Borrower builds a large X position through the deep 0.3% pool.
2. Borrower makes a dust `swap()` into X through a thin pool at another tier. The pool can be one the borrower creates, provided it has observation history for `canQuote`. The dust swap passes the entry-impact and exposure checks, and `swapFeeTierOf[X]` now points at the thin pool.
3. At settlement the whole X balance goes into the thin pool. The output falls short of `TWAP × (1 − tol)` and `settle()` reverts for everyone (lender, borrower and keepers). After the deadline the borrower cannot `swapBack` either, so the fee tier cannot be changed.

A variant needs no thin pool: donating more X to the vault than the configured pool can absorb within tolerance has the same effect.

**Impact**:
The lender's principal stays locked past term with no bound. The borrower keeps a non-liquidating position open for free. If X recovers, the borrower can make settlement pass again by adding liquidity to the thin pool. The lender can unblock settlement only by supplying comparable liquidity to that pool themselves, at their own cost and exposure.

This is related to item 14, but that item covers settlement failing for external reasons. Here the borrower triggers the failure deliberately, getting around the control that was added to prevent it.

**Root Cause**:
The fee tier used to exit the whole position is chosen by the borrower's last swap, and the exit sells the whole balance in one call.

**Recommendation**:
Fix the fee tier the first time an asset becomes held, and refuse a later `swap()` into the same asset at a different tier (`require(!isHeld[tokenOut] || swapFeeTierOf[tokenOut] == poolFee)`). Also run the entry-impact check against the **post-swap total balance** in the reverse direction, i.e. quote the full held amount out through that pool, rather than only against the incremental swap.

---

## Security Strengths

- **Reentrancy**: `Vault.settle()` and `cancel()` set `isSettled` before any external call, and the integration addresses (router, factories, Aave) are now `immutable` in `AssetRegistry`, so no callback target is attacker-controlled.
- **Snapshotting**: fee terms, APR, term, `maxTier`, premium and the yield venue are snapshotted per vault. `highestTierSince` correctly refuses re-tags in both directions (the backward walk stops at the first entry ≤ `originatedAt`).
- **Timelock design**: `Timelocked` binds queue IDs to exact arguments, uses an immutable delay and consumes each entry on execution. The first `setVaultFactory` call being instant is limited correctly to the unwired state.
- **Clone safety**: `Vault` locks its implementation in the constructor (`factory = address(this)`), and the factory clones and initialises atomically. `creditDeposit` checks that the balance is actually present.
- **TWAP liveness**: `UniswapTwap.canQuote` refuses entry into pools that cannot serve the window, and the vendored tick math matches v3-core/periphery.

---

## Architecture Observations

These are not reported as findings (killed by the gates or downgraded to Low), but they are worth reading:

- **Attester timelock can be bypassed.** `KYCRegistry.rotateAttester` calls `_addAttester` instantly, and `verify()` admits any wallet instantly. The README states that "adding an attester is timelocked". Against the operator, that timelock currently protects nothing. Downgraded to Low because the operator is semi-trusted, but it is the same "walked-around timelock" pattern as item 10, and with KRAIT-001/002 open the KYC gate is the only barrier.
- **Self-referral.** In `deployVault` the lender names the `referrer`, so a lender can name themselves and take 30% (up to 50%) of the protocol fee on every direct loan. Mandate fills hard-code `address(0)`, so the two paths are inconsistent.
- **The exposure cap reads the asset's current tier**, not the tier at origination. `setTier` to a safer tier loosens the cap on live loans, the same pattern as item 12, reached through `setTier` rather than `setTierConfig`.
- **The `setTier` NatSpec is stale.** It says unassessed assets default to BlueChip, but `_addAsset` now defaults them to Speculative. That is the kind of reassuring comment item 1 started from.
- **The KYC signature digest has no `chainid`.** It is bound only by `address(this)`. That is safe unless the registry is deployed at the same address on two chains with the same attester key.
- **MEV on tier-3 settlement is bounded by `twapToleranceBps`.** A keeper can extract up to that tolerance, which is acceptable under an FCFS sequencer.

---

## Methodology

This audit was performed using Krait's multi-phase analysis:
1. **Recon**: Architecture mapping, fund flow analysis, trust boundary identification
2. **Detection**: Feynman first-principles interrogation + exploit-derived heuristic checks
3. **State Analysis**: Coupled state dependency mapping, mutation matrix cross-checking, parallel path comparison
4. **Verification**: Kill gates, impact premise, executed PoCs for H/C findings with fix falsification

_Generated by [Krait](https://github.com/ZealynxSecurity/krait) by Zealynx Security_
