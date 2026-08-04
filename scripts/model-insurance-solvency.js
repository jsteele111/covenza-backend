/**
 * Asks whether insurance premiums cover expected insurance draws.
 *
 * WHY: deposit floors are DERIVED — 1.8 x sigma x sqrt(T), calibrated against
 * expected loss. The premiums (100 / 250 / 600 bps) and the 10% draw cap were
 * CHOSEN. Nothing has ever checked whether the income covers the liability, so
 * the pool's solvency is an assumption wearing the costume of a parameter.
 *
 * WHAT IT DOES: for each tier, works out how far an asset must fall before the
 * borrower's deposit is exhausted, how likely that is, and what the pool pays
 * when it happens. Compares that to premium income over the same term.
 *
 * READ THE ASSUMPTIONS BEFORE THE NUMBERS. The headline result is extremely
 * sensitive to the tail model, and the lognormal baseline is known to be wrong
 * in the direction that flatters us. Both are printed for that reason.
 *
 * Usage:
 *   npx hardhat run scripts/model-insurance-solvency.js --network robinhoodTestnet
 *   OFFLINE=1 npx hardhat run scripts/model-insurance-solvency.js   (uses spec defaults)
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const YEAR = 365 * 24 * 3600;
const TIER_NAMES = ["Blue chip", "Standard", "Speculative"];

// Terms to evaluate, in days. Each tier is only evaluated up to its own limit.
const TERMS = [1, 7, 30, 90, 365];

// --- Distribution helpers ---------------------------------------------

/** Abramowitz & Stegun 7.1.26 — plenty for four significant figures. */
function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const normPdf = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

/**
 * Expected shortfall below a threshold for a standard normal: E[(a - Z)+].
 * Used for "how far past the deposit does the loss go, when it goes past".
 */
function expectedShortfall(a) {
  return normPdf(a) - a * normCdf(-a);
}

// --- The model ---------------------------------------------------------

/**
 * @param sigma      annualised volatility, as a fraction (1.0 = 100%)
 * @param termDays   loan term
 * @param depositFr  deposit as a fraction of principal
 * @param exposureFr most of principal that may sit in the risky asset
 * @param drawCapFr  pool's per-settlement cap, fraction of principal
 */
function tierRisk({ sigma, termDays, depositFr, exposureFr, drawCapFr }) {
  const T = termDays / 365;
  const vol = sigma * Math.sqrt(T);          // volatility over the term

  // Loss on PRINCIPAL is the asset's fall scaled by how much of the principal
  // is allowed to sit in it. The exposure cap is doing as much work here as the
  // deposit, and is easy to forget when reasoning about "a 50% crash".
  //
  // Breach happens when exposure x assetLoss > deposit.
  const lossThreshold = Math.min(depositFr / exposureFr, 0.999);

  // Lognormal, zero drift: ln(S_T/S_0) ~ N(-vol^2/2, vol^2). Zero drift is the
  // conservative choice — assuming assets drift up would flatter the result.
  const logMove = Math.log(1 - lossThreshold);
  const z = (logMove + 0.5 * vol * vol) / vol;   // standardised
  const pBreach = normCdf(z);

  // Expected loss beyond the deposit, in fractions of principal. Approximated
  // in log space then converted, which slightly understates deep losses — noted
  // rather than corrected, because the tail model below dominates the error.
  const shortfallStd = expectedShortfall(-z);
  const expectedExcess = Math.max(0, exposureFr * vol * shortfallStd);
  const expectedDraw = Math.min(expectedExcess, drawCapFr * pBreach + drawCapFr * 0);

  return {
    lossThreshold,
    volOverTerm: vol,
    sigmasToBreach: -z,
    pBreach,
    expectedDraw: Math.min(expectedExcess, drawCapFr),
    cappedBy: expectedExcess > drawCapFr ? "cap" : "distribution",
  };
}

