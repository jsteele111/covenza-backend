# Covenza

**Fixed-term, low-collateral lending for tokenised assets. Each loan lives in its own vault that the borrower operates but cannot drain.**

Over-collateralised lending dominates DeFi: borrowers post 100–150%+ of what they borrow, which serves leverage but excludes credit. Under-collateralised lending has repeatedly failed because it requires trusting the borrower with the funds.

Covenza removes that dependency. The principal is sent to a purpose-built vault, never to the borrower's wallet. The borrower trades freely within limits fixed when the loan was written: whitelisted assets only, a risk-tier ceiling, per-asset exposure caps. They cannot move value to any outside address while the loan is live. Custody is enforced by code.

It is **low-collateral, not uncollateralised**, and it is **non-liquidating**. There are no margin calls and no forced closure mid-term. Deposit floors, exposure caps and term limits do the job that liquidation does elsewhere, which is why they are strict.

**Status:** live on Robinhood Chain testnet against real Uniswap V3. Pre-audit. Not deployed to mainnet.
**Target:** Robinhood Chain, an Arbitrum Orbit L2, with lending against tokenised equities as the end goal. A test tokenised stock (tAAPL) is already listed on testnet with its own risk tier.

---

## Audit scope

Counted at `main` on 1 October 2026, as non-blank, non-comment lines. The exact frozen commit will be confirmed with the auditor before the engagement starts.

| File | nSLOC | Responsibility |
|---|---:|---|
| `contracts/Vault.sol` | 545 | Per-loan vault (EIP-1167 clone). Deposit invariant, swaps with tier ceiling, exposure caps and entry-impact check, yield venues, TWAP-bounded forced swap-back, three-tier settlement, keeper bounty, protocol fee, payout waterfall |
| `contracts/VaultFactory.sol` | 535 | Clones vaults from one implementation. KYC and whitelist gating, mandates (publish, fill atomically, cancel), pricing quotes, insurance premium routing, protocol fee config, timelocked registry repointing, two-step ownership |
| `contracts/AssetRegistry.sol` | 336 | Operator-curated whitelist, risk tiers with tier history, on-chain deposit floors, per-asset yield venue and grace period, immutable integration addresses, settlement config |
| `contracts/KYCRegistry.sol` | 146 | Records wallets admitted by recognised third-party attesters. Stores address, timestamp and attester only, no identity data. Timelocked attester additions |
| `contracts/InsurancePool.sol` | 104 | Per-asset reserves, draws capped as a % of principal, vault-only draws, timelocked withdrawals and factory changes |
| `contracts/Timelocked.sol` | 38 | Announce-then-execute delay for risk-increasing admin actions. Immutable delay, call-bound queue IDs |
| `contracts/OperatorControlled.sol` | 32 | Two-step (nominate, then accept) operator transfer shared by three contracts |
| `contracts/interfaces/IERC20.sol` | 8 | Minimal ERC20 interface |
| `contracts/libraries/UniswapTwap.sol` | 142 | TWAP quote helper, deployed as a linked library. 53 lines of Covenza wrapper (`quote`, `canQuote`, `_consult`); 89 lines of tick/price maths vendored unchanged from Uniswap v3-core/periphery |
| **Total** | **1,886** | 1,797 written for Covenza + 89 vendored |

Out of scope: `contracts/mocks/` (6 test-only contracts, never deployed to production), `scripts/`, `test/`.

Compiler: Solidity 0.8.24, optimizer on (200 runs). Hardhat 2.22.

---

## How it works

**1. Custody — the vault boundary.**
Principal goes from the lender straight into the loan's own vault. The vault exposes only whitelisted actions: swaps through Uniswap V3 into whitelisted assets, and supplying to the asset's configured yield venue. There is no path to an external address while the loan is live.

**2. Mandates — lenders publish terms, borrowers fill them.**
A lender publishes a mandate: asset, size range, term range, expiry (capped at 7 days), a risk-tier ceiling, and optionally a single permitted borrower. Pricing is a **formula, not a range**. APR = base + a premium per day of term − a credit per point of deposit above the binding floor, never below the lender's minimum. Publishing a range would expose the lender's worst corner. Pricing every point on the surface leaves the lender indifferent across it. A verified borrower fills a mandate in one atomic transaction that moves the principal, their deposit and the insurance premium together, or none of them. Capital stays in the lender's wallet until a fill.

**3. Risk tiers — deposit floors computed on chain.**
Every asset carries a tier (Blue chip, Standard, Speculative), each with an assumed volatility, an absolute deposit floor, a maximum term, an exposure cap and an insurance premium. The required deposit is `max(tier floor, 1.8 × assumed volatility × √(term/365))`, computed by `AssetRegistry` and **enforced at origination**, not advisory. An unassessed asset defaults to Speculative. The tier ceiling is snapshotted per loan: `highestTierSince(asset, originatedAt)` means re-tagging an asset can tighten a live loan but never loosen it.

