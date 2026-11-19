/**
 * Asks whether insurance premiums cover expected insurance draws.
 *
 * WHY: deposit floors are DERIVED — coefficient x sigma x sqrt(horizon). The
 * premiums and the 10% draw cap were CHOSEN. This checks whether premium income
 * covers the modelled liability, by tier, term and portfolio, against a target
 * multiple (default 3x).
 *
 * RERUN FOR THE ZEALYNX AUDIT (M-06, M-07), November 2026. Three changes from
 * the version reviewed at the audit freeze:
 *
 *   1. HORIZON (M-06). Insurance now covers a loan until deadline + the insured
 *      window (5 days), extended by recorded outages of up to 72 hours. The
 *      deposit floor and premium are both priced on term + window. The model
 *      prices risk over the same term + window, and separately stresses the
 *      full 72-hour outage extension, which is insured but not priced.
 *   2. SHORT TERMS (M-06). Terms start at 60 seconds and one hour, not one day:
 *      seconds-mode loans exist, and the window dominates their horizon.
 *   3. PORTFOLIOS (M-07). A vault may hold several assets. Holdings share one
 *      exposure budget: each uses value / (its tier cap x principal), total at
 *      most 100%. The main tables evaluate single holdings and two-asset splits
 *      of the budget (50/50 and 75/25) across every tier the vault may hold, at
 *      return correlations of 0.4, 0.8 and 1.0, and report the worst. A
 *      separate portfolio coverage check (added in the M-07 fix review) widens
 *      this to up to three holdings, budget shares in 10% steps and
 *      correlations from 0 to 1, and reports whether any of those mixes draws
 *      more than the worst single holding. Both are sampled checks over stated
 *      sets of portfolios, not a proof covering every possible portfolio.
 *
 * METHOD. Monte Carlo, seeded, so a rerun reproduces every figure. Returns are
 * zero-drift lognormal (the baseline) and, as a tail stress, a multivariate
 * Student-t with 4 degrees of freedom scaled to the same volatility. For each
 * case: expected draw = E[ min( max(loss - deposit, 0), drawCap ) ] as a
 * fraction of principal, where loss = sum over holdings of value x fall.
 * Cover = premium / expected draw.
 *
 * Usage (no chain needed):
 *   node scripts/model-insurance-solvency.js                 all three configurations
 *   CONFIG=launch node scripts/model-insurance-solvency.js   one of: launch, defaults, caps100
 *   PATHS=400000 TARGET_COVER=3 node scripts/model-insurance-solvency.js
 *   CHECK=0 node scripts/model-insurance-solvency.js        skip the portfolio coverage check
 *   CHECK_PATHS=100000 GRID_STEP=0.05 node scripts/model-insurance-solvency.js
 */

const YEAR = 365 * 86400;
const DAY = 86400;
const TIER_NAMES = ["Blue chip", "Standard", "Speculative"];

const TARGET_COVER = Number(process.env.TARGET_COVER || 3);
const PATHS = Number(process.env.PATHS || 200000);
const WINDOW = 5 * DAY;          // AssetRegistry.insuredWindow default
const OUTAGE_EXT = 3 * DAY;      // maximum outage extension (72 h default cap)
const DRAW_CAP = 0.10;           // InsurancePool drawCapBps 1000
const CORRELATIONS = [0.4, 0.8, 1.0];
const T_DOF = 4;

// Terms evaluated, in seconds; each tier only up to its own maximum.
const TERMS = [60, 3600, DAY, 7 * DAY, 30 * DAY, 90 * DAY, YEAR];

