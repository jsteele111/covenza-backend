# Mainnet readiness review

**Date:** 2 August 2026
**Scope:** `contracts/` as deployed to Robinhood Chain testnet (chain 46630)
**Status:** not ready for real money. Nothing here is unfixable; two items are
structural and the rest are a week of work plus an audit.

**Progress:** items 1, 2, 4, 5 and 6 are addressed in code, and 3 is now
partially enforced by a deploy guard. Items 7 and 8 are blocked; 9 is an audit.
Fixes are marked inline.

**Second review, 1 October 2026:** eleven further findings, items 10–20, recorded
in their own section at the end. Two were HIGH and are fixed. One of them
(item 10) showed that item 2 below was only half fixed: the withdrawal was
timelocked, but the same reserves could still leave instantly by another
route. Item 2 is annotated accordingly rather than quietly rewritten.

Item 5's fix caught something the review did not: `TIMELOCK_DELAY` defaults to
zero, introduced by the fix for items 2, 4 and 6 an hour earlier. Shipped to
mainnet it would have deployed timelocks that queue and execute in the same
block. A fix creating the next finding is the ordinary case, not a surprise.

This is a self-review, not an independent audit, and self-review has a known
failure mode: the person who wrote the bug is the person deciding whether it is
a bug. Item 1 below was found by reading a code comment I wrote and noticing it
was wrong, which is exactly the class of thing an outside reviewer catches
faster.

---

## 1. Re-tagging an asset silently loosens live loans — CRITICAL — **FIXED**

> `AssetRegistry` keeps tier history; `Vault.swap` requires
> `highestTierSince(asset, originatedAt) <= maxTier`, which refuses both
> directions of change and leaves an unmoved asset alone. Four tests added —
> the suite previously covered only the direction the code got right.


`Vault.swap()` line 646:

```solidity
require(uint8(registry.tierOf(tokenOut)) <= maxTier, "Asset exceeds this vault's risk mandate");
```

`maxTier` is snapshotted at origination. `tierOf(tokenOut)` is read **live**.
The comment above it claims re-tagging "can tighten a live loan but never
loosen it." That is true in one direction only.

- Re-tag an asset **riskier** (Standard → Speculative): live vaults capped at
  Standard can no longer hold it. Tightens. Fine.
- Re-tag an asset **safer** (Standard → Blue chip): every live vault capped at
  Blue chip can now hold it, immediately, with no lender consent.

Concretely, using today's live values: a lender publishes a Blue chip mandate,
whose deposit floor is computed from 60% assumed volatility — 15% at seven
days. The operator re-tags tAAPL, whose Standard tier assumes 100% volatility,
down to Blue chip. Every borrower on a Blue chip mandate may now buy tAAPL
against a deposit sized for an asset far less volatile. The lender's protection
thins materially and they are not consulted, because their mandate was
expressed as a *tier*, not as a set of assets.

The deposit itself is snapshotted; the risk it was sized against is not.

**Fix (cheap, do now):** snapshot the permitted asset set, or snapshot the
tier configuration, at origination. The simplest version is to record
`tierOf(asset)` for each asset at the moment it is first swapped into and
refuse if the live tier is *lower* than the snapshot — i.e. only ever allow
tightening. A fuller version stores the tier config (assumed volatility,
exposure cap) on the vault at origination, matching how APR, term and deposit
are already handled.

**Also fix the comment.** A reviewer trusts a comment that specific.

---

## 2. The insurance pool can be emptied by one key, instantly — CRITICAL — **FIXED**

> `adminWithdraw` is now announce-then-execute via `Timelocked`, with the delay
> immutable and the queue id bound to asset, recipient and amount. Cancellation
> stays instant. The delay does not stop a determined operator — it makes the
> attempt visible while there is still time to react.
>
> **Correction, 1 October 2026: this was only half fixed until item 10.**
> `setVaultFactory` stayed instant, and repointing the factory let the operator
> register a fake vault and draw the whole reserve in two transactions, so the
> withdrawal timelock could be walked around. Both routes are now delayed.


`InsurancePool.adminWithdraw(asset, to, amount)` sends any amount of reserve to
any address, operator-only, no timelock, no cap, no delay.

The insurance pool is what lenders are told stands behind them after the
borrower's deposit. A single compromised or coerced key removes it between
blocks. This is the first thing an auditor will write down and the first thing
a sophisticated lender will ask about.

The docstring justifies it as "e.g. if a reserve has grown large relative to
outstanding risk" — a real operational need, but the current design solves it
with an unbounded instant withdrawal.

**Fix (cheap, do now):** one or more of —
- timelock it: announce, wait 48h, execute, with the pending withdrawal
  publicly readable;
- cap it per period (e.g. 5% of reserve per week);
- restrict `to` to an address fixed at construction, so a compromised operator
  can move funds but not *steal* them.

The timelock is the honest one. The others reduce blast radius without
removing the power.

---

## 3. Everything is one key — CRITICAL — **RESOLVED ON TESTNET**

> Two Safes now hold the roles, proven end to end on chain:
> operator `0x0A2e01…5B1c`, owner `0x7FfCbd…988B`. The deploying key governs
> nothing. `scripts/verify-handover.js` exercises a real operator action from
> both sides — refused from the old key with the operator check, executed
> successfully from the Safe — because reading `operator()` only proves a
> variable was assigned, not that the permission checks consult it.
>
> **The honest caveat:** these are 1-of-1 Safes owned by the same key that
> deployed everything. Against a compromised key that is barely an improvement.
> What it buys is structural — a Safe's address survives changes to its owner
> set, so co-signers can be added later without Covenza being touched again,
> and the irreversible part is already done and tested.
>
> Adding real co-signers is now a Safe administration task, not a protocol one.
> It must happen before mainnet.

> The deploy guard refuses production when the operator is the deploying EOA.
> `scripts/transfer-control.js` moves both roles and refuses a target with no
> contract code — a Safe has code, a typo'd EOA does not, and the transfer is
> irreversible.
>
> **This surfaced a blocker.** `VaultFactory` had no ownership transfer at all:
> `owner` was set in the constructor with no setter, so the factory could only
> ever belong to whoever deployed it. Handing it to a multisig was not a
> permissions question — it was impossible.
>
> All four roles are now nominate-then-accept, sharing one `OperatorControlled`
> base so the pattern cannot drift between contracts. The reason for two steps
> is not typo protection so much as this: a multisig that cannot reach its
> signing threshold is indistinguishable from a working one until the moment
> you need it, and under a one-step transfer that moment arrives after control
> is already gone. Requiring the nominee to call accept makes the handover its
> own rehearsal.
>
> Deployed and verified on chain by `scripts/verify-two-step.js`, which
> nominates a probe, asserts the incumbent still governs and the nominee is
> still powerless, then cancels. The unit suite proves the source is right; it
> cannot prove the deployment picked it up, and twice today a change reached
> git without reaching the chain while the tests stayed green.
>
> **Still open:** the multisigs themselves. Nothing in code now blocks it.


