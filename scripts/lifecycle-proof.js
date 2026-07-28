// Group F — full lifecycle proof, run against the LIVE testnet deployment
// from deploy-v2-infrastructure.js. Satisfies checklist item 3: "a
// swap-based loan, a genuine loss settling correctly, insurance pool
// actually paying out, automatic swap-back firing in all three access
// tiers."
//
// Usage:
//   npx hardhat run scripts/lifecycle-proof.js --network arbitrumSepolia
//
// Requires KEEPER_PRIVATE_KEY in .env (see hardhat.config.js) — the
// three-tier proof needs a genuinely third-party account for the tier-3
// step; settle() explicitly excludes lender and borrower from the bounty
// branch, so reusing either of those keys wouldn't prove anything. Fund
// this address with a small amount of Sepolia ETH for gas before running.
//
// Deploys and settles THREE small vaults, all USDC-denominated (so the
// USDC<->USDT pool wired in deploy-v2-infrastructure.js can be reused
// without any cross-decimal tick math):
//
//   Vault A — tier 1 (early, borrower-only). Swap into USDT at a fair
//             rate, settle before the deadline. Proves the borrower-only
//             early path and confirms forced swap-back fires even when
//             the access tier itself doesn't care about held assets.
//
//   Vault B — tier 2 (grace period, lender-or-borrower-only). Swap into
//             USDT at a fair rate, THEN the operator drops the price 20%
//             before settling. The forced swap-back returns less than the
//             lender is owed — deposit alone doesn't cover it, so the
//             insurance pool draws to make the lender whole. This is the
//             "genuine loss settling correctly, insurance pool actually
//             paying out" proof.
//
//   Vault C — tier 3 (post-grace, open to anyone, keeper bounty). Fair
//             rate again (isolates the bounty proof from the loss proof
//             above). A neutral third account settles after the grace
//             period ends and collects a time-accrued bounty.
//
// This takes several real minutes to run (grace periods are demo-short,
// but still real wall-clock time on a live network) — the script sleeps
// through the required waits itself and logs progress, so just let it run.
//
// Uses the same "USDC as base asset" trick as the deploy script: USDC and
// USDT are both 6 decimals, so a Uniswap tick of 0 is a true 1:1 price,
// no decimal-adjustment tick math needed anywhere in this script.

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const PRINCIPAL      = 100_000000n; // 100 USDC
const FEE_RATE_BPS    = 300n;        // 3%
const DEPOSIT         = 15_000000n; // 15 USDC (15%)
const SWAP_AMOUNT_A_C = 30_000000n; // Vault A/C: partial swap, no loss
const SWAP_AMOUNT_B   = 100_000000n; // Vault B: full investable amount, to push the loss past the deposit buffer
const VAULT_DURATION_SECONDS = 90;
const POOL_FEE = 3000;
// Grace period itself is NOT hardcoded here — read live from AssetRegistry
// below (registry.swapBackGracePeriod()), since it's protocol config, not
// something this script should assume matches the deploy script's default.

function sleepWithLog(totalSeconds, label) {
  return new Promise((resolve) => {
    let remaining = totalSeconds;
    console.log(`   waiting ${totalSeconds}s (${label})...`);
    const interval = setInterval(() => {
      remaining -= 10;
      if (remaining > 0) console.log(`   ...${remaining}s remaining`);
    }, 10000);
    setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, totalSeconds * 1000);
  });
}

// Uniswap ticks are relative to the pair's ADDRESS ordering (token0 = the
// lower address). This returns the tick that makes the TWAP price of
// base->quote equal 1.0001^magnitude, regardless of which side of the
// ordering the two tokens landed on at deployment — same helper GroupB.test.js
// uses, needed for the same reason (hardcoding the sign is a coin flip).
function tickFor(baseAddr, quoteAddr, magnitude) {
  return BigInt(baseAddr.toLowerCase()) < BigInt(quoteAddr.toLowerCase()) ? magnitude : -magnitude;
}