// Tier settings: [assumed vol bps, min deposit bps, max term s, cap bps, premium bps/yr]
const CONFIGS = {
  launch: {
    label: "A. Launch shape (deploy script; the parameters Zealynx quoted)",
    coeff: 1.8,
    tiers: [
      [6000, 1000, 30 * DAY, 7000, 100],
      [10000, 2000, 7 * DAY, 5000, 250],
      [20000, 4000, 1 * DAY, 2500, 100],
    ],
  },
  defaults: {
    label: "B. Contract defaults (AssetRegistry constructor)",
    coeff: 1.8,
    tiers: [
      [6000, 1000, 365 * DAY, 10000, 100],
      [10000, 2000, 90 * DAY, 5000, 250],
      [20000, 4000, 7 * DAY, 2500, 600],
    ],
  },
  caps100: {
    label: "C. All caps 100%, coefficient 2.6 (launch terms and premiums)",
    coeff: 2.6,
    tiers: [
      [6000, 1000, 30 * DAY, 10000, 100],
      [10000, 2000, 7 * DAY, 10000, 250],
      [20000, 4000, 1 * DAY, 10000, 100],
    ],
  },
  // The settings chosen for launch after this rerun: the launch shape, with
  // Blue chip's premium raised 100 -> 250 bps. Under A, short Blue chip loans
  // clear the 3x target on the baseline (4.4x) but collect about half their
  // expected draw under fat tails and the outage stress; at 250 bps they stay
  // above break-even under both. See docs/insurance-model-rerun-2026-11.md.
  chosen: {
    label: "D. Chosen launch settings (launch shape, Blue chip premium 250bps)",
    coeff: 1.8,
    tiers: [
      [6000, 1000, 30 * DAY, 7000, 250],
      [10000, 2000, 7 * DAY, 5000, 250],
      [20000, 4000, 1 * DAY, 2500, 100],
    ],
  },
};

// --- Seeded random numbers ----------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pre-drawn standard normals (and t mixing factors), shared across cases so
 *  that comparisons between cases are not muddied by sampling noise. */
function drawShocks(n, seed) {
  const u = rng(seed);
  const normal = () => {
    let x = 0;
    while (x === 0) x = u();
    return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u());
  };
  const z1 = new Float64Array(n), z2 = new Float64Array(n), tmix = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    z1[i] = normal();
    z2[i] = normal();
    let chi = 0;
    for (let k = 0; k < T_DOF; k++) { const g = normal(); chi += g * g; }
    // Multivariate t, rescaled to unit variance: z * sqrt(nu / chi) * sqrt((nu - 2) / nu)
    tmix[i] = Math.sqrt((T_DOF - 2) / chi);
  }
  return { z1, z2, tmix };
}

const SHOCKS = drawShocks(PATHS, 20261114);

// --- The model ------------------------------------------------------------

function depositFloor(coeff, volBps, minDepBps, termS) {
  const v = coeff * (volBps / 10000) * Math.sqrt((termS + WINDOW) / YEAR);
  return Math.max(minDepBps / 10000, Math.min(1, v));
}

/**
 * Expected draw for a portfolio of up to two holdings.
 * @param h   [{ value, sigma }] value as a fraction of principal
 * @param rho correlation between the two holdings' returns
 * @param horizonS seconds of insured risk
 * @param tails "normal" | "t"
 */
function expectedDraw(h, rho, deposit, horizonS, tails) {
  const T = horizonS / YEAR;
  const s1 = h[0].sigma * Math.sqrt(T), s2 = h[1] ? h[1].sigma * Math.sqrt(T) : 0;
  const v1 = h[0].value, v2 = h[1] ? h[1].value : 0;
  const c = Math.sqrt(1 - rho * rho);
  const { z1, z2, tmix } = SHOCKS;
  let sum = 0;
  for (let i = 0; i < PATHS; i++) {
    const m = tails === "t" ? tmix[i] : 1;
    const a = z1[i] * m;
    const b = (rho * z1[i] + c * z2[i]) * m;
    const loss1 = v1 * (1 - Math.exp(-0.5 * s1 * s1 + s1 * a));
    const loss2 = v2 ? v2 * (1 - Math.exp(-0.5 * s2 * s2 + s2 * b)) : 0;
    const excess = loss1 + loss2 - deposit;
    if (excess > 0) sum += excess < DRAW_CAP ? excess : DRAW_CAP;
  }
  return sum / PATHS;
}

/** The portfolios the main tables test: one holding at its cap, or the budget
 *  split 50/50 or 75/25 across two holdings of any tiers the vault may hold
 *  (including two different assets of one tier). The portfolio coverage check
 *  below tests a wider grid. */
