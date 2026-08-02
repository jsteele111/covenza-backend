/**
 * Adds a tokenised equity to the existing Robinhood testnet deployment:
 * deploys the token, opens a tUSDG pool against it, seeds liquidity, warms the
 * oracle, then whitelists it as a Standard-tier asset with a 72-hour grace.
 *
 * Why a token we deploy ourselves
 * ------------------------------
 * The canonical Robinhood Stock Tokens are documented for MAINNET only
 * (chain 4663). On testnet there are none — the borrower wallet holds nothing
 * but our own test tokens — and even if there were, they would have no Uniswap
 * pool, because Uniswap V3 is not deployed on Robinhood testnet either. We
 * already bring our own Uniswap; bringing our own equity is the same
 * concession, made for the same reason.
 *
 * What this is therefore testing is the MECHANISM, not the asset: a
 * higher-volatility tier, the deposit floor that tier implies, and the 72-hour
 * grace that exists because equities stop trading at the weekend while the
 * chain does not.
 *
 * The 72-hour grace
 * -----------------
 * A tokenised equity trades 24/5. If a loan's deadline falls on a Friday
 * evening, the forced swap-back at settlement cannot execute at a sane price
 * until Monday — there is no market. The grace extension lengthens the window
 * in which settlement may still happen normally, and 72 hours is what covers a
 * weekend. It applies to any vault HOLDING this asset, which is the correct
 * unit: the constraint comes from what the vault is carrying, not from what it
 * borrowed.
 *
 * Prerequisites
 * -------------
 *   uniswap-testnet.json and deployed-addresses.json must both be current.
 *   Run diagnose-chain.js first if unsure.
 *
 * Usage
 * -----
 *   npx hardhat run scripts/deploy-stock-token-testnet.js --network robinhoodTestnet
 *   SYMBOL=tTSLA NAME="Test Tesla" PRICE=430 npx hardhat run ... --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const FACTORY_ARTIFACT = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const POOL_ARTIFACT    = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const ROUTER_ARTIFACT  = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const SYMBOL = process.env.SYMBOL || "tAAPL";
const NAME   = process.env.NAME   || "Test Apple";
// tUSDG per share. Only the ORDER OF MAGNITUDE matters here — it decides how
// lopsided the pool is, and therefore whether the tick maths is being
// exercised at all. A 1:1 pool would hide sign errors.
const PRICE  = process.env.PRICE  || "255";

const FEE = 3000;
const LIQUIDITY = 20000n * 10n ** 18n;
const TIER_STANDARD = 1;
const GRACE_SECONDS = 72 * 3600;
const TARGET_CARDINALITY = 64;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Integer square root, Newton's method — BigInt has no sqrt. */
function bigSqrt(value) {
  if (value < 0n) throw new Error("negative");
  if (value < 2n) return value;
  let x = value, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}

/**
 * sqrtPriceX96 for a pool whose token1/token0 price is num/den.
 *
 * @dev Computed as sqrt((num << 192) / den) rather than sqrt(num/den) << 96,
 *      because the latter throws away every significant digit before the shift
 *      — integer division of num by den is 0 whenever num < den, which is
 *      exactly the case when the stock is token1.
 */
