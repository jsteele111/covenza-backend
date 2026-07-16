// Run from the lending-poc backend root:
//   node scripts/check-aave-lifecycle.js
//
// Checks every vault deployed on Arbitrum Sepolia (per deployed-vaults.json)
// and reports: whether it currently holds an aWETH balance (i.e. funds were
// actually supplied to Aave), its settlement status, and whether settle()
// would be expected to succeed right now.
//
// NOTE: updated for the unified settle() design — reads feeRateBps() instead
// of the old repaymentDue(), since repaymentDue no longer exists as a
// concept. Vaults deployed before this redesign (old bytecode) will not
// have a feeRateBps() function and will show as unreadable below — that's
// expected, not a bug; they're running the old contract.

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
  "function principal() view returns (uint256)",
  "function feeRateBps() view returns (uint256)",
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

      const [isSettled, isExpired, vaultBalance, deposit, principal, feeRateBps, aWethBalance] =
        await Promise.all([
          vault.isSettled(),
          vault.isExpired(),
          vault.vaultBalance(),
          vault.deposit(),
          vault.principal(),
          vault.feeRateBps(),
          aToken.balanceOf(v.vaultAddress),
        ]);

      const fee = (principal * feeRateBps) / 10000n;

      console.log("isSettled:", isSettled);
      console.log("isExpired:", isExpired);
      console.log("Plain ETH balance:", ethers.formatEther(vaultBalance), "ETH");
      console.log("Deposit paid:", ethers.formatEther(deposit), "ETH");
      console.log("Principal:", ethers.formatEther(principal), "ETH");
      console.log("Fee rate:", Number(feeRateBps) / 100, "%  (expected fee:", ethers.formatEther(fee), "ETH)");
      console.log("aWETH balance (Aave-supplied funds):", ethers.formatEther(aWethBalance), "aWETH");

      if (aWethBalance > 0n) {
        console.log("⚠️  This vault HAS funds in Aave right now.");
        if (isSettled) {
          console.log("   Already settled — but aWETH is still >0, which would mean withdrawal");
          console.log("   did NOT actually happen despite isSettled=true. Under the redesigned");
          console.log("   settle(), this should no longer be possible — worth investigating if seen.");
        } else {
          console.log("   Not yet settled. Real candidate to test settle() against.");
        }
      } else if (!isSettled) {
        console.log("No Aave funds currently held. Either never supplied, or already withdrawn.");
      }
    } catch (err) {
      console.log("❌ Could not read this vault with the current ABI:", err.message);
      console.log("   (Likely running OLD contract bytecode, predating this redesign — expected for");
      console.log("    vaults deployed before the settle()/feeRateBps() change.)");
    }

    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});