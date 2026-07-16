const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [lender] = await hre.ethers.getSigners();

  // --- Load infrastructure addresses saved by deploy-infrastructure.js ---
  const addressesPath = path.join(__dirname, "..", "deployed-addresses.json");
  if (!fs.existsSync(addressesPath)) {
    throw new Error("deployed-addresses.json not found — run deploy-infrastructure.js first.");
  }
  const allAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const addresses = allAddresses[hre.network.name];
  if (!addresses) {
    throw new Error(`No infrastructure found for network "${hre.network.name}" — run deploy-infrastructure.js on this network first.`);
  }
  const factoryAddress = addresses.vaultFactory;

  // --- Loan terms (short/testnet timing) ---
  const borrowerAddress   = addresses.verifiedBorrower;
  const principalAmount   = hre.ethers.parseEther("0.001");
  const feeRateBps        = 300n; // 3%, charged in full regardless of early or on-time close
  const depositAmount     = hre.ethers.parseEther("0.00015"); // 15% of principal
  const durationSeconds   = 3600; // 1 hour — enough slack for a full interactive test session

  console.log("Originating SHORT-DURATION test loan via VaultFactory...");
  console.log("Factory:      ", factoryAddress);
  console.log("Lender:       ", lender.address);
  console.log("Borrower:     ", borrowerAddress);
  console.log("Principal:    ", hre.ethers.formatEther(principalAmount), "ETH");
  console.log("Fee rate:     ", Number(feeRateBps) / 100, "%");
  console.log("Deposit req:  ", hre.ethers.formatEther(depositAmount), "ETH");
  console.log("Duration:     ", durationSeconds, "seconds");

  const factory = await hre.ethers.getContractAt("VaultFactory", factoryAddress);

  const tx = await factory.deployVault(
    borrowerAddress,
    feeRateBps,
    durationSeconds,
    true, // _useSeconds = true — short/testnet timing
    depositAmount,
    { value: principalAmount }
  );

  const receipt = await tx.wait();

  let vaultAddress = null;
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed.name === "VaultDeployed") {
        vaultAddress = parsed.args.vault;
      }
    } catch (e) {
      // log from a different contract/interface — ignore
    }
  }

  if (!vaultAddress) {
    throw new Error("VaultDeployed event not found in transaction receipt.");
  }

  console.log("\n✅ Short-duration vault deployed via factory!");
  console.log("   Vault address:", vaultAddress);
  console.log("   Tx hash:      ", tx.hash);
  console.log("   Explorer:     https://sepolia.arbiscan.io/address/" + vaultAddress);
  console.log("\n   This vault expires in", durationSeconds, "seconds from deployment.");
  console.log("   Next: borrower must call payDeposit() with", hre.ethers.formatEther(depositAmount), "ETH");

  const vaultsPath = path.join(__dirname, "..", "deployed-vaults.json");
  const existing = fs.existsSync(vaultsPath)
    ? JSON.parse(fs.readFileSync(vaultsPath, "utf8"))
    : [];

  existing.push({
    vaultAddress,
    network: hre.network.name,
    txHash: tx.hash,
    lender: lender.address,
    borrower: borrowerAddress,
    principal: hre.ethers.formatEther(principalAmount),
    feeRateBps: feeRateBps.toString(),
    depositRequired: hre.ethers.formatEther(depositAmount),
    durationSeconds,
    useSeconds: true,
    deployedAt: new Date().toISOString()
  });

  fs.writeFileSync(vaultsPath, JSON.stringify(existing, null, 2));
  console.log("📄 Vault record saved to deployed-vaults.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});