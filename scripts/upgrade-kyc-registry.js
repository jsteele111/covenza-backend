/**
 * Deploys the attester-based KYCRegistry and repoints the existing factory
 * at it.
 *
 * WHY THIS IS CHEAP: VaultFactory holds its registries in storage, not as
 * immutables, and exposes setRegistries to the owner. So the KYC registry can
 * be replaced without touching the factory, the vault implementation, or any
 * live loan. Settlement never consults the KYC registry — only origination
 * does — so an open vault is unaffected either way.
 *
 * WHAT DOES NOT CARRY OVER: verifications. The new registry starts with
 * nobody verified, and each borrower must present an attestation again. That
 * is deliberate rather than an oversight to work around: the old registry
 * recorded that Covenza's own key had signed for a wallet, which is precisely
 * the claim this change exists to stop making. Migrating those records would
 * import the thing being removed.
 *
 * The verifier key from the old registry is carried across as the first
 * recognised attester, so the local mock signer keeps working on testnet.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-kyc-registry.js --network robinhoodTestnet
 *   ATTESTER_NAME="Provider" ATTESTER_URL="https://…" npx hardhat run ... --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ATTESTER_NAME = process.env.ATTESTER_NAME || "Testnet mock signer";
const ATTESTER_URL  = process.env.ATTESTER_URL  || "";

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();

  const addressesPath = path.join(__dirname, "..", "deployed-addresses.json");
  const all = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const existing = all[hre.network.name];

  for (const key of ["kycRegistry", "assetRegistry", "insurancePool", "vaultFactory"]) {
    if (!existing?.[key]) throw new Error(`deployed-addresses.json has no ${key}.`);
    if ((await ethers.provider.getCode(existing[key])) === "0x") {
      throw new Error(`No code at ${key} (${existing[key]}). Run diagnose-chain.js.`);
    }
  }

  const factory = await ethers.getContractAt("VaultFactory", existing.vaultFactory);
  const owner = await factory.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer is not the factory owner (${owner}) — setRegistries would revert.`);
  }

  // Read the outgoing registry's verifier key so the mock signer's existing
  // signatures remain acceptable. Tolerated as a legacy read: the new
  // registry has no such function.
  let carriedKey = null;
  try {
    const legacy = await ethers.getContractAt(
      ["function verifierKey() view returns (address)"],
      existing.kycRegistry
    );
    carriedKey = await legacy.verifierKey();
  } catch {
    carriedKey = null;
  }

  // Deliberately NOT falling back to the deployer. An earlier version did,
  // and the result was that the operator's own address became a recognised
  // attester — meaning Covenza could attest for itself, which is the exact
  // arrangement this upgrade exists to remove. A default that quietly
  // reinstates the thing being removed is worse than a failure.
  const verifierKey = carriedKey || process.env.ATTESTER_KEY;
  if (!verifierKey) {
    throw new Error(
      "Could not read a verifier key from the outgoing registry, and ATTESTER_KEY " +
      "is not set. Pass the identity provider's signing key explicitly — this " +
      "script will not make the deployer an attester."
    );
  }
  if (verifierKey.toLowerCase() === deployer.address.toLowerCase()) {
    throw new Error(
      "The attester key is the deployer. That would let the operator attest for " +
      "itself. Use a key controlled by the identity provider."
    );
  }

  console.log("=".repeat(70));
  console.log("Upgrading the KYC registry to recognised attesters");
  console.log("=".repeat(70));
  console.log(`Outgoing registry  ${existing.kycRegistry}`);
  console.log(`Attester key       ${verifierKey}${carriedKey ? " (carried from old registry)" : " (from ATTESTER_KEY)"}`);

  const Registry = await ethers.getContractFactory("KYCRegistry");
  const registry = await Registry.deploy(deployer.address, verifierKey);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`\nNew registry       ${registryAddress}`);

  // The constructor registers the carried key unnamed and with no URL. Name
  // it properly — an attester nobody can identify cannot be audited, and one
  // with no URL leaves an unverified borrower nowhere to go.
  await (await registry.removeAttester(verifierKey)).wait();
  await (await registry.addAttester(verifierKey, ATTESTER_NAME, ATTESTER_URL)).wait();
  console.log(`Attester           ${ATTESTER_NAME}${ATTESTER_URL ? ` — ${ATTESTER_URL}` : " (no URL)"}`);

  await (await factory.setRegistries(
    registryAddress,
    existing.assetRegistry,
    existing.insurancePool
  )).wait();
  console.log("\nFactory repointed. Asset registry and insurance pool unchanged.");

  const updated = {
    ...existing,
    kycRegistry: registryAddress,
    previousKycRegistry: existing.kycRegistry,
    kycUpgradedAt: new Date().toISOString(),
  };
  all[hre.network.name] = updated;
  fs.writeFileSync(addressesPath, JSON.stringify(all, null, 2));
  console.log("deployed-addresses.json updated.");

  console.log("\n" + "-".repeat(70));
  console.log("Nobody is verified on the new registry — every borrower must present");
  console.log("an attestation again. Open loans are unaffected; settlement does not");
  console.log("consult the registry.");
  console.log("\nFRONTEND — src/config/contracts.js under chain 46630:");
  console.log(`    kycRegistry: "${registryAddress}"`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
