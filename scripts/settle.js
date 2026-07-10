const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  // --- Load the most recently deployed vault for this network ---
  const vaultsPath = path.join(__dirname, "..", "deployed-vaults.json");
  if (!fs.existsSync(vaultsPath)) {
    throw new Error("deployed-vaults.json not found — run deploy-vault.js first.");
  }
  const vaults = JSON.parse(fs.readFileSync(vaultsPath, "utf8"));
  const vaultsOnThisNetwork = vaults.filter(v => v.network === hre.network.name);
  if (vaultsOnThisNetwork.length === 0) {
    throw new Error(`No vaults found for network "${hre.network.name}" in deployed-vaults.json.`);
  }
  const vaultAddress = vaultsOnThisNetwork[vaultsOnThisNetwork.length - 1].vaultAddress;

  const [lender] = await hre.ethers.getSigners();

  console.log("Triggering default settlement...");
  console.log("Caller (keeper):", lender.address);
  console.log("Vault:", vaultAddress);

  const vault = await hre.ethers.getContractAt("Vault", vaultAddress);

  // --- Local networks only: force a block to be mined so block.timestamp catches up to real time ---
  const isLocalNetwork = hre.network.name === "hardhat" || hre.network.name === "localhost";
  if (isLocalNetwork) {
    await hre.network.provider.send("evm_mine");
  }

  // Check current state before settling
  const isExpired  = await vault.isExpired();
  const balance    = await vault.vaultBalance();
  console.log("\nVault isExpired:", isExpired);
  console.log("Vault balance:", hre.ethers.formatEther(balance), "ETH");

  if (!isExpired) {
    console.log("\n❌ Vault has not yet expired (or is already settled). Wait longer and try again.");
    return;
  }

  const lenderBalanceBefore = await hre.ethers.provider.getBalance(lender.address);

  const tx = await vault.settleDefault();
  console.log("\nTransaction sent, waiting for confirmation...");
  const receipt = await tx.wait();

  const lenderBalanceAfter = await hre.ethers.provider.getBalance(lender.address);

  console.log("\n✅ Default settlement confirmed!");
  console.log("   Transaction hash:", receipt.hash);
  console.log("   View on explorer: https://sepolia.arbiscan.io/tx/" + receipt.hash);
  console.log("   Vault isSettled:", await vault.isSettled());
  console.log("   Vault remaining balance:", hre.ethers.formatEther(await vault.vaultBalance()), "ETH");
  console.log("   Lender balance change:", hre.ethers.formatEther(lenderBalanceAfter - lenderBalanceBefore), "ETH");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
