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
 *      most 100%. The model evaluates single holdings and two-asset splits of
 *      the budget across every tier the vault may hold, at return correlations
 *      of 0.4, 0.8 and 1.0, and reports the worst.
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

/** Every portfolio the risk budget allows that is worth testing: one holding
 *  at its cap, or the budget split 50/50 or 75/25 across two holdings of any
 *  tiers the vault may hold (including two different assets of one tier). */
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

  console.log("\n  Summary — lowest cover across every permitted term and portfolio");
  console.log("  tier          premium   baseline   fat tails   +72h outage   premium for " + TARGET_COVER + "x (baseline)");
  for (const s of summary) {
    const f = (x) => (x === Infinity ? "   inf" : x.toFixed(1).padStart(6)) + "x";
    const verdict = s.worstBase >= TARGET_COVER ? "meets target" : "BELOW target";
    console.log(`  ${TIER_NAMES[s.tier].padEnd(12)} ${String(s.premBps).padStart(5)}bps  ${f(s.worstBase)}    ${f(s.worstTail)}     ${f(s.worstOut)}       ` +
                `${Math.ceil(s.needBps).toString().padStart(5)}bps   ${verdict}`);
  }
  return summary;
}

function main() {
  const keys = process.env.CONFIG ? [process.env.CONFIG] : Object.keys(CONFIGS);
  console.log("Insurance pool solvency — do premiums cover expected draws? (audit rerun, M-06/M-07)");
  for (const k of keys) {
    if (!CONFIGS[k]) throw new Error(`Unknown CONFIG ${k}`);
    runConfig(k);
  }
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
   riskier tier's, or the risk budget (M-07) stops bounding portfolio risk.
4. SELECTION. Borrowers choose term, timing and assets; adverse selection makes
   realised draws exceed modelled ones under any distribution.
5. EXCLUDED: lender interest (insurance covers principal only), swap fees and
   the 5% reserve-share limit per draw (which can only reduce a payout).
`);
}

main();
