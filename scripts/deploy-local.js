/**
 * Deploys the whole stack to a LOCAL Hardhat node, against real Uniswap V3,
 * for click-testing the web interface before testnet.
 *
 * Local only. Lives on the local-test branch; it changes no contract and is
 * not part of the code frozen for audit (tag audit-freeze-2026-10).
 *
 * What it builds
 * --------------
 *   - Real Uniswap V3 (factory, SwapRouter02) from the audited npm artifacts,
 *     as deploy-uniswap-testnet.js does.
 *   - tUSDG and tWETH (plain test tokens) and tAAPL, a FREEZABLE test token, so
 *     a frozen held asset — the case in-kind settlement and claim() exist for —
 *     can be reproduced on demand (scripts/local-freeze.js).
 *   - Pools tUSDG/tWETH and tUSDG/tAAPL at 0.3%, priced 1:1, with more history
 *     slots than the TWAP window has seconds and real observations written, so
 *     they pass the registry's history check and are approved.
 *   - The frozen contracts, wired together, with a REAL timelock (1 hour by
 *     default) so the interface's announce/wait/execute flow can be exercised.
 *     The deploy fast-forwards the chain past each delay itself.
 *
 * Accounts — Hardhat's PUBLISHED default test accounts (printed by
 * `npx hardhat node`; never use them on a real network):
 *   #0 operator / deployer   #1 lender   #2 borrower   #3 keeper
 *   #4 attester signing key (for scripts/mock-verify-server.js)
 *   #5 newcomer — funded, never verified, for testing the gates
 *
 * Nobody is pre-verified. The lender and borrower get attestations through the
 * interface's development path (mock-verify-server), which is the flow under
 * test.
 *
 * Outage detection is switched OFF here. A local chain is idle between clicks
 * and is fast-forwarded on purpose; with detection on, every jump would be
 * recorded as a sequencer outage and stretch grace periods and keeper waits,
 * which would make the settlement screens hard to reason about. It stays on in
 * the testnet deploy.
 *
 * Usage (two terminals, in lending-poc):
 *   1.  npx hardhat node
 *   2.  npx hardhat run scripts/deploy-local.js --network localhost
 *
 * Writes the "localhost" entry of deployed-addresses.json. Re-running it after
 * restarting the node replaces that entry.
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const FACTORY_ARTIFACT = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const ROUTER_ARTIFACT  = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const TIMELOCK_DELAY = Number(process.env.TIMELOCK_DELAY || 3600);

const FEE = 3000;
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const LIQUIDITY = 10n ** 21n;
const MINT_TO_HELPER = 10_000_000n * 10n ** 18n;
const CARDINALITY = 64;                 // > TWAP window of 60s (KRAIT-004)

const TWAP_WINDOW_SECONDS      = 60;    // contract floor; production is 1800
const TWAP_TOLERANCE_BPS       = 300;   // 3%
const GRACE_PERIOD_SECONDS     = 3600;  // 1h, so grace is visible but short
const BOUNTY_RATE_PER_HOUR_BPS = 100;   // 1%/h
const BOUNTY_CAP_BPS           = 200;   // 2%
const INSURANCE_DRAW_CAP_BPS   = 1000;  // 10% of principal

const TIER_BLUECHIP = 0;
const TIER_STANDARD = 1;
const STOCK_GRACE_SECONDS = 72 * 3600;

async function advance(seconds) {
  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine", []);
}

/**
 * Sends a timelocked call: announces it by the hash of its calldata, moves the
 * chain past the delay, then executes. If the call goes through without an
 * announcement (zero delay, or a setter that is only delayed one way), it is
 * simply sent.
 */
async function timelocked(contract, method, args, label) {
  const { ethers } = hre;
  try {
    await contract[method].staticCall(...args);
    await (await contract[method](...args)).wait();
    console.log(`  ${label}`);
    return;
  } catch (e) {
    const msg = String(e.shortMessage || e.message);
    if (!/not queued/i.test(msg)) throw e;
  }
  const id = ethers.keccak256(contract.interface.encodeFunctionData(method, args));
  await (await contract.queueAction(id)).wait();
  await advance(TIMELOCK_DELAY + 1);
  await (await contract[method](...args)).wait();
  console.log(`  ${label} (announced, waited ${TIMELOCK_DELAY}s, executed)`);
}

