# Covenza

**Fixed-term, low-collateral lending for tokenised assets. Each loan lives in its own vault that the borrower operates but cannot drain.**

Over-collateralised lending dominates DeFi: borrowers post 100–150%+ of what they borrow, which serves leverage but excludes credit. Under-collateralised lending has repeatedly failed because it requires trusting the borrower with the funds.

Covenza removes that dependency. The principal is sent to a purpose-built vault, never to the borrower's wallet. The borrower trades freely within limits fixed when the loan was written: whitelisted assets only, a risk-tier ceiling, per-asset exposure caps. They cannot move value to any outside address while the loan is live. Custody is enforced by code.

It is **low-collateral, not uncollateralised**, and it is **non-liquidating**. There are no margin calls and no forced closure mid-term. Deposit floors, exposure caps and term limits do the job that liquidation does elsewhere, which is why they are strict.

**Status:** live on Robinhood Chain testnet against real Uniswap V3. Pre-audit. Not deployed to mainnet.
**Target:** Robinhood Chain, an Arbitrum Orbit L2, with lending against tokenised equities as the end goal. A test tokenised stock (tAAPL) is already listed on testnet with its own risk tier.

---

## Audit scope

Counted on 19 October 2026, as non-blank, non-comment lines. The exact frozen commit will be confirmed with the auditor before the engagement starts.

| File | nSLOC | Responsibility |
|---|---:|---|
| `contracts/Vault.sol` | 577 | Per-loan vault (EIP-1167 clone). Deposit invariant, swaps through the approved pool with tier ceiling, exposure caps, entry-impact and full-exit checks, measured swap output, internal holdings record, TWAP-bounded swap-back (voluntary and forced), three-tier settlement, keeper bounty, protocol fee, payout waterfall in which a payout the token refuses is held for the recipient to claim, last-resort in-kind settlement (lender-only for its first 7 days; unsellable assets handed over at TWAP value; no insurance draw) |
| `contracts/VaultFactory.sol` | 569 | Clones vaults from one implementation. Lender and borrower must differ; identity gating through `IIdentityAdapter` (borrowers need all three claims, lenders sanctions screening; loosening is timelocked), whitelist gating, mandates (publish, fill atomically with a borrower APR limit, cancel, per-loan range plus total capacity), approved-referrer list, pricing quotes, insurance premium routing, protocol fee config, timelocked registry repointing, two-step ownership |
| `contracts/AssetRegistry.sol` | 352 | Operator-curated whitelist, risk tiers with tier history (risk ceiling and exposure cap both read the worst tier since origination), on-chain deposit floors, approved Uniswap pool per pair, per-asset grace period, immutable integration addresses, bounded settlement config, sequencer-outage record (heartbeat; grace extended by outages, keepers held through recovery; lookup cost independent of later outages). Changes that reach open loans wait on the timelock |
| `contracts/KYCRegistry.sol` | 176 | Identity adapter backed by third-party attesters. EIP-712 attestations bound to chain and contract, carrying claim flags (KYC, sanctions, jurisdiction) and an expiry of at most 365 days, checked at every origination. Timelocked attester additions and rotations. Manual grants: timelocked, 30 days, once per wallet per year, case reference on chain, marked manual, at most 5 per 30 days. No identity data stored |
| `contracts/InsurancePool.sol` | 115 | Per-asset reserves, draws capped as a % of principal and as a share of the remaining reserve (so no run of claims empties it), vault-only draws, timelocked withdrawals, factory and draw-limit changes |
| `contracts/Timelocked.sol` | 51 | Announce-then-execute delay for risk-increasing admin actions. Immutable delay, call-bound queue IDs, 14-day execution window after which an approval lapses |
| `contracts/VaultLens.sol` | 37 | Read-only swap quote for the interface (`quoteSwapOut`). Holds no state; nothing in the protocol calls it. Moved off Vault for contract size |
| `contracts/OperatorControlled.sol` | 32 | Two-step (nominate, then accept) operator transfer shared by three contracts |
| `contracts/interfaces/IERC20.sol` | 8 | Minimal ERC20 interface |
| `contracts/interfaces/IIdentityAdapter.sol` | 10 | The one identity question the protocol asks (`isEligible(wallet, claims)`), and the claim flags. Lets a ZK adapter replace KYCRegistry without changing the lending contracts |
| `contracts/libraries/SafeTransfer.sol` | 36 | Token transfers and approvals that accept tokens returning `true` or no data (USDT-style), and fail on `false`, a revert, or an address with no code. A non-reverting variant for payouts a token may refuse, which still reverts when out of gas |
| `contracts/libraries/UniswapTwap.sol` | 143 | TWAP quote helper, deployed as a linked library. 54 lines of Covenza wrapper (`quote`, `canQuote`, `_consult`); 89 lines of tick/price maths vendored unchanged from Uniswap v3-core/periphery |
| **Total** | **2,106** | 2,017 written for Covenza + 89 vendored |

