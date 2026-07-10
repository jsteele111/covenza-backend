const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  // --- Load the most recently deployed vault ---
  const vaultsPath = path.join(__dirname, "..", "deployed-vaults.json");
  if (!fs.existsSync(vaultsPath)) {
    throw new Error("deployed-vaults.json not found — run deploy-vault.js first.");
  }
  const vaults = JSON.parse(fs.readFileSync(vaultsPath, "utf8"));
  if (vaults.length === 0) {
    throw new Error("deployed-vaults.json is empty — no vaults recorded.");
  }
  const vaultsOnThisNetwork = vaults.filter(v => v.network === hre.network.name);
  if (vaultsOnThisNetwork.length === 0) {
    throw new Error(`No vaults found for network "${hre.network.name}" in deployed-vaults.json.`);
  }
  const vaultAddress = vaultsOnThisNetwork[vaultsOnThisNetwork.length - 1].vaultAddress;

  // Index 1 = borrower account (per hardhat.config.js order)
  const [lender, borrower] = await hre.ethers.getSigners();

  const vault = await hre.ethers.getContractAt("Vault", vaultAddress);

  // --- Ask the vault itself how much is required, rather than hardcoding it ---
  const depositAmount = await vault.requiredDeposit();

  console.log("Paying deposit as borrower:", borrower.address);
  console.log("Vault:", vaultAddress);
  console.log("Deposit amount:", hre.ethers.formatEther(depositAmount), "ETH");

  // Confirm the vault isn't already settled (covers the repaid-and-zeroed-deposit case)
  const alreadySettled = await vault.isSettled();
  if (alreadySettled) {
    console.log("\n❌ This vault is already settled — cannot pay deposit.");
    return;
  }

  // Confirm deposit not yet paid
  const alreadyPaid = await vault.depositPaid();
  if (alreadyPaid) {
    console.log("\n❌ Deposit already paid for this vault.");
    return;
  }

  const tx = await vault.connect(borrower).payDeposit({ value: depositAmount });
  console.log("\nTransaction sent, waiting for confirmation...");
  const receipt = await tx.wait();

  console.log("\n✅ Deposit confirmed!");
  console.log("   Transaction hash:", receipt.hash);
  console.log("   View on explorer: https://sepolia.arbiscan.io/tx/" + receipt.hash);
  console.log("   Deposit paid:", await vault.depositPaid());
  console.log("   Vault balance:", hre.ethers.formatEther(await vault.vaultBalance()), "ETH");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
