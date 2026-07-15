// Run from the lending-poc backend root:
//   node scripts/check-aave-lifecycle.js
//
// Checks every vault deployed on Arbitrum Sepolia (per deployed-vaults.json)
// and reports: whether it currently holds an aWETH balance (i.e. funds were
// actually supplied to Aave), its settlement status, and whether repay()/
// settleDefault() would be expected to succeed right now.

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const AAVE_WETH_A_TOKEN = "0xf5f17EbE81E516Dc7cB38D61908EC252F150CE60";

const VAULT_ABI = [
  "function isSettled() view returns (bool)",
  "function isExpired() view returns (bool)",
  "function vaultBalance() view returns (uint256)",
  "function deposit() view returns (uint256)",
  "function repaymentDue() view returns (uint256)",
  "function deadline() view returns (uint256)",
  "function borrower() view returns (address)",
  "function lender() view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);
  const aToken = new ethers.Contract(AAVE_WETH_A_TOKEN, ERC20_ABI, provider);

  const vaultsPath = path.join(__dirname, "..", "deployed-vaults.json");
  const allVaults = JSON.parse(fs.readFileSync(vaultsPath, "utf8"));
  const sepoliaVaults = allVaults.filter((v) => v.network === "arbitrumSepolia");

  console.log(`Found ${sepoliaVaults.length} vault(s) deployed on Arbitrum Sepolia.\n`);

  for (const v of sepoliaVaults) {
    console.log("─".repeat(60));
    console.log("Vault:", v.vaultAddress);
    console.log("Deployed:", v.deployedAt);

    try {
      const vault = new ethers.Contract(v.vaultAddress, VAULT_ABI, provider);

      const [isSettled, isExpired, vaultBalance, deposit, repaymentDue, aWethBalance] =
        await Promise.all([
          vault.isSettled(),
          vault.isExpired(),
          vault.vaultBalance(),
          vault.deposit(),
          vault.repaymentDue(),
          aToken.balanceOf(v.vaultAddress),
        ]);

      console.log("isSettled:", isSettled);
      console.log("isExpired:", isExpired);
      console.log("Plain ETH balance:", ethers.formatEther(vaultBalance), "ETH");
      console.log("Deposit paid:", ethers.formatEther(deposit), "ETH");
      console.log("Repayment due:", ethers.formatEther(repaymentDue), "ETH");
      console.log("aWETH balance (Aave-supplied funds):", ethers.formatEther(aWethBalance), "aWETH");

      if (aWethBalance > 0n) {
        console.log("⚠️  This vault HAS funds in Aave right now.");
        if (isSettled) {
          console.log("   Already settled — but check above whether aWETH is still >0,");
          console.log("   which would mean withdrawal did NOT actually happen despite isSettled=true.");
        } else {
          console.log("   Not yet settled. This is a real candidate to test repay()/settleDefault()");
          console.log("   against, to prove the auto-withdraw-from-Aave path actually works live.");
        }
      } else if (!isSettled) {
        console.log("No Aave funds currently held. Either never supplied, or already withdrawn.");
      }
    } catch (err) {
      console.log("❌ Could not read this vault (may not exist / wrong ABI):", err.message);
    }

    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});