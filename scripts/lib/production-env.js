/**
 * Which environment file a run reads, and typed confirmation of the
 * addresses a production deployment hands money and control to.
 *
 * Security review S5 (26 Nov 2026): a production network reads ONLY its own
 * file, `.env.<network>` (`.env.mainnet` for Ethereum, `.env.robinhoodMainnet`
 * for Robinhood Chain), and signs ONLY with that file's DEPLOYER_PRIVATE_KEY.
 * Every other run reads the everyday `.env`. So a test key, a testnet RPC or a
 * leftover testnet address can never reach a production deployment, and a
 * production key is never loaded for a test. `.gitignore` already excludes
 * `.env.*`, so these files can never be committed.
 *
 * Security review S1: before a production deployment, the operator Safe and
 * the treasury must be confirmed by typing them in the terminal for that run
 * (CONFIRM_OPERATOR_SAFE, CONFIRM_TREASURY). A confirmation stored in the
 * environment file is refused: the point is that a person checks the address
 * at the moment of deployment, not that a file agrees with itself.
 */

const fs = require("fs");
const path = require("path");

const PRODUCTION_ENV_NETWORKS = ["mainnet", "robinhoodMainnet"];

/** The network this process was started for: `--network x`, else HARDHAT_NETWORK, else "hardhat". */
function selectedNetwork(argv = process.argv, env = process.env) {
  const i = argv.indexOf("--network");
  if (i >= 0 && argv[i + 1]) { return argv[i + 1]; }
  return env.HARDHAT_NETWORK || "hardhat";
}

/** `.env.<network>` for a production network, `.env` for everything else. */
function envFileFor(network, root) {
  return path.join(root, PRODUCTION_ENV_NETWORKS.includes(network) ? `.env.${network}` : ".env");
}

/**
 * Refuses unless `CONFIRM_<name>` was typed for this run and equals `value`.
 * @param {object} o
 * @param {string} o.name     e.g. "TREASURY" (reads CONFIRM_TREASURY)
 * @param {string} o.value    the address the deployment will use
 * @param {string} o.envFile  the environment file this run loaded
 * @param {object} [o.env]    defaults to process.env
 */
function requireTypedConfirmation({ name, value, envFile, env = process.env }) {
  const key = `CONFIRM_${name}`;
  if (fs.existsSync(envFile)) {
    const parsed = require("dotenv").parse(fs.readFileSync(envFile));
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      throw new Error(`${key} is stored in ${path.basename(envFile)}. Remove it: confirmations must be typed in the terminal for each run.`);
    }
  }
  const typed = env[key];
  if (!typed) {
    throw new Error(`Confirm the ${name.toLowerCase().replace(/_/g, " ")} by typing it for this run: $env:${key}="${value}"`);
  }
  if (typed.toLowerCase() !== String(value).toLowerCase()) {
    throw new Error(`${key} (${typed}) does not match the address this deployment would use (${value}).`);
  }
}

module.exports = { PRODUCTION_ENV_NETWORKS, selectedNetwork, envFileFor, requireTypedConfirmation };