function portfolios(cfg, ceiling) {
  const caps = cfg.tiers.map((t) => t[3] / 10000);
  const sig = cfg.tiers.map((t) => t[0] / 10000);
  const out = [];
  for (let j = 0; j <= ceiling; j++) {
    out.push({ name: `100% budget in ${TIER_NAMES[j]}`, h: [{ value: Math.min(1, caps[j]), sigma: sig[j] }], single: true });
  }
  for (let j1 = 0; j1 <= ceiling; j1++) {
    for (let j2 = j1; j2 <= ceiling; j2++) {
      for (const w of [0.5, 0.75]) {
        if (j1 === j2 && w === 0.75) continue;
        for (const [a, b, wa] of [[j1, j2, w], [j2, j1, w]]) {
          if (a === b && wa !== 0.5) continue;
          const va = wa * caps[a], vb = (1 - wa) * caps[b];
          if (va + vb > 1 + 1e-9) continue;   // cannot invest more than principal
          out.push({
            name: `${wa * 100}% ${TIER_NAMES[a]} + ${(1 - wa) * 100}% ${TIER_NAMES[b]}`,
            h: [{ value: va, sigma: sig[a] }, { value: vb, sigma: sig[b] }],
          });
        }
      }
    }
  }
  // De-duplicate by name.
  return [...new Map(out.map((p) => [p.name, p])).values()];
}

function fmtTerm(s) {
  if (s < 3600) return `${s}s`;
  if (s < DAY) return `${s / 3600}h`;
  return `${s / DAY}d`;
}

function runConfig(key) {
  const cfg = CONFIGS[key];
  console.log("\n" + "=".repeat(86));
  console.log(cfg.label);
  console.log(`coefficient ${cfg.coeff}   insured window ${WINDOW / DAY}d   draw cap ${DRAW_CAP * 100}%   ` +
              `target ${TARGET_COVER}x   paths ${PATHS.toLocaleString("en-GB")}`);
  console.log("=".repeat(86));

  const summary = [];
  for (let tier = 0; tier < 3; tier++) {
    const [volBps, minDep, maxTerm, capBps, premBps] = cfg.tiers[tier];
    console.log(`\n--- ${TIER_NAMES[tier]} vault ---  vol ${volBps / 100}%  cap ${capBps / 100}%  ` +
                `premium ${premBps}bps/yr  max term ${fmtTerm(maxTerm)}`);
    console.log("   term  deposit  premium |  E[draw] / cover, worst portfolio and correlation");
    console.log("                          |  baseline           fat tails (t4)      +72h outage");
    console.log("   " + "-".repeat(82));

    const pf = portfolios(cfg, tier);
    let worstBase = Infinity, worstTail = Infinity, worstOut = Infinity, needBps = 0, worstCase = "";
    for (const term of TERMS.filter((t) => t <= maxTerm)) {
      const deposit = depositFloor(cfg.coeff, volBps, minDep, term);
      const premium = (premBps / 10000) * ((term + WINDOW) / YEAR);
      const worst = { base: 0, tail: 0, out: 0, baseName: "" };
      for (const p of pf) {
        for (const rho of p.single ? [1] : CORRELATIONS) {
          const b = expectedDraw(p.h, rho, deposit, term + WINDOW, "normal");
          const t = expectedDraw(p.h, rho, deposit, term + WINDOW, "t");
          const o = expectedDraw(p.h, rho, deposit, term + WINDOW + OUTAGE_EXT, "normal");
          if (b > worst.base) { worst.base = b; worst.baseName = `${p.name}${p.single ? "" : `, rho ${rho}`}`; }
          if (t > worst.tail) worst.tail = t;
          if (o > worst.out) worst.out = o;
        }
      }
      const cov = (d) => (d > 0 ? premium / d : Infinity);
      const cell = (d) => `${(d * 10000).toFixed(2).padStart(6)}bp ${cov(d) === Infinity ? "   inf" : cov(d).toFixed(1).padStart(6)}x`;
      console.log(`  ${fmtTerm(term).padStart(5)}  ${(deposit * 100).toFixed(1).padStart(6)}%  ${(premium * 10000).toFixed(2).padStart(6)}bp |  ` +
                  `${cell(worst.base)}   ${cell(worst.tail)}   ${cell(worst.out)}`);
      if (cov(worst.base) < worstBase) { worstBase = cov(worst.base); worstCase = `${fmtTerm(term)}: ${worst.baseName}`; }
      worstTail = Math.min(worstTail, cov(worst.tail));
      worstOut = Math.min(worstOut, cov(worst.out));
      // Premium (bps/yr) that would give TARGET_COVER on the baseline at this term.
      needBps = Math.max(needBps, (TARGET_COVER * worst.base * YEAR / (term + WINDOW)) * 10000);
    }
    console.log(`   worst baseline case: ${worstCase.endsWith(": ") || !worstCase ? "no portfolio draws on the baseline" : worstCase}`);
    summary.push({ tier, premBps, worstBase, worstTail, worstOut, needBps });
  }

  console.log("\n  Summary — lowest cover across every permitted term and every portfolio in these tables");
  console.log("  tier          premium   baseline   fat tails   +72h outage   premium for " + TARGET_COVER + "x (baseline)");
  for (const s of summary) {
    const f = (x) => (x === Infinity ? "   inf" : x.toFixed(1).padStart(6)) + "x";
    const verdict = s.worstBase >= TARGET_COVER ? "meets target" : "BELOW target";
    console.log(`  ${TIER_NAMES[s.tier].padEnd(12)} ${String(s.premBps).padStart(5)}bps  ${f(s.worstBase)}    ${f(s.worstTail)}     ${f(s.worstOut)}       ` +
                `${Math.ceil(s.needBps).toString().padStart(5)}bps   ${verdict}`);
  }
  return summary;
}