Today, on testnet, `0x6C9317…3a68` is simultaneously:

- `operator` of AssetRegistry, KYCRegistry and InsurancePool
- `owner` of VaultFactory
- the lender in every live loan
- the deployer

That is expedient for a testnet and unacceptable for mainnet. The powers this
key holds, combined:

| Contract | Power |
|---|---|
| AssetRegistry | whitelist assets, set tiers, set tier volatility/caps, set settlement config |
| KYCRegistry | recognise attesters, verify and revoke wallets |
| InsurancePool | set draw cap, repoint factory, withdraw reserves |
| VaultFactory | repoint all three registries, set fees, set treasury |

**Fix (free, do at deploy):** operator and owner become separate multisigs.
Nothing in the code needs to change — `transferOperator` and the ownership
transfer already exist. This is a deployment decision, not an engineering one,
which is why it is easy to leave undone.

---

## 4. `setRegistries` can repoint the protocol at anything — HIGH — **FIXED**

> Same mechanism. A planned migration tolerates the delay; an attack does not.


`VaultFactory.setRegistries(kyc, assetRegistry, insurancePool)` is `onlyOwner`
and instant. We used it today, legitimately, to migrate the KYC registry
without redeploying the factory — which is exactly why it exists and exactly
why it is dangerous. The same call points the factory at an attacker's asset
registry, which can whitelist a worthless token at Blue chip tier with a zero
deposit floor.

**Fix (cheap, do now):** timelock it, on the same mechanism as item 2. The
legitimate use case — a planned migration — tolerates a 48-hour delay without
difficulty. The malicious one does not.

---

## 5. A 60-second TWAP is manipulable, and it is one config line from
production — HIGH — **FIXED**

> `scripts/lib/production-guards.js` refuses a production deploy carrying a
> TWAP window under 1800s, a timelock under 24h, an operator equal to the
> deployer, or any asset with a yield venue set. Reports every problem at once.
> Overridable via `ALLOW_UNSAFE_PRODUCTION=1`, which prints what is waived.
> Ten tests, because the guard is the only thing between a legal default and a
> live deployment.


`setSettlementConfig` enforces `_twapWindow >= 60`. Testnet runs at exactly 60.
The intended production value is 1800.

Today, in this repository, we moved a pool's price by 80% in eight
transactions. A 60-second window on a thin pool is not an oracle, it is a
suggestion. Nothing prevents a mainnet deployment being left at the floor,
because the floor is a valid value and the deploy scripts do not object.

**Fix (cheap, do now):** have the mainnet deploy and the settlement-config
script refuse a window below 1800 unless an explicit override is passed. The
contract minimum can stay at 60 for testing; the deployment path should not
quietly accept it.

---

## 6. A recognised attester can admit anyone — HIGH (accepted) — **MITIGATED**

> `addAttester` is timelocked. Removal is not, deliberately: a delay on
> revoking a compromised provider key would make the timelock the
> vulnerability.


`KYCRegistry.verifyWithSignature` verifies only that a signature came from a
key on the attester list. It cannot verify that an identity check happened.
Curation is the entire control, and curation is one operator transaction.

This is inherent to reading third-party attestations and is the right
trade — it is what keeps identity data out of the protocol entirely. It should
be *stated* rather than fixed. The operator UI already says so.

**Mitigate:** attester changes go through the same timelock as items 2 and 4.
Adding an identity provider is not an emergency.

---

## 7. The ERC-4626 yield venue is a mock — HIGH (blocked) — **RESOLVED BY REMOVAL (19 October 2026)**

> **Update, 19 October 2026:** yield venues (Aave V3 and ERC-4626) were removed
> from the contracts before the audit freeze (audit E-1). With no real venue on
> this chain they were unused code in scope. They can return as a separate,
> separately audited change once a venue exists. Original text below.

`MockERC4626` is registered as the venue for tUSDG on testnet. Real funds must
never touch it.

Morpho's stack is deployed on Ethereum, Base, Arbitrum, Optimism, Polygon,
Scroll, Ink, World Chain and Fraxtal — not Robinhood Chain. There is no real
vault to point at yet.

**Cannot fix now.** The ERC-4626 abstraction means it becomes an address change
in the registry when one exists, not a code change. Until then: mainnet ships
with the venue set to `None` for every asset, and the deploy script should
assert that rather than trusting the operator to remember.

---

## 8. Insurance pool solvency is untested at scale — MEDIUM — **MODELLED; aggregate drain limited (18 October 2026)**

> **Aggregate limit (18 October 2026).** `InsurancePool.maxDrawShareBps`
> (default 500 = 5%) caps every draw at a share of the asset's reserve as it
> stands at that moment, on top of the per-loan `drawCapBps`. A run of claims
> can no longer empty the pool: in a 40-claim crash on a 20-unit reserve, where
> first-come-first-served paid the first 20 in full and the last 20 nothing,
> the first is paid in full, the fortieth about 13.5% of its claim, and 2.57
> remains. It slows the drain rather than equalising payouts: order still
> matters. While the reserve is large next to loan sizes it never binds; on a
> young or depleted pool it does, by design. Timelocked in both directions.
> Seven tests in `DrawShare.test.js`. Chosen over coverage-ratio scaling (fairer,
> but needs the pool to track every live loan's maximum claim, touching the
> factory and the Vault) for pre-audit simplicity. Premium calibration below
> stands.


> `scripts/model-insurance-solvency.js` compares modelled expected draw against
> premium income, reading tier parameters off the live registry.
>
> The finding inverted the expectation. **Blue chip was the only tier that could
> cost the pool anything, and carried the lowest premium.** Breach requires the
> asset to fall by deposit ÷ exposure; Blue chip permitted 100% exposure, so a
> 14.9% fall at seven days sufficed — 1.9 sigma, 2.8% likely, expected draw
> 9.01bp against 1.92bp of premium. Standard needs a 49.8% fall and Speculative
> a 99.9% one, so both are effectively unexposed.
>
> Two consequences:
>
> - Blue chip exposure reduced 100% → 70%, the cap at which premium income
>   covers modelled draw by 3x at every permitted term. Tightening the control
>   rather than repricing, per the principle the tiers were built on.
> - Speculative's premium cut 600bps → 100bps. Its 40% deposit exceeds the 25%
>   maximum possible loss, so the pool's exposure is not improbable but
>   arithmetically zero — no tail model reaches it. That is what separates it
>   from Standard, whose 4.9-sigma threshold fat tails could plausibly touch,
>   and why Standard's 250bps stands.
>
> The 3x target is a risk-appetite choice, not a derivation — it is the margin
> held against the lognormal being wrong, which the script says plainly it is.
> Aggregate reserve sizing remains unanswered: `drawCapBps` limits any single
> settlement and nothing limits the total, so correlated losses drain the pool
> first-come-first-served.


