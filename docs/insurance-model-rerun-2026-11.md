# Insurance model rerun — November 2026

Rerun of `scripts/model-insurance-solvency.js` after the fixes for audit
findings **M-06** (term-only pricing of post-maturity cover) and **M-07**
(multiple holdings beyond the single-exposure model). Contracts at
`c042518`; this document and the model change no contract code.

*Updated in the M-07 fix review (November 2026):* Zealynx noted that the
earlier wording claimed the model evaluated "every portfolio the exposure
budget allows", when it tested one holding at its cap and two-holding splits of
50/50 and 75/25 only. The claims below are narrowed to the portfolios actually
tested, and a wider **portfolio coverage check** has been added (see that
section). The main tables and every figure in them are unchanged.

**Result.** With the chosen launch settings (below), premium income covers the
modelled expected insurance draw by at least **10.9×** at every permitted term,
every tier and every portfolio tested (below), against a target of
3×. It stays above break-even (≥ 1.1×) under a fat-tail stress and under the
full 72-hour outage extension. The one change from the launch settings
previously quoted is **Blue chip's premium, raised from 100 to 250 bps a year**.

## What changed in the model

| | At the audit freeze | This rerun |
|---|---|---|
| Risk horizon | The loan term | **Term + the 5-day insured window** (M-06), matching the deposit floor and premium, which are both priced on that horizon. A separate stress adds the full **72-hour outage extension**, which is insured but not priced. |
| Terms evaluated | 1 day and up | **60 seconds, 1 hour**, 1 day, 7, 30, 90 and 365 days, each up to the tier's maximum term |
| Holdings | One asset at the tier cap | **Main tables:** one holding at its cap, and the budget split 50/50 or 75/25 across two holdings of any tier the vault may hold (including two assets of one tier), at return correlations of **0.4, 0.8 and 1.0**; the worst case is reported. **Portfolio coverage check:** up to three holdings, budget shares in 10% steps, correlations 0 to 1 (see below). |
| Tails | Lognormal only | Lognormal baseline, plus a **multivariate Student-t (4 degrees of freedom)** stress scaled to the same volatility |
| Method | Closed-form approximation | **Monte Carlo**, 200,000 paths, **fixed seed**: a rerun reproduces every figure |
| Inputs | Read from a live registry | Tier settings stated in the script, so it runs without a chain |

For each case:

> expected draw = E[ min( max(loss − deposit, 0), draw cap ) ], as a fraction of principal
> loss = Σ over holdings of value × fall
> cover = premium ÷ expected draw

Deposit floor = max(tier minimum, coefficient × volatility × √((term + window) ÷ year)).
Premium = tier rate × (term + window) ÷ year. Draw cap 10% of principal.

## Settings tested

| | Blue chip | Standard | Speculative | Coefficient |
|---|---|---|---|---|
| **A. Launch shape** (as quoted in the findings) | cap 70%, ≤ 30 d, 100 bps | cap 50%, ≤ 7 d, 250 bps | cap 25%, ≤ 1 d, 100 bps | 1.8 |
| **B. Contract defaults** (AssetRegistry constructor) | cap 100%, ≤ 365 d, 100 bps | cap 50%, ≤ 90 d, 250 bps | cap 25%, ≤ 7 d, 600 bps | 1.8 |
| **C. All caps 100%** (an alternative under consideration) | cap 100%, ≤ 30 d, 100 bps | cap 100%, ≤ 7 d, 250 bps | cap 100%, ≤ 1 d, 100 bps | 2.6 |
| **D. Chosen** | cap 70%, ≤ 30 d, **250 bps** | cap 50%, ≤ 7 d, 250 bps | cap 25%, ≤ 1 d, 100 bps | 1.8 |

Assumed volatilities in every case: 60% / 100% / 200%. Minimum deposits:
10% / 20% / 40%.

## Results

Lowest cover across every permitted term and every portfolio in the main tables:

