/**
 * Hands operator and owner control to multisigs.
 *
 * WHY TWO: the operator curates — whitelists assets, sets tiers, recognises
 * identity providers, manages the pool. The owner can repoint the factory at
 * different registries entirely. Those are different powers with different
 * blast radii, and one key holding both means a single compromise takes the
 * protocol rather than a slice of it.
 *
 * ORDER MATTERS. Operator roles transfer last. Each transfer is one-way — the
 * old holder cannot take the role back — so a mistyped address is unrecoverable
 * on that contract. Every target is checked for contract code first: a
 * multisig has code, a typo'd EOA does not, and "I meant to paste the Safe
 * address" is not a recoverable error.
 *
 * Usage:
 *   OPERATOR_SAFE=0x… OWNER_SAFE=0x… npx hardhat run scripts/transfer-control.js --network robinhoodTestnet
 *   DRY_RUN=1 OPERATOR_SAFE=0x… OWNER_SAFE=0x… npx hardhat run ...   (checks only)
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const OPERATOR_SAFE = process.env.OPERATOR_SAFE || "";
const OWNER_SAFE    = process.env.OWNER_SAFE || "";
const DRY_RUN       = process.env.DRY_RUN === "1";
const ALLOW_EOA     = process.env.ALLOW_EOA === "1";

async function main() {
  const { ethers } = hre;
  const [current] = await ethers.getSigners();

  if (!ethers.isAddress(OPERATOR_SAFE)) throw new Error("Set OPERATOR_SAFE to a valid address.");
  if (!ethers.isAddress(OWNER_SAFE))    throw new Error("Set OWNER_SAFE to a valid address.");

  if (OPERATOR_SAFE.toLowerCase() === OWNER_SAFE.toLowerCase()) {
    console.log("\nNOTE: operator and owner are the same address. That is a real");
    console.log("improvement on one EOA, but it concentrates curation and the power to");
    console.log("repoint the protocol behind a single threshold.\n");
  }

  // A Safe has code. An EOA does not. Transferring to a typo'd EOA is
  // unrecoverable, so this refuses by default rather than warning.
  for (const [label, addr] of [["OPERATOR_SAFE", OPERATOR_SAFE], ["OWNER_SAFE", OWNER_SAFE]]) {
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") {
      if (!ALLOW_EOA) {
        throw new Error(
          `${label} (${addr}) has no contract code — it is an EOA, not a multisig.\n` +
          `Transfers are one-way. Set ALLOW_EOA=1 only if this is deliberate.`
        );
      }
      console.log(`WARNING: ${label} is an EOA. Proceeding because ALLOW_EOA=1.`);
    }
  }

  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  )[hre.network.name];

  const registry = await ethers.getContractAt("AssetRegistry", d.assetRegistry);
  const kyc      = await ethers.getContractAt("KYCRegistry", d.kycRegistry);
  const pool     = await ethers.getContractAt("InsurancePool", d.insurancePool);
  const factory  = await ethers.getContractAt("VaultFactory", d.vaultFactory);

  console.log("=".repeat(72));
  console.log("Transferring control");
  console.log("=".repeat(72));
  console.log(`From      ${current.address}`);
  console.log(`Operator  -> ${OPERATOR_SAFE}`);
  console.log(`Owner     -> ${OWNER_SAFE}\n`);

  const holders = [
    ["AssetRegistry operator", registry, "operator", "transferOperator", OPERATOR_SAFE],
    ["KYCRegistry operator",   kyc,      "operator", "transferOperator", OPERATOR_SAFE],
    ["InsurancePool operator", pool,     "operator", "transferOperator", OPERATOR_SAFE],
    ["VaultFactory owner",     factory,  "owner",    "transferOwnership", OWNER_SAFE],
  ];

  for (const [label, c, getter, , target] of holders) {
    const held = await c[getter]();
    const ok = held.toLowerCase() === current.address.toLowerCase();
    console.log(`  ${label.padEnd(24)} ${held}  ${ok ? "" : "<-- NOT HELD BY CALLER"}`);
    if (!ok) {
      throw new Error(`${label} is held by ${held}, not the caller. Aborting before any transfer.`);
    }
    if (target === held) {
      console.log(`  ${"".padEnd(24)} already at target`);
    }
  }

  if (DRY_RUN) {
    console.log("\nDRY_RUN=1 — checks passed, nothing sent.");
    return;
  }

  console.log("\nTransferring.\n");
  for (const [label, c, getter, setter, target] of holders) {
    const held = await c[getter]();
    if (held.toLowerCase() === target.toLowerCase()) { continue; }
    await (await c[setter](target)).wait();
    console.log(`  ${label} -> ${target}`);
  }

  console.log(`
The factory owner is NOMINATED, not transferred. The Safe must call
acceptOwnership() to take it — which is the point: it proves the multisig can
transact before anything depends on it. Until then this key still owns it.

The three operator roles ARE transferred, immediately and irreversibly. They
are one-step in the contracts, which is a weaker guarantee than the factory
now has; a mistyped operator address cannot be undone. Worth aligning them on
the same two-step pattern before mainnet.

Verify the Safe can act, then confirm with:
  npx hardhat run scripts/diagnose-chain.js --network ${hre.network.name}`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
