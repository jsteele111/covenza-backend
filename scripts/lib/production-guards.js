/**
 * Refuses a production deployment carrying a testnet configuration.
 *
 * WHY THIS EXISTS: every value below is VALID. The contracts accept a 60-second
 * TWAP window and a zero timelock delay — they have to,
 * because testing needs them. That is precisely the danger: nothing reverts, no
 * test fails, and the mistake is invisible until it is exploited.
 *
 * Specific near-misses this guards against:
 *
 *   - A 60s TWAP is the contract minimum and the testnet value. We moved a
 *     pool's price 80% in eight transactions during testing; a 60-second
 *     window on a thin pool is a suggestion, not an oracle.
 *
 *   - TIMELOCK_DELAY defaults to zero so testnet flows run in one sitting.
 *     Shipped to mainnet that yields timelocks which queue and execute in the
 *     same block — the ceremony of a delay with none of the protection. This
 *     default was introduced in the same change that added the timelocks.
 *
 * Outage detection depends on the CHAIN (Ethereum deployment plan, 23 Nov 2026):
 *
 *   - Robinhood Chain and Arbitrum have a single block producer (a sequencer).
 *     If it stops, the chain stops, and a grace window can silently run out.
 *     Detection must be ON there, with a heartbeat bot running.
 *
 *   - Ethereum mainnet has no single block producer, so there is no outage of
 *     that kind to detect. Worse, with detection on and no heartbeat bot, any
 *     quiet half-hour between Covenza transactions would be recorded as an
 *     "outage", extending grace and holding keepers back for no reason.
 *     Detection must be OFF there.
 *
 * Override with ALLOW_UNSAFE_PRODUCTION=1 — deliberately ugly, and it prints
 * what is being waived so it appears in the terminal history.
 *
 * HARD CHECKS cannot be waived, not even with ALLOW_UNSAFE_PRODUCTION
 * (security review, 26 Nov 2026):
 *
 *   - S8, the tier calibration rule from the audit M-07 fix review: each
 *     safer tier's exposure cap x assumed volatility must be at or below the
 *     next riskier tier's. The exposure budget only keeps a mixed portfolio
 *     inside the risk the insurance model priced while this holds. The
 *     contract defaults break it (Blue chip 1.00 x 60% = 0.60 > Standard
 *     0.50 x 100% = 0.50) and must never go live.
 *   - The operator, treasury and attester must be three different addresses.
 */

const PRODUCTION_NETWORKS = ["robinhoodMainnet", "mainnet", "arbitrum"];

// Chains with a single block producer: outage detection must be on.
const SINGLE_SEQUENCER_NETWORKS = ["robinhoodMainnet", "arbitrum"];

// Chains without one: outage detection must be off.
const NO_SEQUENCER_NETWORKS = ["mainnet"];

const MIN_TWAP_WINDOW   = 1800;   // 30 minutes
const MIN_TIMELOCK      = 24 * 3600;

function isProduction(networkName) {
  return PRODUCTION_NETWORKS.includes(networkName);
}

/** True where the chain has a single block producer, so outages must be detected. */
function needsOutageDetection(networkName) {
  return SINGLE_SEQUENCER_NETWORKS.includes(networkName);
}

/**
 * S8. Returns a problem string, or null. `tiers` is safest first, each
 * { name, assumedVolBps, maxExposureBps }.
 */
function calibrationProblem(tiers) {
  for (let i = 0; i + 1 < tiers.length; i++) {
    const a = tiers[i], b = tiers[i + 1];
    const ra = BigInt(a.maxExposureBps) * BigInt(a.assumedVolBps);
    const rb = BigInt(b.maxExposureBps) * BigInt(b.assumedVolBps);
    if (ra > rb) {
      const f = (t) => `${(Number(t.maxExposureBps) / 10000).toFixed(2)} x ${(Number(t.assumedVolBps) / 100).toFixed(0)}% = ${(Number(t.maxExposureBps) * Number(t.assumedVolBps) / 1e8).toFixed(2)}`;
      return `tier calibration rule broken (audit M-07): ${a.name} ${f(a)} is above ${b.name} ${f(b)}. ` +
             "Each safer tier's cap x volatility must be at or below the riskier tier's.";
    }
  }
  return null;
}

/**
 * @param {string} networkName        hre.network.name
 * @param {object} cfg
 * @param {number} [cfg.timelockDelay]
 * @param {number} [cfg.twapWindow]
 * @param {number} [cfg.outageGapThreshold] sequencer-outage detection (0 = off)
 * @param {string} [cfg.operator]     intended operator address
 * @param {string} [cfg.deployer]     the deploying EOA
 * @param {string} [cfg.attesterKey]  the initial identity attester
 * @param {string} [cfg.treasury]     the protocol fee recipient
 * @param {Array}  [cfg.tiers]        safest first: { name, assumedVolBps, maxExposureBps }
 */