`drawCapBps` limits any single settlement to a share of that loan's principal
(currently 10%). There is no aggregate limit and no reserve-ratio target. Many
simultaneous losses drain the pool in order of arrival, and the last lender to
settle finds it empty.

The only inflows are borrower premiums and grants. Nothing models whether
premiums cover expected draws.

**Fix (needs thought, not code):** ~~a reserve-ratio floor below which draws are
scaled down rather than served first-come-first-served~~ (done as a per-draw
reserve share, above), and a premium model
calibrated against the tier volatilities already in the registry. This is
actuarial work, not engineering, and doing the engineering first would be
building the wrong thing.

---

## 9. No audit — BLOCKING

Everything above is what one reviewer found in an afternoon, knowing where the
bodies are. The protocol handles other people's money across four contracts,
a clone factory, an AMM integration and an oracle. It needs an independent
audit before mainnet, and the findings above should be fixed first so the audit
spends its time on what I have missed rather than what I already know.

---

## What can be done now

**Done:**

1. ~~Snapshot tier configuration at origination (item 1)~~ — the real bug.
2. ~~Timelock `adminWithdraw`, `setRegistries` and attester changes (items 2, 4, 6).~~
4. ~~Fix the misleading comment on `Vault.swap` (item 1).~~

**Immediately, no dependencies:**

3. Deploy-script guards: TWAP window ≥ 1800, all yield venues `None` (items 5, 7).

**At mainnet deploy, free:**

5. Operator and owner as separate multisigs (item 3).

**Blocked on the outside world:**

6. Real ERC-4626 vault — waiting on Morpho or an equivalent reaching this chain.
7. Real identity provider — a commercial conversation, not a build.
8. Audit — money and calendar time.

**Needs modelling before code:**

9. Insurance pool solvency and premium calibration (item 8).

---

# Second review — 1 October 2026

**Scope:** `contracts/` at commit `3da1f3a`, read check by check against the
Krait lending checklist while preparing the Zealynx audit-grant application.

The first review looked for what each function does wrong. This one asked a
different question of every admin setter: *what does a vault read from this
live, and what happens to an open loan if it changes in the next block?* The
two HIGH findings both fell out of that question, and both are the same class
of power that items 2 and 4 had already timelocked — reached by a route the
first review did not walk.

| # | Finding | Severity | Status |
|---|---|---|---|
| 10 | Insurance pool drainable via an instant factory repoint | HIGH | **FIXED** |
| 11 | Swap router and Uniswap factory repointable under live vaults | HIGH | **FIXED** |
| 12 | Other live-loan parameters change instantly | MEDIUM | **FIXED** |
| 13 | A mandate can be filled repeatedly | MEDIUM | **FIXED** |
| 14 | Settlement has no fallback when swap-back is impossible | MEDIUM | **FIXED** (in-kind settlement) |
| 15 | ERC20 assumptions, and timelock entries that never expire | LOW | **FIXED** (bounty note stands) |
| 16 | Sequencer downtime can consume the grace window | MEDIUM | **FIXED** (needs a heartbeat bot) |
| 17 | Swaps trust the router's minimum-output check | LOW | **FIXED** |
| 18 | `swapBack` had no price floor: borrower could drain principal (KRAIT-001) | CRITICAL | **FIXED** |
| 19 | Insurance paid unpaid interest at a lender-chosen APR (KRAIT-002) | HIGH | **FIXED** |
| 20 | Borrower can make forced swap-back revert at will (KRAIT-003) | MEDIUM | **FIXED** (residual covered by item 14) |

Items 16 and 17 surfaced while completing the Krait readiness assessment
(report: https://krait.zealynx.io/shared/mEyG-WH0MhK1), after items 10–15 were
written up.

---

## 10. The insurance pool could still be emptied instantly — HIGH — **FIXED**

> First `setVaultFactory` call stays instant, so deployment is unchanged.
> Every later change must be queued, wait out the timelock, and is bound to
> the exact factory address. Vaults registered by an earlier factory stay
> registered, so live loans keep their cover across a migration. Eleven tests
> in `test/AdminTimelocks.test.js`; ten of them fail against the old contract.

`InsurancePool.setVaultFactory` was operator-only and instant. The factory is
the only address that may register vaults, and a registered vault may call
`draw()` naming any principal it likes. So:

1. operator repoints the factory at an address it controls;
2. that address registers itself as a vault and draws against an inflated
   principal — the draw cap is a percentage of a number the caller supplies.

Two transactions, no delay, whole reserve. Item 2's withdrawal timelock was
real but could be walked around, which is worse than having no timelock: it
let this document claim a protection the contracts did not provide.

**Follow-up:** `scripts/redeploy-factory-v21.js` repointed the factory in one
step. It needs a queue → wait → execute flow before it is next used.

---

## 11. Integration addresses could be repointed under live loans — HIGH — **FIXED**

> `aavePool`, `swapRouter`, `uniswapFactory` and `weth` are now `immutable`
> and `setIntegrationAddresses()` is removed. A router migration means a new
> AssetRegistry, adopted for new loans through the factory's timelocked
> `setRegistries`; live vaults keep the registry they were originated against.
> Three tests; the two that check the setter is gone fail against the old
> contract.

`AssetRegistry.setIntegrationAddresses` was operator-only and instant, and
vaults read `swapRouter()` and `uniswapFactory()` from the registry at every
swap and at settlement:

- the vault approves the router for its full held balance and trusts the
  router to enforce `amountOutMinimum`. A substituted router could take the
  tokens and return nothing, during a settlement anyone may trigger;
- the TWAP is read from whichever factory the registry names, so a
  substituted factory could serve a price from a pool of the operator's
  choosing, against every open loan at once.

Timelocking it was the alternative. Removing it is stronger and was the
smaller change: nothing in the tests, scripts or frontend called it.

---

## 12. Other live-loan parameters change instantly — MEDIUM — **FIXED**

> **Fixed 18 October 2026.** `AssetRegistry` is now `Timelocked`, and the
> registry and `InsurancePool` gain `queueAction(id)` / `cancelAction(id)`,
> where `id` is keccak256 of the exact calldata of the setter call that will
> follow. The rule is by direction:
>
> | Setter | Waits | Instant |
> |---|---|---|
> | `setSettlementConfig` (tolerance, window, global grace, bounty) | every change | — |
> | `setMaxEntryImpactBps` | raising it, or 0 (off) | lowering it |
> | `setTierConfig` | raising a tier's exposure cap | everything else (read at origination only) |
> | `setPoolFeeTier` | changing a pair's pool | naming the first one |
> | `setVenue` | pointing at Aave or an ERC-4626 vault | setting None |
> | `InsurancePool.setDrawCapBps` | every change | — |
> | `setTier` | — | both ways: loans read the worst tier since origination |
> | `setGracePeriod` (per asset) | every change (19 October) | — |
> | re-listing a removed asset | a different grace extension, or a new non-None venue | the same terms, or a brand-new asset |
>
> The exposure cap now reads the worst tier since origination
> (`maxExposureBpsSince`), closing the Krait observation below, and the
> `setTierConfig` and `setTier` comments are corrected. With a zero delay
> (tests, testnet) the queue is skipped, since it would add nothing; the
> production guard refuses a delay under 24 hours. Sixteen tests in
> `ParameterTimelocks.test.js`, all with a real 48-hour delay. **Limit:** a
> change still reaches a loan already in its grace window once it lands; the
> timelock gives warning, not immunity.
>
> **Per-asset grace, 19 October 2026.** Timelocked in both directions, as the
> global grace already was. It cannot be snapshotted at origination, because
> which assets a vault holds is only known at expiry, so a change reaches
> every live loan holding the asset: shortening it cuts the borrower's window
> to exit at a fair price, lengthening it holds keepers and the lender's
> recovery off for longer. Building it exposed a bypass: `removeAsset` is
> instant, and re-listing overwrote the grace extension AND the yield venue
> with no delay, while vaults could still hold the asset. Re-listing on
> different terms now waits too, and listing enforces the same 14-day cap
> (`MAX_GRACE_EXTENSION`) as the setter. Six tests; five fail against
> `50ae32e`, the sixth confirms new listings stay instant.
>
> **Considered and deferred: a trading-hours rule.** Holding keepers to each
> asset's market hours (a per-asset weekly schedule plus a timelocked holiday
> list) would be more precise than a fixed extension, which does not
> guarantee a weekday: a loan due Tuesday evening ends grace early Saturday.
> It was not adopted before audit because it would not remove the need for
> this timelock (the schedule is itself a live-loan parameter); its benefit
> is small while the lender can settle at any time in grace and forced sales
> must land within the TWAP tolerance; it protects only against keepers, not
> a party settling against a thin weekend pool; and it adds a new failure
> mode (a wrong schedule blocks keepers for that asset), annual holiday
> maintenance, and scope. To revisit with data on out-of-hours pool
> behaviour. Both residual risks are listed in the README's known
> limitations.