| Settings | Tier | Baseline | Fat tails (t4) | +72 h outage | Meets 3× baseline |
|---|---|---|---|---|---|
| A | Blue chip | 4.4× | 0.5× | 0.6× | Yes |
| A | Standard | 7,395× | 6.0× | 291× | Yes |
| A | Speculative | no draw | 85× | no draw | Yes |
| B | Blue chip | **0.2×** | 0.1× | 0.1× | **No** |
| B | Standard | 63× | 1.5× | 3.5× | Yes |
| B | Speculative | no draw | 66× | no draw | Yes |
| C | Blue chip | 3.5× | 0.4× | 0.4× | Yes |
| C | Standard | 13× | 0.9× | 1.2× | Yes |
| C | Speculative | 134× | 0.8× | 3.6× | Yes |
| **D** | **Blue chip** | **10.9×** | **1.1×** | **1.4×** | **Yes** |
| **D** | **Standard** | **7,395×** | **6.0×** | **291×** | **Yes** |
| **D** | **Speculative** | **no draw** | **85×** | **no draw** | **Yes** |

Chosen settings (D), Blue chip in detail — the binding tier:

| Term | Deposit | Premium | Baseline E[draw] / cover | Fat tails | +72 h outage |
|---|---|---|---|---|---|
| 60 s | 12.6% | 3.43 bp | 0.31 bp / 10.9× | 3.00 bp / 1.1× | 2.48 bp / 1.4× |
| 1 h | 12.7% | 3.45 bp | 0.31 bp / 11.0× | 3.00 bp / 1.1× | 2.45 bp / 1.4× |
| 1 d | 13.8% | 4.11 bp | 0.31 bp / 13.3× | 3.07 bp / 1.3× | 1.96 bp / 2.1× |
| 7 d | 19.6% | 8.22 bp | 0.24 bp / 34.2× | 3.13 bp / 2.6× | 0.80 bp / 10.3× |
| 30 d | 33.4% | 23.97 bp | 0.05 bp / 516× | 2.28 bp / 10.5× | 0.09 bp / 254× |

In every tier the worst portfolio in the main tables is a **single holding at
its cap**, including at correlation 1.0. The portfolio coverage check below
tests a wider grid and finds the same.

## Portfolio coverage check (added in the M-07 fix review)

**Question.** Within the exposure budget, does any mix of holdings have a
larger expected insurance draw than the worst single holding at its cap?

**Grid tested**, for every settings case (A–D), every vault tier and every
permitted term, under all three stresses (baseline, fat tails, +72 h outage):

- one, two or three holdings, each of any tier the vault may hold, including
  two or three different assets of the same tier;
- the budget split in **10% steps** across them (for example 90/10, 60/30/10);
- every pair of holdings at the same return correlation: **0, 0.2, 0.4, 0.6,
  0.8 and 1.0**;
- 50,000 paths per case, seeded. A mix that looks worse than the single holding
  on that sample is re-measured on an independent **400,000-path** sample
  against the single holding on the same sample, so rare-tail sampling noise is
  not reported as an excess.

That is 270 portfolio-correlation cases per term for a Blue chip vault, 1,026
for Standard and 2,484 for Speculative.

**Result: in every settings case, vault tier, term and stress, no tested mix
draws more than 1% above the worst single holding at its cap.**

| Settings | Vault | Worst mix ÷ worst single — baseline | Fat tails | +72 h outage |
|---|---|---|---|---|
| A | Blue chip / Standard / Speculative | 1.000 / no draw / no draw | 1.000 / 1.000 / 1.000 | 1.000 / 1.000 / no draw |
| B | Blue chip / Standard / Speculative | 1.000 / 1.000 / no draw | 1.000 / 1.007 / 1.000 | 1.000 / 1.000 / no draw |
| C | Blue chip / Standard / Speculative | 1.000 / 1.000 / 0.689 | 1.000 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 |
| **D** | **Blue chip / Standard / Speculative** | **1.000 / no draw / no draw** | **1.000 / 1.000 / 1.000** | **1.000 / 1.000 / no draw** |

A ratio of 1.000 means the worst mix is, in effect, the single holding: for
example 90% + 10% of two assets of one tier at correlation 1.0. "No draw" means
neither the single holding nor any mix draws on that stress. Six cases across
the four settings looked worse on the 50,000-path sample; all were within 1% of
the single holding when re-measured.

**One exact property, which is why partly used budgets are not enumerated.**
On every path the payout, min(max(loss − deposit, 0), draw cap), does not
decrease when all holdings are scaled up together: it is zero wherever the
scaled loss is negative, and non-decreasing in the loss elsewhere. So a mix
that uses only part of the budget can never have a larger expected draw than
the same mix scaled to the full budget, and the full-budget grid covers it.

