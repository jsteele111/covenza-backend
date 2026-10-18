# Covenza

**Fixed-term, low-collateral lending for tokenised assets. Each loan lives in its own vault that the borrower operates but cannot drain.**

Over-collateralised lending dominates DeFi: borrowers post 100–150%+ of what they borrow, which serves leverage but excludes credit. Under-collateralised lending has repeatedly failed because it requires trusting the borrower with the funds.

Covenza removes that dependency. The principal is sent to a purpose-built vault, never to the borrower's wallet. The borrower trades freely within limits fixed when the loan was written: whitelisted assets only, a risk-tier ceiling, per-asset exposure caps. They cannot move value to any outside address while the loan is live. Custody is enforced by code.

It is **low-collateral, not uncollateralised**, and it is **non-liquidating**. There are no margin calls and no forced closure mid-term. Deposit floors, exposure caps and term limits do the job that liquidation does elsewhere, which is why they are strict.

**Status:** live on Robinhood Chain testnet against real Uniswap V3. Pre-audit. Not deployed to mainnet.
**Target:** Robinhood Chain, an Arbitrum Orbit L2, with lending against tokenised equities as the end goal. A test tokenised stock (tAAPL) is already listed on testnet with its own risk tier.

---

## Audit scope

Counted on 18 October 2026, as non-blank, non-comment lines. The exact frozen commit will be confirmed with the auditor before the engagement starts.

| File | nSLOC | Responsibility |
|---|---:|---|
| `contracts/Vault.sol` | 674 | Per-loan vault (EIP-1167 clone). Deposit invariant, swaps through the approved pool with tier ceiling, exposure caps, entry-impact and full-exit checks, measured swap output, internal holdings record, yield venues, TWAP-bounded swap-back (voluntary and forced), three-tier settlement, keeper bounty, protocol fee, payout waterfall, last-resort in-kind settlement (unsellable assets handed over at TWAP value; frozen tokens claimable later) |
| `contracts/VaultFactory.sol` | 566 | Clones vaults from one implementation. identity gating through `IIdentityAdapter` (borrowers need all three claims, lenders sanctions screening; loosening is timelocked), whitelist gating, mandates (publish, fill atomically, cancel, per-loan range plus total capacity), approved-referrer list, pricing quotes, insurance premium routing, protocol fee config, timelocked registry repointing, two-step ownership |
| `contracts/AssetRegistry.sol` | 431 | Operator-curated whitelist, risk tiers with tier history (risk ceiling and exposure cap both read the worst tier since origination), on-chain deposit floors, approved Uniswap pool per pair, per-asset yield venue and grace period, immutable integration addresses, settlement config, sequencer-outage record (heartbeat; grace extended by outages, keepers held through recovery). Changes that reach open loans wait on the timelock |
| `contracts/KYCRegistry.sol` | 190 | Identity adapter backed by third-party attesters. EIP-712 attestations bound to chain and contract, carrying claim flags (KYC, sanctions, jurisdiction) and an expiry of at most 365 days, checked at every origination. Timelocked attester additions and rotations. Manual grants: timelocked, 30 days, once per wallet per year, case reference on chain, marked manual, at most 5 per 30 days. No identity data stored |
| `contracts/InsurancePool.sol` | 115 | Per-asset reserves, draws capped as a % of principal and as a share of the remaining reserve (so no run of claims empties it), vault-only draws, timelocked withdrawals, factory and draw-limit changes |
| `contracts/Timelocked.sol` | 51 | Announce-then-execute delay for risk-increasing admin actions. Immutable delay, call-bound queue IDs, 14-day execution window after which an approval lapses |
| `contracts/VaultLens.sol` | 37 | Read-only swap quote for the interface (`quoteSwapOut`). Holds no state; nothing in the protocol calls it. Moved off Vault for contract size |
| `contracts/OperatorControlled.sol` | 32 | Two-step (nominate, then accept) operator transfer shared by three contracts |
| `contracts/interfaces/IERC20.sol` | 8 | Minimal ERC20 interface |
| `contracts/interfaces/IIdentityAdapter.sol` | 10 | The one identity question the protocol asks (`isEligible(wallet, claims)`), and the claim flags. Lets a ZK adapter replace KYCRegistry without changing the lending contracts |
| `contracts/libraries/SafeTransfer.sol` | 34 | Token transfers and approvals that accept tokens returning `true` or no data (USDT-style), and fail on `false`, a revert, or an address with no code. A non-reverting variant for in-kind hand-over of frozen tokens |
| `contracts/libraries/UniswapTwap.sol` | 142 | TWAP quote helper, deployed as a linked library. 53 lines of Covenza wrapper (`quote`, `canQuote`, `_consult`); 89 lines of tick/price maths vendored unchanged from Uniswap v3-core/periphery |
| **Total** | **2,290** | 2,201 written for Covenza + 89 vendored |