// --- Portfolio coverage check (M-07 fix review) ----------------------------
//
// The tables above test a fixed set of portfolios: one holding at its cap, and
// two holdings splitting the budget 50/50 or 75/25. This check widens that set
// and asks one question per vault tier, term and stress: does any portfolio in
// the grid have a larger expected draw than the worst single holding at its
// cap? It is a sampled check over a stated grid, not a proof for every
// possible portfolio.
//
// Grid: one, two or three holdings (three or more different assets of the same
// tier allowed), drawn from every tier the vault may hold; budget shares in
// steps of GRID_STEP (default 10%) summing to the full budget; every pair of
// holdings at the same return correlation, from 0 to 1 in steps of 0.2.
//
// Why only full-budget portfolios: on every path the payout
// min(max(loss - deposit, 0), drawCap) is non-decreasing as all holdings are
// scaled up together (it is zero wherever the scaled loss is negative, and
// non-decreasing in the loss elsewhere). So holding the same mix with part of
// the budget unused can never have a larger expected draw than the full-budget
// version, and the full-budget grid covers it.
//
// Not covered: four or more holdings, budget shares off the grid, unequal
// pairwise correlations, and distributions other than the two stated. Each
// tier's assets are assumed to have exactly the tier's volatility.

const CHECK_PATHS = Number(process.env.CHECK_PATHS || 50000);
const GRID_STEP = Number(process.env.GRID_STEP || 0.1);
const MAX_HOLDINGS = 3;
const CHECK_RHOS = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
const TOLERANCE = 0.01;   // a mix must beat the single holding by > 1% to count

/** Equicorrelated shocks: holding i's shock = sqrt(rho) x common + sqrt(1 - rho) x own. */
function drawCheckShocks(n, seed) {
  const u = rng(seed);
  const normal = () => {
    let x = 0;
    while (x === 0) x = u();
    return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u());
  };
  const common = new Float64Array(n), tmix = new Float64Array(n);
  const own = [0, 1, 2].map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    common[i] = normal();
    for (let k = 0; k < MAX_HOLDINGS; k++) own[k][i] = normal();
    let chi = 0;
    for (let k = 0; k < T_DOF; k++) { const g = normal(); chi += g * g; }
    tmix[i] = Math.sqrt((T_DOF - 2) / chi);
  }
  return { n, common, own, tmix };
}

let CHECK_SHOCKS;
const CONFIRM_PATHS = Number(process.env.CONFIRM_PATHS || 400000);
let CONFIRM_SHOCKS;

/** Expected draw for any number of holdings at equal pairwise correlation. */
function expectedDrawN(h, rho, deposit, horizonS, tails, shocks = CHECK_SHOCKS) {
  const T = horizonS / YEAR;
  const { n, common, own, tmix } = shocks;
  const a = Math.sqrt(rho), b = Math.sqrt(1 - rho);
  const s = h.map((x) => x.sigma * Math.sqrt(T));
  const k = h.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const m = tails === "t" ? tmix[i] : 1;
    let loss = 0;
    for (let j = 0; j < k; j++) {
      const z = (a * common[i] + b * own[j][i]) * m;
      loss += h[j].value * (1 - Math.exp(-0.5 * s[j] * s[j] + s[j] * z));
    }
    const excess = loss - deposit;
    if (excess > 0) sum += excess < DRAW_CAP ? excess : DRAW_CAP;
  }
  return sum / n;
}

