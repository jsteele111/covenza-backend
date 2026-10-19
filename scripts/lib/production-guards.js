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
 * Override with ALLOW_UNSAFE_PRODUCTION=1 — deliberately ugly, and it prints
 * what is being waived so it appears in the terminal history.
 */

const PRODUCTION_NETWORKS = ["robinhoodMainnet", "mainnet", "arbitrum"];

const MIN_TWAP_WINDOW   = 1800;   // 30 minutes
const MIN_TIMELOCK      = 24 * 3600;

function isProduction(networkName) {
  return PRODUCTION_NETWORKS.includes(networkName);
}

/**
 * @param {string} networkName        hre.network.name
 * @param {object} cfg
 * @param {number} [cfg.timelockDelay]
 * @param {number} [cfg.twapWindow]
 * @param {number} [cfg.outageGapThreshold] sequencer-outage detection (0 = off)
 * @param {string} [cfg.operator]     intended operator address
 * @param {string} [cfg.deployer]     the deploying EOA
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
  if (cfg.outageGapThreshold !== undefined && Number(cfg.outageGapThreshold) === 0) {
    problems.push(
      "sequencer-outage detection is disabled (gap threshold 0). Production " +
      "needs it on, with a heartbeat bot running."
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
  isProduction,
  MIN_TWAP_WINDOW,
  MIN_TIMELOCK,
};
