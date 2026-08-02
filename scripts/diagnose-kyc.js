/**
 * Reports what the KYC registry actually says about a wallet.
 *
 * Written because the app and the mock verifier disagreed about whether the
 * same address was verified on the same registry, and neither is authoritative
 * — the chain is. Reads both the current registry and the previous one, since
 * the usual cause of that disagreement is one party still talking to the
 * registry that was replaced.
 *
 * All reads. Costs nothing.
 *
 * Usage:
 *   WALLET=0x… npx hardhat run scripts/diagnose-kyc.js --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const WALLET = process.env.WALLET || "0x6369ffc9F3D8cdAB69Fa0e6C002ABE617A5D576D";

async function main() {
  const { ethers } = hre;

  const deployed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  )[hre.network.name];

  const factory = await ethers.getContractAt("VaultFactory", deployed.vaultFactory);

  console.log("=".repeat(70));
  console.log(`Wallet ${WALLET}`);
  console.log("=".repeat(70));

  // The factory's own pointer is the one that decides whether origination is
  // allowed, so it is checked rather than assumed to match the JSON.
  const factoryRegistry = await factory.kycRegistry();
  console.log(`\nFactory points at   ${factoryRegistry}`);
  console.log(`JSON records        ${deployed.kycRegistry}`);
  console.log(`Previous registry   ${deployed.previousKycRegistry || "(none)"}`);
  if (factoryRegistry.toLowerCase() !== (deployed.kycRegistry || "").toLowerCase()) {
    console.log("  ^ MISMATCH — the factory and deployed-addresses.json disagree.");
  }

  for (const [label, addr] of [
    ["current", deployed.kycRegistry],
    ["previous", deployed.previousKycRegistry],
  ]) {
    if (!addr) continue;
    if ((await ethers.provider.getCode(addr)) === "0x") {
      console.log(`\n--- ${label} (${addr}) --- no code`);
      continue;
    }

    const reg = await ethers.getContractAt("KYCRegistry", addr);
    console.log(`\n--- ${label} (${addr}) ---`);
    try {
      console.log(`  isVerified   ${await reg.isVerified(WALLET)}`);
      console.log(`  nonce        ${await reg.nonces(WALLET)}`);
    } catch (e) {
      console.log(`  read failed: ${(e.shortMessage || e.message).slice(0, 70)}`);
    }
    try {
      console.log(`  attestedBy   ${await reg.attestedBy(WALLET)}`);
      const keys = await reg.allAttesters();
      for (const k of keys) {
        const a = await reg.attesters(k);
        console.log(`  attester     ${a.recognised ? "LIVE    " : "delisted"} ${k}  ${a.name}`);
      }
    } catch {
      console.log("  (no attester surface — pre-upgrade registry)");
    }
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
