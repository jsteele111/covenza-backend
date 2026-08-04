/**
 * Changes one tier's risk parameters, leaving the rest as they are.
 *
 * setTierConfig takes all five values at once — deliberately, so a tier is
 * always a coherent statement of policy rather than a pile of independent
 * dials. That makes it easy to change one thing and clobber the other four by
 * retyping them from memory. This reads the current values first and overrides
 * only what is passed.
 *
 * Applies to NEW loans only. Vaults snapshot what they need at origination, and
 * tier history means a live loan cannot be widened by a later change.
 *
 * Usage:
 *   TIER=0 MAX_EXPOSURE_BPS=7000 npx hardhat run scripts/set-tier-config.js --network robinhoodTestnet
 *   TIER=2 PREMIUM_BPS=100       npx hardhat run scripts/set-tier-config.js --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const NAMES = ["Blue chip", "Standard", "Speculative"];
const TIER = Number(process.env.TIER ?? -1);

async function main() {
  const { ethers } = hre;
  const [operator] = await ethers.getSigners();

  if (TIER < 0 || TIER > 2) throw new Error("Set TIER to 0, 1 or 2.");

  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  )[hre.network.name];
  const registry = await ethers.getContractAt("AssetRegistry", d.assetRegistry);

  const op = await registry.operator();
  if (op.toLowerCase() !== operator.address.toLowerCase()) {
    throw new Error(`Caller is not the registry operator (${op}).`);
  }

  const cur = await registry.tierConfig(TIER);
  const next = {
    vol:     BigInt(process.env.VOL_BPS            ?? cur[0]),
    minDep:  BigInt(process.env.MIN_DEPOSIT_BPS    ?? cur[1]),
    maxTerm: BigInt(process.env.MAX_TERM_SECONDS   ?? cur[2]),
    maxExp:  BigInt(process.env.MAX_EXPOSURE_BPS   ?? cur[3]),
    prem:    BigInt(process.env.PREMIUM_BPS        ?? cur[4]),
  };

  console.log(`Registry ${d.assetRegistry}`);
  console.log(`Tier     ${TIER} — ${NAMES[TIER]}\n`);

  const rows = [
    ["assumed volatility", cur[0], next.vol, "bps"],
    ["minimum deposit",    cur[1], next.minDep, "bps"],
    ["max term",           cur[2], next.maxTerm, "s"],
    ["max exposure",       cur[3], next.maxExp, "bps"],
    ["insurance premium",  cur[4], next.prem, "bps"],
  ];
  let changed = false;
  for (const [label, from, to, unit] of rows) {
    const moved = BigInt(from) !== BigInt(to);
    if (moved) changed = true;
    console.log(`  ${label.padEnd(20)} ${String(from).padStart(9)} -> ${String(to).padStart(9)} ${unit}` +
                (moved ? "   <-- changed" : ""));
  }

  if (!changed) {
    console.log("\nNothing to change.");
    return;
  }

  await (await registry.setTierConfig(
    TIER, next.vol, next.minDep, next.maxTerm, next.maxExp, next.prem
  )).wait();

  console.log("\nApplied. Existing loans are unaffected — vaults snapshot at origination.");
  console.log("Re-run model-insurance-solvency.js to see the effect on coverage.");
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