Several operator setters still take effect immediately and are read live by
open vaults:

| Setter | What an open loan feels |
|---|---|
| `AssetRegistry.setSettlementConfig` | TWAP window (≥ 60s) and tolerance (≤ 10%) used by forced swap-back |
| `AssetRegistry.setMaxEntryImpactBps` | can be set to 0, disabling the entry-impact check |
| `AssetRegistry.setTierConfig` | `maxExposureBps` is read live by `Vault.swap` |
| `AssetRegistry.setGracePeriod` | extends or shortens grace on vaults already past deadline |
| `AssetRegistry.setVenue` | instant; a vault that has not yet supplied will use the new venue |
| `InsurancePool.setDrawCapBps` | changes cover on loans already written |

Each is bounded, and several only *tighten*. But the same principle as item 1
applies: a lender priced the loan against the parameters in force when it was
written. **The comment on `setTierConfig` says "applies to NEW loans only",
which is not true of the exposure cap** — the same kind of reassuring comment
item 1 started from.

**Fix (before freeze):** decide per setter. Risk-reducing changes stay instant;
risk-increasing ones get the timelock, or the value is snapshotted into the
vault at origination the way APR, fee terms and the tier ceiling already are.
Correct the `setTierConfig` comment either way.

---

## 13. A mandate can be filled repeatedly — MEDIUM — **FIXED**

> **Fixed 18 October 2026: both.** A mandate keeps its per-loan range
> (`minPrincipal`..`maxPrincipal`) and gains a `totalCapacity` across all
> fills, which may not be below the per-loan maximum. `fillMandate` refuses a
> fill beyond what remains ("Exceeds the mandate's remaining capacity") and
> records it; `mandateRemaining(id)` reports the rest, and
> `quoteMandateFillable` now returns the lesser of allowance, balance,
> per-loan maximum and remaining capacity. Three tests in `Mandates.test.js`.
> The interface must send `totalCapacity` when publishing.


`fillMandate` checks `principal <= maxPrincipal` per fill and never marks the
mandate used. A mandate stays live until it expires or is cancelled, so a
lender who publishes "maximum 100" can be filled for 100, then 100 again, up to
whatever their allowance and balance allow. `quoteMandateFillable` reports the
per-fill figure, which reads as a total.

The bounded approval added in the 5 August UI review (approve the mandate's
maximum, not unlimited) contains this in practice through the interface. The
contract does not, and a lender who approves directly, or for several
mandates at once, is exposed to more than they published.

**Fix (before freeze):** decide whether a mandate is a standing per-fill offer
or a capacity. If capacity, track `filled` against `maxPrincipal` and refuse
the excess. Either way, make the UI and the getter say which it is.

---

## 14. Settlement has no fallback when swap-back is impossible — MEDIUM — **FIXED** (18 October 2026)

> `Vault.settleInKind()` is a last-resort settlement, open to anyone from
> `inKindFrom()`: `IN_KIND_DELAY` (7 days) after the grace period ends,
> including any outage extension, and never during an outage's recovery
> period, so it never cuts a normal path short.
>
> *Corrected the same day, after the invariant fuzzer could not reach this
> path:* the seven days were first counted from the keeper start, which moves
> with the latest recorded outage. Without the heartbeat bot, a quiet chain
> records every silence over 30 minutes as an outage, so each attempt pushed
> the window back a week and it never opened. Counting from the grace end
> (bounded by the 72-hour extension cap) fixes it; the recovery hour can be
> cleared by anyone calling `heartbeat()`. Regression test in
> `InKindSettlement.test.js`, failing against `a114f28`.
> `settle()` stays available throughout.
>
> 1. Each held asset is sold at the TWAP floor if it can be, each attempt
>    isolated (`exitHeld`, a self-call), so one refusing asset no longer
>    blocks the rest.
> 2. Cash pays the lender first, up to principal plus accrued interest;
>    surplus cash goes to the borrower.
> 3. Each unsold asset goes to the lender up to what is still owed, valued at
>    the TWAP, the rest to the borrower. Priced assets are allocated first.
> 4. An asset with no TWAP goes wholly to the lender if anything is still
>    owed, otherwise to the borrower.
>
> Insurance is drawn only on the shortfall after counting in-kind assets at
> TWAP value, and only when every asset could be priced: an unpriceable asset
> could be worth anything, and a claim on top of it could pay twice. No keeper
> bounty and no protocol fee on this path. A token that refuses even the
> in-kind transfer (issuer freeze) is recorded in `inKindOwed` and claimed with
> `claimInKind()` once it moves; the cash goes out regardless.
>
> **Out of scope:** an ERC-4626 venue that cannot redeem still reverts this
> path. Mainnet ships with every venue `None`, enforced by the production
> guard.
>
> **Contract size:** Vault went over the 24,576-byte limit. The exit floor was
> consolidated into one helper and `quoteSwapOut` (a read-only view) moved to a
> new `VaultLens` contract. Vault is now 23,965 bytes; the interface must call
> `VaultLens.quoteSwapOut(vault, …)`.
>
> Eleven tests in `InKindSettlement.test.js`.


