# Mainnet readiness review

**Date:** 2 August 2026
**Scope:** `contracts/` as deployed to Robinhood Chain testnet (chain 46630)
**Status:** not ready for real money. Nothing here is unfixable; two items are
structural and the rest are a week of work plus an audit.

**Progress:** items 1, 2, 4, 5 and 6 are addressed in code, and 3 is now
partially enforced by a deploy guard. Items 7 and 8 are blocked; 9 is an audit.
Fixes are marked inline.

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

## 3. Everything is one key — CRITICAL — **PARTIALLY GUARDED**

> The deploy guard refuses production when the operator is the deploying EOA.
> That catches the laziest version. It cannot check that the operator is a
> multisig rather than another EOA, so this remains a deployment discipline
> question rather than something code can settle.


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

## 7. The ERC-4626 yield venue is a mock — HIGH (blocked)

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

## 8. Insurance pool solvency is untested at scale — MEDIUM — **MODELLED, one fix applied**

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
> - **Speculative's 600bps premium buys insurance that cannot pay out** — its
>   40% deposit exceeds the 25% maximum possible loss. Not a solvency problem;
>   a fairness one, and still open.
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

**Fix (needs thought, not code):** a reserve-ratio floor below which draws are
scaled down rather than served first-come-first-served, and a premium model
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
