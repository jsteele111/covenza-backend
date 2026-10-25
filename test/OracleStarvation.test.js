const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Audit KRAIT-004 — a pool's price history must not be starvable.
 *
 * Runs against REAL Uniswap V3 (the audited v3-core factory and pool, and
 * SwapRouter02), because the bug lives in how a real pool stores its history,
 * which no mock reproduces.
 *
 * A pool keeps its price history in a ring of `observationCardinality` slots
 * and writes at most one observation per second, on any mint or burn of
 * in-range liquidity or any swap that moves the tick. If every slot holds an
 * observation younger than the TWAP window, observe() reverts "OLD". Anyone
 * can cause that with dust liquidity mints, which leave the price untouched.
 *
 * Before the fix, while the history was starved:
 *   - swapBack, early close, settle() and keeper settlement all reverted;
 *   - settleInKind() found the asset "unpriceable" and gave ALL of it to the
 *     lender, who alone may call it for its first week.
 * A lender could block every exit and then take the borrower's whole position
 * (the PoC: +1.45 WETH on a 10 WETH loan, the borrower's whole deposit).
 *
 * The fix: a pool may be listed, and a position opened in it, only if its
 * ring has more slots than the window has seconds. At one observation per
 * second, such a ring always holds one at least a window old.
 */
const FACTORY_ARTIFACT = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const POOL_ARTIFACT    = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const ROUTER_ARTIFACT  = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const E = ethers.parseEther;
const FEE = 3000;
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const WINDOW = 1800;   // the registry default and the production minimum

async function realPool(cardinality) {
  const [operator, lender, borrower, stranger] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20", operator);
  const weth = await Mock.deploy("WETH", "WETH", 18);
  const x    = await Mock.deploy("Tokenised stock", "XSTK", 18);

  const uniFactory = await new ethers.ContractFactory(FACTORY_ARTIFACT.abi, FACTORY_ARTIFACT.bytecode, operator).deploy();
  const router = await new ethers.ContractFactory(ROUTER_ARTIFACT.abi, ROUTER_ARTIFACT.bytecode, operator)
    .deploy(ethers.ZeroAddress, await uniFactory.getAddress(), ethers.ZeroAddress, await weth.getAddress());
  await uniFactory.createPool(await weth.getAddress(), await x.getAddress(), FEE);
  const pool = new ethers.Contract(
    await uniFactory.getPool(await weth.getAddress(), await x.getAddress(), FEE), POOL_ARTIFACT.abi, operator);
  await pool.initialize(SQRT_PRICE_1_1);

  const helper = await (await ethers.getContractFactory("UniswapLiquidityHelper", operator)).deploy();
  await weth.mint(await helper.getAddress(), E("10000000"));
  await x.mint(await helper.getAddress(), E("10000000"));
  await helper.addFullRangeLiquidity(await pool.getAddress(), 10n ** 23n);   // deep: ~100k of each
  // Growing the ring costs ~20k gas a slot, so do it in steps.
  for (let c = 300; c < cardinality; c += 300) {
    await helper.warmUpOracle(await pool.getAddress(), c, { gasLimit: 16_000_000 });
  }
  await helper.warmUpOracle(await pool.getAddress(), cardinality, { gasLimit: 16_000_000 });
  // Honest history spanning more than the window. Each dust mint writes one
  // observation (and the first one grows the ring to its new size).
  for (let i = 0; i < 4; i++) {
    await helper.addFullRangeLiquidity(await pool.getAddress(), 1000n);
    await time.increase(700);
  }

  // Anyone can write observations: here, the lender's own dust mints.
  const lenderHelper = await (await ethers.getContractFactory("UniswapLiquidityHelper", lender)).deploy();
  await weth.mint(await lenderHelper.getAddress(), E("1"));
  await x.mint(await lenderHelper.getAddress(), E("1"));
  async function writeObservations(n) {
    for (let i = 0; i < n; i++) {   // automine: one block, and one second, each
      await lenderHelper.addFullRangeLiquidity(await pool.getAddress(), 1000n);
    }
  }

  return { operator, lender, borrower, stranger, weth, x, uniFactory, router, pool, writeObservations };
}

async function protocol(env, { listWindow = WINDOW } = {}) {
  const { operator, lender, borrower, weth, x, uniFactory, router } = env;
  const id = await (await ethers.getContractFactory("MockIdentityAdapter", operator)).deploy();
  await id.set(lender.address, 7);
  await id.set(borrower.address, 7);
  const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
    operator.address, await router.getAddress(), await uniFactory.getAddress(), 0);
  await registry.addAssetWithTier(await weth.getAddress(), 0, 0);
  await registry.addAssetWithTier(await x.getAddress(), 0, 0);
  await registry.setOutageConfig(0, 0, 0);   // no heartbeat bot in these tests
  if (listWindow !== WINDOW) { await registry.setSettlementConfig(listWindow, 200, 36 * 3600, 2, 100); }
  await registry.setPoolFeeTier(await weth.getAddress(), await x.getAddress(), FEE);

  const ipool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
  const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
  const impl = await (await ethers.getContractFactory("Vault", {
    signer: operator, libraries: { UniswapTwap: await twapLib.getAddress() } })).deploy();
  const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
    await id.getAddress(), await registry.getAddress(), await ipool.getAddress(), operator.address, await impl.getAddress(), 0);
  await ipool.setVaultFactory(await factory.getAddress());

  const P = E("10");
  await weth.mint(lender.address, P);
  await weth.connect(lender).approve(await factory.getAddress(), P);
  const D = await factory.quoteMinimumDeposit(P, 0, 7, false);
  await factory.connect(lender).deployVaultWithTier(
    await weth.getAddress(), borrower.address, P, 1000, 7, false, D, ethers.ZeroAddress, 0);
  const vault = await ethers.getContractAt("Vault", await factory.allVaults(0));
  const premium = await vault.insurancePremium();
  await weth.mint(borrower.address, D + premium);
  await weth.connect(borrower).approve(await vault.getAddress(), D + premium);
  await vault.connect(borrower).payDeposit();
  return { registry, vault };
}