`settle()` reverts in full if any step of the forced exit fails:

- a held asset cannot be swapped back within `twapToleranceBps` of the TWAP
  (thin or moved pool, divergence);
- a held token refuses the transfer — **a tokenised equity whose issuer can
  pause or freeze it**, which is exactly the asset class this chain is for;
- the ERC-4626 venue cannot redeem in full.

Each is a liveness failure rather than a theft, but the principal is locked
for as long as it lasts, and nothing bounds that. Grace periods give the
parties time; they do not give an exit.

**Fix (design first):** a last-resort path after an extended window — e.g.
distribute an unswappable held asset *in kind* to the lender, up to what they
are owed, and the remainder to the borrower — so the worst case is "lender
receives the asset" rather than "nobody receives anything".

---

## 15. Minor — LOW — **FIXED** (18 October 2026, except the bounty note)

> - **Return values:** every token call in Vault, VaultFactory and
>   InsurancePool now goes through `libraries/SafeTransfer.sol`, which accepts
>   `true` or no data and still fails on `false`, a revert, or an address with
>   no code. Approvals reset to zero and retry if a token refuses a direct
>   change. A full loan now runs end to end in a USDT-style token.
> - **Fee-on-transfer and rebasing tokens** are excluded by a listing rule,
>   stated in `AssetRegistry`'s header and the README, rather than handled.
> - **Expiry:** `Timelocked` adds a 14-day `EXECUTION_WINDOW`. A matured action
>   must execute within it ("Timelock approval expired" otherwise) and may then
>   be queued afresh, waiting the full delay again. `executionDeadline(id)`
>   publishes the cut-off.
>
> Nine tests in `TokenSafety.test.js`; the USDT-style loan and the expiry cases
> fail against `3a7a784`.


- **ERC20 return values.** Transfers and approvals assume `bool` returns
  (`require(IERC20(..).transfer(..))`); no `SafeERC20`. Tokens that return
  nothing (USDT on Ethereum mainnet) would revert. Fee-on-transfer tokens
  would break payout accounting. Acceptable while the whitelist is curated,
  but it should be either enforced at listing or handled in code, and stated.
- **Queued actions never expire.** A timelocked action queued once can be
  executed at any later time. An approval granted for a migration months ago
  should not still be live. Add an execution window (e.g. delay + 14 days).
- **Keeper bounty is zero on underwater vaults.** The bounty is paid from the
  borrower's residual, so a vault in loss pays no keeper. The lender is
  motivated to settle in that case (it triggers the insurance draw), so this is
  noted rather than fixed.

---

## 16. Sequencer downtime can consume the grace window — MEDIUM — **FIXED**

> **Fixed 18 October 2026.** `AssetRegistry` keeps a heartbeat that anyone may
> call. A gap between heartbeats longer than `outageGapThreshold` (30 minutes)
> is recorded as an outage. `Vault.settle()` calls `heartbeat()` first, so the
> first transaction after a restart records the outage before any window is
> read, then asks `settlementWindow()` for:
>
> - **the grace end, extended** by the outage time that fell after the deadline
>   and within the window, capped at `maxGraceExtension` (72 hours). The
>   parties get back exactly the time they lost;
> - **the earliest keeper settlement**: the later of that and the end of the
>   last outage plus `recoveryPeriod` (1 hour, which may not be shorter than
>   the TWAP window, since the TWAP is frozen through an outage). The keeper
>   bounty accrues only from here. The lender and borrower are never held by
>   the recovery period.
>
> Values chosen against recorded L2 outages (Base: 33 minutes in Aug 2025,
> about 2 hours in Jun 2026; Arbitrum One: almost 3 hours in Dec 2023).
> Configuration is timelocked in every direction; zero disables detection and
> the production guard refuses that. Eleven tests in `OutageGrace.test.js`;
> the three that matter fail against `a9b954b`.
>
> **Operational dependency:** an off-chain bot must call `heartbeat()` every
> 5 minutes. Without it, any 30 minutes with no transaction reads as an
> outage, even when the sequencer was fine. If it stops, quiet periods read as outages: the parties gain time
> and keepers wait (bounded by the cap). A keeper held off by the recovery
> period must call `heartbeat()` itself and wait, because a reverted
> `settle()` also reverts the outage record. No sequencer uptime feed is
> assumed to exist on Robinhood Chain.
>
> **Bot built (18 October 2026):** `scripts/heartbeat-bot.js` under pm2
> (`ecosystem.config.js`), with its own gas-only key and Telegram alerts on
> start, stop, recorded outage, 3 consecutive failures, recovery and low
> balance. It measures the gap by wall-clock time, not the latest block's,
> because an idle Arbitrum-style chain makes no blocks. Mainnet needs an
> always-on host.


Robinhood Chain is an Arbitrum Orbit L2 with a single sequencer. While it is
down, no transactions are included but wall-clock time keeps passing, and
`block.timestamp` jumps forward when it resumes.

Settlement access is entirely time-based (`Vault.settle`): borrower-only before
the deadline, lender or borrower during grace, anyone with a bounty after.
If an outage spans a vault's deadline and grace window:

- the borrower loses the chance to close early or unwind positions themselves;
- the lender loses the grace period meant for them to settle at a price of
  their choosing;
- on restart, keepers may settle immediately and the bounty has already
  accrued for the whole outage;
- the TWAP window may straddle the outage, so the price bounding the forced
  swap-back reflects a market nobody could trade in.

This is not theft, but it removes protections the design promises at exactly
the moment they matter, and a long weekend outage on a 24/5 asset compounds it.

**Fix (before freeze):** detect a gap in block production and extend grace
accordingly — e.g. track the last observed timestamp per vault interaction, or
read the chain's sequencer-uptime feed if one exists on Robinhood Chain, and
refuse keeper settlement until a minimum period has elapsed since restart.
Accrue the bounty from that point, not from the original grace end.

---

## 17. Swaps trust the router's minimum-output check — LOW — **FIXED**

> **Fixed 18 October 2026.** `_executeSwap` measures the output token's
> balance before and after, requires the delta to meet the minimum
> ("Received less than minimum"), and returns the measured figure. Every later
> check and the new held-amount record use it. Tests: `KraitFindings.test.js`,
> "Item 17".


`Vault._executeSwap` and `_forcedSwapBackAll` pass `amountOutMinimum` to the
router and rely on the router to enforce it. The vault never checks its own
balance change, and uses the router's return value only for events and the
entry-impact check.

