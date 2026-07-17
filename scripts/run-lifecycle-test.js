// Run from the lending-poc backend root:
//   node scripts/run-lifecycle-test.js
//
// Full script-based lifecycle test against the freshly deployed vault:
// pay deposit -> supply to Aave -> early-close settle(). Uses test-wallet-2's
// key (loaded from test-wallet-2.json, never printed) as the borrower signer.
// Reads independently after each step rather than trusting each
// transaction's own "success" report.

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const VAULT_ADDRESS = "0x7eC130095c92Fe72652E88e66d95C898CDb2b739";
const REQUIRED_DEPOSIT = ethers.parseEther("0.00015");

const VAULT_ABI = [
  "function payDeposit() payable",
  "function supplyToAave(uint256 amount)",
  "function settle()",
  "function principal() view returns (uint256)",
  "function deposit() view returns (uint256)",
  "function investedAmount() view returns (uint256)",
  "function depositPaid() view returns (bool)",
  "function isSettled() view returns (bool)",
  "function vaultBalance() view returns (uint256)",
  "event Settled(address indexed triggeredBy, bool early, uint256 totalReturned, uint256 lenderPayout, uint256 borrowerPayout, uint256 fee, uint256 timestamp)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);

  const walletPath = path.join(__dirname, "..", "test-wallet-2.json");
  const { privateKey, address } = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const borrower = new ethers.Wallet(privateKey, provider);

  console.log("Borrower (test-wallet-2):", address);
  console.log("Vault:", VAULT_ADDRESS);

  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, borrower);
  const readOnlyVault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);

  // --- Step 1: pay deposit ---
  console.log("\n--- Step 1: payDeposit() ---");
  const feesA = await provider.getFeeData();
  const tx1 = await vault.payDeposit({
    value: REQUIRED_DEPOSIT,
    maxFeePerGas: feesA.maxFeePerGas * 2n,
    maxPriorityFeePerGas: feesA.maxPriorityFeePerGas,
  });
  await tx1.wait();
  const depositPaid = await readOnlyVault.depositPaid();
  const depositAmount = await readOnlyVault.deposit();
  console.log("Tx:", tx1.hash);
  console.log("depositPaid (independent read):", depositPaid);
  console.log("deposit amount (independent read):", ethers.formatEther(depositAmount), "ETH");
  if (!depositPaid) throw new Error("Deposit payment did not register — stopping.");

  // --- Step 2: supply to Aave (full principal, testing deposit segregation) ---
  console.log("\n--- Step 2: supplyToAave(principal) ---");
  const principal = await readOnlyVault.principal();
  const feesB = await provider.getFeeData();
  const tx2 = await vault.supplyToAave(principal, {
    maxFeePerGas: feesB.maxFeePerGas * 2n,
    maxPriorityFeePerGas: feesB.maxPriorityFeePerGas,
  });
  await tx2.wait();
  const investedAmount = await readOnlyVault.investedAmount();
  const balanceAfterSupply = await readOnlyVault.vaultBalance();
  console.log("Tx:", tx2.hash);
  console.log("investedAmount (independent read):", ethers.formatEther(investedAmount), "ETH");
  console.log("vaultBalance after supply (should equal deposit, since principal left):", ethers.formatEther(balanceAfterSupply), "ETH");
  if (investedAmount !== principal) throw new Error("Invested amount doesn't match principal — stopping.");
  if (balanceAfterSupply !== depositAmount) throw new Error("Vault balance after supply doesn't equal deposit — deposit segregation may have failed!");

  // --- Step 3: early-close settle() ---
  console.log("\n--- Step 3: settle() (early close) ---");
  const feesC = await provider.getFeeData();
  const tx3 = await vault.settle({
    maxFeePerGas: feesC.maxFeePerGas * 2n,
    maxPriorityFeePerGas: feesC.maxPriorityFeePerGas,
  });
  const receipt3 = await tx3.wait();
  console.log("Tx:", tx3.hash);
  console.log("View on explorer: https://sepolia.arbiscan.io/tx/" + tx3.hash);

  let settledEvent = null;
  for (const log of receipt3.logs) {
    try {
      const parsed = vault.interface.parseLog(log);
      if (parsed.name === "Settled") settledEvent = parsed.args;
    } catch (e) { /* ignore logs from other contracts */ }
  }

  const isSettled = await readOnlyVault.isSettled();
  const finalBalance = await readOnlyVault.vaultBalance();

  console.log("\nisSettled (independent read):", isSettled);
  console.log("Final vault balance (independent read):", ethers.formatEther(finalBalance), "ETH");

  if (settledEvent) {
    console.log("\nSettled event:");
    console.log("  early:", settledEvent.early);
    console.log("  totalReturned:", ethers.formatEther(settledEvent.totalReturned), "ETH");
    console.log("  lenderPayout:", ethers.formatEther(settledEvent.lenderPayout), "ETH");
    console.log("  borrowerPayout:", ethers.formatEther(settledEvent.borrowerPayout), "ETH");
    console.log("  fee:", ethers.formatEther(settledEvent.fee), "ETH");
  } else {
    console.log("⚠️  Settled event not found in receipt.");
  }

  console.log("\n✅ Full lifecycle test complete.");
}

main().catch((err) => {
  console.error("\n❌ Lifecycle test failed:", err.message || err);
  process.exitCode = 1;
});
