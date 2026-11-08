const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Audit M-04 (Zealynx) — the deposit is a loan-wide budget for trading
 * losses.
 *
 * Runs against REAL Uniswap V3, because the loss the attack harvests is the
 * pool's real fee and price impact, paid on every round trip.
 *
 * The problem. Every purchase was checked against the deposit on its own, and
 * every trade against the TWAP on its own, but nothing bounded their sum. A
 * borrower who owned the pool's liquidity could round-trip the principal
 * through it again and again, each trade passing, until the fees and impact
 * paid into their own position had eaten the deposit and then the principal,
 * with the shortfall drawn from the shared insurance reserve.
 *
 * The fix. After every purchase the vault values itself conservatively — its
 * cash plus each holding at its exit floor (TWAP less tolerance) — and refuses
 * the purchase if that falls below the principal, i.e. if realised plus
 * unrealised trading losses would exceed the deposit. Sales are never blocked
 * by the budget: a sale at or above its floor cannot increase the measured
 * loss, and blocking it would trap a borrower cutting a market loss.
 */
const FACTORY_ARTIFACT = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const POOL_ARTIFACT    = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const ROUTER_ARTIFACT  = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const E = ethers.parseEther;
const FEE = 3000;
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const WINDOW = 1800;
const DEEP = 10n ** 23n;
const RESERVE = E("100");
const P = E("10");
const OVER_BUDGET = "Trading losses would exceed the deposit";

async function stack() {
  const [operator, lender, borrower, market] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20", operator);
  const weth = await Mock.deploy("WETH", "WETH", 18);
  const x = await Mock.deploy("Stock X", "XSTK", 18);
  const y = await Mock.deploy("Stock Y", "YSTK", 18);

  const uniFactory = await new ethers.ContractFactory(FACTORY_ARTIFACT.abi, FACTORY_ARTIFACT.bytecode, operator).deploy();
  const router = await new ethers.ContractFactory(ROUTER_ARTIFACT.abi, ROUTER_ARTIFACT.bytecode, operator)
    .deploy(ethers.ZeroAddress, await uniFactory.getAddress(), ethers.ZeroAddress, await weth.getAddress());
  const lp = await (await ethers.getContractFactory("UniswapLiquidityHelper", operator)).deploy();
  await weth.mint(await lp.getAddress(), E("10000000"));

  // Two deep WETH pools with full price history: one per stock.
  const pools = {};
  for (const token of [x, y]) {
    await token.mint(await lp.getAddress(), E("10000000"));
    await uniFactory.createPool(await weth.getAddress(), await token.getAddress(), FEE);
    const pool = new ethers.Contract(
      await uniFactory.getPool(await weth.getAddress(), await token.getAddress(), FEE), POOL_ARTIFACT.abi, operator);
    await pool.initialize(SQRT_PRICE_1_1);
    await lp.addFullRangeLiquidity(await pool.getAddress(), DEEP);
    for (let c = 300; c < WINDOW + 1; c += 300) {
      await lp.warmUpOracle(await pool.getAddress(), c, { gasLimit: 16_000_000 });
    }
    await lp.warmUpOracle(await pool.getAddress(), WINDOW + 1, { gasLimit: 16_000_000 });
    pools[await token.getAddress()] = pool;
  }
  for (let i = 0; i < 4; i++) {
    for (const pool of Object.values(pools)) { await lp.addFullRangeLiquidity(await pool.getAddress(), 1000n); }
    await time.increase(700);
  }

  const id = await (await ethers.getContractFactory("MockIdentityAdapter", operator)).deploy();
  await id.set(lender.address, 7);
  await id.set(borrower.address, 7);
  const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
    operator.address, await router.getAddress(), await uniFactory.getAddress(), 0);
  await registry.addAssetWithTier(await weth.getAddress(), 0, 0);
  await registry.setOutageConfig(0, 0, 0);
  for (const token of [x, y]) {
    await registry.addAssetWithTier(await token.getAddress(), 0, 0);
    await registry.setMinPoolLiquidity(await weth.getAddress(), await token.getAddress(), DEEP / 10n);
    await registry.setPoolFeeTier(await weth.getAddress(), await token.getAddress(), FEE);
  }

  const ipool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
  const twap = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
  const impl = await (await ethers.getContractFactory("Vault", {
    signer: operator, libraries: { UniswapTwap: await twap.getAddress() } })).deploy();
  const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
    await id.getAddress(), await registry.getAddress(), await ipool.getAddress(), operator.address, await impl.getAddress(), 0);
  await ipool.queueSetVaultFactory(await factory.getAddress());
  await ipool.setVaultFactory(await factory.getAddress());
  await weth.mint(operator.address, RESERVE);
  await weth.approve(await ipool.getAddress(), RESERVE);
  await ipool.fund(await weth.getAddress(), RESERVE);

  // A 10 WETH, 7-day loan at the minimum deposit.
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

  for (const token of [x, y]) {
    await token.mint(market.address, E("1000000"));
    await token.connect(market).approve(await router.getAddress(), ethers.MaxUint256);
  }

  /** The vault's own conservative worth: cash plus each holding at TWAP less tolerance. */
  async function worth() {
    let w = await weth.balanceOf(await vault.getAddress());
    const keep = 10000n - (await registry.twapToleranceBps());
    for (const token of [x, y]) {
      const held = await vault.heldAmount(await token.getAddress());
      if (held > 0n) {
        const v = await twap.quote(uniFactory.getAddress(), token.getAddress(), weth.getAddress(), FEE, held, WINDOW);
        w += (v * keep) / 10000n;
      }
    }
    return w;
  }

  /** The market sells `amount` of `token` into its pool, then the TWAP catches up. */
  async function marketDumps(token, amount) {
    await router.connect(market).exactInputSingle({
      tokenIn: await token.getAddress(), tokenOut: await weth.getAddress(), fee: FEE,
      recipient: market.address, amountIn: amount, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    });
    await time.increase(WINDOW + 60);
    await lp.addFullRangeLiquidity(await pools[await token.getAddress()].getAddress(), 1000n);
  }

  const buy  = (token, amount) => vault.connect(borrower).swap(token.getAddress(), amount, 1n, FEE);
  const sell = async (token) =>
    vault.connect(borrower).swapBack(token.getAddress(), await vault.heldAmount(await token.getAddress()), 1n);

  const reserve = await ipool.reserveOf(await weth.getAddress());
  return { lender, borrower, weth, x, y, vault, ipool, D, reserve, worth, marketDumps, buy, sell };
}