Since item 11 made the router immutable this is not exploitable by the
operator, and SwapRouter02 is audited and widely used. But it puts the vault's
only slippage protection in someone else's code, and costs little to verify.

**Fix (before freeze):** measure `balanceOf(tokenOut)` before and after each
swap, require the delta to meet the minimum, and use the measured delta rather
than the returned value for the entry-impact and exposure checks.

---

# Krait audit pass — 1 October 2026

**Tool:** Krait (Zealynx Security), full `/krait` pipeline in Claude Code, at
commit `aee7316`, with items 1–15 above supplied as known issues.

This is the section that matters most in this document, and it should be read
as a correction to everything before it. Two reviews by the person who wrote
the code — and a 37-check readiness assessment answered by the same person —
missed a CRITICAL and a HIGH that an independent pass found in one evening,
both with executed proofs of concept. Item 10 found a side door around a
timelock; item 18 is a side door around the custody model itself. The pattern
is the same: each protection was correct on the path it was written for, and
nobody walked the parallel path.

## 18. `swapBack` had no price floor: a borrower could drain principal — CRITICAL — **FIXED**

> `swapBack` now enforces the same floor as the forced swap-back at
> settlement: output >= TWAP x (1 - twapToleranceBps). The borrower may set a
> higher minimum, never a lower one. Four regression tests in
> `test/KraitFindings.test.js`; the two attack tests fail against the old
> contract.

Entry into a foreign asset was bounded (`_enforceEntryImpact`), and the forced
exit at settlement was bounded (TWAP tolerance). The **voluntary** exit,
`swapBack`, was bounded only by the borrower's own `minAmountOut`, which had
to be greater than zero and nothing more. The deposit invariant checks only
outflows of the loan asset, and a swap-back is an inflow, so nothing in the
vault looked at the price.

A borrower could move the principal into a held asset at a fair price, move
the pool's spot price (or route through a pool where they are the only
liquidity), and sell back at any price they liked. The difference left the
vault and reached them. In Krait's proof of concept the lender was owed 10.02
and received 4.58.

This broke the protocol's central claim: that the borrower operates the vault
but cannot move value out of it.

## 19. Insurance paid unpaid interest at a lender-chosen APR — HIGH — **FIXED**

> The pool now covers a shortfall against **principal only**. Interest is never
> insured. Two regression tests; one `GroupB` test updated, since it asserted
> the old behaviour (pool paid 0.8 including interest; now pays 0.5, the
> principal shortfall).

`_distribute` drew on the pool whenever the vault returned less than
`principal + accruedFee()`. The fee is computed from `aprBps`, which the lender
sets and which had no upper bound; and nothing stopped the lender and the
borrower being the same wallet (lenders need no KYC). So one KYC'd wallet
could lend to itself for 60 seconds at an absurd APR, settle, and draw
`drawCapBps` of principal from the shared reserve on every cycle. No market
loss involved. Krait's proof of concept drained 5 WETH in five cycles.

This is distinct from item 8 (aggregate limits under honest correlated loss):
here the claim was manufactured.

**Product consequence, stated plainly:** lenders' interest is no longer
protected by the pool. The deposit absorbs loss first and still covers
interest where it is large enough; the pool then restores principal, up to
the cap. Public materials must say "principal", not "made whole".

## 20. Borrower can make forced swap-back revert at will — MEDIUM — **FIXED**