async function loadTiers() {
  if (process.env.OFFLINE === "1") {
    // Spec defaults, for running without a chain.
    return [
      { vol: 6000, minDep: 1000, maxTerm: 365 * 86400, maxExp: 10000, prem: 100 },
      { vol: 10000, minDep: 2000, maxTerm: 7 * 86400, maxExp: 5000, prem: 250 },
      { vol: 20000, minDep: 4000, maxTerm: 86400, maxExp: 2500, prem: 600 },
    ].map((t, i) => ({ ...t, tier: i, drawCapBps: 1000, source: "spec defaults" }));
  }

  const { ethers } = hre;
  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  )[hre.network.name];

  const registry = await ethers.getContractAt("AssetRegistry", d.assetRegistry);
  const pool = await ethers.getContractAt("InsurancePool", d.insurancePool);
  const drawCapBps = Number(await pool.drawCapBps());

  const out = [];
  for (let i = 0; i < 3; i++) {
    const c = await registry.tierConfig(i);
    out.push({
      tier: i,
      vol: Number(c[0]),
      minDep: Number(c[1]),
      maxTerm: Number(c[2]),
      maxExp: Number(c[3]),
      prem: Number(c[4]),
      drawCapBps,
      source: `live registry ${d.assetRegistry}`,
    });
  }
  return out;
}

async function depositFloor(registry, tier, termSeconds) {
  return Number(await registry.minimumDepositBpsForTier(tier, termSeconds));
}

