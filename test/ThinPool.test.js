const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Audit M-01 (Zealynx) — a TWAP taken over an EMPTY pool is not a price.
 *
 * Runs against REAL Uniswap V3 (v3-core factory and pool, SwapRouter02),
 * because the bug lives in how a real pool behaves with no liquidity, which
 * no mock reproduces.
 *
 * The attack. A pool with no in-range liquidity still reports a tick, and a
 * swap against dust liquidity can move that tick anywhere for a few wei. So:
 *   1. the pool's liquidity is withdrawn (or simply leaves);
 *   2. the attacker adds dust and pushes the price of the held asset down
 *      a millionfold, for under a million wei;
 *   3. it waits out the 30-minute TWAP window, so the TWAP agrees;
 *   4. it adds real liquidity AT the manipulated price, and settles.
 * Before the fix, settle() sold the borrower's stock into that liquidity at
 * the manipulated price. The exit floor (TWAP x 98%) passed, because the TWAP
 * had been manipulated too, and the shortfall was drawn from the shared
 * insurance pool. The attacker kept the stock, bought for almost nothing.
 *
 * The fix. The registry holds a minimum pool liquidity for each pair; a pool
 * can be approved only once one is set and while the pool meets it. The vault
 * compares the pool's harmonic-mean liquidity over the TWAP window (the same
 * measure as Uniswap's OracleLibrary.consult) with that minimum, and below it:
 *   - settle() and keeper settlement revert, before any insurance is drawn;
 *   - the asset counts as unpriceable, so the delayed settleInKind() route
 *     hands it over instead, with no insurance draw.
 */
const FACTORY_ARTIFACT = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const POOL_ARTIFACT    = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const ROUTER_ARTIFACT  = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const E = ethers.parseEther;
const FEE = 3000;
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const WINDOW = 1800;
const DEEP = 10n ** 23n + 4000n;          // the honest LP's position (~100k of each token)
const MIN_L = 10n ** 22n;         // the pair's minimum: a tenth of normal depth
const RESERVE = E("100");         // insurance pool reserve

async function stack({ minLiquidity = MIN_L } = {}) {
  const [operator, lender, borrower, attacker] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20", operator);
  const weth = await Mock.deploy("WETH", "WETH", 18);
  const x    = await Mock.deploy("Tokenised stock", "XSTK", 18);

  // Real Uniswap V3 pool with deep honest liquidity and a ring larger than
  // the window (KRAIT-004), plus history older than the window.
  const uniFactory = await new ethers.ContractFactory(FACTORY_ARTIFACT.abi, FACTORY_ARTIFACT.bytecode, operator).deploy();
  const router = await new ethers.ContractFactory(ROUTER_ARTIFACT.abi, ROUTER_ARTIFACT.bytecode, operator)
    .deploy(ethers.ZeroAddress, await uniFactory.getAddress(), ethers.ZeroAddress, await weth.getAddress());
  await uniFactory.createPool(await weth.getAddress(), await x.getAddress(), FEE);
  const pool = new ethers.Contract(
    await uniFactory.getPool(await weth.getAddress(), await x.getAddress(), FEE), POOL_ARTIFACT.abi, operator);
  await pool.initialize(SQRT_PRICE_1_1);

  const lp = await (await ethers.getContractFactory("UniswapLiquidityHelper", operator)).deploy();
  await weth.mint(await lp.getAddress(), E("10000000"));
  await x.mint(await lp.getAddress(), E("10000000"));
  await lp.addFullRangeLiquidity(await pool.getAddress(), DEEP - 4000n);
  for (let c = 300; c < WINDOW + 1; c += 300) {
    await lp.warmUpOracle(await pool.getAddress(), c, { gasLimit: 16_000_000 });
  }
  await lp.warmUpOracle(await pool.getAddress(), WINDOW + 1, { gasLimit: 16_000_000 });
  // Honest history spanning more than the window; each dust mint writes an
  // observation (and the first grows the ring to its new size).
  for (let i = 0; i < 4; i++) {
    await lp.addFullRangeLiquidity(await pool.getAddress(), 1000n);
    await time.increase(700);
  }

  // Protocol.
  const id = await (await ethers.getContractFactory("MockIdentityAdapter", operator)).deploy();
  await id.set(lender.address, 7);
  await id.set(borrower.address, 7);
  const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
    operator.address, await router.getAddress(), await uniFactory.getAddress(), 0);
  await registry.addAssetWithTier(await weth.getAddress(), 0, 0);
  await registry.addAssetWithTier(await x.getAddress(), 0, 0);
  await registry.setOutageConfig(0, 0, 0);   // no heartbeat bot in these tests
  await registry.setMinPoolLiquidity(await weth.getAddress(), await x.getAddress(), minLiquidity);
  await registry.setPoolFeeTier(await weth.getAddress(), await x.getAddress(), FEE);

  const ipool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
  const twap = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
  const impl = await (await ethers.getContractFactory("Vault", {
    signer: operator, libraries: { UniswapTwap: await twap.getAddress() } })).deploy();
  const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
    await id.getAddress(), await registry.getAddress(), await ipool.getAddress(), operator.address, await impl.getAddress(), 0);
  await ipool.setVaultFactory(await factory.getAddress());
  await weth.mint(operator.address, RESERVE);
  await weth.approve(await ipool.getAddress(), RESERVE);
  await ipool.fund(await weth.getAddress(), RESERVE);

  // A 10 WETH loan; the borrower buys 9 WETH of the stock.
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
  await vault.connect(borrower).swap(await x.getAddress(), E("9"), 1n, FEE);
  // The reserve now also holds this loan's premium; nothing may be drawn from it.
  const reserve = await ipool.reserveOf(await weth.getAddress());
  expect(reserve).to.be.greaterThan(RESERVE);

  // The attacker's own liquidity helper, funded generously.
  const atk = await (await ethers.getContractFactory("UniswapLiquidityHelper", attacker)).deploy();
  await weth.mint(await atk.getAddress(), E("10000000"));
  await x.mint(await atk.getAddress(), E("10000000"));
  await x.mint(attacker.address, E("1"));
  await x.connect(attacker).approve(await router.getAddress(), ethers.MaxUint256);

  const meanL = () => twap.meanLiquidity(
    uniFactory.getAddress(), weth.getAddress(), x.getAddress(), FEE, WINDOW);
  const stockValue = (amount) => twap.quote(
    uniFactory.getAddress(), x.getAddress(), weth.getAddress(), FEE, amount, WINDOW);

  /** Steps 1–2: the pool empties, then the attacker pushes the stock's price down ~1,000,000x. */
  async function emptyAndPushDown() {
    await lp.removeFullRangeLiquidity(await pool.getAddress(), await pool.liquidity());
    expect(await pool.liquidity()).to.equal(0n);
    await atk.addFullRangeLiquidity(await pool.getAddress(), 1000n);
    await router.connect(attacker).exactInputSingle({
      tokenIn: await x.getAddress(), tokenOut: await weth.getAddress(), fee: FEE,
      recipient: attacker.address, amountIn: 999_000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    });
  }

  return { reserve, operator, lender, borrower, attacker, weth, x, pool, router, registry, ipool, vault, twap, lp, atk,
           meanL, stockValue, emptyAndPushDown };
}

