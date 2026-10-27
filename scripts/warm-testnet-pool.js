/**
 * Diagnoses a testnet Uniswap pool's price history and depth, and repairs both.
 *
 * Written when the tUSDG/tWETH pool on Robinhood testnet reported ONE history
 * slot after a fresh deploy (27 October 2026), so the registry would not approve
 * it. Capacity (cardinalityNext) is not history: slots only become real as
 * trades in later blocks write observations into them.
 *
 * What it does, each step only if needed:
 *   1. prints the pool's state — history slots, slots requested, tick, depth;
 *   2. requests 64 slots (more than the 60-second TWAP window has seconds);
 *   3. tops the pool up to ~100,000 of each token if it is shallower;
 *   4. writes observations with small trades in both directions, 35s apart,
 *      so the price is left where it was;
 *   5. prints the result. Then run approve-testnet-pools.js.
 *
 *   npx hardhat run scripts/warm-testnet-pool.js --network robinhoodTestnet
 *
 * POOL=0x... to target a pool other than the first in uniswap-testnet.json.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const TARGET_SLOTS = 64;
const TARGET_LIQUIDITY = 10n ** 23n; // ~100,000 a side at a 1:1 price
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function increaseObservationCardinalityNext(uint16)",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ethers } = hre;
  const [signer] = await ethers.getSigners();
  const uni = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "uniswap-testnet.json"), "utf8"));
  const poolAddr = process.env.POOL || uni.pools[0].address;
  const pool = new ethers.Contract(poolAddr, POOL_ABI, signer);

  const show = async (label) => {
    const s = await pool.slot0();
    const L = await pool.liquidity();
    console.log(`${label}: history slots ${s.observationCardinality}, requested ${s.observationCardinalityNext}, tick ${s.tick}, liquidity ${L} (~${ethers.formatEther(L)} a side at 1:1)`);
    return { s, L };
  };

  console.log(`Pool ${poolAddr}`);
  let { s, L } = await show("Before");

  if ((await ethers.provider.getCode(poolAddr)).length <= 2) {
    throw new Error("No contract at this address — the testnet may have been reset. Re-run deploy-uniswap-testnet.js.");
  }

  const t0 = await pool.token0();
  const t1 = await pool.token1();
  const fee = await pool.fee();
  const Mock = await ethers.getContractFactory("MockERC20");
  const tok0 = Mock.attach(t0);
  const tok1 = Mock.attach(t1);

  if (Number(s.observationCardinalityNext) < TARGET_SLOTS) {
    await (await pool.increaseObservationCardinalityNext(TARGET_SLOTS)).wait();
    console.log(`Requested ${TARGET_SLOTS} history slots.`);
  }

  if (L < TARGET_LIQUIDITY && uni.liquidityHelper) {
    const Helper = await ethers.getContractFactory("UniswapLiquidityHelper");
    const helper = Helper.attach(uni.liquidityHelper);
    const add = TARGET_LIQUIDITY - L;
    // Generous: full-range at an unknown price can need more of one side.
    const mint = ethers.parseEther("10000000");
    await (await tok0.mint(uni.liquidityHelper, mint)).wait();
    await (await tok1.mint(uni.liquidityHelper, mint)).wait();
    await (await helper.addFullRangeLiquidity(poolAddr, add)).wait();
    console.log(`Added liquidity ${add}.`);
  }

  // Small trades both ways, each in a later block, to write observations.
  const router = new ethers.Contract(uni.swapRouter, [
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  ], signer);
  const amt = ethers.parseEther("1");
  await (await tok0.mint(signer.address, amt * 10n)).wait();
  await (await tok1.mint(signer.address, amt * 10n)).wait();
  await (await tok0.approve(uni.swapRouter, ethers.MaxUint256)).wait();
  await (await tok1.approve(uni.swapRouter, ethers.MaxUint256)).wait();
  for (let i = 1; i <= 4; i++) {
    const [tin, tout] = i % 2 ? [t0, t1] : [t1, t0];
    await (await router.exactInputSingle({ tokenIn: tin, tokenOut: tout, fee, recipient: signer.address, amountIn: amt, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n })).wait();
    s = await pool.slot0();
    console.log(`  trade ${i}/4 — history slots ${s.observationCardinality}`);
    if (i < 4) await sleep(35000);
  }

  await show("After");
  console.log("\nNext: npx hardhat run scripts/approve-testnet-pools.js --network robinhoodTestnet");
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
