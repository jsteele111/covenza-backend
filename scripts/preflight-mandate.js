/**
 * Checks the preconditions for a manual mandate walkthrough in the UI.
 *
 * The frontend surfaces most of this itself — the lender's capacity strip
 * reads allowance and balance, and the borrower's KYC state shows on the
 * origination form. What it cannot show ahead of time is whether the borrower
 * holds enough of the loan asset to cover deposit AND premium, because that
 * depends on the size they are about to type. A shortfall there appears only
 * as a reverted fill, which is an expensive way to learn it.
 *
 * All reads. Costs nothing.
 *
 * Usage:
 *   npx hardhat run scripts/preflight-mandate.js --network robinhoodTestnet
 *   PRINCIPAL=50 TERM_DAYS=7 DEPOSIT_PCT=20 npx hardhat run scripts/preflight-mandate.js --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const PRINCIPAL   = process.env.PRINCIPAL   || "50";
const TERM_DAYS   = Number(process.env.TERM_DAYS   || 7);
const DEPOSIT_PCT = Number(process.env.DEPOSIT_PCT || 20);
const TIER        = Number(process.env.TIER || 0); // 0 BlueChip, 1 Standard, 2 Speculative

async function main() {
  const { ethers } = hre;
  const signers = await ethers.getSigners();
  const [lender, borrower] = signers;

  const deployed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  )[hre.network.name];
  const uni = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "uniswap-testnet.json"), "utf8")
  );

  const asset   = uni.tokens.tUSDG;
  const token   = await ethers.getContractAt("MockERC20", asset);
  const factory = await ethers.getContractAt("VaultFactory", deployed.vaultFactory);
  const kyc     = await ethers.getContractAt("KYCRegistry", deployed.kycRegistry);
  const registry= await ethers.getContractAt("AssetRegistry", deployed.assetRegistry);

  const principal = ethers.parseEther(PRINCIPAL);
  const termSecs  = BigInt(TERM_DAYS * 86400);
  const deposit   = (principal * BigInt(DEPOSIT_PCT)) / 100n;

  console.log("=".repeat(70));
  console.log(`Mandate preflight — ${PRINCIPAL} tUSDG, ${TERM_DAYS}d, ${DEPOSIT_PCT}% deposit, tier ${TIER}`);
  console.log(`Factory ${deployed.vaultFactory}`);
  console.log("=".repeat(70));

  let blocked = false;
  const check = (ok, label, detail) => {
    if (!ok) blocked = true;
    console.log(`  ${ok ? "OK  " : "FAIL"}  ${label.padEnd(34)} ${detail}`);
  };

  // --- asset is listable at all ---
  console.log("\n--- asset ---");
  check(await registry.isWhitelisted(asset), "tUSDG whitelisted", asset);

  // --- lender side ---
  console.log("\n--- lender (publishes) ---");
  const lBal = await token.balanceOf(lender.address);
  const lAllow = await token.allowance(lender.address, deployed.vaultFactory);
  const lEth = await ethers.provider.getBalance(lender.address);
  const capacity = lAllow < lBal ? lAllow : lBal;

  check(lBal >= principal, "balance covers principal", `${ethers.formatEther(lBal)} tUSDG`);
  // Not a failure: the UI offers to raise this, and publishing without it is
  // legitimate — the mandate simply shows zero fillable until it is set.
  console.log(`  ${capacity >= principal ? "OK  " : "note"}  ${"allowance to factory".padEnd(34)} ${ethers.formatEther(lAllow)} tUSDG${capacity < principal ? "   <-- raise in the UI before publishing" : ""}`);
  check(lEth > 0n, "has gas", `${ethers.formatEther(lEth)} ETH`);

  // --- borrower side ---
  console.log("\n--- borrower (fills) ---");
  const bBal = await token.balanceOf(borrower.address);
  const bEth = await ethers.provider.getBalance(borrower.address);

  // The premium is annualised on principal, so it scales with term. Read it
  // from the chain rather than recomputing — that arithmetic has moved twice.
  const premiumBps = await registry.insurancePremiumBpsForTier(TIER);
  const premium = (principal * premiumBps * termSecs) / (10000n * 31536000n);
  const owed = deposit + premium;

  check(await kyc.isVerified(borrower.address), "KYC verified", borrower.address);
  check(bBal >= owed, "balance covers deposit + premium",
        `${ethers.formatEther(bBal)} tUSDG held, ${ethers.formatEther(owed)} needed`);
  console.log(`        ${"".padEnd(34)} (deposit ${ethers.formatEther(deposit)} + premium ${ethers.formatEther(premium)})`);
  check(bEth > 0n, "has gas", `${ethers.formatEther(bEth)} ETH`);

  // --- the deposit floor will be enforced on fill ---
  console.log("\n--- risk floor ---");
  const minDeposit = await factory.quoteMinimumDeposit(principal, TIER, termSecs, true);
  check(deposit >= minDeposit, "deposit clears tier floor",
        `${ethers.formatEther(deposit)} vs ${ethers.formatEther(minDeposit)} required`);
  if (deposit < minDeposit) {
    const pct = (Number(minDeposit * 10000n / principal) / 100).toFixed(1);
    console.log(`        ${"".padEnd(34)} raise the deposit to at least ${pct}%`);
  }

  console.log("\n" + "-".repeat(70));
  console.log(blocked
    ? "Blocked. Fix the FAIL lines above before walking through the UI."
    : "Clear. These terms will fill.");
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