Out of scope: `contracts/mocks/` (test-only contracts, never deployed to production), `scripts/`, `test/`.

Compiler: Solidity 0.8.24, optimizer on (200 runs). Hardhat 2.22.

---

## How it works

**1. Custody — the vault boundary.**
Principal goes from the lender straight into the loan's own vault. The vault exposes only whitelisted actions: swaps through Uniswap V3 into whitelisted assets. There is no path to an external address while the loan is live.

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
Loss hits the borrower's deposit first. The per-asset insurance pool then covers any remaining shortfall **against principal** — never interest — capped as a % of principal and on post-deadline settlements only. Only a genuine tail event reaches the lender's principal. Insuring principal only means the size of a claim can never be set by the lender's chosen rate. Once the lender is whole, the residual pays the keeper bounty, then the protocol fee, then the borrower. `lossSeverity()` records the outcome on chain: 0 none, 1 borrower only, 2 lender impacted, 3 settled in kind (the outcome depends on the assets handed over, so it is not measured in the loan asset).

**7. Insurance pool.**
Reserves are per asset and never cross-converted, because converting at draw time would need a price and reintroduce the oracle. The pool is funded by a per-tier premium the borrower pays at origination. Reserves are never lent or staked. Only vaults registered by the factory can draw.

**8. Protocol fee — an add-on, never a haircut.**
A share of the loan's fee is charged to the borrower from their residual after the lender is paid in full. It can be split with a referrer. A loss yields zero protocol fee. Fee terms are snapshotted at origination.

**9. Payouts a token refuses.**
Regulated stablecoins can blacklist addresses. A payout the token refuses is not allowed to block anyone else's: it is held in the vault as `owed(token, recipient)` and the recipient calls `claim(token)` once the token will pay them.

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
  - the initial attester equal to the deployer;
  - sequencer-outage detection switched off.

---

## Tests

**355 Hardhat tests** across 21 suites, plus **9 Foundry invariants** and one
handler-path test.

```bash
npm install
npx hardhat test
forge install foundry-rs/forge-std   # once, after cloning (git submodule)
forge test                           # invariants: about a minute
```