describe("Audit KRAIT-004 — price history that cannot be starved (real Uniswap V3)", function () {
  this.timeout(300000);

  it("The threat: 64 dust mints make a 64-slot pool's 30-minute TWAP unreadable", async function () {
    const env = await realPool(64);
    await env.pool.observe([WINDOW, 0]);                       // healthy
    await env.writeObservations(64);
    await expect(env.pool.observe([WINDOW, 0])).to.be.revertedWith("OLD");
  });

  it("Refuses to list that pool against a 30-minute window", async function () {
    const env = await realPool(64);
    await expect(protocol(env)).to.be.revertedWith("Pool keeps too little price history");
  });

  it("Refuses a position in it if the window has since been raised past its ring", async function () {
    const env = await realPool(64);
    // Listed against a 60-second window (the testnet setting), then the
    // window is raised to 30 minutes.
    const { registry, vault } = await protocol(env, { listWindow: 60 });
    await registry.setSettlementConfig(WINDOW, 200, 36 * 3600, 2, 100);
    await expect(
      vault.connect(env.borrower).swap(await env.x.getAddress(), E("9"), 1n, FEE)
    ).to.be.revertedWith("Pool keeps too little price history for the TWAP window");
  });

  it("With more slots than the window has seconds, the lender cannot starve it, and the borrower is paid", async function () {
    const env = await realPool(WINDOW + 1);
    const { vault } = await protocol(env);
    const { lender, borrower, x, pool, writeObservations } = env;
    await vault.connect(borrower).swap(await x.getAddress(), E("9"), 1n, FEE);

    // The attack from the PoC, with the same 64 writes and then more.
    await time.increaseTo((await vault.deadline()) - 200n);
    await writeObservations(64);
    await pool.observe([WINDOW, 0]);                          // still readable
    await time.increaseTo(await vault.inKindFrom());
    await writeObservations(150);
    await pool.observe([WINDOW, 0]);

    // Every asset sells, so the in-kind route is closed (KRAIT-005) and the
    // loan settles normally: the borrower gets their surplus, the lender no stock.
    await expect(vault.connect(lender).settleInKind()).to.be.revertedWith("Everything sold - use settle()");
    await vault.connect(lender).settle();
    expect(await x.balanceOf(lender.address)).to.equal(0n);
    expect(await vault.settledBorrowerPayout()).to.be.greaterThan(E("1"));
  });
});
