/**
 * Lists the identity providers whose attestations this registry accepts.
 *
 * Replaces a check against a single `verifierKey`. Covenza no longer issues
 * attestations — it recognises attestations issued independently by providers
 * on this list — so the meaningful question is no longer "is our key correct"
 * but "who can currently admit a borrower".
 *
 * Also drops the hardcoded Arbitrum Sepolia address the old version carried;
 * it reads deployed-addresses.json for whichever network is selected, which
 * is the only version that stays true after a redeploy.
 *
 * All reads. Costs nothing.
 *
 * Usage:
 *   npx hardhat run scripts/check-verifier-key.js --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const REGISTRY_ABI = [
  "function operator() view returns (address)",
  "function allAttesters() view returns (address[])",
  "function attesters(address) view returns (bool recognised, string name, string url, uint256 addedAt)",
];

async function main() {
  const { ethers } = hre;

  const deployed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  )[hre.network.name];

  if (!deployed?.kycRegistry) {
    throw new Error(`No kycRegistry recorded for ${hre.network.name}.`);
  }

  const registry = await ethers.getContractAt(REGISTRY_ABI, deployed.kycRegistry);

  console.log("=".repeat(70));
  console.log(`KYC registry ${deployed.kycRegistry}`);
  console.log(`Operator     ${await registry.operator()}`);
  console.log("=".repeat(70));

  const keys = await registry.allAttesters();
  if (keys.length === 0) {
    console.log("\nNo attesters have ever been registered — nobody can be verified.");
    return;
  }

  console.log("\n--- attesters ---");
  let live = 0;
  for (const key of keys) {
    const a = await registry.attesters(key);
    if (a.recognised) live++;
    const added = new Date(Number(a.addedAt) * 1000).toISOString().slice(0, 10);
    console.log(
      `  ${a.recognised ? "LIVE    " : "delisted"}  ${key}  ${a.name} (added ${added})`
    );
    if (a.url) console.log(`  ${" ".repeat(52)}${a.url}`);
  }

  console.log(`\n${live} of ${keys.length} recognised.`);
  if (live === 0) {
    console.log("No live attester — no new borrower can be verified by signature.");
  }
  console.log("\nDelisted keys are still listed because the list is history: wallets");
  console.log("they admitted stay verified, and attestedBy(wallet) records which key.");
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