| Suite | Tests | Covers |
|---|---:|---|
| `GroupA.test.js` | 26 | AssetRegistry whitelist and config; InsurancePool funding, draws, cap, access control |
| `GroupB.test.js` | 12 | Full lifecycle: swaps, deposit invariant, forced swap-back (aligned and diverged TWAP), principal-only insurance draws, three-tier access, keeper bounty |
| `GroupD.test.js` | 15 | Guard rails and edge cases, settlement boundaries, KYC revocation mid-loan |
| `GroupH.test.js` | 19 | Protocol fee: add-on behaviour, zero fee on loss, referrer split, approved referrers only, rate snapshotting |
| `InsuranceFunding.test.js` | 15 | Premium funding and cancellation |
| `Interest.test.js` | 11 | Annualised interest and minimum charge |
| `KYCRegistry.test.js` | 59 | EIP-712 attestations (expiry, claims, chain and contract binding, replay, renewal), the six manual-grant safeguards, revocation, two-step operator transfer, timelocked attester addition and rotation, status |
| `IdentityAdapter.test.js` | 8 | Eligibility checked at origination: expired and partial attestations refused, lenders screened, requirements timelocked to loosen, any adapter accepted |
| `Mandates.test.js` | 35 | Publish, fill, cancel, cancel-all, expiry, binding deposit, pricing surface, total capacity, borrower APR limit |
| `ProductionGuards.test.js` | 10 | Deploy guards, including outage detection left on |
| `RiskTiers.test.js` | 24 | Tier floors, term limits, exposure caps, tier history (both directions) |
| `TwapGuard.test.js` | 14 | Unquotable and manipulated pools; only the approved pool per pair; the lens quote agrees with the swap; amounts too large to quote |
| `AssetGrace.test.js` | 5 | Per-asset grace: global grace for continuously traded assets, the extended window for 24/5 assets, longest governs, keepers held off but the parties not |
| `Payouts.test.js` | 7 | Audit M-1 and L-5: a blacklisted borrower, lender, treasury or referrer blocks nobody; held payouts claimable by their owner alone; zero-value payouts skipped |
| `AdminTimelocks.test.js` | 14 | Insurance-pool factory changes are timelocked; integration addresses cannot be repointed |
| `KraitFindings.test.js` | 17 | Regression tests from Krait's proofs of concept: swap-back held to the TWAP floor; self-dealing cannot draw on the insurance pool, and a wallet cannot lend to itself; settlement cannot be stalled (approved pool, held-amount record, full-exit check); measured swap output |
| `TokenSafety.test.js` | 9 | USDT-style tokens through a whole loan; `false`-returning and code-less tokens still fail; timelock approvals lapse after 14 days |
| `OutageGrace.test.js` | 12 | Sequencer outages: grace extended by lost time, keeper's own settle records the outage first, recovery hold for keepers only, bounty from recovery, 72-hour cap, config bounds, constant cost however many outages follow |
| `InKindSettlement.test.js` | 13 | Item 14: opens 7 days after grace, and only once the chain has recovered from any outage; lender only for the first 7 days; cash to the lender first, then the asset at TWAP value; frozen tokens claimable later; unpriceable assets to the lender; never draws insurance; reported as loss severity 3 |
| `DrawShare.test.js` | 7 | Item 8: each insurance draw limited to 5% of the remaining reserve; a 40-claim crash pays everyone something; timelocked both ways |
| `ParameterTimelocks.test.js` | 23 | Live-loan parameters wait on a real 48-hour timelock by direction, including the per-asset grace extension and re-listing a removed asset on new terms; settlement config upper limits; exposure cap uses the worst tier since origination |

Loss scenarios run against real state changes. Mock Uniswap contracts with configurable rates and TWAP ticks, and mock tokens that freeze or blacklist, reproduce a genuine loss deterministically rather than stubbing it.

### Invariants (Foundry)

`test-foundry/` drives the real stack (factory, clones, registry, pool, linked
TWAP library) through random sequences of up to 300 actions, 128 sequences per
run: originate directly or through a mandate, pay or skip the deposit, swap in
and out (including attempts to spend the deposit or sell more than was bought),
move the price, manipulate spot away from the TWAP, freeze the bought token,
donate tokens to a vault, let time pass with or without the heartbeat bot,
settle, settle in kind, cancel, and claim. After every action it checks:

| Invariant | Property |
|---|---|
| `openVaultHoldsDeposit` | An open, funded vault always holds at least the deposit in the loan asset |
| `heldRecordIsBacked` | The record of what a vault bought never exceeds what it holds, and clears at settlement |
| `settlementConserves` | Every settlement pays out exactly the vault's funds plus the insurance draw; the only loan asset left behind is what is held for recipients to claim |
| `lenderPayoutBounded` | The lender never receives more than principal plus accrued interest; an early close always pays in full |
| `inKindClaimsAreBacked` | Tokens owed in kind are still in the vault |
| `reserveAccounting` | The pool's reserve equals funding plus premiums minus draws, and never exceeds its balance |
| `drawsWithinBothCaps` | No draw exceeds 10% of the loan's principal or 5% of the remaining reserve |
| `wethConserved` | Every token minted is accounted for: none created, none lost |
| `mandateCapacity` | No mandate lends beyond its total capacity |

Checked against deliberately broken contracts: removing the reserve-share
cap, or letting a swap spend the deposit, each fails within seconds.

