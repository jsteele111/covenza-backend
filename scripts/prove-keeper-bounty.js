/**
 * Proves the keeper path: an abandoned loan gets closed by a stranger, and
 * the stranger gets paid for it.
 *
 * WHY: this is the last settlement tier that has never fired outside unit
 * tests. It is what stops a borrower who simply walks away from becoming
 * permanent bad debt — nobody has to be watching, because closing the vault
 * is profitable for whoever notices. An incentive that has never actually
 * paid anyone is a hypothesis.
 *
 * WHY tWETH RATHER THAN tAAPL: the grace period is the maximum over the
 * assets a vault holds, and tAAPL carries a 72-hour weekend extension. tWETH
 * has none, so the vault clears the global grace in minutes instead of days.
 *
 * SETTLEMENT CONFIG: the launch grace is 36 hours and the bounty accrues at
 * 2bps of principal per hour, which is unobservable inside a session. This
 * script temporarily shortens both, then RESTORES the originals — including
 * on failure. Changing protocol parameters to make a demo work is only
 * honest if it is stated and undone, so it does both.
 *
 * Usage:
 *   npx hardhat run scripts/prove-keeper-bounty.js --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const PRINCIPAL    = process.env.PRINCIPAL || "20";
const TERM_SECONDS = Number(process.env.TERM_SECONDS || 180);
const SWAP_IN      = process.env.SWAP_IN || "5";
const TEST_GRACE   = Number(process.env.TEST_GRACE || 120);
const TEST_RATE    = Number(process.env.TEST_RATE || 1200);  // bps/hour
const APR_BPS      = 914;
const FEE          = 3000;
const TIER_BLUECHIP = 0;
const ZERO         = "0x0000000000000000000000000000000000000000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => hre.ethers.formatEther(v);

async function main() {
  const { ethers } = hre;
  const signers = await ethers.getSigners();
  const [lender, borrower, keeper] = signers;

  if (!keeper) throw new Error("No keeper signer — set KEEPER_PRIVATE_KEY in .env.");
  if (keeper.address === lender.address || keeper.address === borrower.address) {
    throw new Error("Keeper must be a third account; settling as lender or borrower earns no bounty.");
  }

  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  )[hre.network.name];
  const uni = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "uniswap-testnet.json"), "utf8")
  );

  const usdgAddr = uni.tokens.tUSDG;
  const wethAddr = uni.tokens.tWETH;

  const factory  = await ethers.getContractAt("VaultFactory", d.vaultFactory);
  const registry = await ethers.getContractAt("AssetRegistry", d.assetRegistry);
  const usdg     = await ethers.getContractAt("MockERC20", usdgAddr);

  console.log("=".repeat(70));
  console.log("Proving the keeper bounty");
  console.log("=".repeat(70));
  console.log(`Keeper ${keeper.address}`);

  // --- Settlement config, saved for restoration --------------------------

  const original = {
    twapWindow: Number(await registry.twapWindow()),
    tolerance:  await registry.twapToleranceBps(),
    grace:      await registry.swapBackGracePeriod(),
    rate:       await registry.bountyRatePerHourBps(),
    cap:        await registry.bountyCapBps(),
  };
  console.log(`\nLive config: grace ${original.grace}s, bounty ${original.rate}bps/hr, cap ${original.cap}bps`);
  console.log(`Temporarily: grace ${TEST_GRACE}s, bounty ${TEST_RATE}bps/hr — restored at the end.`);

  async function restore() {
    await (await registry.connect(lender).setSettlementConfig(
      original.twapWindow, original.tolerance, original.grace, original.rate, original.cap
    )).wait();
    console.log("\nSettlement config restored to launch values.");
  }

  await (await registry.connect(lender).setSettlementConfig(
    original.twapWindow, original.tolerance, TEST_GRACE, TEST_RATE, original.cap
  )).wait();

  try {
    // --- Originate and abandon ------------------------------------------

    const principal = ethers.parseEther(PRINCIPAL);
    const floor = await factory.quoteMinimumDeposit(principal, TIER_BLUECHIP, BigInt(TERM_SECONDS), true);
    const deposit = floor > 0n ? floor : ethers.parseEther("2");

    const skim = await factory.quoteInsuranceSkim(principal, APR_BPS, BigInt(TERM_SECONDS), true);
    await (await usdg.connect(lender).approve(d.vaultFactory, principal + skim)).wait();
    await (await factory.connect(lender).deployVaultWithTier(
      usdgAddr, borrower.address, principal, APR_BPS,
      BigInt(TERM_SECONDS), true, deposit, ZERO, TIER_BLUECHIP
    )).wait();

    const vaults = await factory.getVaultsByBorrower(borrower.address);
    const vaultAddr = vaults[vaults.length - 1];
    const vault = await ethers.getContractAt("Vault", vaultAddr);
    console.log(`\nVault      ${vaultAddr}`);

    const premium = await vault.insurancePremium();
    await (await usdg.connect(borrower).approve(vaultAddr, deposit + premium)).wait();
    await (await vault.connect(borrower).payDeposit()).wait();
    console.log(`Deposit    ${fmt(deposit)} tUSDG`);

    // A foreign asset is what puts the vault into the graced tier at all. A
    // cash-only vault past its deadline is open to anyone immediately and
    // pays no bounty — which is what the cleanup script got wrong earlier.
    await (await vault.connect(borrower).swap(
      wethAddr, ethers.parseEther(SWAP_IN), ethers.parseEther("1"), FEE
    )).wait();
    console.log(`Holding    ${SWAP_IN} tUSDG worth of tWETH — then abandoned.`);

    // --- Wait out deadline, then grace ----------------------------------

    const deadline = Number(await vault.deadline());
    const graceEnd = deadline + TEST_GRACE;

    while (true) {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      if (now > graceEnd) break;
      const wait = graceEnd - now + 20;
      console.log(`\nWaiting ${wait}s — deadline then grace. Inside grace only the`);
      console.log("lender or borrower may settle; neither does, which is the point.");
      await sleep(wait * 1000);
    }

    // Mirrors Vault._accruedBounty so the expected figure is on screen before
    // the transaction, rather than only being able to accept whatever comes
    // back. There is no public view for it on the vault.
    const nowTs = (await ethers.provider.getBlock("latest")).timestamp;
    const elapsed = nowTs - graceEnd;
    const capBps = Number(original.cap);
    const accruedBps = Math.min(Math.floor((elapsed * TEST_RATE) / 3600), capBps);
    console.log(`\n${elapsed}s past grace at ${TEST_RATE}bps/hr = ${accruedBps}bps (cap ${capBps})`);
    console.log(`Expected bounty: ${fmt((principal * BigInt(accruedBps)) / 10000n)} tUSDG`);

    // --- A stranger closes it -------------------------------------------

    const keeperBefore = await usdg.balanceOf(keeper.address);
    await (await vault.connect(keeper).settle()).wait();
    const keeperAfter = await usdg.balanceOf(keeper.address);

    const bounty        = await vault.settledBounty();
    const lenderPayout  = await vault.settledLenderPayout();
    const borrowerPayout= await vault.settledBorrowerPayout();
    const protocolFee   = await vault.settledProtocolFee();
    const totalReturned = await vault.settledTotalReturned();
    const fee           = await vault.settledFee();

    console.log("\n" + "=".repeat(70));
    console.log("Settled by a third party");
    console.log("=".repeat(70));
    console.log(`  vault returned      ${fmt(totalReturned)} tUSDG`);
    console.log(`  lender received     ${fmt(lenderPayout)}  (owed ${fmt(principal + fee)})`);
    console.log(`  KEEPER BOUNTY       ${fmt(bounty)}`);
    console.log(`  protocol fee        ${fmt(protocolFee)}`);
    console.log(`  borrower received   ${fmt(borrowerPayout)}`);
    console.log(`\n  keeper balance      ${fmt(keeperBefore)} -> ${fmt(keeperAfter)}`);
    console.log(`  keeper net          +${fmt(keeperAfter - keeperBefore)} tUSDG`);

    if (bounty === 0n) {
      console.log("\n  Bounty was zero. Either the vault held no foreign asset, or the");
      console.log("  residual was exhausted — the bounty is paid from what survives");
      console.log("  after the lender is whole.");
    } else {
      console.log("\n  The bounty ranks ahead of the protocol's own fee, deliberately:");
      console.log("  the incentive to close abandoned vaults must not be squeezed by");
      console.log("  protocol revenue.");
    }
  } finally {
    await restore();
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