/** Budget shares in GRID_STEP steps: every way to split 1 into n positive parts. */
function splits(n) {
  const steps = Math.round(1 / GRID_STEP);
  const out = [];
  const rec = (left, parts, acc) => {
    if (parts === 1) { out.push([...acc, left]); return; }
    for (let x = 1; x <= left - (parts - 1); x++) rec(left - x, parts - 1, [...acc, x]);
  };
  rec(steps, n, []);
  return out.map((p) => p.map((x) => x / steps));
}

/** Tier assignments for n holdings: multisets of tiers 0..ceiling. */
function tierSets(n, ceiling) {
  const out = [];
  const rec = (from, acc) => {
    if (acc.length === n) { out.push(acc); return; }
    for (let t = from; t <= ceiling; t++) rec(t, [...acc, t]);
  };
  rec(0, []);
  return out;
}

function gridPortfolios(cfg, ceiling) {
  const caps = cfg.tiers.map((t) => t[3] / 10000);
  const sig = cfg.tiers.map((t) => t[0] / 10000);
  const out = [];
  for (let n = 2; n <= MAX_HOLDINGS; n++) {
    for (const tiers of tierSets(n, ceiling)) {
      for (const w of splits(n)) {
        out.push({
          name: tiers.map((t, i) => `${Math.round(w[i] * 100)}% ${TIER_NAMES[t]}`).join(" + "),
          h: tiers.map((t, i) => ({ value: w[i] * caps[t], sigma: sig[t] })),
        });
      }
    }
  }
  return out;
}