describe("Audit M-04 — trading losses are capped at the deposit (real Uniswap V3)", function () {
  this.timeout(600000);

  it("The finding: repeated full round trips stop at the budget, before insurance or principal is touched", async function () {
    const env = await stack();
    const { lender, x, weth, vault, ipool } = env;

    let trips = 0;
    let blocked = false;
    for (let i = 0; i < 300 && !blocked; i++) {
      const cashBefore = await weth.balanceOf(await vault.getAddress());
      // The most the per-purchase deposit check allows: everything above the deposit.
      try {
        await env.buy(x, cashBefore - env.D);
      } catch (e) {
        expect(e.message).to.include(OVER_BUDGET);
        // The refused purchase changed nothing.
        expect(await weth.balanceOf(await vault.getAddress())).to.equal(cashBefore);
        expect(await vault.isHeld(await x.getAddress())).to.equal(false);
        blocked = true;
        break;
      }
      // Every purchase that went through left the vault worth at least the principal.
      expect(await env.worth()).to.be.greaterThanOrEqual(P);
      await env.sell(x);
      expect(await vault.isHeld(await x.getAddress())).to.equal(false);   // the budget survives exits to zero
      trips++;
    }
    expect(blocked).to.equal(true);
    expect(trips).to.be.greaterThan(3);                                 // ordinary trading works
    console.log(`      [${trips} full round trips before the budget bound; deposit ${ethers.formatEther(env.D)} WETH]`);
    expect(await weth.balanceOf(await vault.getAddress())).to.be.greaterThanOrEqual(P);

    // The lender settles: principal back in full, nothing drawn from the shared reserve.
    await time.increaseTo((await vault.deadline()) + 1n);
    const before = await weth.balanceOf(lender.address);
    await vault.connect(lender).settle();
    expect(await vault.settledInsuranceDraw()).to.equal(0n);
    expect((await weth.balanceOf(lender.address)) - before).to.be.greaterThanOrEqual(P);
    expect(await ipool.reserveOf(await weth.getAddress())).to.equal(env.reserve);
  });

  it("Smaller purchases are still allowed while they fit what is left of the budget", async function () {
    const env = await stack();
    const { x } = env;
    // Spend most of the budget on round trips, then buy a little.
    for (let i = 0; i < 300; i++) {
      const cash = await env.weth.balanceOf(await env.vault.getAddress());
      try { await env.buy(x, cash - env.D); } catch { break; }
      await env.sell(x);
    }
    await env.buy(x, E("0.5"));
    expect(await env.worth()).to.be.greaterThanOrEqual(P);
  });

  it("Selling is never blocked: a market loss beyond the deposit stops purchases, not exits", async function () {
    const env = await stack();
    const { lender, x, vault } = env;
    await env.buy(x, E("9"));
    await env.marketDumps(x, E("58000"));               // the stock falls ~60%
    expect(await env.worth()).to.be.lessThan(P);

    await expect(env.buy(x, E("0.1"))).to.be.revertedWith(OVER_BUDGET);
    await env.sell(x);                                   // cutting the loss is allowed
    expect(await vault.isHeld(await x.getAddress())).to.equal(false);
    await expect(env.buy(x, E("0.1"))).to.be.revertedWith(OVER_BUDGET);   // and the realised loss still counts

    // A genuine market loss is still insured as before.
    await time.increaseTo((await vault.deadline()) + 1n);
    await vault.connect(lender).settle();
    expect(await vault.settledInsuranceDraw()).to.be.greaterThan(0n);
  });

  it("Counts every open holding: a loss on one asset blocks a purchase of another", async function () {
    const env = await stack();
    const { x, y, vault } = env;
    await env.buy(y, E("9"));
    await env.buy(x, E("0.5"));                          // within budget while Y holds its value
    await env.marketDumps(y, E("58000"));                // Y falls ~60%
    await expect(env.buy(x, E("0.1"))).to.be.revertedWith(OVER_BUDGET);
    // Both positions can still be sold.
    await env.sell(x);
    await env.sell(y);
    expect(await vault.isHeld(await y.getAddress())).to.equal(false);
  });

  it("A loan that trades within its deposit is unaffected, and settles normally", async function () {
    const env = await stack();
    const { lender, borrower, x, weth, vault } = env;
    await env.buy(x, E("9"));
    await env.sell(x);
    await env.buy(x, E("5"));
    await time.increaseTo((await vault.deadline()) + 1n);
    await vault.connect(lender).settle();
    expect(await vault.settledInsuranceDraw()).to.equal(0n);
    expect(await vault.settledBorrowerPayout()).to.be.greaterThan(0n);
    void borrower; void weth;
  });
});
