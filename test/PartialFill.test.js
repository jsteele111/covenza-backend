const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Audit M-03 (Zealynx) — a partial fill must not erase the unsold rest of a
 * holding.
 *
 * Runs against REAL Uniswap V3, because the partial fill is real V3
 * behaviour: an exact-input swap that runs out of liquidity in range stops at
 * its price limit, spends only part of amountIn, and still returns whatever
 * it bought. If the liquidity was concentrated near the price, what it
 * returns can clear the vault's TWAP floor.
 *
 * Before the fix, the vault checked only what it received; every exit path
 * then debited the FULL requested amount from its record (or dropped the
 * asset altogether), so the unspent units stayed in the vault with no record
 * and no owner. Now _executeSwap() requires the token in to fall by exactly
 * amountIn, so a partial fill reverts before any record changes.
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
const PARTIAL = "Swap did not spend the full amount";

async function stack() {
  const [operator, lender, borrower, outsider, market] = await ethers.getSigners();
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

  const lp = await (await ethers.getContractFactory("UniswapLiquidityHelper", operator)).deploy();
  await weth.mint(await lp.getAddress(), E("10000000"));
  await x.mint(await lp.getAddress(), E("10000000"));
  await lp.addFullRangeLiquidity(await pool.getAddress(), DEEP);
  for (let c = 300; c < WINDOW + 1; c += 300) {
    await lp.warmUpOracle(await pool.getAddress(), c, { gasLimit: 16_000_000 });
  }
  await lp.warmUpOracle(await pool.getAddress(), WINDOW + 1, { gasLimit: 16_000_000 });
  for (let i = 0; i < 4; i++) {
    await lp.addFullRangeLiquidity(await pool.getAddress(), 1000n);
    await time.increase(700);
  }

  const id = await (await ethers.getContractFactory("MockIdentityAdapter", operator)).deploy();
  await id.set(lender.address, 7);
  await id.set(borrower.address, 7);
  const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
    operator.address, await router.getAddress(), await uniFactory.getAddress(), 0);
  await registry.addAssetWithTier(await weth.getAddress(), 0, 0);
  await registry.addAssetWithTier(await x.getAddress(), 0, 0);
  await registry.setOutageConfig(0, 0, 0);
  await registry.setMinPoolLiquidity(await weth.getAddress(), await x.getAddress(), 10n ** 21n);
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
  await weth.mint(borrower.address, D + premium + E("1"));
  await weth.connect(borrower).approve(await vault.getAddress(), D + premium);
  await vault.connect(borrower).payDeposit();
  await vault.connect(borrower).swap(await x.getAddress(), E("9"), 1n, FEE);

  await x.mint(market.address, E("1000000"));
  await x.connect(market).approve(await router.getAddress(), ethers.MaxUint256);

  /** The settlement config with only the tolerance changed. */
  async function setTolerance(bps) {
    await registry.setSettlementConfig(
      await registry.twapWindow(), bps, await registry.swapBackGracePeriod(),
      await registry.bountyRatePerHourBps(), await registry.bountyCapBps());
  }

  /** The stock falls ~60% (the market sells into the pool) and the TWAP catches up. */
  async function stockFalls() {
    await router.connect(market).exactInputSingle({
      tokenIn: await x.getAddress(), tokenOut: await weth.getAddress(), fee: FEE,
      recipient: market.address, amountIn: E("58000"), amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    });
    await time.increase(WINDOW + 60);
    await lp.addFullRangeLiquidity(await pool.getAddress(), 1000n);   // a block, and an observation
  }

  /**
   * The LP concentrates the pool: its full-range position is replaced by a
   * band whose liquidity in the selling direction absorbs only `share` of the
   * vault's holding. A full sale then consumes that much and stops at the
   * band's edge — with almost no slippage, so the output still clears the
   * TWAP floor.
   */
  async function narrowTo(share) {
    const H = Number(ethers.formatEther(await vault.heldAmount(await x.getAddress())));
    const s0 = await pool.slot0();
    const t = Number(s0.tick);
    const sqrtCur = Number(s0.sqrtPriceX96) / 2 ** 96;
    const xIsToken0 = (await pool.token0()).toLowerCase() === (await x.getAddress()).toLowerCase();
    const sqrtAt = (tick) => Math.pow(1.0001, tick / 2);
    let lower, upper, delta;
    if (xIsToken0) {   // selling X lowers the tick
      lower = Math.floor(t / 60) * 60; if (lower === t) lower -= 60;
      upper = lower + 120;
      delta = 1 / sqrtAt(lower) - 1 / sqrtCur;
    } else {            // selling X raises the tick
      upper = Math.floor(t / 60) * 60 + 60;
      lower = upper - 120;
      delta = sqrtAt(upper) - sqrtCur;
    }
    // Input consumed (fee included) up to the edge = L * delta / (1 - 0.3%).
    const L = BigInt(Math.floor((share * H * 0.997 / delta) * 1e18));
    // Band first, then withdraw: the pool is never empty, even for a second,
    // which the harmonic-mean depth check (audit M-01) would rightly punish.
    const full = await pool.liquidity();
    await lp.addRangeLiquidity(await pool.getAddress(), lower, upper, L);
    await lp.removeFullRangeLiquidity(await pool.getAddress(), full);
  }

  const reserve = await ipool.reserveOf(await weth.getAddress());
  return { narrowTo, operator, lender, borrower, outsider, weth, x, pool, registry, ipool, vault, lp,
           reserve, setTolerance, stockFalls, router, market };
}