**4. Deposit segregation — the core invariant.**
The deposit is collateral, not working capital. Every borrower-triggered outflow of the loan asset checks that the vault's loan-asset balance stays at or above the deposit. The rule is enforced the same way for every action type.

**5. Settlement — oracle-free.**
At settlement, any foreign assets are force-swapped back to the loan asset. The realised output must land within a tolerance of the Uniswap V3 time-weighted average price, or settlement reverts. Settlement happens in the loan asset or not at all. There is no price feed, no oracle governance and no oracle failure mode.

| Tier | Window | Who may settle |
|---|---|---|
| 1 | Before deadline | Borrower only (early close) |
| 2 | Deadline → end of grace | Lender or borrower |
| 3 | After grace | Anyone, earning a time-increasing bounty from the borrower's residual |

Grace periods are per asset. A tokenised equity trades 24/5, so its grace covers a weekend with no market.

**6. Payout waterfall.**
Loss hits the borrower's deposit first. The per-asset insurance pool covers any remaining shortfall, capped as a % of principal and on post-deadline settlements only. Only a genuine tail event reaches the lender's principal. Once the lender is whole, the residual pays the keeper bounty, then the protocol fee, then the borrower. `lossSeverity()` records the outcome on chain.

**7. Insurance pool.**
Reserves are per asset and never cross-converted, because converting at draw time would need a price and reintroduce the oracle. The pool is funded by a per-tier premium the borrower pays at origination. Reserves are never lent or staked. Only vaults registered by the factory can draw.

**8. Protocol fee — an add-on, never a haircut.**
A share of the loan's fee is charged to the borrower from their residual after the lender is paid in full. It can be split with a referrer. A loss yields zero protocol fee. Fee terms are snapshotted at origination.

**9. Yield venues.**
Per asset: none, Aave V3, or any ERC-4626 vault. The deposit is never investable. Production ships with every venue set to none until a real venue exists on the target chain, and the deploy guard enforces this.

**10. Identity — attestations, not custody of data.**
Covenza performs no identity check itself. `KYCRegistry` records that a recognised third-party attester admitted a wallet, and when. Adding an attester is timelocked; removing one is instant. Revocation is a deliberate operator decision, never automatic.

---

## Governance and admin safety

- **Two-step role transfer** on every admin role (nominate, then accept), so a handover to a multisig proves the multisig can transact before anything depends on it.
- **Timelocks on risk-increasing actions only:** insurance withdrawals, changing the pool's factory, repointing the factory's registries, and adding attesters. Risk-reducing actions stay instant. The delay is immutable, and each queued action is bound to its exact arguments.
- **Roles held by Safes on testnet:** operator `0x0A2e01C8CE58a53E44cd475faDD0a376906E5B1c`, owner `0x7FfCbd24b5EA061C1e5d478D608BcCc2eb45988B`. The deploying key governs nothing. These are currently 1-of-1 Safes. Adding real co-signers is required before mainnet.
- **Production deploy guards** (`scripts/lib/production-guards.js`) refuse a production deploy with:
  - a TWAP window under 1800s;
  - a timelock under 24h;
  - the operator equal to the deployer;
  - any yield venue set.

---

## Tests

**250 tests** across 13 suites.

```bash
npm install
npx hardhat test
```

| Suite | Tests | Covers |
|---|---:|---|
| `GroupA.test.js` | 26 | AssetRegistry whitelist and config; InsurancePool funding, draws, cap, access control |
| `GroupB.test.js` | 13 | Full lifecycle: swaps, deposit invariant, forced swap-back (aligned and diverged TWAP), insurance draws, three-tier access, keeper bounty |
| `GroupD.test.js` | 17 | Guard rails and edge cases, settlement boundaries, KYC revocation mid-loan |
| `GroupH.test.js` | 15 | Protocol fee: add-on behaviour, zero fee on loss, referrer split, rate snapshotting |
| `InsuranceFunding.test.js` | 15 | Premium funding and cancellation |
| `Interest.test.js` | 11 | Annualised interest and minimum charge |
| `KYCRegistry.test.js` | 46 | Attester signatures, revocation, two-step operator transfer, timelocked attesters, status |
| `Mandates.test.js` | 31 | Publish, fill, cancel, cancel-all, expiry, binding deposit, pricing surface |
| `ProductionGuards.test.js` | 11 | Deploy guards |
| `RiskTiers.test.js` | 25 | Tier floors, term limits, exposure caps, tier history (both directions) |
| `TwapGuard.test.js` | 12 | Unquotable and manipulated pools |
| `YieldVenue.test.js` | 14 | Aave and ERC-4626 venues, per-asset grace |
| `AdminTimelocks.test.js` | 14 | Insurance-pool factory changes are timelocked; integration addresses cannot be repointed |