function guardProductionConfig(networkName, cfg = {}) {
  if (!isProduction(networkName)) { return; }

  const problems = [];

  if (cfg.timelockDelay !== undefined && Number(cfg.timelockDelay) < MIN_TIMELOCK) {
    problems.push(
      `timelock delay is ${cfg.timelockDelay}s; production needs at least ${MIN_TIMELOCK}s. ` +
      `A zero delay makes queue-then-execute a formality — it is the testnet default.`
    );
  }

  if (cfg.twapWindow !== undefined && Number(cfg.twapWindow) < MIN_TWAP_WINDOW) {
    problems.push(
      `TWAP window is ${cfg.twapWindow}s; production needs at least ${MIN_TWAP_WINDOW}s. ` +
      `60s is the contract minimum and is manipulable on a thin pool.`
    );
  }

  // MAINNET-READINESS item 16. With detection off, a sequencer outage across a
  // grace window silently consumes it and hands keepers the time jump. The
  // contract defaults to on; this catches a deployment that switched it off.
  if (needsOutageDetection(networkName) &&
      cfg.outageGapThreshold !== undefined && Number(cfg.outageGapThreshold) === 0) {
    problems.push(
      "sequencer-outage detection is disabled (gap threshold 0). Production " +
      "needs it on, with a heartbeat bot running."
    );
  }

  // Ethereum deployment plan, 23 Nov 2026. No sequencer, so detection can only
  // misfire: a quiet half-hour would be recorded as an outage.
  if (NO_SEQUENCER_NETWORKS.includes(networkName) &&
      cfg.outageGapThreshold !== undefined && Number(cfg.outageGapThreshold) !== 0) {
    problems.push(
      `outage detection is on (gap threshold ${cfg.outageGapThreshold}s), but ${networkName} ` +
      "has no single block producer. With no heartbeat bot, any quiet period would be " +
      "recorded as an outage, extending grace and holding keepers back. Switch it off " +
      "with setOutageConfig(0, 0, 0)."
    );
  }

  // The operator holds powers that can drain or brick the protocol. Being the
  // same key that just deployed it means one compromised laptop is the whole
  // trust model. Not fatal on its own, but it should never pass silently.
  if (cfg.operator && cfg.deployer &&
      cfg.operator.toLowerCase() === cfg.deployer.toLowerCase()) {
    problems.push(
      "operator is the deploying EOA. Production wants a multisig, distinct " +
      "from the deployer and from the factory owner."
    );
  }

  // Covenza recognising its own key means it can admit any wallet with a
  // signature it produced — the exact arrangement the attester redesign
  // removed. It came back through a deploy script's default, so it is checked
  // here rather than trusted to stay fixed.
  if (cfg.attesterKey && cfg.deployer &&
      cfg.attesterKey.toLowerCase() === cfg.deployer.toLowerCase()) {
    problems.push(
      "the initial attester is the deploying key. Covenza would be its own " +
      "identity provider, able to verify any wallet without a check."
    );
  }

  // Hard checks: never waivable.
  const hard = [];
  if (cfg.tiers) {
    const c = calibrationProblem(cfg.tiers);
    if (c) { hard.push(c); }
  }
  const roles = [["operator", cfg.operator], ["treasury", cfg.treasury], ["attester", cfg.attesterKey]]
    .filter(([, a]) => a);
  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      if (roles[i][1].toLowerCase() === roles[j][1].toLowerCase()) {
        hard.push(`the ${roles[i][0]} and the ${roles[j][0]} are the same address (${roles[i][1]}). Each must be separate.`);
      }
    }
  }
  if (hard.length > 0) {
    throw new Error(`Refusing to deploy to ${networkName}. These cannot be overridden:\n` +
      hard.map((p) => `  - ${p}`).join("\n"));
  }

  if (problems.length === 0) { return; }

  const message =
    `Refusing to deploy to ${networkName} with a testnet configuration:\n` +
    problems.map((p) => `  - ${p}`).join("\n");

  if (process.env.ALLOW_UNSAFE_PRODUCTION === "1") {
    console.warn("\n" + "!".repeat(70));
    console.warn(message);
    console.warn("\nPROCEEDING ANYWAY because ALLOW_UNSAFE_PRODUCTION=1.");
    console.warn("!".repeat(70) + "\n");
    return;
  }

  throw new Error(message + "\n\nSet ALLOW_UNSAFE_PRODUCTION=1 to override.");
}

module.exports = {
  guardProductionConfig,
  calibrationProblem,
  isProduction,
  needsOutageDetection,
  MIN_TWAP_WINDOW,
  MIN_TIMELOCK,
};