describe("Audit M-01 — a TWAP over a near-empty pool is refused (real Uniswap V3)", function () {
  this.timeout(300000);

  it("Measures the pool's mean liquidity over the window: full depth when deep, ~0 when emptied", async function () {
    const env = await stack();
    const deep = await env.meanL();
    expect(deep).to.be.closeTo(DEEP, DEEP / 1_000_000n);

    await env.lp.removeFullRangeLiquidity(await env.pool.getAddress(), await env.pool.liquidity());
    await time.increase(WINDOW + 1);
    expect(await env.meanL()).to.be.lessThan(10n);   // Uniswap counts an empty pool as liquidity 1
  });

  it("The attack: an emptied, pushed pool gives a TWAP worth a millionth of the stock — settle() refuses it and draws nothing", async function () {
    const env = await stack();
    const { lender, x, weth, vault, ipool, pool, atk, reserve } = env;
    const stock = await x.balanceOf(await vault.getAddress());
    expect(stock).to.be.greaterThan(E("8"));

    await time.increaseTo((await vault.deadline()) - BigInt(WINDOW + 100));
    await env.emptyAndPushDown();
    await time.increaseTo((await vault.deadline()) + 1n);
    // Step 4: real liquidity at the manipulated price, just before settling.
    await atk.addFullRangeLiquidity(await pool.getAddress(), 10n ** 20n);

    // What the floor would have been: the TWAP now values ~9 WETH of stock
    // at a few millionths of a WETH.
    expect(await env.stockValue(stock)).to.be.lessThan(E("0.0001"));
    expect(await env.meanL()).to.be.lessThan(MIN_L);

    await expect(vault.connect(lender).settle()).to.be.revertedWith("Pool too thin over the TWAP window");
    expect(await vault.isSettled()).to.equal(false);
    expect(await ipool.reserveOf(await weth.getAddress())).to.equal(reserve);
    expect(await x.balanceOf(await vault.getAddress())).to.equal(stock);
  });

  it("Keepers are refused too, after the grace period", async function () {
    const env = await stack();
    const { attacker, vault, pool, atk } = env;
    await time.increaseTo((await vault.deadline()) - BigInt(WINDOW + 100));
    await env.emptyAndPushDown();
    await time.increaseTo(await vault.inKindFrom());
    await atk.addFullRangeLiquidity(await pool.getAddress(), 10n ** 20n);
    await expect(vault.connect(attacker).settle()).to.be.revertedWith("Pool too thin over the TWAP window");
  });

  it("The fallback: delayed in-kind settlement hands the stock to the lender, with no insurance draw", async function () {
    const env = await stack();
    const { lender, x, weth, vault, ipool, pool, atk, reserve } = env;
    const stock = await x.balanceOf(await vault.getAddress());
    await time.increaseTo((await vault.deadline()) - BigInt(WINDOW + 100));
    await env.emptyAndPushDown();
    await atk.addFullRangeLiquidity(await pool.getAddress(), 10n ** 20n);   // still a hundredth of the minimum

    await time.increaseTo(await vault.inKindFrom());
    expect(await env.meanL()).to.be.lessThan(MIN_L);
    await vault.connect(lender).settleInKind();

    expect(await vault.isSettled()).to.equal(true);
    expect(await vault.settledInKind()).to.equal(true);
    expect(await x.balanceOf(lender.address)).to.equal(stock);   // unpriceable: the lender takes it
    expect(await ipool.reserveOf(await weth.getAddress())).to.equal(reserve);
  });

  it("A pool that keeps enough depth still settles in cash, and the borrower is paid", async function () {
    const env = await stack();
    const { lender, borrower, x, weth, vault, ipool, pool, lp, reserve } = env;
    // Half the liquidity leaves, well above the tenth-of-normal minimum.
    await time.increaseTo((await vault.deadline()) - BigInt(WINDOW + 100));
    await lp.removeFullRangeLiquidity(await pool.getAddress(), DEEP / 2n);
    await time.increaseTo((await vault.deadline()) + 1n);
    expect(await env.meanL()).to.be.greaterThanOrEqual(MIN_L);

    const before = await weth.balanceOf(lender.address);
    await vault.connect(lender).settle();
    expect(await vault.isSettled()).to.equal(true);
    expect(await vault.settledInKind()).to.equal(false);
    expect(await x.balanceOf(await vault.getAddress())).to.equal(0n);
    expect((await weth.balanceOf(lender.address)) - before).to.be.greaterThanOrEqual(E("10"));
    expect(await vault.settledBorrowerPayout()).to.be.greaterThan(0n);
    expect(await ipool.reserveOf(await weth.getAddress())).to.equal(reserve);
    void borrower;
  });

  it("The minimum is a hard line: settle passes below and at the measured mean, and refuses one unit above", async function () {
    const env = await stack();
    const { lender, weth, x, vault, registry } = env;
    await time.increaseTo((await vault.deadline()) + 1n);
    const a = await weth.getAddress(), b = await x.getAddress();

    // Mean liquidity is constant here (nothing happens between calls), so
    // each static call is measured against the same figure.
    const measured = await env.meanL();
    await registry.setMinPoolLiquidity(a, b, measured / 2n);
    await vault.connect(lender).settle.staticCall();
    await registry.setMinPoolLiquidity(b, a, measured);          // either order sets both
    expect(await registry.minPoolLiquidity(a, b)).to.equal(measured);
    expect(await env.meanL()).to.equal(measured);
    await vault.connect(lender).settle.staticCall();
    await registry.setMinPoolLiquidity(a, b, measured + 1n);
    await expect(vault.connect(lender).settle()).to.be.revertedWith("Pool too thin over the TWAP window");
  });

  it("Approval requires a minimum, and a pool that currently meets it", async function () {
    const env = await stack();
    const { registry, weth } = env;
    const Mock = await ethers.getContractFactory("MockERC20");
    const y = await Mock.deploy("Other", "Y", 18);
    await registry.addAssetWithTier(await y.getAddress(), 0, 0);
    const uniFactory = new ethers.Contract(await registry.uniswapFactory(), FACTORY_ARTIFACT.abi, env.operator);
    await uniFactory.createPool(await weth.getAddress(), await y.getAddress(), FEE);
    const pool = new ethers.Contract(
      await uniFactory.getPool(await weth.getAddress(), await y.getAddress(), FEE), POOL_ARTIFACT.abi, env.operator);
    await pool.initialize(SQRT_PRICE_1_1);
    for (let c = 300; c < WINDOW + 1; c += 300) {
      await env.lp.warmUpOracle(await pool.getAddress(), c, { gasLimit: 16_000_000 });
    }
    await env.lp.warmUpOracle(await pool.getAddress(), WINDOW + 1, { gasLimit: 16_000_000 });
    await weth.mint(await env.lp.getAddress(), E("1"));
    await y.mint(await env.lp.getAddress(), E("1000000"));
    await env.lp.addFullRangeLiquidity(await pool.getAddress(), 10n ** 18n);   // writes an observation: ring grows

    const a = await weth.getAddress(), b = await y.getAddress();
    await expect(registry.setPoolFeeTier(a, b, FEE)).to.be.revertedWith("Set the pair's minimum pool liquidity first");
    await expect(registry.setMinPoolLiquidity(a, b, 0n)).to.be.revertedWith("Minimum pool liquidity must be nonzero");
    await registry.setMinPoolLiquidity(a, b, 10n ** 18n + 1n);
    await expect(registry.setPoolFeeTier(a, b, FEE)).to.be.revertedWith("Pool liquidity below the pair's minimum");
    await registry.setMinPoolLiquidity(a, b, 10n ** 18n);
    await registry.setPoolFeeTier(a, b, FEE);
    expect(await registry.poolFeeTier(b, a)).to.equal(FEE);
  });
});
