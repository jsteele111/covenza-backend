const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
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

  const [lender, borrower] = await hre.ethers.getSigners();
  const vault = await hre.ethers.getContractAt("Vault", vaultAddress);

  console.log("Supplying vault balance to Aave via WETH Gateway...");
  console.log("Vault:   ", vaultAddress);
  console.log("Borrower:", borrower.address);

  const deadline = await vault.deadline();
  const currentBlock = await hre.ethers.provider.getBlock("latest");
  const now = currentBlock.timestamp;
  console.log("Seconds remaining before deadline:", Number(deadline) - now);

  const isSettled = await vault.isSettled();
  if (isSettled) {
    console.log("\n❌ This vault is already settled — cannot supply to Aave.");
    return;
  }

  const depositPaid = await vault.depositPaid();
  if (!depositPaid) {
    console.log("\n❌ Deposit not yet paid — cannot supply to Aave.");
    return;
  }

  const balance = await vault.vaultBalance();
  if (balance === 0n) {
    console.log("\n❌ Vault balance is zero — nothing to supply.");
    return;
  }

  console.log("Amount to supply:", hre.ethers.formatEther(balance), "ETH (full vault balance)");
  console.log("\n⚠️  Note: this vault will NOT be repayable or settleable after this,");
  console.log("   since withdrawal from Aave isn't built yet.");
  console.log("\nForcing an explicit gas limit to bypass estimation and force broadcast...");

  try {
    const tx = await vault.connect(borrower).supplyToAave(balance, { gasLimit: 500000 });
    console.log("Tx hash:", tx.hash);
    console.log("View on explorer: https://sepolia.arbiscan.io/tx/" + tx.hash);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      console.log("\n✅ Supply to Aave confirmed!");
      console.log("   Vault balance after supply:", hre.ethers.formatEther(await vault.vaultBalance()), "ETH");
      console.log("   aWETH token: 0xf5f17EbE81E516Dc7cB38D61908EC252F150CE60");
    } else {
      console.log("\n❌ Transaction was mined but reverted (status 0).");
      console.log("   Check the decoded reason on Arbiscan:");
      console.log("   https://sepolia.arbiscan.io/tx/" + tx.hash);
    }
  } catch (err) {
    console.log("\n❌ Transaction failed.");
    console.log("   Message:", err.message);
    const hash = err.transactionHash || (err.receipt && err.receipt.hash);
    if (hash) {
      console.log("   Tx hash:", hash);
      console.log("   Check Arbiscan for the decoded revert reason:");
      console.log("   https://sepolia.arbiscan.io/tx/" + hash);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