> **Fixed 18 October 2026**, going further than Krait's recommendation.
> Pinning the first fee tier a vault used would not have been enough: the
> borrower could make their own thin pool the first. So:
>
> - **The protocol names the pool.** `AssetRegistry.setPoolFeeTier` approves
>   one fee tier per pair; `Vault.swap` refuses any other ("Swap must use the
>   approved pool"). An open position keeps the tier it was bought at, so a
>   registry change affects new positions only. The setter is instant for now
>   and moves under the timelock with item 12.
> - **The vault records what it bought** (`heldAmount`, from measured balance
>   changes, item 17). Swap-back and settlement sell that amount and no more,
>   so tokens sent in directly can no longer push an exit past the pool's
>   depth. They stay in the vault.
> - **The whole position must be sellable at entry.** After every purchase the
>   vault performs the full exit it would face at settlement and reverts it
>   (the Uniswap Quoter technique), refusing the purchase if the result misses
>   the settlement floor ("Position too large to exit within tolerance").
>
> Ten regression tests in `KraitFindings.test.js`; all ten fail against
> `27a30d7`. **Residual:** liquidity withdrawn after entry, for example by a
> borrower who is also the approved pool's main provider, can still leave a
> position unsellable. That is item 14's job. Deployment scripts must now call
> `setPoolFeeTier` for every tradeable pair.


`_trackHeldAsset` overwrites an asset's fee tier with the tier of the **most
recent** swap into it, however small, and `_forcedSwapBackAll` sells the whole
balance through that one tier in a single call. A borrower can build a large
position through a deep pool, then make a dust swap through a thin pool
(possibly their own) at another tier. At settlement the whole position is
pushed into the thin pool, misses the TWAP floor, and `settle()` reverts for
everyone. After the deadline the borrower cannot `swapBack` either, so the
tier cannot be changed back. The borrower holds a free option on a
non-liquidating position; the lender's principal is locked.

Related to item 14, but deliberate rather than circumstantial.

**Fix (before freeze):** pin the fee tier when an asset first becomes held and
refuse later swaps into it at a different tier; check entry impact against the
full post-swap balance in the exit direction, not just the increment.

## Krait observations (not findings, but on the list)

- ~~**Attester timelock can be walked around.**~~ — **fixed 18 October 2026**
  in the KYC adapter redesign: `rotateAttester` must be announced and wait,
  and the manual `verify()` is timelocked, lasts 30 days, is once per wallet
  per year, carries a case reference, is marked manual, and is limited to five
  in any 30 days. `KYCRegistry.test.js`. Original note:
  `KYCRegistry.rotateAttester`
  adds the new key instantly, and `verify()` admits any wallet instantly. The
  README says adding an attester is timelocked; against the operator it
  currently protects nothing. Same pattern as item 10. Fold into the KYC
  adapter redesign.
- ~~**Self-referral.**~~ — **fixed 18 October 2026.** Only integrators the
  owner approves (`setReferrerApproved`) earn the referrer share, and never on
  a loan where they are also the lender or borrower; anyone else named is
  ignored and the whole fee goes to the treasury. Mandate fills still carry no
  referrer. Four tests in `GroupH.test.js`.
- ~~**The exposure cap reads the asset's current tier**~~ — **fixed with item 12**:
  the cap now uses the worst tier since origination.
- ~~**Stale NatSpec on `setTier`**~~ — **fixed with item 12**.

---

## Second review — what is left before freeze

**Done (1 October 2026):** items 10, 11, 18 and 19. 256 tests passing.

**Done (18 October 2026):** items 12 (except per-asset grace), 13, 15, 16, 17 and 20, the KYC adapter redesign, and four Krait observations. 335 tests passing.

**Done (18 October 2026, later):** item 14 (in-kind settlement) and item 8's
aggregate limit (per-draw reserve share). 353 tests passing.

**Done (18 October 2026, later still):** deployment scripts (approved pool per
pair, announce-then-execute for timelocked calls via `scripts/lib/timelock.js`
and `execute-timelocked.js`, `VaultLens` in the factory redeploy) and the
heartbeat bot (item 16).

**Done (18 October 2026, evening):** outdated scripts retired to
`scripts/legacy/`; Foundry invariant suite (`test-foundry/`, nine invariants,
checked against deliberately broken contracts), which found and fixed the
in-kind window bug above. 354 Hardhat tests passing.

**Done (19 October 2026):** per-asset grace timelocked both ways, and the re-listing bypass closed (item 12). 360 Hardhat tests passing.

**Done (19 October 2026, pre-freeze audit pass):** M-1, M-2, L-1, L-2, L-4,
L-5, L-6, L-7 and the missing event fixed; yield venues and unused views
removed; `scripts/legacy/` deleted; `package.json` trimmed. I-3 fixed. M-3, L-3
and the three remaining informational items accepted and documented. See
*Pre-freeze audit pass* below. 355 Hardhat tests (21 suites) and 10 Foundry
tests passing.

**Done (25 October 2026, Krait re-run on 089ce71):** KRAIT-004 (High) and KRAIT-005 (Low) fixed; see items 26 and 27. 361 Hardhat tests (22 suites) and 10 Foundry tests passing.

**Before freeze:** nothing outstanding in the code. All four Krait observations are closed.
Item 8's premium calibration remains modelling work.

The KYC adapter work is
**done (18 October 2026)**: `IIdentityAdapter`, expiring claim-bearing EIP-712
attestations checked at origination, lender screening, and the manual-grant
safeguards. See `KYCRegistry.sol` and `IdentityAdapter.test.js`.

---

# Pre-freeze audit pass — 19 October 2026

A final self-audit before freezing the commit: every contract re-read against
the Cyfrin/Solodit checklist (370 items), Zealynx's Uniswap integration
checklist, and the classes of bug that automated LLM auditors have found in
production contracts. Each finding was confirmed with a failing proof of
concept before it was fixed, and each fix has a regression test.

| ID | Finding | Severity | Status | Tests |
|---|---|---|---|---|
| M-1 | One recipient the token refuses blocks the whole settlement | Medium | **Fixed** | `Payouts.test.js`, invariant `settlementConserves` |
| M-2 | In-kind split and insurance draw follow a TWAP the caller can move | Medium | **Fixed** | `InKindSettlement.test.js` |
| M-3 | Forced swap-back can be sandwiched within the TWAP tolerance | Medium | **Accepted, documented** | — |
| L-1 | A wallet can lend to itself | Low | **Fixed** | `KraitFindings.test.js` |
| L-2 | Settlement config had no upper limits and could break the window/recovery rule | Low | **Fixed** | `ParameterTimelocks.test.js` |
| L-3 | `settleInKind` charges no protocol fee, so a borrower holding dust could choose it | Low | **Closed by KRAIT-005 (25 October)** | `InKindSettlement.test.js` |
| L-4 | `settlementWindow` cost grows with every outage recorded | Low | **Fixed** | `OutageGrace.test.js` |
| L-5 | Zero-value payouts were still sent; tokens that reject them would block total-loss settlements | Low | **Fixed** | `Payouts.test.js` |
| L-6 | A mandate fill had no borrower-side APR limit | Low | **Fixed** | `Mandates.test.js` |
| L-7 | TWAP quote truncates amounts above `uint128` | Low | **Fixed** | `TwapGuard.test.js` |
| I-1 | `setMaxEntryImpactBps` emitted no event | Info | **Fixed** | `ParameterTimelocks.test.js` |
| I-2 | Interest stops at the deadline though capital stays locked through grace and the in-kind window | Info | **Documented** | — |
| I-3 | `lossSeverity` misreports in-kind closes | Info | **Fixed** | `InKindSettlement.test.js` |
| I-4 | Tokens sent to a vault outside its holdings cannot be recovered | Info | **Documented** | — |
| I-5 | No pause function | Info | **Documented** | — |
| — | Out-of-gas failures inside `try` could be read as a refused payout or an unsellable asset | Hardening | **Fixed** | — |
| E-1 | Yield venues unused on this chain | Efficiency | **Removed** | `AssetGrace.test.js` replaces `YieldVenue.test.js` |
| E-3 | Views nothing reads (KYC status helpers, venue getters) | Efficiency | **Removed** | — |
| E-5 | `scripts/legacy/` | Efficiency | **Deleted** | — |
| E-6 | `package.json` listed hardhat's own dependencies at top level | Efficiency | **Trimmed** | fresh install, all tests passing |

In-scope size after this pass: **2,107 nSLOC** (2,018 written for Covenza plus
89 vendored), down from 2,311.

## 21. M-1 — one refused payout blocked the whole settlement — MEDIUM — **FIXED**

Settlement pushed every payout (lender, keeper, treasury, referrer, borrower)
in one transaction. Regulated stablecoins can blacklist addresses. If any
recipient was blacklisted, every `settle()` reverted for ever: a borrower on a
sanctions list locked the lender's principal in the vault permanently, and a
blacklisted treasury blocked every settlement that paid a protocol fee.

**Fix:** every payout goes through `Vault._pay`. It transfers if it can; if the
token refuses, it records the amount in `owed(token, recipient)` and emits
`PaymentDeferred`. Everyone else is paid as normal. The recipient calls
`claim(token)` once the token lets them receive. `cancel()` uses the same path.
The invariant `settlementConserves` now allows a vault to hold exactly the
amounts owed to recipients and nothing more.

## 22. M-2 — the in-kind split followed a movable TWAP — MEDIUM — **FIXED**

`settleInKind()` values unsold assets at the TWAP and, before this fix, could
draw insurance on the shortfall. It is only reachable when the pool cannot
absorb the sale, which is exactly when its TWAP is cheapest to move. In the
proof of concept (8 units held, 6.02 owed to the lender) the split was 6.02 /
1.98 at a fair price, 4.02 / 3.98 with the TWAP pushed up, and 8 / 0 plus a
1.0 insurance draw with it pushed down.

**Fix:** `settleInKind()` never draws insurance, and for the first
`IN_KIND_LENDER_PERIOD` (7 days) only the lender may call it. The lender is
the party owed and already receives the cash first; anyone may call it after
that, so a lender who walks away cannot strand the borrower's share.

## 23. M-3 — sandwiching within the tolerance — MEDIUM — **ACCEPTED**

A forced swap-back must land within the settlement tolerance of the TWAP. A
searcher can sandwich it and take up to that tolerance from the sale. The loss
falls on the borrower's residual first, and reaches the lender only in a loss.
This is the price of having no oracle, and it is bounded: the tolerance is a
timelocked parameter and should be kept tight on mainnet. Recorded under known
limitations.

## 24. L-1 to L-7 and the missing event — **FIXED or ACCEPTED**

- **L-1:** `lender == borrower` is now refused at origination. A wallet
  lending to itself has no legitimate purpose and is the first step of every
  self-dealing route against the shared insurance pool. Separate wallets can
  still collude; this removes the trivial case.
- **L-2:** `setSettlementConfig` now has upper limits (TWAP window at most
  1 day, grace at most 7 days, bounty rate at most 100% per hour) and enforces
  from its side the rule `setOutageConfig` already enforced: the TWAP window
  may not exceed the outage recovery period. Before, widening the window here
  quietly broke that rule, and an unbounded window longer than any pool's
  history would make every quote revert.
- **L-3 (accepted; closed 25 October by KRAIT-005, item 27):** `settleInKind()` charges no protocol fee, so a patient
  borrower holding 1 wei of a dust asset could choose it to avoid the fee.
  M-2's fix closes most of that route: the borrower cannot call it until
  7 days after grace plus the 7-day lender-only period, and the lender can
  settle normally (fee included) throughout. The fee forgone is small next to
  two weeks of waiting, so charging a fee on surplus cash was not added.
- **L-4:** outages are searched with a binary search instead of walked one by
  one, so settling a vault costs the same however many outages were recorded
  after its window (previously about 0.93M gas at 300 outages and 1.73M at
  600).
- **L-5:** `_pay` skips zero amounts, so a token that reverts on a
  zero-value transfer cannot block a total-loss settlement (lender payout 0),
  or any settlement with no referrer or no keeper bounty.
- **L-6:** `fillMandate` takes a `maxAprBps` from the borrower and refuses a
  fill priced above it, so a fill can never cost more than the borrower
  accepted when they sent it.
- **L-7:** `UniswapTwap.quote` refuses amounts above `type(uint128).max`
  instead of truncating them.
- **Event (I-1):** `setMaxEntryImpactBps` emits `MaxEntryImpactUpdated`.
- **Additional hardening:** a `try` that fails because it ran out of gas now
  reverts the whole transaction (`gasleft() <= gasBefore / 63`), in both the
  in-kind sale loop and `trySafeTransfer`. M-1's fix made payouts
  non-reverting, and without this a caller could send just enough gas for a
  payout or sale to fail on purpose and have it treated as refused or
  unsellable.

## 25. Informational items I-2 to I-5 — **I-3 FIXED; the rest DOCUMENTED**

- **I-2: interest stops at the deadline.** A lender's capital can stay in the
  vault through grace and, in the worst case, the in-kind window, without
  earning.
- **I-3: `lossSeverity` misreported in-kind closes — FIXED.** It compared
  the cash the lender received with what they were owed, so an in-kind close
  where the lender was made whole in assets read as a lender loss (2). It now
  returns 3 for any in-kind close: the outcome depends on assets the vault
  could not sell, so it cannot be measured in the loan asset. What each side
  received is in the `InKindAllocated` events.
- **I-4: stray tokens are stuck.** Tokens sent to a vault that are not part
  of its holdings record cannot be recovered. There is deliberately no sweep
  function: any path to an arbitrary address is a path out of the vault.
- **I-5: no pause.** The brakes are `removeAsset` (no new loans in that
  asset), the identity requirements (no new borrowers) and the timelocks. Live
  loans cannot be frozen by anyone, which is intended: a pause would be one
  key holding every borrower's exit.

---

# Krait re-run — 25 October 2026

Krait's full pipeline (recon, three detection passes, rescan, per-contract,
state analysis, verification) re-run on `089ce71`, with items 1–25 treated as
known. Two new findings, both reproduced by executed proofs of concept; the
High against **real Uniswap V3** (the v3-core factory and pool and
SwapRouter02), because it lives in how a real pool stores price history. The
full report is in `.audit/krait-report-2026-10-25.md`.