describe("Audit M-03 — a partial fill reverts instead of stranding the unsold rest (real Uniswap V3)", function () {
  this.timeout(300000);

  it("swapBack(): a 99% fill reverts, leaving the holding and its custody intact", async function () {
    const env = await stack();
    const { borrower, x, vault } = env;
    const H = await vault.heldAmount(await x.getAddress());
    await env.narrowTo(0.99);
    await expect(vault.connect(borrower).swapBack(await x.getAddress(), H, 1n)).to.be.revertedWith(PARTIAL);
    expect(await vault.heldAmount(await x.getAddress())).to.equal(H);
    expect(await x.balanceOf(await vault.getAddress())).to.equal(H);
    expect(await vault.isHeld(await x.getAddress())).to.equal(true);
  });

  it("swapBack(): a full fill in the same narrowed pool still closes the holding", async function () {
    const env = await stack();
    const { borrower, x, vault } = env;
    const H = await vault.heldAmount(await x.getAddress());
    await env.narrowTo(1.05);
    await vault.connect(borrower).swapBack(await x.getAddress(), H, 1n);
    expect(await vault.isHeld(await x.getAddress())).to.equal(false);
    expect(await x.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("settle(): after the deadline a partial fill reverts the settlement, and a full fill settles", async function () {
    const env = await stack();
    const { lender, x, vault } = env;
    const H = await vault.heldAmount(await x.getAddress());
    await env.narrowTo(0.99);
    await time.increaseTo((await vault.deadline()) + 1n);
    await expect(vault.connect(lender).settle()).to.be.revertedWith(PARTIAL);
    expect(await vault.isSettled()).to.equal(false);
    expect(await vault.heldAmount(await x.getAddress())).to.equal(H);

    // The LP restores depth: the same sale now fills in full and settles.
    await env.lp.addFullRangeLiquidity(await env.pool.getAddress(), DEEP);
    await vault.connect(lender).settle();
    expect(await vault.isSettled()).to.equal(true);
    expect(await x.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("settleInKind(): the isolated sale reverts on a partial fill, and the WHOLE holding is allocated", async function () {
    const env = await stack();
    const { lender, borrower, x, vault } = env;
    const H = await vault.heldAmount(await x.getAddress());
    await env.narrowTo(0.99);
    await time.increaseTo(await vault.inKindFrom());
    await vault.connect(lender).settleInKind();
    expect(await vault.settledInKind()).to.equal(true);
    // Nothing is left behind untracked: every unit went to the lender or the borrower.
    expect(await x.balanceOf(await vault.getAddress())).to.equal(0n);
    expect((await x.balanceOf(lender.address)) + (await x.balanceOf(borrower.address))).to.equal(H);
  });
});