function encodeSqrtPriceX96(num, den) {
  return bigSqrt((num << 192n) / den);
}

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();

  const uniPath = path.join(__dirname, "..", "uniswap-testnet.json");
  const addrPath = path.join(__dirname, "..", "deployed-addresses.json");
  const uni = JSON.parse(fs.readFileSync(uniPath, "utf8"));
  const allAddresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const deployed = allAddresses[hre.network.name];

  const usdgAddr = uni.tokens.tUSDG;

  console.log("=".repeat(68));
  console.log(`Listing ${SYMBOL} (${NAME}) at ${PRICE} tUSDG/share`);
  console.log("=".repeat(68));

  for (const [label, addr] of [
    ["uniswap factory", uni.uniswapFactory],
    ["swap router", uni.swapRouter],
    ["tUSDG", usdgAddr],
    ["asset registry", deployed?.assetRegistry],
  ]) {
    if (!addr || (await ethers.provider.getCode(addr)) === "0x") {
      throw new Error(`No code at ${label} (${addr}). Run diagnose-chain.js.`);
    }
  }

  const registry = await ethers.getContractAt("AssetRegistry", deployed.assetRegistry);
  const op = await registry.operator();
  if (op.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer is not the registry operator (${op}).`);
  }

  // --- 1. The token ----------------------------------------------------

  const Mock = await ethers.getContractFactory("MockERC20");
  const stock = await Mock.deploy(NAME, SYMBOL, 18);
  await stock.waitForDeployment();
  const stockAddr = await stock.getAddress();
  console.log(`\n${SYMBOL}: ${stockAddr}`);

  // --- 2. The pool -----------------------------------------------------

  const factory = new ethers.Contract(uni.uniswapFactory, FACTORY_ARTIFACT.abi, deployer);
  await (await factory.createPool(usdgAddr, stockAddr, FEE)).wait();
  const poolAddr = await factory.getPool(usdgAddr, stockAddr, FEE);
  console.log(`Pool (0.3%): ${poolAddr}`);

  const pool = new ethers.Contract(poolAddr, POOL_ARTIFACT.abi, deployer);

  // Uniswap orders tokens by address, not by which one we think of as the
  // quote currency, so the price has to be inverted when the stock sorts
  // first. Getting this backwards produces a pool priced at 1/255 that looks
  // superficially fine until the first swap returns nonsense.
  const token0 = await pool.token0();
  const stockIsToken0 = token0.toLowerCase() === stockAddr.toLowerCase();

  const priceScaled = BigInt(Math.round(Number(PRICE) * 1e6));
  const oneScaled = 1000000n;
  const sqrtPriceX96 = stockIsToken0
    ? encodeSqrtPriceX96(priceScaled, oneScaled)   // token1 = tUSDG per stock
    : encodeSqrtPriceX96(oneScaled, priceScaled);  // token1 = stock per tUSDG

  await (await pool.initialize(sqrtPriceX96)).wait();
  const slot0 = await pool.slot0();
  console.log(`Initialised: token0 is ${stockIsToken0 ? SYMBOL : "tUSDG"}, tick ${slot0.tick}`);

  // --- 3. Liquidity ----------------------------------------------------

  const Helper = await ethers.getContractFactory("UniswapLiquidityHelper");
  const helper = await Helper.deploy();
  await helper.waitForDeployment();
  const helperAddr = await helper.getAddress();

  const usdg = await ethers.getContractAt("MockERC20", usdgAddr);
  await (await usdg.mint(helperAddr, ethers.parseEther("2000000"))).wait();
  await (await stock.mint(helperAddr, ethers.parseEther("20000"))).wait();

  await (await helper.addFullRangeLiquidity(poolAddr, LIQUIDITY)).wait();
  console.log("\nPool holds:");
  console.log(`  tUSDG:  ${ethers.formatEther(await usdg.balanceOf(poolAddr))}`);
  console.log(`  ${SYMBOL}: ${ethers.formatEther(await stock.balanceOf(poolAddr))}`);

  // Depth decides the largest position a borrower can take without tripping
  // the entry-impact cap, which is the constraint that actually bites in
  // practice — worth stating rather than leaving to be discovered.
  const usdgDepth = await usdg.balanceOf(poolAddr);
  const capBps = await registry.maxEntryImpactBps();
  console.log(`\nEntry-impact cap is ${capBps} bps, so the largest single swap`);
  console.log(`is roughly ${ethers.formatEther((usdgDepth * capBps) / 10000n)} tUSDG.`);

  // --- 4. Oracle -------------------------------------------------------

  await (await helper.warmUpOracle(poolAddr, TARGET_CARDINALITY)).wait();
  console.log("\nCardinality raised. Writing observations via swaps.");

  const router = new ethers.Contract(uni.swapRouter, ROUTER_ARTIFACT.abi, deployer);
  await (await usdg.mint(deployer.address, ethers.parseEther("10000"))).wait();
  await (await usdg.approve(uni.swapRouter, ethers.MaxUint256)).wait();

  for (let i = 1; i <= 3; i++) {
    await (await router.exactInputSingle({
      tokenIn: usdgAddr,
      tokenOut: stockAddr,
      fee: FEE,
      recipient: deployer.address,
      amountIn: ethers.parseEther("10"),
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    })).wait();
    const [c] = await helper.oracleStatus(poolAddr);
    console.log(`  swap ${i}/3 — cardinality ${c}`);
    if (i < 3) await sleep(35000);
  }

  console.log("\nProbing observe():");
  for (const w of [60, 120, 1800]) {
    try { await pool.observe([w, 0]); console.log(`  ${w}s: OK`); }
    catch { console.log(`  ${w}s: REVERTS (insufficient history)`); }
  }

  // --- 5. List it ------------------------------------------------------

  await (await registry.addAssetWithVenue(
    stockAddr,
    ethers.ZeroAddress, // no Aave on this chain
    0,                  // YieldVenue.None — an equity has no lending venue here
    ethers.ZeroAddress,
    GRACE_SECONDS
  )).wait();
  await (await registry.setTier(stockAddr, TIER_STANDARD)).wait();

  console.log(`\nWhitelisted, Standard tier, ${GRACE_SECONDS / 3600}h grace extension.`);

  const cfg = await registry.tierConfig(TIER_STANDARD);
  console.log(`  assumed volatility ${Number(cfg[0]) / 100}%`);
  console.log(`  max term           ${Number(cfg[2]) / 86400} days`);
  console.log(`  max exposure       ${Number(cfg[3]) / 100}% of principal`);
  console.log(`  insurance premium  ${Number(cfg[4])} bps annualised`);

  for (const days of [7, 30, 90]) {
    const bps = await registry.minimumDepositBpsForTier(TIER_STANDARD, days * 86400);
    console.log(`  deposit floor at ${String(days).padStart(2)}d: ${Number(bps) / 100}%`);
  }

  // --- 6. Record -------------------------------------------------------

  uni.tokens[SYMBOL] = stockAddr;
  uni.pools.push({ address: poolAddr, pair: `tUSDG/${SYMBOL}`, fee: FEE, price: PRICE });
  fs.writeFileSync(uniPath, JSON.stringify(uni, null, 2));

  console.log("\nuniswap-testnet.json updated.");
  console.log("\nFRONTEND — add to src/config/contracts.js under chain 46630:");
  console.log(`    tokens: { ..., ${SYMBOL}: "${stockAddr}" }`);
  console.log(`    TOKEN_DECIMALS: { ..., ${SYMBOL}: 18 }`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
