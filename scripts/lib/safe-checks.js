/**
 * Security review S1 and S2 (26 Nov 2026): on a production network, anything
 * that holds admin control or receives protocol fees must be a real multisig
 * that needs at least 2 signatures from at least 3 owners, and must not be
 * controlled by the deploying key alone.
 *
 * Why 2 of 3: a 1-of-1 Safe is no safer than the key behind it, and a 2-of-2
 * Safe is locked for good if either key is lost. 2 of 3 is the smallest
 * set-up that survives both one stolen key and one lost key.
 */

const MIN_THRESHOLD = 2;
const MIN_OWNERS = 3;

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

/**
 * Returns { owners, threshold } or throws, naming what is wrong.
 * @param {object} ethers   hre.ethers
 * @param {string} address  the Safe
 * @param {string} label    for messages, e.g. "Operator Safe"
 */
async function requireProductionSafe(ethers, address, label) {
  if (!address || !ethers.isAddress(address)) { throw new Error(`${label} is not a valid address.`); }
  if ((await ethers.provider.getCode(address)) === "0x") {
    throw new Error(`${label} (${address}) has no contract code: it is a single key, not a Safe.`);
  }
  const safe = new ethers.Contract(address, SAFE_ABI, ethers.provider);
  let owners, threshold;
  try {
    owners = await safe.getOwners();
    threshold = Number(await safe.getThreshold());
  } catch {
    throw new Error(`${label} (${address}) is a contract, but not a Safe: it has no owners or threshold.`);
  }
  if (owners.length < MIN_OWNERS || threshold < MIN_THRESHOLD) {
    throw new Error(`${label} (${address}) needs ${threshold} of ${owners.length} signatures; production needs at least ${MIN_THRESHOLD} of ${MIN_OWNERS}.`);
  }
  return { owners, threshold };
}

module.exports = { requireProductionSafe, MIN_THRESHOLD, MIN_OWNERS };
