/**
 * Distributes ETH from the deployer to the borrower and keeper accounts.
 *
 * Exists because Robinhood Chain's testnet faucet rate-limits by IP rather
 * than by address, so claiming three times in a day is not possible from one
 * connection. One claim plus this script funds all three.
 *
 * The amounts are deliberately small: the deployer does all the contract
 * deployment, while the borrower only needs gas for deposit, swaps and
 * settlement, and the keeper needs gas for a single settle() call. Robinhood
 * Chain gas is cheap enough that these are generous.
 *
 * Usage:
 *   npx hardhat run scripts/fund-accounts.js --network robinhoodTestnet
 *
 * Override the per-account amount:
 *   FUND_AMOUNT_ETH=0.003 npx hardhat run scripts/fund-accounts.js --network robinhoodTestnet
 */

const { ethers } = require("hardhat");

const PER_ACCOUNT = ethers.parseEther(process.env.FUND_AMOUNT_ETH || "0.002");

// The deployer must keep enough to deploy Uniswap V3, SwapRouter02, the
// helper, and the full Covenza stack. It is the account that actually needs
// the money.
const DEPLOYER_RESERVE = ethers.parseEther("0.004");

const LABELS = ["deployer / lender", "borrower", "keeper"];

async function main() {
  const signers = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  if (signers.length < 2) {
    throw new Error(
      "Need at least two accounts to distribute between. Check BORROWER_PRIVATE_KEY " +
      "and KEEPER_PRIVATE_KEY in .env."
    );
  }

  const deployer = signers[0];
  const recipients = signers.slice(1);

  const deployerBalance = await ethers.provider.getBalance(deployer.address);

  console.log("=".repeat(72));
  console.log(`Funding accounts on chain ${net.chainId}`);
  console.log("=".repeat(72));
  console.log(`\nDeployer ${deployer.address}`);
  console.log(`  balance ${ethers.formatEther(deployerBalance)} ETH`);

  // Work out who actually needs topping up, so re-running this is harmless.
  const needy = [];
  for (let i = 0; i < recipients.length; i++) {
    const bal = await ethers.provider.getBalance(recipients[i].address);
    const label = LABELS[i + 1] || `account ${i + 1}`;
    if (bal >= PER_ACCOUNT) {
      console.log(`\n${label} already has ${ethers.formatEther(bal)} ETH — skipping`);
    } else {
      needy.push({ signer: recipients[i], label, shortfall: PER_ACCOUNT - bal });
    }
  }

  if (needy.length === 0) {
    console.log("\nNothing to do — all accounts funded.");
    return;
  }

  const totalNeeded = needy.reduce((sum, n) => sum + n.shortfall, 0n);

  if (deployerBalance < totalNeeded + DEPLOYER_RESERVE) {
    console.log("\n" + "-".repeat(72));
    console.error("Deployer cannot fund the others and still deploy.");
    console.error(`  needs to send   : ${ethers.formatEther(totalNeeded)} ETH`);
    console.error(`  must retain     : ${ethers.formatEther(DEPLOYER_RESERVE)} ETH`);
    console.error(`  has             : ${ethers.formatEther(deployerBalance)} ETH`);
    console.error(
      "\nEither claim from the faucet again (24h, and it limits by IP — a phone\n" +
      "hotspot counts as a different connection), or lower FUND_AMOUNT_ETH."
    );
    console.log("-".repeat(72));
    throw new Error("Insufficient balance to distribute");
  }

  for (const n of needy) {
    console.log(`\nSending ${ethers.formatEther(n.shortfall)} ETH -> ${n.label}`);
    console.log(`  ${n.signer.address}`);
    const tx = await deployer.sendTransaction({ to: n.signer.address, value: n.shortfall });
    await tx.wait();
    const after = await ethers.provider.getBalance(n.signer.address);
    console.log(`  done — now ${ethers.formatEther(after)} ETH`);
  }

  console.log("\n" + "-".repeat(72));
  console.log("Final balances:");
  for (let i = 0; i < signers.length; i++) {
    const bal = await ethers.provider.getBalance(signers[i].address);
    console.log(`  ${(LABELS[i] || `account ${i}`).padEnd(18)} ${ethers.formatEther(bal)} ETH`);
  }
  console.log("-".repeat(72));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
