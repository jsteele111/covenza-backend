const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer, localBorrower] = await hre.ethers.getSigners();

  // --- Use the real borrower on Sepolia, the local test signer when testing locally ---
  const REAL_BORROWER_ADDRESS = "0x6369ffc9F3D8cdAB69Fa0e6C002ABE617A5D576D";
  const isLocalNetwork = hre.network.name === "hardhat" || hre.network.name === "localhost";
  const borrowerAddress = isLocalNetwork ? localBorrower.address : REAL_BORROWER_ADDRESS;

  console.log("Deploying infrastructure (KYCRegistry + VaultFactory)...");
  console.log("Network:                     ", hre.network.name);
  console.log("Deployer / operator / lender:", deployer.address);
  console.log("Borrower to verify:          ", borrowerAddress);

  // --- Step 1: Deploy KYCRegistry ---
  const KYCRegistry = await hre.ethers.getContractFactory("KYCRegistry");
  const registry = await KYCRegistry.deploy(deployer.address);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("\n✅ KYCRegistry deployed:", registryAddress);

  // --- Step 2: Verify the borrower ---
  const verifyTx = await registry.verify(borrowerAddress);
  await verifyTx.wait();
  console.log("✅ Borrower verified:", borrowerAddress);

  // --- Step 3: Deploy VaultFactory ---
  const VaultFactoryContract = await hre.ethers.getContractFactory("VaultFactory");
  const factory = await VaultFactoryContract.deploy(registryAddress);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("✅ VaultFactory deployed:", factoryAddress);

  // --- Step 4: Save addresses for deploy-vault.js ---
  const addresses = {
    network: hre.network.name,
    kycRegistry: registryAddress,
    vaultFactory: factoryAddress,
    operator: deployer.address,
    verifiedBorrower: borrowerAddress,
    deployedAt: new Date().toISOString()
  };

  const outputPath = path.join(__dirname, "..", "deployed-addresses.json");
  const rawContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").trim() : "";
  const allAddresses = rawContent.length > 0 ? JSON.parse(rawContent) : {};
  allAddresses[hre.network.name] = addresses;
  fs.writeFileSync(outputPath, JSON.stringify(allAddresses, null, 2));
  console.log("\n📄 Addresses saved to deployed-addresses.json");
  console.log("\nExplorer links:");
  console.log("   Registry: https://sepolia.arbiscan.io/address/" + registryAddress);
  console.log("   Factory:  https://sepolia.arbiscan.io/address/" + factoryAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
