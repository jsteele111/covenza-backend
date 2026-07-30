/**
 * Deploys REAL Uniswap V3 to a test network, with pools we control.
 *
 * Why this exists
 * ---------------
 * Uniswap V3 is deployed on Robinhood Chain MAINNET only — Uniswap's own
 * deployment page lists chainId 4663 and no testnet addresses. So testing
 * against real Uniswap on testnet means bringing our own.
 *
 * That turns out to be better than either alternative, not just a workaround:
 *
 *   - Against MOCKS, an entire class of bug is invisible. Our MockUniswapV3Pool
 *     synthesised tick cumulatives for any window and never reverted, so a pool
 *     that real Uniswap could not quote looked perfectly healthy. That is how
 *     the TWAP fund-freeze bug survived 91 passing tests.
 *
 *   - Against MAINNET pools, we cannot move the price on command, so the
 *     deliberate-loss scenarios cannot run at all.
 *
 * Deploying the real contracts to a pool we own gives authentic observe(),
 * authentic observation cardinality and authentic tick math, while leaving us
 * able to push the price wherever a test needs it. No real money at risk.
 *
 * How it avoids a compiler fight
 * ------------------------------
 * Uniswap V3 is Solidity 0.7.6; this repo is 0.8.24. Rather than vendoring
 * their sources and running a multi-compiler config, we deploy from the
 * PREBUILT ARTIFACTS shipped in their npm packages — real audited bytecode,
 * no compilation, no version conflict.
 *
 * Prerequisites
 * -------------
 *   npm install --save-dev @uniswap/v3-core @uniswap/swap-router-contracts
 *   ROBINHOOD_TESTNET_RPC_URL and DEVTEST_PRIVATE_KEY in .env
 *   Testnet ETH from faucet.testnet.chain.robinhood.com
 *
 * Usage
 * -----
 *   npx hardhat run scripts/deploy-uniswap-testnet.js --network robinhoodTestnet
 *
 * Writes uniswap-testnet.json for the lifecycle proof to consume.
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const FACTORY_ARTIFACT = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const POOL_ARTIFACT    = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const ROUTER_ARTIFACT  = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const ZERO = ethers.ZeroAddress;

// Fee tier and its tick spacing. 0.3% is the tier with real depth on
// Robinhood Chain mainnet for both WETH/USDG and AAPL/USDG.
const FEE = 3000;

// sqrt(1.0001^0) * 2^96 — tick 0, meaning 1:1 between the pair in RAW UNITS.
// Only meaningful because both mock tokens below use 18 decimals; for a
// mismatched pair (say 18 vs 6) tick 0 is emphatically NOT parity, which is a
// trap worth remembering when adding USDC-like assets.
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;

// Liquidity for the full-range position. Chosen by feel rather than computed:
// the helper pays whatever the pool asks, so this only has to be large enough
// that test swaps do not move the price absurdly, and small enough that the
// helper's funding covers it.
const LIQUIDITY = 10n ** 21n;

const MINT_EACH = ethers.parseEther("10000000");

// A fresh pool stores ONE observation. This raises the ring buffer size, but
// capacity alone is not history — observations are only written when the pool
// is touched, so the warm-up swaps below are what actually make a TWAP
// servable.
const TARGET_CARDINALITY = 64;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The faucet drips 0.01 ETH once per 24 hours, so the threshold has to sit
// below a single claim or it locks you out for a day. Actual cost of this
// script is far lower — Robinhood Chain gas is cheap enough that a full run
// of ~10 deployments and a dozen transactions came in under a thousandth of
// an ETH in estimation.
const MIN_DEPLOYER_BALANCE = ethers.parseEther("0.004");

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const net = await ethers.provider.getNetwork();

  console.log("=".repeat(68));
  console.log("Deploying real Uniswap V3 to chain", net.chainId.toString());
  console.log("=".repeat(68));

  // Report every configured account, not just the deployer. The lifecycle
  // proof needs the borrower and keeper funded too, and finding that out
  // three scripts later means another trip to the faucet.
  const labels = ["deployer/lender", "borrower", "keeper"];
  const balances = [];
  for (let i = 0; i < signers.length; i++) {
    const bal = await ethers.provider.getBalance(signers[i].address);
    balances.push(bal);
    console.log(
      `  ${(labels[i] || `account ${i}`).padEnd(16)} ${signers[i].address}  ${ethers.formatEther(bal)} ETH`
    );
  }

  if (balances[0] < MIN_DEPLOYER_BALANCE) {
    console.log("\n" + "-".repeat(68));
    console.error("Deployer balance too low to complete this script.");
    console.error(`Have ${ethers.formatEther(balances[0])} ETH, want at least ${ethers.formatEther(MIN_DEPLOYER_BALANCE)}.`);
    console.error("\nFund it at https://faucet.testnet.chain.robinhood.com");
    console.error("Fund the borrower and keeper at the same time — the lifecycle");
    console.error("proof needs all three, and the keeper must be a genuinely");
    console.error("third-party account for the post-grace bounty tier to prove");
    console.error("anything.");
    console.log("-".repeat(68));
    throw new Error("Insufficient deployer balance");
  }

  const unfunded = signers
    .map((s, i) => ({ label: labels[i] || `account ${i}`, addr: s.address, bal: balances[i] }))
    .filter((a, i) => i > 0 && a.bal === 0n);

  if (unfunded.length > 0) {
    console.log("\nNote: these are unfunded and will be needed by the lifecycle proof:");
    for (const a of unfunded) console.log(`  ${a.label.padEnd(16)} ${a.addr}`);
    console.log("Proceeding — this script only spends from the deployer.");
  }

  console.log();

  if (net.chainId === 4663n) {
    throw new Error(
      "Refusing to run against Robinhood MAINNET — Uniswap V3 is already " +
      "deployed there. Use the published addresses instead."
    );
  }

  // --- 1. Test tokens ---------------------------------------------------

  const Mock = await ethers.getContractFactory("MockERC20");

  // Both 18 decimals deliberately, so tick 0 really is parity and the
  // arithmetic in the lifecycle proof stays legible.
  const usdg = await Mock.deploy("Test USDG", "tUSDG", 18);
  await usdg.waitForDeployment();
  const weth = await Mock.deploy("Test WETH", "tWETH", 18);
  await weth.waitForDeployment();

  console.log("\ntUSDG:", await usdg.getAddress());
  console.log("tWETH:", await weth.getAddress());

  // --- 2. Real Uniswap V3 factory --------------------------------------

  const Factory = new ethers.ContractFactory(
    FACTORY_ARTIFACT.abi, FACTORY_ARTIFACT.bytecode, deployer
  );
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("\nUniswapV3Factory:", factoryAddress);

  // --- 3. Real SwapRouter02 --------------------------------------------
  //
  // Constructor is (factoryV2, factoryV3, positionManager, WETH9). We only
  // ever call the V3 exactInputSingle path, so the V2 factory and position
  // manager can be zero — they are read only by paths we never touch.

  const Router = new ethers.ContractFactory(
    ROUTER_ARTIFACT.abi, ROUTER_ARTIFACT.bytecode, deployer
  );
  const router = await Router.deploy(ZERO, factoryAddress, ZERO, await weth.getAddress());
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  console.log("SwapRouter02:    ", routerAddress);

  // --- 4. Create and initialise the pool -------------------------------

  const usdgAddr = await usdg.getAddress();
  const wethAddr = await weth.getAddress();

  await (await factory.createPool(usdgAddr, wethAddr, FEE)).wait();
  const poolAddress = await factory.getPool(usdgAddr, wethAddr, FEE);
  console.log("\nPool (0.3%):     ", poolAddress);

  const pool = new ethers.Contract(poolAddress, POOL_ARTIFACT.abi, deployer);
  await (await pool.initialize(SQRT_PRICE_1_1)).wait();
  console.log("Initialised at tick 0 (1:1)");

  // --- 5. Liquidity -----------------------------------------------------

  const Helper = await ethers.getContractFactory("UniswapLiquidityHelper");
  const helper = await Helper.deploy();
  await helper.waitForDeployment();
  const helperAddress = await helper.getAddress();

  await (await usdg.mint(helperAddress, MINT_EACH)).wait();
  await (await weth.mint(helperAddress, MINT_EACH)).wait();

  await (await helper.addFullRangeLiquidity(poolAddress, LIQUIDITY)).wait();

  console.log("\nLiquidity added. Pool now holds:");
  console.log("  tUSDG:", ethers.formatEther(await usdg.balanceOf(poolAddress)));
  console.log("  tWETH:", ethers.formatEther(await weth.balanceOf(poolAddress)));

  // --- 6. Oracle warm-up ------------------------------------------------
  //
  // This is the step with no mock equivalent, and the reason this script is
  // worth writing. canQuote() returns FALSE right now: cardinality is 1, so
  // observe() reverts for any non-zero window. Watching it flip to true as
  // observations accumulate is the Phase 0 guard being verified against real
  // Uniswap rather than against my approximation of it.

  await (await helper.warmUpOracle(poolAddress, TARGET_CARDINALITY)).wait();

  let [c, cNext] = await helper.oracleStatus(poolAddress);
  console.log(`\nCardinality raised: ${c} -> next ${cNext}`);
  console.log("Capacity is not history — writing observations via swaps.");

  await (await usdg.mint(deployer.address, ethers.parseEther("10000"))).wait();
  await (await usdg.approve(routerAddress, ethers.MaxUint256)).wait();
  await (await weth.approve(routerAddress, ethers.MaxUint256)).wait();

  // Three swaps, ~35s apart, so the observations span more than the 60s TWAP
  // window we will configure on testnet. The default 1800s window would mean
  // 30 minutes of real waiting per test — twapWindow is operator-configurable
  // with a floor of 60, so testnet uses the floor.
  for (let i = 1; i <= 3; i++) {
    await (await router.exactInputSingle({
      tokenIn: usdgAddr,
      tokenOut: wethAddr,
      fee: FEE,
      recipient: deployer.address,
      amountIn: ethers.parseEther("1"),
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    })).wait();

    [c, cNext] = await helper.oracleStatus(poolAddress);
    console.log(`  swap ${i}/3 — cardinality now ${c}`);
    if (i < 3) await sleep(35000);
  }

  // --- 7. Verify the oracle actually serves a TWAP ---------------------

  console.log("\nProbing observe() directly:");
  for (const window of [60, 120, 1800]) {
    try {
      await pool.observe([window, 0]);
      console.log(`  ${window}s window: OK`);
    } catch {
      console.log(`  ${window}s window: REVERTS (insufficient history)`);
    }
  }

  // --- 8. Record ---------------------------------------------------------

  const out = {
    chainId: net.chainId.toString(),
    deployedAt: new Date().toISOString(),
    note: "Real Uniswap V3 from @uniswap/v3-core artifacts. Test-network only.",
    uniswapFactory: factoryAddress,
    swapRouter: routerAddress,
    liquidityHelper: helperAddress,
    pools: [{ token0: usdgAddr, token1: wethAddr, fee: FEE, address: poolAddress }],
    tokens: { tUSDG: usdgAddr, tWETH: wethAddr },
    recommendedTwapWindow: 60,
  };

  const outPath = path.join(__dirname, "..", "uniswap-testnet.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log("\n" + "=".repeat(68));
  console.log("Written to uniswap-testnet.json");
  console.log("\nNext: deploy-v2-infrastructure.js pointed at this factory and");
  console.log("router, then setSettlementConfig with twapWindow = 60.");
  console.log("=".repeat(68));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