## 26. KRAIT-004 — the TWAP could be starved: a lender could block every exit and take the position in kind — HIGH — **FIXED**

Every price the vault uses comes from `pool.observe([twapWindow, 0])`. A
Uniswap V3 pool keeps its history in a ring of `observationCardinality` slots
and writes at most one observation a second, on any mint or burn of in-range
liquidity and any swap that moves the tick. If every slot holds an
observation younger than the window, `observe` reverts "OLD". Anyone could
cause that with dust liquidity mints, which leave the price untouched.

While starved, `swapBack`, early close, `settle()` and keeper settlement all
reverted, and `settleInKind()` found the held asset "unpriceable", which gives
all of it to the lender. The lender alone may call `settleInKind()` for its
first week. So a lender could block every exit from just before the deadline,
then take the borrower's whole position. In the PoC (10 WETH loan, 64-slot
pool, the 1,800-second window) the lender over-collected 1.45 WETH: the
borrower's entire deposit. Any gains on the position would have gone too.
Cost: about 64 dust mints per 30 minutes for the ~8.5 days to in-kind, or
only 64 if a loan reached in-kind anyway. Our own testnet pools use 64 slots,
and `TwapGuard.test.js` notes a real Robinhood mainnet pool with 1.

**Fix:** a pool may be approved (`AssetRegistry.setPoolFeeTier`), and a
position opened in it (`Vault.swap`, via `UniswapTwap.cannotBeStarved`), only
if its ring has more slots than the window has seconds. At one observation a
second, such a ring always holds one at least a window old, so it cannot be
starved. `VaultLens` reports such a pool as not quotable. Tests:
`OracleStarvation.test.js` (real Uniswap V3) and `TwapGuard.test.js`.

**Operator procedure:** grow every pool's ring past the window before
approving it (`scripts/lib/pool-history.js` checks this and says how).
Never raise `twapWindow` above an approved pool's ring: positions already open
in that pool would become starvable again. Production needs more than 1,800
slots per pool; testnet's 64 slots are enough only for its 60-second window.

## 27. KRAIT-005 — `settleInKind()` could stand in for `settle()` and skip the insurance draw — LOW — **FIXED**

`settleInKind()` sells every held asset it can first. If every sale
succeeded, it still finished as a cash settlement, but without the insurance
draw, bounty or protocol fee that `settle()` would apply. After the
lender-only week, anyone could pick it for a losing loan and cancel the
lender's draw (PoC: lender 8.23 instead of 9.23 WETH). A losing loan has no
keeper incentive, so a passive lender's loan could still be open by then.

**Fix:** `settleInKind()` refuses with "Everything sold - use settle()" when
nothing is left to hand over. That also closes L-3's dust route completely.
Test: `InKindSettlement.test.js`.

In-scope size after this pass: **2,129 nSLOC** (2,040 written for Covenza plus
89 vendored).

