const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Deploys a fresh VaultFactory only, pointing at the EXISTING KYCRegistry
// address — used when VaultFactory/Vault logic changes but KYCRegistry
// itself is unchanged. Redeploying KYCRegistry would be wasteful and
// destructive: it would reset every verified address and badge back to
// zero for no reason, since nothing about identity verification changed.

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const addressesPath = path.join(__dirname, "..", "deployed-addresses.json");
  if (!fs.existsSync(addressesPath)) {
    throw new Error("deployed-addresses.json not found — run deploy-infrastructure.js first.");
  }
  const allAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const existing = allAddresses[hre.network.name];
  if (!existing || !existing.kycRegistry) {
    throw new Error(`No existing KYCRegistry found for network "${hre.network.name}".`);
  }

  const existingRegistryAddress = existing.kycRegistry;

  console.log("Deploying VaultFactory only (KYCRegistry unchanged)...");
  console.log("Network:               ", hre.network.name);
  console.log("Deployer:              ", deployer.address);
  console.log("Existing KYCRegistry:  ", existingRegistryAddress);

  // Sanity check: confirm the existing registry actually has code at that
  // address before pointing a brand new factory at it — same "don't trust,
  // verify" principle as everything else.
  const code = await hre.ethers.provider.getCode(existingRegistryAddress);
  if (code === "0x") {
    throw new Error(`No contract code found at ${existingRegistryAddress} — refusing to deploy against a non-existent registry.`);
  }
  console.log("✅ Confirmed KYCRegistry has deployed code at that address.");

  const VaultFactoryContract = await hre.ethers.getContractFactory("VaultFactory");
  const factory = await VaultFactoryContract.deploy(existingRegistryAddress);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  console.log("\n✅ New VaultFactory deployed:", factoryAddress);

  // --- Save updated address, preserving the unchanged registry ---
  const updated = {
    ...existing,
    vaultFactory: factoryAddress,
    vaultFactoryRedeployedAt: new Date().toISOString(),
    previousVaultFactory: existing.vaultFactory, // keep for reference/audit trail
  };

  allAddresses[hre.network.name] = updated;
  fs.writeFileSync(addressesPath, JSON.stringify(allAddresses, null, 2));

  console.log("📄 deployed-addresses.json updated.");
  console.log("   kycRegistry (UNCHANGED):", updated.kycRegistry);
  console.log("   vaultFactory (NEW):     ", updated.vaultFactory);
  console.log("   vaultFactory (previous):", updated.previousVaultFactory);
  console.log("\nExplorer link: https://sepolia.arbiscan.io/address/" + factoryAddress);
  console.log("\n⚠️  Next steps:");
  console.log("   1. Update the frontend's config/contracts.js with this new vaultFactory address.");
  console.log("   2. Do NOT change kycRegistry anywhere — it's unchanged.");
  console.log("   3. Any vault deployed via the OLD factory continues to run old Vault.sol logic.");
  console.log("      Only NEW vaults, deployed via this new factory, get the redesigned settle().");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});