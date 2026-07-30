/**
 * Generates a throwaway keeper wallet for testnet use.
 *
 * Why a third account is needed at all: settle()'s post-grace tier pays a
 * bounty to whoever settles, but explicitly excludes the lender and borrower
 * from that branch. Proving the tier therefore requires a genuinely
 * third-party account — reusing the deployer or borrower key demonstrates
 * nothing, because the code path they take is a different one.
 *
 * TESTNET ONLY. This prints a private key to your terminal. Never fund the
 * resulting address with anything of value, and never reuse this key on a
 * mainnet.
 *
 * Usage:
 *   npx hardhat run scripts/generate-keeper.js
 */

const { ethers } = require("hardhat");

async function main() {
  const wallet = ethers.Wallet.createRandom();

  console.log("=".repeat(72));
  console.log("Throwaway keeper wallet — TESTNET ONLY");
  console.log("=".repeat(72));
  console.log(`\naddress     : ${wallet.address}`);
  console.log(`lowercase   : ${wallet.address.toLowerCase()}`);
  console.log(`private key : ${wallet.privateKey}`);

  console.log("\n" + "-".repeat(72));
  console.log("Add to .env:");
  console.log(`\n  KEEPER_PRIVATE_KEY=${wallet.privateKey}`);
  console.log("\nThen fund it — the faucet's lowercase form is above, or use:");
  console.log("  npx hardhat run scripts/fund-accounts.js --network robinhoodTestnet");
  console.log("\n.env is already gitignored in this repo. Keep it that way.");
  console.log("-".repeat(72));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