function portfolioCheck(keys) {
  CHECK_SHOCKS = drawCheckShocks(CHECK_PATHS, 20261119);
  console.log("\n" + "=".repeat(86));
  console.log("PORTFOLIO COVERAGE CHECK (M-07) — does any mix in the grid draw more than a single holding?");
  console.log(`up to ${MAX_HOLDINGS} holdings, budget shares in ${GRID_STEP * 100}% steps, equal pairwise correlation ` +
              `${CHECK_RHOS.join("/")}, paths ${CHECK_PATHS.toLocaleString("en-GB")}`);
  console.log("ratio = worst mix E[draw] / worst single-holding E[draw], over every permitted term (<= 1 means no mix is worse)");
  console.log("=".repeat(86));
  const results = [];
  for (const key of keys) {
    const cfg = CONFIGS[key];
    console.log(`\n${cfg.label}`);
    console.log("  vault         portfolios   baseline    fat tails   +72h outage   result");
    for (let tier = 0; tier < 3; tier++) {
      const [volBps, minDep, maxTerm] = cfg.tiers[tier];
      const caps = cfg.tiers.map((t) => t[3] / 10000);
      const sig = cfg.tiers.map((t) => t[0] / 10000);
      const mixes = gridPortfolios(cfg, tier);
      const worstRatio = { base: 0, t: 0, out: 0 };
      const worstName = { base: "", t: "", out: "" };
      let exceeds = false, remeasured = 0;
      for (const term of TERMS.filter((t) => t <= maxTerm)) {
        const deposit = depositFloor(cfg.coeff, volBps, minDep, term);
        for (const [stress, tails, horizon] of [["base", "normal", term + WINDOW], ["t", "t", term + WINDOW], ["out", "normal", term + WINDOW + OUTAGE_EXT]]) {
          let single = 0;
          for (let j = 0; j <= tier; j++) {
            single = Math.max(single, expectedDrawN([{ value: Math.min(1, caps[j]), sigma: sig[j] }], 1, deposit, horizon, tails));
          }
          let mix = 0, best = null;
          for (const p of mixes) {
            for (const rho of CHECK_RHOS) {
              const d = expectedDrawN(p.h, rho, deposit, horizon, tails);
              if (d > mix) { mix = d; best = { p, rho }; }
            }
          }
          let note = "";
          // A mix that looks worse on the grid's sample is re-measured on a
          // larger, independent sample, against the single holding on that same
          // sample. Rare-tail draws are noisy at CHECK_PATHS; this separates a
          // real excess from sampling noise.
          if (best && mix > single * (1 + TOLERANCE)) {
            if (!CONFIRM_SHOCKS) CONFIRM_SHOCKS = drawCheckShocks(CONFIRM_PATHS, 20261120);
            let s2 = 0;
            for (let j = 0; j <= tier; j++) {
              for (const rho of [1, best.rho]) {
                s2 = Math.max(s2, expectedDrawN([{ value: Math.min(1, caps[j]), sigma: sig[j] }], rho, deposit, horizon, tails, CONFIRM_SHOCKS));
              }
            }
            const m2 = expectedDrawN(best.p.h, best.rho, deposit, horizon, tails, CONFIRM_SHOCKS);
            note = ` (grid sample ${(mix * 1e4).toFixed(4)}bp vs ${(single * 1e4).toFixed(4)}bp; ` +
                   `re-measured on ${CONFIRM_PATHS.toLocaleString("en-GB")} paths: ${(m2 * 1e4).toFixed(4)}bp vs ${(s2 * 1e4).toFixed(4)}bp)`;
            single = s2; mix = m2; remeasured++;
          }
          if (mix > single * (1 + TOLERANCE) && mix > 0) exceeds = true;
          const ratio = single > 0 ? mix / single : (mix > 0 ? Infinity : 0);
          if (ratio > worstRatio[stress]) {
            worstRatio[stress] = ratio;
            worstName[stress] = best ? `${fmtTerm(term)}: ${best.p.name}, rho ${best.rho}${note}` : "";
          }
        }
      }
      const f = (r) => (r === Infinity ? "   inf" : r === 0 ? "no draw" : r.toFixed(3)).padStart(9);
      console.log(`  ${TIER_NAMES[tier].padEnd(12)} ${String(mixes.length * CHECK_RHOS.length).padStart(8)}   ${f(worstRatio.base)}   ${f(worstRatio.t)}     ${f(worstRatio.out)}     ` +
                  `${exceeds ? "A MIX IS WORSE" : "no mix worse"}`);
      if (exceeds) for (const s of ["base", "t", "out"]) if (worstRatio[s] > 1 + TOLERANCE) console.log(`      ${s}: ${worstName[s]}`);
      if (remeasured) console.log(`      ${remeasured} case(s) looked worse on the grid sample and were re-measured on ${CONFIRM_PATHS.toLocaleString("en-GB")} paths` +
                                  (exceeds ? "" : "; all within 1% of the single holding"));
      results.push({ key, tier, worstRatio, exceeds, remeasured });
    }
  }
  return results;
}

function main() {
  const keys = process.env.CONFIG ? [process.env.CONFIG] : Object.keys(CONFIGS);
  console.log("Insurance pool solvency — do premiums cover expected draws? (audit rerun, M-06/M-07)");
  for (const k of keys) {
    if (!CONFIGS[k]) throw new Error(`Unknown CONFIG ${k}`);
    runConfig(k);
  }
  if (process.env.CHECK !== "0") portfolioCheck(keys);
  console.log(`
ASSUMPTIONS, in the order they are likely to be wrong:

1. TAILS. The baseline is zero-drift lognormal; real assets, and tokenised
   equities through a halt or a weekend gap, have fatter tails. The t4 column
   is a stress, not a calibration. Read the baseline as an upper bound on cover.
2. CORRELATION ACROSS LOANS. Each loan is priced alone. A market-wide fall
   breaches many deposits at once; the per-settlement cap limits each payout
   and nothing limits the sum. Reserve size against that is a separate,
   scenario-based decision (see the readiness notes), not an output here.
3. VOLATILITY INPUTS. Tier volatilities are policy assumptions (60/100/200%).
   An asset listed in a tier must actually be no more volatile than the tier
   assumes, and each safer tier's cap x volatility must stay at or below the
   riskier tier's. The portfolio coverage check shows the budget keeps every
   tested mix at or below the single-holding case under these settings; it is
   a sampled check over a stated grid, not a general bound.
4. SELECTION. Borrowers choose term, timing and assets; adverse selection makes
   realised draws exceed modelled ones under any distribution.
5. EXCLUDED: lender interest (insurance covers principal only), swap fees and
   the 5% reserve-share limit per draw (which can only reduce a payout).
`);
}

main();
