/**
 * Crashes a testnet pool's price so a live loan settles into a real loss.
 *
 * WHY: every live settlement so far has ended "borrower-only loss" — the
 * deposit absorbed everything and the insurance pool was never touched. The
 * pool is the protocol's second line of defence and, outside unit tests
 * against mocks, has never paid anything. A mechanism that has never fired is
 * a claim, not a feature.
 *
 * WHAT IT DOES: sells the destination asset into the pool in chunks until the
 * price falls below a target, then waits for the TWAP to catch up. The wait is
 * not optional. Vault.settle() requires the forced swap-back to return at
 * least the TWAP-implied value less tolerance, and immediately after a crash
 * the TWAP still reflects the old price — so settlement would revert, and it
 * would look like a bug rather than the guard doing its job.
 *
 * THIS IS DESTRUCTIVE. The pool is left at the crashed price. That is fine on
 * a testnet pool we deployed and can re-seed, and would be indefensible
 * anywhere else.
 *
 * Usage:
 *   TARGET_PRICE=50 npx hardhat run scripts/force-loss-testnet.js --network robinhoodTestnet
 *   SYMBOL=tAAPL TARGET_PRICE=50 CHUNK=200 npx hardhat run ... --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const POOL_ARTIFACT   = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const ROUTER_ARTIFACT = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const SYMBOL       = process.env.SYMBOL || "tAAPL";
const TARGET_PRICE = Number(process.env.TARGET_PRICE || 50);
const CHUNK        = Number(process.env.CHUNK || 200);
const FEE          = 3000;
const MAX_ROUNDS   = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** tUSDG per share, from the pool tick. Ticks are log returns: 1.0001^tick. */
function priceFromTick(tick, stockIsToken0) {
  const raw = Math.pow(1.0001, Number(tick)); // token1 per token0
  return stockIsToken0 ? raw : 1 / raw;
}

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();

  const uni = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "uniswap-testnet.json"), "utf8")
  );

  const stockAddr = uni.tokens[SYMBOL];
  const usdgAddr  = uni.tokens.tUSDG;
  if (!stockAddr) throw new Error(`${SYMBOL} is not in uniswap-testnet.json.`);

  const poolEntry = uni.pools.find((p) => (p.pair || "").includes(SYMBOL));
  if (!poolEntry) throw new Error(`No recorded pool for tUSDG/${SYMBOL}.`);

  const pool   = new ethers.Contract(poolEntry.address, POOL_ARTIFACT.abi, deployer);
  const router = new ethers.Contract(uni.swapRouter, ROUTER_ARTIFACT.abi, deployer);
  const stock  = await ethers.getContractAt("MockERC20", stockAddr);

  const token0 = await pool.token0();
  const stockIsToken0 = token0.toLowerCase() === stockAddr.toLowerCase();

  let slot0 = await pool.slot0();
  let price = priceFromTick(slot0.tick, stockIsToken0);

  console.log("=".repeat(70));
  console.log(`Crashing tUSDG/${SYMBOL} from ${price.toFixed(2)} toward ${TARGET_PRICE}`);
  console.log(`Pool ${poolEntry.address}`);
  console.log("=".repeat(70));

  if (price <= TARGET_PRICE) {
    console.log("\nAlready at or below target. Nothing to do.");
    return;
  }

  // Minted rather than bought: acquiring this much stock through the pool
  // would itself push the price UP first, which is the opposite of the point.
  const needed = ethers.parseEther(String(CHUNK * MAX_ROUNDS));
  await (await stock.mint(deployer.address, needed)).wait();
  await (await stock.approve(uni.swapRouter, ethers.MaxUint256)).wait();

  for (let i = 1; i <= MAX_ROUNDS && price > TARGET_PRICE; i++) {
    await (await router.exactInputSingle({
      tokenIn: stockAddr,
      tokenOut: usdgAddr,
      fee: FEE,
      recipient: deployer.address,
      amountIn: ethers.parseEther(String(CHUNK)),
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    })).wait();

    slot0 = await pool.slot0();
    price = priceFromTick(slot0.tick, stockIsToken0);
    console.log(`  round ${String(i).padStart(2)} — price ${price.toFixed(2)} (tick ${slot0.tick})`);
  }

  if (price > TARGET_PRICE) {
    console.log(`\nStopped at ${price.toFixed(2)} after ${MAX_ROUNDS} rounds.`);
    console.log("Raise CHUNK or MAX_ROUNDS if you need it lower.");
  }

  // --- Let the oracle catch up ------------------------------------------
  //
  // settle() compares what the forced swap-back actually returns against the
  // TWAP. Straight after a crash the TWAP is still averaging the old price, so
  // the swap-back looks like a catastrophic loss against it and the guard
  // refuses. Waiting past the window is what makes the loss REAL rather than
  // apparent.
  const registry = await ethers.getContractAt(
    "AssetRegistry",
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"))[
      hre.network.name
    ].assetRegistry
  );
  const window = Number(await registry.twapWindow());
  const wait = window + 30;

  console.log(`\nTWAP window is ${window}s. Waiting ${wait}s for it to converge —`);
  console.log("settling before then would revert on the TWAP guard, not on the loss.");
  await sleep(wait * 1000);

  const after = await pool.slot0();
  console.log(`\nSpot now ${priceFromTick(after.tick, stockIsToken0).toFixed(2)}.`);
  console.log("Settle the loan now. Expect the deposit to absorb what it can and");
  console.log("the insurance pool to cover the rest, up to its per-settlement cap.");
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