**What this does not claim.** It is a sampled check over the stated grid, not a
proof for every portfolio. Four or more holdings, budget shares between the
10% steps, unequal pairwise correlations and return distributions other than
the two stated are not tested, and every asset is assumed to have exactly its
tier's volatility. We do not offer a general bound: a safer asset at a higher
cap can lose a larger share of principal in an extreme fall (a 70% Blue chip
holding against a 50% Standard one), so a strict bound would need conditions
on the tail of the return distribution that this model does not establish.

## Reading the results

1. **The fixes close both gaps.** Short loans are now priced and deposited on
   the horizon they are insured for, and no tested portfolio carries more risk
   than the single capped holding the tiers were sized on (portfolio coverage
   check above).
2. **Blue chip was the tier to adjust.** Its short loans clear 3× on the
   baseline at 100 bps (4.4×), but under fat tails or a full outage extension
   collect about half their expected draw. The 3× target exists as a margin for
   exactly those departures from the lognormal, and here it was not enough. At
   250 bps the worst case stays above break-even under both stresses. The cost
   to a borrower is small: a 100,000 USDG, 7-day Blue chip loan pays about
   82 USDG of premium instead of 33.
3. **The contract defaults must not go live.** Under B, Blue chip at a 100%
   cap and 1-year terms covers 0.2× of its expected draw. The deployment sets
   every tier explicitly (`scripts/deploy-robinhood-testnet.js`), and the
   mainnet deployment must do the same.
4. **The all-caps-100% option (C)** clears 3× on the baseline but falls below
   break-even under fat tails in all three tiers. Adopting it later would need
   premiums of about 300 / 400 / 400 bps (tested: 1.1× / 1.5× / 3.3× under fat
   tails).

## Checks on the model itself

Reproducing the M-07 finding's reference case (frozen code: Standard, 7 days,
24.92% deposit, two holdings at 50% each, correlation 0.4, priced and insured
on the term only), the model gives **2.13×** cover against the **2.21×**
reported in the finding: the same quantity, within sampling and method
differences. After the fixes, that loan cannot hold 50% + 50% (a 200% budget);
the most it may hold of two Standard assets is 25% + 25%, which at the new
32.6% deposit floor draws nothing.

## Calibration rules for the operator

- **Each safer tier's cap × assumed volatility must stay at or below the riskier
  tier's** (chosen: Blue chip 0.70 × 60% = 0.42 ≤ Standard 0.50 × 100% = 0.50 ≤
  Speculative 0.25 × 200% = 0.50). It keeps a safer-tier holding at its cap
  within the risk the vault's own tier was priced on, so the worst single
  holding — the case the portfolio coverage check compares against — is the
  vault tier's own. Contract defaults (B) break it: 1.00 × 60% = 0.60 > 0.50.
- **An asset's real volatility must not exceed its tier's assumption.** The
  depth check and listing review should confirm this per asset.
- **Rerun this model before changing any tier setting, the coefficient, the
  insured window or the draw cap.**

## Assumptions and limits

1. **Tails.** The baseline is zero-drift lognormal; tokenised equities can gap
   over weekends and halts. The t4 column is a stress, not a calibration; read
   baseline cover as an upper bound.
2. **Correlation across loans.** Each loan is priced alone. A market-wide fall
   breaches many deposits at once; `drawCapBps` limits each payout and
   `maxDrawShareBps` (5%) slows a run on the reserve, but reserve size against
   correlated stress remains a scenario-based decision, not an output here.
3. **Volatility inputs** are tier assumptions (60/100/200%), not measurements of
   the launch assets.
4. **Selection.** Borrowers choose term, timing and assets; adverse selection
   makes realised draws exceed modelled ones under any distribution.
5. **Excluded:** lender interest (insurance covers principal only), swap fees,
   and the 5% reserve-share limit per draw (which can only reduce a payout).

## Rerunning

```
node scripts/model-insurance-solvency.js                 # all four settings, then the portfolio coverage check (about 4 minutes)
CONFIG=chosen node scripts/model-insurance-solvency.js   # one of: launch, defaults, caps100, chosen (about 1 minute)
CHECK=0 node scripts/model-insurance-solvency.js         # main tables only (seconds)
PATHS=400000 TARGET_COVER=3 node scripts/model-insurance-solvency.js
CHECK_PATHS=100000 GRID_STEP=0.05 node scripts/model-insurance-solvency.js   # finer grid, slower
```

No chain or dependencies are needed. The fixed seeds make every figure
reproducible.
