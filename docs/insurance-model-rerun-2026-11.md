# Insurance model rerun — November 2026

Rerun of `scripts/model-insurance-solvency.js` after the fixes for audit
findings **M-06** (term-only pricing of post-maturity cover) and **M-07**
(multiple holdings beyond the single-exposure model). Contracts at
`c042518`; this document and the model change no contract code.

**Result.** With the chosen launch settings (below), premium income covers the
modelled expected insurance draw by at least **10.9×** at every permitted term,
every tier and every portfolio the exposure budget allows, against a target of
3×. It stays above break-even (≥ 1.1×) under a fat-tail stress and under the
full 72-hour outage extension. The one change from the launch settings
previously quoted is **Blue chip's premium, raised from 100 to 250 bps a year**.

## What changed in the model

| | At the audit freeze | This rerun |
|---|---|---|
| Risk horizon | The loan term | **Term + the 5-day insured window** (M-06), matching the deposit floor and premium, which are both priced on that horizon. A separate stress adds the full **72-hour outage extension**, which is insured but not priced. |
| Terms evaluated | 1 day and up | **60 seconds, 1 hour**, 1 day, 7, 30, 90 and 365 days, each up to the tier's maximum term |
| Holdings | One asset at the tier cap | **Every portfolio the M-07 budget allows**: one holding at its cap, and the budget split 50/50 or 75/25 across two holdings of any tier the vault may hold (including two assets of one tier), at return correlations of **0.4, 0.8 and 1.0**. The worst case is reported. |
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

Lowest cover across every permitted term and portfolio:

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

In every tier the worst portfolio is a **single holding at its cap**: with the
budget in place, splitting it across assets never adds risk at these settings,
including at correlation 1.0.

## Reading the results

1. **The fixes close both gaps.** Short loans are now priced and deposited on
   the horizon they are insured for, and no allowed portfolio carries more risk
   than the single capped holding the tiers were sized on.
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
  Speculative 0.25 × 200% = 0.50). This is what lets the M-07 budget bound any
  portfolio's risk by the single-holding case. Contract defaults (B) break it:
  1.00 × 60% = 0.60 > 0.50.
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
node scripts/model-insurance-solvency.js                 # all four settings
CONFIG=chosen node scripts/model-insurance-solvency.js   # one of: launch, defaults, caps100, chosen
PATHS=400000 TARGET_COVER=3 node scripts/model-insurance-solvency.js
```

No chain or dependencies are needed. The fixed seed makes every figure
reproducible.