async function main() {
  const { ethers } = hre;
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 31337n) {
    throw new Error(`deploy-local.js is for a local Hardhat node (31337); this is ${net.chainId}.`);
  }

  const [operator, lender, borrower, keeper, attester, newcomer] = await ethers.getSigners();

  console.log("=".repeat(70));
  console.log("Covenza -> local Hardhat node, against real Uniswap V3");
  console.log("=".repeat(70));

  // --- Tokens -------------------------------------------------------------
  const Mock = await ethers.getContractFactory("MockERC20", operator);
  const Freezable = await ethers.getContractFactory("MockFreezableToken", operator);
  const usdg = await Mock.deploy("Test USDG", "tUSDG", 18);
  const weth = await Mock.deploy("Test WETH", "tWETH", 18);
  const aapl = await Freezable.deploy("Test AAPL (freezable)", "tAAPL", 18);
  await Promise.all([usdg, weth, aapl].map((t) => t.waitForDeployment()));
  const [usdgA, wethA, aaplA] = await Promise.all([usdg, weth, aapl].map((t) => t.getAddress()));
  console.log(`\ntUSDG  ${usdgA}\ntWETH  ${wethA}\ntAAPL  ${aaplA} (freezable)`);

  // --- Real Uniswap V3 ----------------------------------------------------
  const uniFactory = await new ethers.ContractFactory(FACTORY_ARTIFACT.abi, FACTORY_ARTIFACT.bytecode, operator).deploy();
  await uniFactory.waitForDeployment();
  const uniFactoryA = await uniFactory.getAddress();
  const router = await new ethers.ContractFactory(ROUTER_ARTIFACT.abi, ROUTER_ARTIFACT.bytecode, operator)
    .deploy(ethers.ZeroAddress, uniFactoryA, ethers.ZeroAddress, wethA);
  await router.waitForDeployment();
  const routerA = await router.getAddress();
  console.log(`\nUniswapV3Factory  ${uniFactoryA}\nSwapRouter02      ${routerA}`);

  const helper = await (await ethers.getContractFactory("UniswapLiquidityHelper", operator)).deploy();
  await helper.waitForDeployment();
  const helperA = await helper.getAddress();

  const POOL_ABI = [
    "function initialize(uint160)",
    "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
    "function observe(uint32[]) view returns (int56[], uint160[])",
  ];

  await (await usdg.mint(operator.address, 1_000_000n * 10n ** 18n)).wait();
  await (await weth.mint(operator.address, 1_000_000n * 10n ** 18n)).wait();
  await (await aapl.mint(operator.address, 1_000_000n * 10n ** 18n)).wait();
  for (const t of [usdg, weth, aapl]) await (await t.approve(routerA, ethers.MaxUint256)).wait();

  const pools = [];
  for (const [label, other, otherA] of [["tUSDG/tWETH", weth, wethA], ["tUSDG/tAAPL", aapl, aaplA]]) {
    await (await uniFactory.createPool(usdgA, otherA, FEE)).wait();
    const poolA = await uniFactory.getPool(usdgA, otherA, FEE);
    const pool = new ethers.Contract(poolA, POOL_ABI, operator);
    await (await pool.initialize(SQRT_PRICE_1_1)).wait();

    await (await usdg.mint(helperA, MINT_TO_HELPER)).wait();
    await (await other.mint(helperA, MINT_TO_HELPER)).wait();
    await (await helper.addFullRangeLiquidity(poolA, LIQUIDITY)).wait();
    await (await helper.warmUpOracle(poolA, CARDINALITY)).wait();

    // Capacity is not history: observations are written by trades in later
    // blocks. Small trades both ways, 20s apart, keep the price at 1:1 while
    // filling the slots and covering well over the 60s window.
    for (let i = 0; i < 8; i++) {
      await advance(20);
      const [tokenIn, tokenOut] = i % 2 === 0 ? [usdgA, otherA] : [otherA, usdgA];
      await (await router.exactInputSingle({
        tokenIn, tokenOut, fee: FEE, recipient: operator.address,
        amountIn: 10n ** 18n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
      })).wait();
    }
    const s = await pool.slot0();
    console.log(`Pool ${label.padEnd(12)} ${poolA}  history slots ${s[3]}`);
    pools.push({ label, a: usdgA, b: otherA, address: poolA });
  }
  await advance(TWAP_WINDOW_SECONDS + 5);

  // --- Covenza ------------------------------------------------------------
  console.log("\nCovenza (timelock delay " + TIMELOCK_DELAY + "s):");
  const kyc = await (await ethers.getContractFactory("KYCRegistry", operator))
    .deploy(operator.address, attester.address, TIMELOCK_DELAY);
  const insurance = await (await ethers.getContractFactory("InsurancePool", operator))
    .deploy(operator.address, INSURANCE_DRAW_CAP_BPS, TIMELOCK_DELAY);
  const registry = await (await ethers.getContractFactory("AssetRegistry", operator))
    .deploy(operator.address, routerA, uniFactoryA, TIMELOCK_DELAY);
  await Promise.all([kyc, insurance, registry].map((c) => c.waitForDeployment()));

  // Outage detection off for local testing (see header); then settlement
  // config, whose window must fit the recovery rule as it stands.
  await timelocked(registry, "setOutageConfig", [0, 0, 0], "outage detection off (local only)");
  await timelocked(registry, "setSettlementConfig", [
    TWAP_WINDOW_SECONDS, TWAP_TOLERANCE_BPS, GRACE_PERIOD_SECONDS, BOUNTY_RATE_PER_HOUR_BPS, BOUNTY_CAP_BPS,
  ], `settlement config (TWAP ${TWAP_WINDOW_SECONDS}s, grace ${GRACE_PERIOD_SECONDS}s)`);
  await timelocked(registry, "setTierConfig", [0, 6000, 1000, 30 * 86400, 7000, 100], "tier config: Blue chip");
  await timelocked(registry, "setTierConfig", [1, 10000, 2000, 7 * 86400, 5000, 250], "tier config: Standard");
  await timelocked(registry, "setTierConfig", [2, 20000, 4000, 86400, 2500, 100], "tier config: Speculative");

  await (await registry.addAssetWithTier(usdgA, 0, TIER_BLUECHIP)).wait();
  await (await registry.addAssetWithTier(wethA, 0, TIER_BLUECHIP)).wait();
  await (await registry.addAssetWithTier(aaplA, STOCK_GRACE_SECONDS, TIER_STANDARD)).wait();
  console.log("  listed tUSDG, tWETH (Blue chip) and tAAPL (Standard, 72h grace)");

  for (const p of pools) {
    await (await registry.setPoolFeeTier(p.a, p.b, FEE)).wait();
    console.log(`  approved pool ${p.label} at 0.3%`);
  }

  const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
  await twapLib.waitForDeployment();
  const twapLibA = await twapLib.getAddress();
  const vaultImpl = await (await ethers.getContractFactory("Vault", { signer: operator, libraries: { UniswapTwap: twapLibA } })).deploy();
  const lens = await (await ethers.getContractFactory("VaultLens", { signer: operator, libraries: { UniswapTwap: twapLibA } })).deploy();
  await Promise.all([vaultImpl, lens].map((c) => c.waitForDeployment()));

  const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
    await kyc.getAddress(), await registry.getAddress(), await insurance.getAddress(),
    operator.address, await vaultImpl.getAddress(), TIMELOCK_DELAY
  );
  await factory.waitForDeployment();
  await (await insurance.setVaultFactory(await factory.getAddress())).wait();
  console.log("  insurance pool wired to the factory");

  // --- Balances -----------------------------------------------------------
  const E = (n) => BigInt(n) * 10n ** 18n;
  await (await usdg.mint(lender.address, E(100000))).wait();
  await (await usdg.mint(borrower.address, E(10000))).wait();
  await (await weth.mint(borrower.address, E(10))).wait();
  await (await usdg.mint(keeper.address, E(1000))).wait();
  await (await usdg.mint(newcomer.address, E(1000))).wait();

  const seed = E(2000);
  await (await usdg.approve(await insurance.getAddress(), seed)).wait();
  await (await insurance.fund(usdgA, seed)).wait();
  console.log("  balances seeded; insurance pool holds 2,000 tUSDG");

  // --- Self-check: a swap quote through the lens must work ----------------
  const window = Number(await registry.twapWindow());
  for (const p of pools) {
    const pool = new ethers.Contract(p.address, POOL_ABI, operator);
    try {
      await pool.observe([window, 0]);
      console.log(`  ${p.label}: ${window}s TWAP quotable`);
    } catch {
      console.log(`  ${p.label}: ${window}s TWAP NOT quotable — swaps would be refused`);
    }
  }

  // --- Record -------------------------------------------------------------
  const out = {
    chainId: 31337,
    kycRegistry:   await kyc.getAddress(),
    assetRegistry: await registry.getAddress(),
    insurancePool: await insurance.getAddress(),
    vaultFactory:  await factory.getAddress(),
    vaultLens:     await lens.getAddress(),
    vaultImplementation: await vaultImpl.getAddress(),
    uniswapTwapLibrary:  twapLibA,
    treasury: operator.address,
    tokens: { tUSDG: usdgA, tWETH: wethA, tAAPL: aaplA },
    uniswap: { factory: uniFactoryA, router: routerA, pools: pools.map((p) => ({ pair: p.label, address: p.address, fee: FEE })) },
    accounts: {
      operator: operator.address, lender: lender.address, borrower: borrower.address,
      keeper: keeper.address, attester: attester.address, newcomer: newcomer.address,
    },
    twapWindow: TWAP_WINDOW_SECONDS,
    timelockDelay: TIMELOCK_DELAY,
    deployedAt: new Date().toISOString(),
  };

  const addressesPath = path.join(__dirname, "..", "deployed-addresses.json");
  const all = fs.existsSync(addressesPath) ? JSON.parse(fs.readFileSync(addressesPath, "utf8")) : {};
  all.localhost = out;
  fs.writeFileSync(addressesPath, JSON.stringify(all, null, 2) + "\n");

  console.log("\n" + "=".repeat(70));
  console.log("deployed-addresses.json updated (localhost)");
  for (const [k, v] of Object.entries(out.accounts)) console.log(`  ${k.padEnd(9)} ${v}`);
  console.log("=".repeat(70));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
