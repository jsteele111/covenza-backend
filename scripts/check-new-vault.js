require("dotenv").config();
const { ethers } = require("ethers");

const VAULT_ADDRESS = "0x7eC130095c92Fe72652E88e66d95C898CDb2b739";

const ABI = [
  "function lender() view returns (address)",
  "function borrower() view returns (address)",
  "function principal() view returns (uint256)",
  "function deposit() view returns (uint256)",
  "function feeRateBps() view returns (uint256)",
  "function investedAmount() view returns (uint256)",
  "function deadline() view returns (uint256)",
  "function isSettled() view returns (bool)",
  "function isExpired() view returns (bool)",
  "function vaultBalance() view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);
  const vault = new ethers.Contract(VAULT_ADDRESS, ABI, provider);

  const [lender, borrower, principal, deposit, feeRateBps, investedAmount, deadline, isSettled, isExpired, balance] =
    await Promise.all([
      vault.lender(), vault.borrower(), vault.principal(), vault.deposit(),
      vault.feeRateBps(), vault.investedAmount(), vault.deadline(),
      vault.isSettled(), vault.isExpired(), vault.vaultBalance(),
    ]);

  console.log("Vault:", VAULT_ADDRESS);
  console.log("Lender:", lender);
  console.log("Borrower:", borrower);
  console.log("Principal:", ethers.formatEther(principal), "ETH");
  console.log("Deposit paid:", ethers.formatEther(deposit), "ETH");
  console.log("Fee rate:", Number(feeRateBps) / 100, "%");
  console.log("Invested amount:", ethers.formatEther(investedAmount), "ETH");
  console.log("Deadline (unix):", deadline.toString());
  console.log("isSettled:", isSettled);
  console.log("isExpired:", isExpired);
  console.log("Vault balance:", ethers.formatEther(balance), "ETH");
}

main().catch((err) => { console.error(err); process.exit(1); });