Out of scope: `contracts/mocks/` (test-only contracts, never deployed to production), `scripts/`, `test/`.

Compiler: Solidity 0.8.24, optimizer on (200 runs). Hardhat 2.22.

---

## How it works

**1. Custody — the vault boundary.**
Principal goes from the lender straight into the loan's own vault. The vault exposes only whitelisted actions: swaps through Uniswap V3 into whitelisted assets, and supplying to the asset's configured yield venue. There is no path to an external address while the loan is live.

**2. Mandates — lenders publish terms, borrowers fill them.**
A lender publishes a mandate: asset, a size range per loan and a total capacity across all loans, term range, expiry (capped at 7 days), a risk-tier ceiling, and optionally a single permitted borrower. Pricing is a **formula, not a range**. APR = base + a premium per day of term − a credit per point of deposit above the binding floor, never below the lender's minimum. Publishing a range would expose the lender's worst corner. Pricing every point on the surface leaves the lender indifferent across it. A verified borrower fills a mandate in one atomic transaction that moves the principal, their deposit and the insurance premium together, or none of them. Capital stays in the lender's wallet until a fill.

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
Loss hits the borrower's deposit first. The per-asset insurance pool then covers any remaining shortfall **against principal** — never interest — capped as a % of principal and on post-deadline settlements only. Only a genuine tail event reaches the lender's principal. Insuring principal only means the size of a claim can never be set by the lender's chosen rate. Once the lender is whole, the residual pays the keeper bounty, then the protocol fee, then the borrower. `lossSeverity()` records the outcome on chain.

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

**353 tests** across 20 suites.

```bash
npm install
npx hardhat test
```

| Suite | Tests | Covers |
|---|---:|---|
| `GroupA.test.js` | 26 | AssetRegistry whitelist and config; InsurancePool funding, draws, cap, access control |
| `GroupB.test.js` | 13 | Full lifecycle: swaps, deposit invariant, forced swap-back (aligned and diverged TWAP), principal-only insurance draws, three-tier access, keeper bounty |
| `GroupD.test.js` | 17 | Guard rails and edge cases, settlement boundaries, KYC revocation mid-loan |
| `GroupH.test.js` | 19 | Protocol fee: add-on behaviour, zero fee on loss, referrer split, approved referrers only, rate snapshotting |
| `InsuranceFunding.test.js` | 15 | Premium funding and cancellation |
| `Interest.test.js` | 11 | Annualised interest and minimum charge |
| `KYCRegistry.test.js` | 62 | EIP-712 attestations (expiry, claims, chain and contract binding, replay, renewal), the six manual-grant safeguards, revocation, two-step operator transfer, timelocked attester addition and rotation, status |
| `IdentityAdapter.test.js` | 8 | Eligibility checked at origination: expired and partial attestations refused, lenders screened, requirements timelocked to loosen, any adapter accepted |
| `Mandates.test.js` | 34 | Publish, fill, cancel, cancel-all, expiry, binding deposit, pricing surface, total capacity |
| `ProductionGuards.test.js` | 12 | Deploy guards, including outage detection left on |
| `RiskTiers.test.js` | 25 | Tier floors, term limits, exposure caps, tier history (both directions) |
| `TwapGuard.test.js` | 13 | Unquotable and manipulated pools; only the approved pool per pair; the lens quote agrees with the swap |
| `YieldVenue.test.js` | 14 | Aave and ERC-4626 venues, per-asset grace |
| `AdminTimelocks.test.js` | 14 | Insurance-pool factory changes are timelocked; integration addresses cannot be repointed |
| `KraitFindings.test.js` | 16 | Regression tests from Krait's proofs of concept: swap-back held to the TWAP floor; self-dealing cannot draw on the insurance pool; settlement cannot be stalled (approved pool, held-amount record, full-exit check); measured swap output |
| `TokenSafety.test.js` | 9 | USDT-style tokens through a whole loan; `false`-returning and code-less tokens still fail; timelock approvals lapse after 14 days |
| `OutageGrace.test.js` | 11 | Sequencer outages: grace extended by lost time, keeper's own settle records the outage first, recovery hold for keepers only, bounty from recovery, 72-hour cap, config bounds |
| `InKindSettlement.test.js` | 11 | Item 14: opens 7 days after keepers could settle; cash to the lender first, then the asset at TWAP value; frozen tokens claimable later; unpriceable assets to the lender with no insurance draw; insurance only on the shortfall after in-kind value |
| `DrawShare.test.js` | 7 | Item 8: each insurance draw limited to 5% of the remaining reserve; a 40-claim crash pays everyone something; timelocked both ways |
| `ParameterTimelocks.test.js` | 16 | Live-loan parameters wait on a real 48-hour timelock by direction; exposure cap uses the worst tier since origination |

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

