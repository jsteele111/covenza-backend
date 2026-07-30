/**
 * Prints the addresses and balances of every account configured for the
 * current network, in both checksummed and lowercase form.
 *
 * Exists because funding is a recurring chore across three accounts and two
 * chains, and because some faucets — Robinhood Chain's testnet faucet among
 * them — validate addresses with a lowercase-only regex and reject a
 * perfectly valid EIP-55 checksummed address as "invalid".
 *
 * Reads nothing but the accounts Hardhat has already derived from .env, so
 * no private key is ever printed or handled here.
 *
 * Usage:
 *   npx hardhat run scripts/show-accounts.js --network robinhoodTestnet
 */

const { ethers } = require("hardhat");

// Matches the order in hardhat.config.js:
// [DEVTEST_PRIVATE_KEY, BORROWER_PRIVATE_KEY, KEEPER_PRIVATE_KEY]
const LABELS = ["deployer / lender", "borrower", "keeper"];

async function main() {
  const signers = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  console.log("=".repeat(72));
  console.log(`Accounts on chain ${net.chainId}`);
  console.log("=".repeat(72));

  if (signers.length === 0) {
    console.log("\nNo accounts configured. Check the private keys in .env.");
    return;
  }

  let total = 0n;

  for (let i = 0; i < signers.length; i++) {
    const addr = signers[i].address;
    const bal = await ethers.provider.getBalance(addr);
    total += bal;

    console.log(`\n${LABELS[i] || `account ${i}`}`);
    console.log(`  checksummed : ${addr}`);
    console.log(`  lowercase   : ${addr.toLowerCase()}`);
    console.log(`  balance     : ${ethers.formatEther(bal)} ETH`);
  }

  console.log("\n" + "-".repeat(72));
  console.log(`Total across ${signers.length} account(s): ${ethers.formatEther(total)} ETH`);

  if (signers.length < 3) {
    console.log(
      "\nFewer than three accounts. The lifecycle proof's post-grace tier needs\n" +
      "a keeper that is neither lender nor borrower — set KEEPER_PRIVATE_KEY."
    );
  }

  console.log("-".repeat(72));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
