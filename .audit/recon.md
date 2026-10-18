# Krait Recon Report

## Protocol Overview
- Name: Covenza
- Type: Lending (fixed-term, low-collateral, non-liquidating), with AMM integration (Uniswap V3 swaps + TWAP) and an insurance pool
- Dependencies: OpenZeppelin (Clones, ECDSA, MessageHashUtils); Uniswap V3 (SwapRouter02, Factory, pool observe); Aave V3 / ERC-4626 (yield venues)
- Compiler: Solidity 0.8.24, optimizer 200 runs, Hardhat 2.22
- Scope size: 9 files, ~1,886 nSLOC (mocks out of scope)
- AST extraction: regex-fallback (Hardhat project, no forge build); Slither: SKIPPED (not available)
- Known issues: MAINNET-READINESS.md items 1–15 treated as Gate H

## File Risk Table
| Rank | File | Tier | LOC | Notes |
|------|------|------|-----|-------|
| 1 | Vault.sol | DEEP | 1122 | Holds principal + deposit; swaps, yield, settlement waterfall, insurance draw |
| 2 | VaultFactory.sol | DEEP | 1031 | Origination, mandates, pulls lender/borrower funds |
| 3 | AssetRegistry.sol | DEEP | 770 | Whitelist, tiers, settlement config read live by vaults |
| 4 | InsurancePool.sol | DEEP | 301 | Shared per-asset reserves; vault-only draws |
| 5 | KYCRegistry.sol | DEEP | 349 | Borrower gate; attester signatures |
| 6 | UniswapTwap.sol | DEEP | 233 | TWAP quote; vendored tick math |
| 7 | Timelocked.sol | DEEP | 88 | Queue/consume |
| 8 | OperatorControlled.sol | DEEP | 70 | Two-step operator |
| 9 | interfaces/IERC20.sol | SCAN | 19 | Interface |

Codebase size category: SMALL (≤15) — all files Tier 1.

## Fund Flows
- In: lender principal (factory transferFrom → vault); borrower deposit + premium (payDeposit, or factory on mandate fill); premiums → InsurancePool.fund.
- Inside vault: loan asset ↔ held assets via SwapRouter02 (swap / swapBack / forced swap-back); loan asset ↔ yield venue.
- Out: settle → lender (principal + accrued interest), keeper bounty, treasury/referrer fee, borrower residual; cancel → lender; InsurancePool.draw → vault on post-deadline shortfall; adminWithdraw (timelocked).

## Trust Boundaries
- Operator (AssetRegistry, KYCRegistry, InsurancePool) and owner (VaultFactory): Safes; semi-trusted, timelocked for some actions.
- Attesters: admit any wallet.
- Borrower: KYC'd but economically adversarial. The design premise is that the borrower "cannot move value to any outside address while the loan is live".
- Lender: anyone; chooses APR, deposit, borrower (direct path) or publishes a mandate.
- Keeper: anyone after grace.

## Attack Surface Priority
1. Borrower-controlled swap paths in Vault (price floors, fee-tier choice) — the custody claim rests on them.
2. Settlement waterfall and insurance draw — what the shared reserve pays for, and who sets that amount.
3. Live registry reads under open loans (largely known: item 12).

## Activated Modules
| Module | Trigger Evidence |
|--------|-----------------|
| access-control-state.md | Always active |
| lending-liquidation-deep.md | Loan origination, interest accrual, settlement waterfall |
| oracle-analysis.md | Uniswap V3 TWAP (UniswapTwap.quote / observe) |
| amm-mev-deep.md | exactInputSingle swaps with borrower-supplied minAmountOut |
| economic-design.md | Insurance premiums, protocol fee, referrer split, keeper bounty |
| token-flow-tracing.md | transfer/transferFrom throughout |
| external-protocol-integration.md | Uniswap V3, Aave V3, ERC-4626 |
| flash-loan-interaction.md | balanceOf(address(this)) in deposit invariant and creditDeposit |
| multi-tx-attack.md | Origination → deposit → settle sequenceable within blocks |