## Heartbeat bot

Outage detection (item 16) needs `AssetRegistry.heartbeat()` called every
5 minutes. `scripts/heartbeat-bot.js` does that, skips when a heartbeat landed
in the last 4 minutes, retries after a failure, and sends a Telegram message
when it starts or stops, when an outage is recorded, after 3 failures in a
row, on recovery, and when its balance falls below 0.002 ETH.

```bash
node scripts/generate-heartbeat-key.js      # writes HEARTBEAT_PRIVATE_KEY to .env, prints the address to fund
node scripts/heartbeat-bot.js --test-alert  # needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
node scripts/heartbeat-bot.js --once        # one heartbeat, to check the setup
npm install -g pm2
pm2 start ecosystem.config.js               # testnet; add --env mainnet for mainnet
pm2 logs covenza-heartbeat
```

The bot's key holds gas money only; anyone may call `heartbeat()`. Each call
is about 28,600 gas. Mainnet needs an always-on host.

## Known limitations

Stated plainly, because a reviewer will find them anyway. The full self-review is in [`MAINNET-READINESS.md`](MAINNET-READINESS.md).

- **No independent audit yet.**
- **Tier parameters are placeholders.** Assumed volatilities and exposure caps are pending empirical calibration.
- **Insurance payouts still depend on order.** Each draw is capped at 10% of the loan's principal and at 5% of what is left in the reserve, so a run of losses cannot empty the pool and every lender receives something, but earlier claimants receive more. Premiums are modelled, not yet calibrated against real losses (`scripts/model-insurance-solvency.js`). Item 8.
- **Governance Safes are 1-of-1.** Co-signers must be added before mainnet.
- **The ERC-4626 venue on testnet is a mock.** No real venue exists on Robinhood Chain yet; mainnet ships with none.
- **Outage detection depends on a heartbeat bot.** `scripts/heartbeat-bot.js` calls `AssetRegistry.heartbeat()` every 5 minutes, under pm2, with Telegram alerts (see *Heartbeat bot* above). If it stops, quiet periods are read as outages: the parties get extra time and keepers wait, capped at 72 hours per loan. Nobody is locked out, but the keeper backstop slows.
- **Fee-on-transfer and rebasing tokens must never be listed.** The accounting assumes a transfer delivers what was sent. This is a listing rule for the operator, stated in `AssetRegistry`, not something the code detects. USDT-style tokens that return no data are supported.
- **No commercial identity provider is integrated yet.** Attester curation is the main control on who can borrow; attestations now expire within a year and carry the claims checked. A ZK adapter can be added later behind the same interface.
- **Live-loan parameters wait on the timelock** (settlement tolerance, TWAP window, global grace, bounty, draw cap, a raised exposure cap, a loosened entry-impact limit, a changed pool or a new yield venue); risk-reducing changes are instant. A loan in its grace window when a change lands does feel it: the timelock gives warning, not immunity. The **per-asset grace extension** is still instant, pending a design decision. Item 12.
- **A pool can thin out after entry.** Vaults trade only through the protocol's approved pool, record what they bought, and refuse any position they could not sell back in one go at the time of purchase (item 20, fixed). None of that stops liquidity being withdrawn later, for example by a borrower who is also the pool's main provider. Item 14 is the backstop.
- **A held asset that cannot be sold is handed over in kind.** If a forced swap-back cannot complete (a frozen tokenised equity, a dead pool), anyone may call `settleInKind()` 7 days after keepers could first settle: the lender gets the cash and then the asset at its TWAP value up to what they are owed, and a frozen token is claimable once it moves. The lender may end up holding the asset rather than cash. Item 14.

---

## Repository layout

```
contracts/            Solidity sources (audit scope above)
  interfaces/         Minimal IERC20
  libraries/          UniswapTwap (linked library)
  mocks/              Test-only mocks, out of scope
test/                 353 tests, 20 suites
scripts/              Deployment, proofs, operator and diagnostic scripts
  lib/                Production deploy guards
tools/                compute_volatility.py (historical volatility model)
MAINNET-READINESS.md  Self-review: findings, fixes, what remains open
deployed-addresses.json  Single source of truth for deployments
```

## Licence

MIT
