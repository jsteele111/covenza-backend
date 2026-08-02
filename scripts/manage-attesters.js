/**
 * Adds, removes or rotates an identity provider's signing key.
 *
 * Replaces set-verifier-key.js, which rotated the one key Covenza used to
 * sign its own attestations. Covenza no longer attests to anything: providers
 * verify borrowers independently and sign for them, and this list decides
 * whose signatures the registry will accept.
 *
 * SAFETY: adding an attester is the most consequential admin action in the
 * protocol. A recognised key can admit any wallet, and the registry cannot
 * check that a real identity check happened — only that the signature came
 * from a key on this list. Curation is the entire control.
 *
 * Usage:
 *   ACTION=list                                  npx hardhat run scripts/manage-attesters.js --network robinhoodTestnet
 *   ACTION=add    KEY=0x… NAME="Provider"        npx hardhat run scripts/manage-attesters.js --network robinhoodTestnet
 *   ACTION=remove KEY=0x…                        npx hardhat run scripts/manage-attesters.js --network robinhoodTestnet
 *   ACTION=rotate OLD_KEY=0x… KEY=0x…            npx hardhat run scripts/manage-attesters.js --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ACTION  = (process.env.ACTION || "list").toLowerCase();
const KEY     = process.env.KEY || "";
const OLD_KEY = process.env.OLD_KEY || "";
const NAME    = process.env.NAME || "";
const URL     = process.env.URL || "";

async function main() {
  const { ethers } = hre;
  const [operator] = await ethers.getSigners();

  const deployed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  )[hre.network.name];

  if (!deployed?.kycRegistry) {
    throw new Error(`No kycRegistry recorded for ${hre.network.name}.`);
  }

  const registry = await ethers.getContractAt("KYCRegistry", deployed.kycRegistry);

  console.log(`Network  ${hre.network.name}`);
  console.log(`Registry ${deployed.kycRegistry}`);
  console.log(`Caller   ${operator.address}`);

  const onChainOperator = await registry.operator();
  if (ACTION !== "list" && onChainOperator.toLowerCase() !== operator.address.toLowerCase()) {
    throw new Error(`Caller is not the operator (${onChainOperator}).`);
  }

  if (ACTION === "add") {
    if (!ethers.isAddress(KEY)) throw new Error("KEY must be a valid address.");
    if (!NAME) throw new Error("NAME is required — an unnamed attester cannot be audited.");
    if (!URL) throw new Error("URL is required — it is what an unverified borrower is sent to.");
    console.log(`\nRecognising ${KEY} as "${NAME}" (${URL}).`);
    console.log("This key will be able to admit any wallet to the protocol.");
    await (await registry.addAttester(KEY, NAME, URL)).wait();
    console.log("Done.");
  } else if (ACTION === "remove") {
    if (!ethers.isAddress(KEY)) throw new Error("KEY must be a valid address.");
    console.log(`\nDelisting ${KEY}.`);
    console.log("Wallets it already admitted stay verified — find them via attestedBy().");
    await (await registry.removeAttester(KEY)).wait();
    console.log("Done.");
  } else if (ACTION === "rotate") {
    if (!ethers.isAddress(OLD_KEY) || !ethers.isAddress(KEY)) {
      throw new Error("OLD_KEY and KEY must both be valid addresses.");
    }
    console.log(`\nRotating ${OLD_KEY} -> ${KEY}, keeping the provider's name.`);
    await (await registry.rotateAttester(OLD_KEY, KEY)).wait();
    console.log("Done.");
  } else if (ACTION !== "list") {
    throw new Error(`Unknown ACTION "${ACTION}". Use list, add, remove or rotate.`);
  }

  const keys = await registry.allAttesters();
  console.log("\n--- attesters ---");
  if (keys.length === 0) {
    console.log("  (none — nobody can be verified by signature)");
  }
  for (const k of keys) {
    const a = await registry.attesters(k);
    console.log(`  ${a.recognised ? "LIVE    " : "delisted"}  ${k}  ${a.name}${a.url ? `  ${a.url}` : ""}`);
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
