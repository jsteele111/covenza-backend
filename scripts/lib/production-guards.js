/**
 * Refuses a production deployment carrying a testnet configuration.
 *
 * WHY THIS EXISTS: every value below is VALID. The contracts accept a 60-second
 * TWAP window, a zero timelock delay, and a mock yield venue — they have to,
 * because testing needs them. That is precisely the danger: nothing reverts, no
 * test fails, and the mistake is invisible until it is exploited.
 *
 * Three specific near-misses this guards against:
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
 *   - The ERC-4626 venue is a mock. There is no real vault on Robinhood Chain
 *     to replace it with, so mainnet must ship with every venue set to None
 *     rather than trusting whoever runs the script to remember.
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

/**
 * Asserts no whitelisted asset points at a yield venue.
 *
 * Separate from the config check because it runs AFTER assets are listed, and
 * because it needs the registry rather than a plain object.
 */
async function guardNoYieldVenues(networkName, registry, assets) {
  if (!isProduction(networkName)) { return; }

  const withVenue = [];
  for (const asset of assets) {
    const [venue] = await registry.venueOf(asset);
    if (Number(venue) !== 0) { withVenue.push({ asset, venue: Number(venue) }); }
  }
  if (withVenue.length === 0) { return; }

  const message =
    `Refusing production deployment: ${withVenue.length} asset(s) have a yield venue set.\n` +
    withVenue.map((w) => `  - ${w.asset} (venue ${w.venue})`).join("\n") +
    `\nThe only ERC-4626 implementation in this repo is a mock, and no real ` +
    `vault exists on this chain. Ship with venues set to None.`;

  if (process.env.ALLOW_UNSAFE_PRODUCTION === "1") {
    console.warn("\n" + message + "\nPROCEEDING because ALLOW_UNSAFE_PRODUCTION=1.\n");
    return;
  }
  throw new Error(message + "\n\nSet ALLOW_UNSAFE_PRODUCTION=1 to override.");
}

module.exports = {
  guardProductionConfig,
  guardNoYieldVenues,
  isProduction,
  MIN_TWAP_WINDOW,
  MIN_TIMELOCK,
};
