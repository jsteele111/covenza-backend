/**
 * Checks the live state the deploy and lifecycle scripts depend on.
 *
 * Written because two unrelated things failed in the same run — the insurance
 * pool's fund() reverted with no reason, and the Uniswap pool's observe()
 * stopped serving a 60s window it had served an hour earlier. Either could be
 * a contract problem or an RPC problem, and guessing between them has cost
 * enough time already.
 *
 * All reads. Costs nothing.
 *
 * Usage:
 *   npx hardhat run scripts/diagnose-chain.js --network robinhoodTestnet
 *   REGISTRY=0x... POOL=0x... npx hardhat run scripts/diagnose-chain.js --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();

  const uni = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "uniswap-testnet.json"), "utf8")
  );
  const deployed = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  ).robinhoodTestnet || {};

  const block = await ethers.provider.getBlock("latest");
  console.log("=".repeat(66));
  console.log(`Chain ${(await ethers.provider.getNetwork()).chainId}  block ${block.number}  ts ${block.timestamp}`);
  console.log("=".repeat(66));

  // --- Is there code where we think there is? --------------------------

  const targets = {
    "uniswap factory":  uni.uniswapFactory,
    "swap router":      uni.swapRouter,
    "pool tUSDG/tWETH": uni.pools[0].address,
    "tUSDG":            uni.tokens.tUSDG,
    "tWETH":            uni.tokens.tWETH,
    "registry (saved)": deployed.assetRegistry,
    "pool (saved)":     deployed.insurancePool,
    "factory (saved)":  deployed.vaultFactory,
  };
  if (process.env.REGISTRY) targets["registry (env)"] = process.env.REGISTRY;
  if (process.env.POOL)     targets["pool (env)"]     = process.env.POOL;

  console.log("\n--- contract code present ---");
  for (const [label, addr] of Object.entries(targets)) {
    if (!addr) { console.log(`  ${label.padEnd(18)} (not recorded)`); continue; }
    const size = ((await ethers.provider.getCode(addr)).length - 2) / 2;
    console.log(`  ${label.padEnd(18)} ${addr}  ${size} bytes${size === 0 ? "  <-- NO CODE" : ""}`);
  }

  // --- What is the Uniswap pool's oracle actually doing? ---------------

  console.log("\n--- uniswap pool oracle ---");
  const pool = await ethers.getContractAt(
    [
      "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
      "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] s)",
      "function observations(uint256 index) view returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized)",
      "function liquidity() view returns (uint128)",
    ],
    uni.pools[0].address
  );

  try {
    const s = await pool.slot0();
    console.log(`  tick                 ${s.tick}`);
    console.log(`  cardinality          ${s.observationCardinality}  (next ${s.observationCardinalityNext})`);
    console.log(`  observationIndex     ${s.observationIndex}`);
    console.log(`  unlocked             ${s.unlocked}`);
    console.log(`  liquidity            ${await pool.liquidity()}`);

    // The oldest retained observation is what bounds how far back observe()
    // can look. If it is NEWER than the window requested, observe reverts.
    const oldest = await pool.observations((Number(s.observationIndex) + 1) % Number(s.observationCardinality));
    const newest = await pool.observations(s.observationIndex);
    const now = BigInt(block.timestamp);
    console.log(`  newest observation   ${newest.blockTimestamp}  (${now - BigInt(newest.blockTimestamp)}s ago)`);
    console.log(`  oldest observation   ${oldest.blockTimestamp}  (${oldest.initialized ? `${now - BigInt(oldest.blockTimestamp)}s ago` : "UNINITIALISED"})`);
  } catch (e) {
    console.log(`  slot0/observations failed: ${(e.shortMessage || e.message).slice(0, 90)}`);
  }

  for (const w of [0, 30, 60, 120, 600, 1800]) {
    try {
      await pool.observe([w, 0]);
      console.log(`  observe ${String(w).padStart(4)}s        OK`);
    } catch (e) {
      console.log(`  observe ${String(w).padStart(4)}s        ${(e.shortMessage || e.message).slice(0, 70)}`);
    }
  }

  // --- Can the deployer actually fund the pool? ------------------------

  console.log("\n--- deployer position in tUSDG ---");
  const usdg = await ethers.getContractAt("MockERC20", uni.tokens.tUSDG);
  console.log(`  balance              ${ethers.formatEther(await usdg.balanceOf(deployer.address))}`);
  console.log(`  ETH                  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}`);

  for (const [label, addr] of [["pool (saved)", deployed.insurancePool], ["pool (env)", process.env.POOL]]) {
    if (!addr) continue;
    console.log(`  allowance -> ${label.padEnd(12)} ${ethers.formatEther(await usdg.allowance(deployer.address, addr))}`);
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