async function main() {
  const signers = await hre.ethers.getSigners();
  const [lender, borrower, keeper] = signers;
  if (!keeper) {
    throw new Error(
      "No third signer available — add KEEPER_PRIVATE_KEY to .env (see hardhat.config.js) " +
      "and fund that address with a small amount of Sepolia ETH for gas."
    );
  }

  const addressesPath = path.join(__dirname, "..", "deployed-addresses.json");
  const allAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const d = allAddresses[hre.network.name];
  if (!d || !d.tokens || !d.assetRegistry) {
    throw new Error(`No v2 deployment found for network "${hre.network.name}" — run deploy-v2-infrastructure.js first.`);
  }

  console.log("Lifecycle proof — network:", hre.network.name);
  console.log("Lender (also deployer/operator):", lender.address);
  console.log("Borrower:                       ", borrower.address);
  console.log("Keeper (third party):           ", keeper.address);
  console.log();

  const usdc = await hre.ethers.getContractAt("MockERC20", d.tokens.usdc);
  const usdt = await hre.ethers.getContractAt("MockERC20", d.tokens.usdt);
  const router = await hre.ethers.getContractAt("MockSwapRouter", d.mocks.swapRouter);
  const twapPool = await hre.ethers.getContractAt("MockUniswapV3Pool", d.mocks.usdcUsdtPool);
  const factory = await hre.ethers.getContractAt("VaultFactory", d.vaultFactory);
  const insurancePool = await hre.ethers.getContractAt("InsurancePool", d.insurancePool);
  const registry = await hre.ethers.getContractAt("AssetRegistry", d.assetRegistry);
  const usdcAddr = await usdc.getAddress();
  const usdtAddr = await usdt.getAddress();
  const graceSeconds = Number(await registry.swapBackGracePeriod());

  async function setFairRate() {
    await (await router.setRate(usdcAddr, usdtAddr, 1n, 1n)).wait();
    await (await router.setRate(usdtAddr, usdcAddr, 1n, 1n)).wait();
    await (await twapPool.setAvgTick(0)).wait();
  }

  async function setAdverseRate() {
    // USDT -> USDC drops 20% (0.80). Direction that matters: the forced
    // swap-back converts the HELD asset (USDT) back to the loan asset
    // (USDC), so that's the leg that needs to be worse.
    await (await router.setRate(usdtAddr, usdcAddr, 80n, 100n)).wait();
    await (await router.setRate(usdcAddr, usdtAddr, 1n, 1n)).wait(); // unused reverse leg, keep sane
    const tick = tickFor(usdtAddr, usdcAddr, -2232n); // ~0.80, per Group B's own tick reference
    await (await twapPool.setAvgTick(tick)).wait();
  }

  async function originate(durationSeconds) {
    const skim = await factory.quoteInsuranceSkim(PRINCIPAL, FEE_RATE_BPS);
    await (await usdc.connect(lender).approve(await factory.getAddress(), PRINCIPAL + skim)).wait();
    const countBefore = await factory.totalVaults();
    const tx = await factory.connect(lender).deployVault(
      usdcAddr, borrower.address, PRINCIPAL, FEE_RATE_BPS, durationSeconds, true, DEPOSIT
    );
    await tx.wait();
    const vaultAddress = await factory.allVaults(countBefore);
    const vault = await hre.ethers.getContractAt("Vault", vaultAddress);
    console.log("   originated:", vaultAddress);
    return vault;
  }

  async function payDeposit(vault) {
    await (await usdc.connect(borrower).approve(await vault.getAddress(), DEPOSIT)).wait();
    await (await vault.connect(borrower).payDeposit()).wait();
    console.log("   deposit paid");
  }

  async function swapIntoUsdt(vault, amount) {
    await (await vault.connect(borrower).swap(usdtAddr, amount, amount, POOL_FEE)).wait(); // fair rate => exact minOut
    console.log(`   swapped ${amount} USDC -> USDT`);
  }

  async function logOutcome(label, vault) {
    const [settled, severity, totalReturned, lenderPayout, borrowerPayout, insuranceDraw, fee, bounty] =
      await Promise.all([
        vault.isSettled(), vault.lossSeverity(), vault.settledTotalReturned(),
        vault.settledLenderPayout(), vault.settledBorrowerPayout(),
        vault.settledInsuranceDraw(), vault.settledFee(), vault.settledBounty(),
      ]);
    console.log(`\n   [${label}] settled=${settled} lossSeverity=${severity}`);
    console.log(`   totalReturned=${totalReturned} lenderPayout=${lenderPayout} borrowerPayout=${borrowerPayout}`);
    console.log(`   insuranceDraw=${insuranceDraw} fee=${fee} bounty=${bounty}`);
  }

  // ============================================================
  // Vault A — tier 1 (early, borrower-only)
  // ============================================================
  console.log("─".repeat(60));
  console.log("VAULT A — tier 1 (early close, borrower-only)\n");
  await setFairRate();
  const vaultA = await originate(VAULT_DURATION_SECONDS);
  await payDeposit(vaultA);
  await swapIntoUsdt(vaultA, SWAP_AMOUNT_A_C);
  console.log("   settling early (before deadline)...");
  await (await vaultA.connect(borrower).settle()).wait();
  await logOutcome("Vault A / tier 1", vaultA);

  // ============================================================
  // Vault B — tier 2 (grace period, lender-or-borrower), genuine loss
  // ============================================================
  console.log("\n" + "─".repeat(60));
  console.log("VAULT B — tier 2 (grace period), genuine loss + insurance draw\n");
  await setFairRate();
  const reserveBefore = await insurancePool.reserveOf(usdcAddr);
  const vaultB = await originate(VAULT_DURATION_SECONDS);
  await payDeposit(vaultB);
  await swapIntoUsdt(vaultB, SWAP_AMOUNT_B); // full investable amount — makes the loss exceed the deposit buffer
  await sleepWithLog(VAULT_DURATION_SECONDS + 5, "waiting for the deadline to pass");
  console.log("   dropping USDT->USDC rate 20% (simulated adverse price move)...");
  await setAdverseRate();
  console.log("   settling within the grace period, as lender...");
  await (await vaultB.connect(lender).settle()).wait();
  await logOutcome("Vault B / tier 2", vaultB);
  const reserveAfter = await insurancePool.reserveOf(usdcAddr);
  console.log(`   insurance pool USDC reserve: ${reserveBefore} -> ${reserveAfter}`);

  // ============================================================
  // Vault C — tier 3 (post-grace, anyone), keeper bounty
  // ============================================================
  console.log("\n" + "─".repeat(60));
  console.log("VAULT C — tier 3 (post-grace, open to anyone), keeper bounty\n");
  await setFairRate(); // reset — router/TWAP state is shared across all vaults
  const vaultC = await originate(VAULT_DURATION_SECONDS);
  await payDeposit(vaultC);
  await swapIntoUsdt(vaultC, SWAP_AMOUNT_A_C);
  // The extra 60s past grace end (not just past grace) is deliberate — it's
  // what the bounty accrues against, so the demo shows a clearly nonzero,
  // legible bounty rather than a few accrued-wei rounding artifact.
  await sleepWithLog(VAULT_DURATION_SECONDS + graceSeconds + 60, "waiting past deadline + grace period, plus bounty accrual time");
  const keeperBalanceBefore = await usdc.balanceOf(keeper.address);
  console.log("   settling post-grace, as the neutral keeper account...");
  await (await vaultC.connect(keeper).settle()).wait();
  await logOutcome("Vault C / tier 3", vaultC);
  const keeperBalanceAfter = await usdc.balanceOf(keeper.address);
  console.log(`   keeper USDC balance: ${keeperBalanceBefore} -> ${keeperBalanceAfter} (bounty received)`);

  // ============================================================
  console.log("\n" + "─".repeat(60));
  console.log("Lifecycle proof complete. Vault addresses for Arbiscan cross-check:");
  console.log("   Vault A (tier 1):", await vaultA.getAddress());
  console.log("   Vault B (tier 2, loss):", await vaultB.getAddress());
  console.log("   Vault C (tier 3, bounty):", await vaultC.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});