Loss scenarios run against real state changes. Mock Aave, Uniswap and ERC-4626 contracts with configurable rates and TWAP ticks reproduce a genuine loss deterministically rather than stubbing it.

Not yet present: fuzz and invariant suites.

---

## Deployment — Robinhood Chain testnet (46630)

Real Uniswap V3: the factory and router were deployed from the audited `@uniswap/v3-core` artifacts, because Uniswap is mainnet-only on Robinhood Chain.

| Contract | Address |
|---|---|
| VaultFactory | `0x70b5a6c403FB33D0F601fd8F63E1c09b682d2EED` |
| Vault implementation | `0x66a400775d1B599bF85fD6676d66D127FE2f51CD` |
| AssetRegistry | `0xd3Cc52565faae7419c2BFA6B9FeA9Eed1b28f284` |
| InsurancePool | `0xf7fEb99a5df10Ad3BD37DBB9E3eaAFc79A87e9B1` |
| KYCRegistry | `0xCeC02Aab9e97F8a658D7FED455703E4aAfa1B7ed` |
| UniswapTwap library | `0x80Fd8Be02D8573d2B4D31A2EA4b4Ea24dD33CC70` |

Explorer: [explorer.testnet.chain.robinhood.com](https://explorer.testnet.chain.robinhood.com). The full record, including test tokens, Uniswap pools and the Safes, is in `deployed-addresses.json` under `robinhoodTestnet`.

**Proven on chain** (scripts in `scripts/`):
- `lifecycle-proof-robinhood.js` — all three settlement tiers, including an organic loss absorbed entirely by the borrower's deposit;
- `prove-insurance-draw.js` — the insurance pool paying a lender after a deposit is exhausted;
- `prove-keeper-bounty.js` — a third-party keeper settling after grace and earning the bounty.

Robinhood testnet periodically wipes contract state. These proofs ran against earlier deployments of this code. The current stack was redeployed on 5 August 2026 after the KYC badge was removed.

Testnet settlement parameters are deliberately demo-tuned so every path can be exercised in one sitting: a 60s TWAP window, short grace and a steep bounty. The production deploy guard refuses these values.

The earlier Arbitrum Sepolia deployment predates mandates and risk tiers and is no longer supported by the interface.

**Web interface:** [covenza.xyz](https://covenza.xyz), repository `covenza-frontend` (React, Vite, wagmi, RainbowKit).

---

## Known limitations

Stated plainly, because a reviewer will find them anyway. The full self-review is in [`MAINNET-READINESS.md`](MAINNET-READINESS.md).

- **No independent audit yet.**
- **Tier parameters are placeholders.** Assumed volatilities and exposure caps are pending empirical calibration.
- **Insurance has no aggregate limit.** The draw cap limits each settlement, but nothing limits total draws, so correlated losses would drain a reserve first-come-first-served. A reserve-ratio floor is the intended fix and needs actuarial modelling first. `scripts/model-insurance-solvency.js` holds the current model.
- **Governance Safes are 1-of-1.** Co-signers must be added before mainnet.
- **The ERC-4626 venue on testnet is a mock.** No real venue exists on Robinhood Chain yet; mainnet ships with none.
- **No commercial identity provider is integrated yet.** Attester curation is the whole control on who can borrow.
- **Some live-loan parameters still change instantly** (settlement tolerance, exposure caps, grace, draw cap). Bounded, but a lender priced the loan against the values in force when it was written. Item 12 in the self-review.
- **A mandate can be filled more than once**, up to the lender's allowance; `maxPrincipal` limits each fill, not the total. Item 13.
- **Settlement has no fallback if a held asset cannot be swapped back**, for example a tokenised equity frozen by its issuer. The loan stays unsettled until it can be. Item 14.

---

## Repository layout

```
contracts/            Solidity sources (audit scope above)
  interfaces/         Minimal IERC20
  libraries/          UniswapTwap (linked library)
  mocks/              Test-only mocks, out of scope
test/                 250 tests, 13 suites
scripts/              Deployment, proofs, operator and diagnostic scripts
  lib/                Production deploy guards
tools/                compute_volatility.py (historical volatility model)
MAINNET-READINESS.md  Self-review: findings, fixes, what remains open
deployed-addresses.json  Single source of truth for deployments
```

## Licence

MIT