async function main() {
  const tiers = await loadTiers();
  const { ethers } = hre;

  let registry = null;
  if (process.env.OFFLINE !== "1") {
    const d = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
    )[hre.network.name];
    registry = await ethers.getContractAt("AssetRegistry", d.assetRegistry);
  }

  console.log("=".repeat(78));
  console.log("Insurance pool solvency — do premiums cover expected draws?");
  console.log(`Source: ${tiers[0].source}`);
  console.log("=".repeat(78));

  const rows = [];

  for (const t of tiers) {
    const maxDays = t.maxTerm / 86400;
    console.log(`\n--- ${TIER_NAMES[t.tier]} ---`);
    console.log(`  assumed volatility ${t.vol / 100}%   exposure cap ${t.maxExp / 100}%   ` +
                `premium ${t.prem}bps/yr   max term ${maxDays}d`);
    console.log("");
    console.log("   term   deposit  breach at  sigmas  P(breach)   E[draw]   premium   cover");
    console.log("   " + "-".repeat(70));

    for (const days of TERMS) {
      if (days > maxDays) continue;

      const floorBps = registry
        ? await depositFloor(registry, t.tier, days * 86400)
        : Math.max(t.minDep, Math.min(10000,
            Math.round(1.8 * (t.vol / 100) * Math.sqrt(days / 365) * 100)));

      const r = tierRisk({
        sigma: t.vol / 10000,
        termDays: days,
        depositFr: floorBps / 10000,
        exposureFr: t.maxExp / 10000,
        drawCapFr: t.drawCapBps / 10000,
      });

      // Premium is annualised on principal, so it scales with term exactly as
      // the fee does.
      const premiumFr = (t.prem / 10000) * (days / 365);
      const cover = r.expectedDraw > 0 ? premiumFr / r.expectedDraw : Infinity;

      rows.push({ tier: t.tier, days, cover, pBreach: r.pBreach, premiumFr, draw: r.expectedDraw });

      console.log(
        `   ${String(days).padStart(4)}d` +
        `   ${(floorBps / 100).toFixed(1).padStart(6)}%` +
        `   ${(r.lossThreshold * 100).toFixed(1).padStart(7)}%` +
        `   ${r.sigmasToBreach.toFixed(2).padStart(5)}` +
        `   ${(r.pBreach * 100).toFixed(4).padStart(8)}%` +
        `   ${(r.expectedDraw * 10000).toFixed(2).padStart(6)}bp` +
        `   ${(premiumFr * 10000).toFixed(2).padStart(6)}bp` +
        `   ${cover === Infinity ? "  inf" : cover.toFixed(1).padStart(5)}x`
      );
    }
  }

  // --- Solve for an exposure cap that pays for itself -------------------
  //
  // Deposits are the control; rates are the compensation. Where premium fails
  // to cover expected draw, the consistent response is to tighten the control
  // rather than raise the price — pricing around a loose limit is how a lender
  // ends up compensated for a risk they would not have accepted.
  //
  // Solves, per tier, the largest exposure cap at which premium income still
  // covers the modelled draw at EVERY term the tier permits. Bisection, because
  // the relationship runs through a normal CDF and has no closed form worth
  // writing.
  // TARGET_COVER is the margin over break-even. 1.0 would set the cap exactly
  // where modelled income equals modelled loss — adopting the lognormal's
  // optimism as policy, with nothing left for the fat tails and correlation
  // the assumptions below admit to ignoring. The default of 3 is a
  // risk-appetite choice, not a derivation, and is the one number here that
  // should be argued about rather than computed.
  const TARGET_COVER = Number(process.env.TARGET_COVER || 3);

  console.log("\n" + "=".repeat(78));
  console.log(`Exposure cap implied by the premium already charged (target ${TARGET_COVER}x cover)`);
  console.log("=".repeat(78));
  console.log("\nThe largest exposure at which income covers modelled draw by the target");
  console.log("multiple at every permitted term. Where this sits BELOW the configured");
  console.log("cap, the tier is underwriting more than it is paid for.\n");

  for (const t of tiers) {
    const maxDays = t.maxTerm / 86400;
    const terms = TERMS.filter((d) => d <= maxDays);

    async function worstCover(exposureFr) {
      let worst = Infinity;
      for (const days of terms) {
        const floorBps = registry
          ? await depositFloor(registry, t.tier, days * 86400)
          : Math.max(t.minDep, Math.min(10000,
              Math.round(1.8 * (t.vol / 100) * Math.sqrt(days / 365) * 100)));
        const r = tierRisk({
          sigma: t.vol / 10000,
          termDays: days,
          depositFr: floorBps / 10000,
          exposureFr,
          drawCapFr: t.drawCapBps / 10000,
        });
        const premiumFr = (t.prem / 10000) * (days / 365);
        const cover = r.expectedDraw > 0 ? premiumFr / r.expectedDraw : Infinity;
        if (cover < worst) worst = cover;
      }
      return worst;
    }

    let lo = 0.01, hi = 1.0;
    if (await worstCover(hi) >= TARGET_COVER) {
      console.log(`  ${TIER_NAMES[t.tier].padEnd(12)} 100% clears the target ` +
                  `(configured ${t.maxExp / 100}%)`);
      continue;
    }
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (await worstCover(mid) >= TARGET_COVER) lo = mid; else hi = mid;
    }
    const implied = lo * 100;
    const configured = t.maxExp / 100;
    const verdict = implied < configured
      ? `UNDERWRITTEN — configured ${configured}% exceeds it`
      : `covered — configured ${configured}% is inside it`;
    console.log(`  ${TIER_NAMES[t.tier].padEnd(12)} implied cap ${implied.toFixed(1).padStart(5)}%   ${verdict}`);
  }

  // --- Reserve sizing under correlated stress ---------------------------
  //
  // Everything above prices ONE loan in isolation. The scenario that empties a
  // pool is the opposite: a market-wide fall breaching many deposits at once,
  // where the per-settlement cap limits each payout and nothing limits the sum.
  //
  // Deliberately NOT probabilistic. Asking "how likely is a day when 20% of
  // loans breach" invites the same lognormal that has already been flagged as
  // the weakest assumption here. Stating the scenario and pricing it leaves the
  // judgement visible instead of burying it in a distribution.
  console.log("\n" + "=".repeat(78));
  console.log("Reserve required under correlated stress");
  console.log("=".repeat(78));
  console.log("\nIf a fraction of open loans breach together, each draws up to the");
  console.log(`per-settlement cap (${tiers[0].drawCapBps / 100}% of principal). Reserve needed, as a`);
  console.log("percentage of TOTAL OPEN PRINCIPAL:\n");

  const capFr = tiers[0].drawCapBps / 10000;
  console.log("   loans breaching     reserve needed     on 1m of open principal");
  console.log("   " + "-".repeat(62));
  for (const share of [0.05, 0.2, 0.5, 1.0]) {
    const reserveFr = share * capFr;
    console.log(
      `   ${(share * 100).toFixed(0).padStart(14)}%` +
      `   ${(reserveFr * 100).toFixed(2).padStart(15)}%` +
      `   ${(reserveFr * 1_000_000).toLocaleString("en-GB", { maximumFractionDigits: 0 }).padStart(22)}`
    );
  }

  console.log(`
This is an UPPER bound per scenario: it assumes every breaching loan draws the
full cap, when most draw less. It is also a LOWER bound in a different sense —
the cap binds per settlement, so a loss larger than ${(capFr * 100).toFixed(0)}% of principal leaves the
lender short regardless of how much reserve exists. Reserve protects against
MANY losses, never against a DEEP one.

The 10% cap is therefore doing two jobs: rationing the pool across claimants,
and silently capping how much protection a lender has at all. Those deserve to
be separate numbers.`);

  // --- What the numbers do and do not say ------------------------------

  console.log("\n" + "=".repeat(78));
  console.log("Reading this honestly");
  console.log("=".repeat(78));

  const worst = rows.filter((r) => r.cover !== Infinity)
                    .sort((a, b) => a.cover - b.cover)[0];

  if (!worst) {
    console.log("\nNo tier/term combination produces a measurable expected draw under the");
    console.log("lognormal baseline. That is NOT a clean bill of health — see below.");
  } else {
    console.log(`\nThinnest coverage: ${TIER_NAMES[worst.tier]} at ${worst.days}d — ` +
                `${worst.cover.toFixed(1)}x premium against expected draw.`);
  }

  console.log(`
ASSUMPTIONS, in the order they are likely to be wrong:

1. LOGNORMAL TAILS. Returns are modelled as lognormal with zero drift. Real
   assets — crypto especially, and tokenised equities during a halt — have far
   fatter tails. A move the lognormal calls a 5-sigma event happens far more
   often than "never". Every P(breach) above is therefore a LOWER BOUND, and
   the coverage ratios an UPPER bound.

2. INDEPENDENCE. Each loan is priced as if its loss were unrelated to every
   other. The scenario that empties an insurance pool is precisely the one
   where that fails: a market-wide fall breaches many deposits at once. The
   per-settlement drawCapBps limits any SINGLE payout and nothing limits the
   aggregate, so a correlated event drains the reserve first-come-first-served
   and the last lender to settle finds it empty.

3. THE EXPOSURE CAP IS DOING MOST OF THE WORK. Breach needs the asset to fall
   by deposit/exposure, not by deposit. At Standard — 50% exposure, ~25%
   deposit at 7 days — the asset must halve before the pool pays anything. That
   is why the modelled probabilities look reassuring, and it is entirely
   contingent on the cap staying where it is.

4. NO DRIFT, NO CORRELATION BETWEEN TERM AND SELECTION. Borrowers choose their
   term and their asset. If the ones who pick long terms on volatile assets are
   also the ones most likely to be underwater, realised draws exceed modelled
   ones regardless of the distribution.

WHAT THIS DOES NOT ANSWER: which stress scenario to size against. The table
above prices several; choosing among them is a risk-appetite decision and
belongs to whoever answers for the pool being empty. Nor does it answer whether
the draw cap should keep doing two jobs at once — rationing between claimants
and capping any one lender's protection.
`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
