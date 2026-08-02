/**
 * Proves the insurance pool actually pays.
 *
 * WHY: every live settlement so far ended "borrower-only loss" — the deposit
 * absorbed everything and the pool was never touched. The pool is the
 * protocol's second line of defence and, outside unit tests against mocks, has
 * never moved a single token. A mechanism that has never fired is a claim.
 *
 * WHY A SHORT TEST-MODE LOAN: an insurance draw is only reachable AFTER the
 * deadline. Vault._distribute refuses an early close whose loss exceeds the
 * deposit — "a borrower voluntarily realising a loss cannot tap the shared
 * pool at will" — which is correct, and means the existing week-long loan
 * cannot demonstrate this without waiting a week.
 *
 * WHAT IT DOES, end to end, with no wallet prompts:
 *   1. lender originates a short loan at the Standard risk ceiling
 *   2. borrower pays the deposit and buys the equity
 *   3. the equity's price is crashed until the loss will exceed the deposit
 *      but stay inside the pool's per-settlement cap
 *   4. waits past the deadline and past the TWAP window
 *   5. borrower settles; the waterfall is printed against pool reserves
 *
 * DESTRUCTIVE on testnet: leaves the pool price crashed.
 *
 * Usage:
 *   npx hardhat run scripts/prove-insurance-draw.js --network robinhoodTestnet
 *   PRINCIPAL=20 TERM_SECONDS=900 TARGET_PRICE=33 npx hardhat run ... --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const POOL_ARTIFACT   = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const ROUTER_ARTIFACT = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const SYMBOL        = process.env.SYMBOL || "tAAPL";
const PRINCIPAL     = process.env.PRINCIPAL || "20";
const TERM_SECONDS  = Number(process.env.TERM_SECONDS || 900);
const DEPOSIT_PCT   = Number(process.env.DEPOSIT_PCT || 20);
// Standard tier caps exposure at 50% of principal, so on 20 tUSDG the vault
// may hold at most 10 tUSDG of the equity — asking for more is refused. Left
// just under the cap: the check values the position at TWAP, so going right
// to the line risks failing on rounding.
const SWAP_IN       = process.env.SWAP_IN || "9.5";

// With only ~9.5 at risk against a 4 tUSDG deposit, the equity has to lose
// roughly two thirds before the loss reaches past the deposit at all. That is
// the exposure cap doing its job — it makes a pool-touching loss genuinely
// hard to produce, which is the point of it.
const TARGET_PRICE  = Number(process.env.TARGET_PRICE || 23);
const CHUNK         = Number(process.env.CHUNK || 200);
const APR_BPS       = 914;
const FEE           = 3000;
const TIER_STANDARD = 1;
const ZERO          = "0x0000000000000000000000000000000000000000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => hre.ethers.formatEther(v);

function priceFromTick(tick, stockIsToken0) {
  const raw = Math.pow(1.0001, Number(tick));
  return stockIsToken0 ? raw : 1 / raw;
}

async function main() {
  const { ethers } = hre;
  const [lender, borrower] = await ethers.getSigners();

  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  )[hre.network.name];
  const uni = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "uniswap-testnet.json"), "utf8")
  );

  const usdgAddr  = uni.tokens.tUSDG;
  const stockAddr = uni.tokens[SYMBOL];
  const poolEntry = uni.pools.find((p) => (p.pair || "").includes(SYMBOL));

  const factory = await ethers.getContractAt("VaultFactory", d.vaultFactory);
  const pool    = await ethers.getContractAt("InsurancePool", d.insurancePool);
  const usdg    = await ethers.getContractAt("MockERC20", usdgAddr);
  const stock   = await ethers.getContractAt("MockERC20", stockAddr);
  const uniPool = new ethers.Contract(poolEntry.address, POOL_ARTIFACT.abi, lender);
  const router  = new ethers.Contract(uni.swapRouter, ROUTER_ARTIFACT.abi, lender);

  const principal = ethers.parseEther(PRINCIPAL);
  const depositWanted = (principal * BigInt(DEPOSIT_PCT)) / 100n;

  console.log("=".repeat(70));
  console.log("Proving an insurance pool draw");
  console.log("=".repeat(70));

  const reserveBefore = await pool.reserveOf(usdgAddr);
  const lenderBefore  = await usdg.balanceOf(lender.address);
  console.log(`Pool reserve before   ${fmt(reserveBefore)} tUSDG`);

  // --- 0. Resume ---------------------------------------------------------
  //
  // The RPC dropped mid-wait once and the run died holding a real, funded,
  // position-carrying vault. Re-running from scratch would have abandoned it
  // and originated another. Pass VAULT to pick up an existing one instead.
  if (process.env.VAULT) {
    const existing = await ethers.getContractAt("Vault", process.env.VAULT);
    console.log(`\nResuming ${process.env.VAULT}`);
    console.log(`  principal   ${fmt(await existing.principal())}`);
    console.log(`  deposit     ${fmt(await existing.deposit())}`);
    console.log(`  held        ${fmt(await stock.balanceOf(process.env.VAULT))} ${SYMBOL}`);
    console.log(`  cash        ${fmt(await usdg.balanceOf(process.env.VAULT))} tUSDG`);
    return finish(existing, await existing.principal(), await existing.deposit());
  }

  // --- 1. Originate ------------------------------------------------------

  const floor = await factory.quoteMinimumDeposit(principal, TIER_STANDARD, BigInt(TERM_SECONDS), true);
  const deposit = depositWanted > floor ? depositWanted : floor;
  console.log(`\nDeposit floor         ${fmt(floor)} tUSDG — using ${fmt(deposit)}`);

  const skim = await factory.quoteInsuranceSkim(principal, APR_BPS, BigInt(TERM_SECONDS), true);
  await (await usdg.connect(lender).approve(d.vaultFactory, principal + skim)).wait();
  const tx = await factory.connect(lender).deployVaultWithTier(
    usdgAddr, borrower.address, principal, APR_BPS,
    BigInt(TERM_SECONDS), true, deposit, ZERO, TIER_STANDARD
  );
  await tx.wait();

  const vaults = await factory.getVaultsByBorrower(borrower.address);
  const vaultAddr = vaults[vaults.length - 1];
  const vault = await ethers.getContractAt("Vault", vaultAddr);
  console.log(`Vault                 ${vaultAddr}`);
  console.log(`Deadline in           ${TERM_SECONDS}s`);

  // --- 2. Deposit and buy the equity ------------------------------------

  const premium = await vault.insurancePremium();
  await (await usdg.connect(borrower).approve(vaultAddr, deposit + premium)).wait();
  await (await vault.connect(borrower).payDeposit()).wait();
  console.log(`\nDeposit paid          ${fmt(deposit)} + ${fmt(premium)} premium`);

  const token0 = await uniPool.token0();
  const stockIsToken0 = token0.toLowerCase() === stockAddr.toLowerCase();
  let slot0 = await uniPool.slot0();
  let price = priceFromTick(slot0.tick, stockIsToken0);

  // The vault refuses minAmountOut of zero — slippage protection is not
  // optional, which is right, and passing zero was my mistake rather than a
  // contract quirk to work around. Derived from spot with 10% of room.
  const expectedOut = Number(SWAP_IN) / price;
  const minOut = ethers.parseEther((expectedOut * 0.9).toFixed(18));

  await (await vault.connect(borrower).swap(
    stockAddr, ethers.parseEther(SWAP_IN), minOut, FEE
  )).wait();

  const held = await stock.balanceOf(vaultAddr);
  console.log(`Bought                ${fmt(held)} ${SYMBOL} at ~${price.toFixed(2)}`);

  // --- 3. Crash the price ------------------------------------------------
  //
  // Sized so the loss exceeds the deposit — otherwise the deposit absorbs it
  // and we prove nothing — but stays inside the pool's per-settlement cap, so
  // the lender still comes out whole. Overshooting would demonstrate a lender
  // loss instead, which is a different and less encouraging scenario.
  console.log(`\nCrashing ${SYMBOL} toward ${TARGET_PRICE}`);
  await (await stock.mint(lender.address, ethers.parseEther(String(CHUNK * 40)))).wait();
  await (await stock.connect(lender).approve(uni.swapRouter, ethers.MaxUint256)).wait();

  for (let i = 1; i <= 40 && price > TARGET_PRICE; i++) {
    await (await router.connect(lender).exactInputSingle({
      tokenIn: stockAddr, tokenOut: usdgAddr, fee: FEE,
      recipient: lender.address, amountIn: ethers.parseEther(String(CHUNK)),
      amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    })).wait();
    slot0 = await uniPool.slot0();
    price = priceFromTick(slot0.tick, stockIsToken0);
    console.log(`  round ${String(i).padStart(2)} — ${price.toFixed(2)}`);
  }

  return finish(vault, principal, deposit);

  // --- 4. Wait out the deadline and the TWAP ----------------------------

  async function finish(vault, principal, deposit) {
  const registry = await ethers.getContractAt("AssetRegistry", d.assetRegistry);
  const twapWindow = Number(await registry.twapWindow());
  const deadline = Number(await vault.deadline());

  while (true) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const remaining = deadline - now;
    if (remaining <= 0) break;
    console.log(`\nWaiting ${remaining + 15}s for the deadline — an early close at a loss`);
    console.log("beyond the deposit is refused, which is what forces this wait.");
    await sleep((remaining + 15) * 1000);
  }
  console.log(`\nPast deadline. Waiting ${twapWindow + 15}s more for the TWAP to converge.`);
  await sleep((twapWindow + 15) * 1000);

  // --- 5. Settle ---------------------------------------------------------

  await (await vault.connect(borrower).settle()).wait();

  const totalReturned = await vault.settledTotalReturned();
  const draw          = await vault.settledInsuranceDraw();
  const lenderPayout  = await vault.settledLenderPayout();
  const borrowerPayout= await vault.settledBorrowerPayout();
  const fee           = await vault.settledFee();
  const reserveAfter  = await pool.reserveOf(usdgAddr);
  const lenderAfter   = await usdg.balanceOf(lender.address);

  console.log("\n" + "=".repeat(70));
  console.log("Settlement waterfall");
  console.log("=".repeat(70));
  console.log(`  vault returned      ${fmt(totalReturned)} tUSDG`);
  console.log(`  lender was owed     ${fmt(principal + fee)} (principal ${PRINCIPAL} + fee ${fmt(fee)})`);
  console.log(`  INSURANCE DRAW      ${fmt(draw)} tUSDG`);
  console.log(`  lender received     ${fmt(lenderPayout)}`);
  console.log(`  borrower received   ${fmt(borrowerPayout)}  (deposit ${fmt(deposit)} consumed)`);
  console.log(`\n  pool reserve        ${fmt(reserveBefore)} -> ${fmt(reserveAfter)}`);
  console.log(`  delta               -${fmt(reserveBefore - reserveAfter)}`);

  const whole = lenderPayout >= principal + fee;
  console.log(`\n  lender made whole   ${whole ? "YES" : "NO"}`);
  if (!whole) {
    console.log(`  shortfall to lender ${fmt(principal + fee - lenderPayout)} — the loss exceeded`);
    console.log("  deposit plus the pool's per-settlement cap.");
  }
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