The fuzzer found one real problem, now fixed: the in-kind window was counted
from the keeper start, which moves with the latest outage, so on a quiet
chain without the bot it never opened (item 14).

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
- **No yield on idle principal.** Yield venues (Aave V3, ERC-4626) were removed before the audit: no real venue exists on Robinhood Chain. They would return as a separate, separately audited change.
- **Outage detection depends on a heartbeat bot.** `scripts/heartbeat-bot.js` calls `AssetRegistry.heartbeat()` every 5 minutes, under pm2, with Telegram alerts (see *Heartbeat bot* above). If it stops, quiet periods are read as outages: the parties get extra time and keepers wait, capped at 72 hours per loan. Nobody is locked out, but the keeper backstop slows.
- **Fee-on-transfer and rebasing tokens must never be listed.** The accounting assumes a transfer delivers what was sent. This is a listing rule for the operator, stated in `AssetRegistry`, not something the code detects. USDT-style tokens that return no data are supported.
- **No commercial identity provider is integrated yet.** Attester curation is the main control on who can borrow; attestations now expire within a year and carry the claims checked. A ZK adapter can be added later behind the same interface.
- **Live-loan parameters wait on the timelock** (settlement tolerance, TWAP window, global grace, bounty, draw cap, a raised exposure cap, a loosened entry-impact limit, a changed pool, any change to an asset's grace extension, and re-listing a removed asset on different terms); risk-reducing changes are instant. A loan in its grace window when a change lands does feel it: the timelock gives warning, not immunity. Item 12.
- **Grace for tokenised equities is a fixed extension, not a trading calendar.** The 72-hour extension covers a weekend for loans due late in the week, but a keeper can still force-settle at a weekend when grace happens to end there (a loan due Tuesday evening ends grace early Saturday). The forced sale must still land within the TWAP tolerance or it reverts, so the exposure is a failed or thin-market settlement, not an arbitrary price. A per-asset trading schedule was considered and deferred until there is data on how these pools behave out of hours.
- **Lenders and borrowers may settle against a thin out-of-hours pool.** Only keepers are held back by grace. A party settling on a weekend is bound by the same TWAP floor, but a thin weekend pool makes that average cheaper to move.
- **A pool can thin out after entry.** Vaults trade only through the protocol's approved pool, record what they bought, and refuse any position they could not sell back in one go at the time of purchase (item 20, fixed). None of that stops liquidity being withdrawn later, for example by a borrower who is also the pool's main provider. Item 14 is the backstop.
- **A held asset that cannot be sold is handed over in kind.** If a forced swap-back cannot complete (a frozen tokenised equity, a dead pool), `settleInKind()` opens 7 days after grace ends, to the lender alone for 7 days and to anyone after that: the lender gets the cash and then the asset at its TWAP value up to what they are owed, and a frozen token is claimable once it moves. It never draws insurance, because the TWAP of a pool too thin to sell into is cheap to move (audit M-2). The lender may end up holding the asset rather than cash. Item 14.
- **In-kind settlement charges no protocol fee** (audit L-3, accepted). A borrower would have to make the sale fail and then wait out two weeks during which the lender can settle; the fee forgone is small next to that.
- **A forced swap-back can be sandwiched within the TWAP tolerance** (audit M-3, accepted). A searcher can take up to the tolerance from the sale. It falls on the borrower's residual first and reaches the lender only in a loss. This is the cost of having no oracle; the tolerance is timelocked and should be kept tight on mainnet.
- **Interest stops at the deadline.** A lender's capital can stay in the vault through grace and the in-kind window without earning.
- **Tokens sent to a vault by mistake are stuck.** There is deliberately no sweep function; any path to an arbitrary address is a path out of the vault.
- **There is no pause.** `removeAsset`, the identity requirements and the timelocks are the brakes. Nobody can freeze a live loan, by design.
- **A payout the token refuses waits to be claimed.** If a stablecoin blacklists a recipient, their share stays in the vault under `owed(token, recipient)` until the token lets them receive it; everyone else is paid at settlement (audit M-1).

---

## Repository layout

```
contracts/            Solidity sources (audit scope above)
  interfaces/         Minimal IERC20
  libraries/          UniswapTwap (linked library)
  mocks/              Test-only mocks, out of scope
test/                 355 Hardhat tests, 21 suites
test-foundry/         Foundry invariant suite and handler
lib/forge-std/        Foundry test library (git submodule)
scripts/              Deployment, proofs, operator and diagnostic scripts
  lib/                Production deploy guards
tools/                compute_volatility.py (historical volatility model)
MAINNET-READINESS.md  Self-review: findings, fixes, what remains open
deployed-addresses.json  Single source of truth for deployments
```

## Licence

MIT
