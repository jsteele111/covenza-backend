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

  // Index 1 = borrower account (per hardhat.config.js order)
  const [lender, borrower] = await hre.ethers.getSigners();

  const vault = await hre.ethers.getContractAt("Vault", vaultAddress);

  // --- Ask the vault itself how much is owed, rather than hardcoding it ---
  const repaymentDue = await vault.repaymentDue();

  console.log("Repaying as borrower:", borrower.address);
  console.log("Vault:", vaultAddress);
  console.log("Repayment due:", hre.ethers.formatEther(repaymentDue), "ETH");

  // Guard: don't attempt repayment on an already-settled vault
  const alreadySettled = await vault.isSettled();
  if (alreadySettled) {
    console.log("\n❌ This vault is already settled — cannot repay.");
    return;
  }

  const tx = await vault.connect(borrower).repay({ value: repaymentDue });

  console.log("\nTransaction sent, waiting for confirmation...");
  const receipt = await tx.wait();

  console.log("\n✅ Repayment confirmed!");
  console.log("   Transaction hash:", receipt.hash);
  console.log("   View on explorer: https://sepolia.arbiscan.io/tx/" + receipt.hash);

  const isSettled = await vault.isSettled();
  const balance = await vault.vaultBalance();
  console.log("   Vault isSettled:", isSettled);
  console.log("   Vault remaining balance:", hre.ethers.formatEther(balance), "ETH");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
