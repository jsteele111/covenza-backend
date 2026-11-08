const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Audit M-02 (Zealynx) — a tightened TWAP tolerance must not turn a liquid
 * holding into an uninsured in-kind close.
 *
 * Runs against REAL Uniswap V3, because the bug is the pool's own fee: a 0.3%
 * pool charges 30 bps on every sale, so a tolerance tightened to 1 bp makes
 * every sale miss the floor, however deep the pool.
 *
 * The problem. A position's whole exit is checked at entry against the
 * tolerance of the day. If the operator later tightens the tolerance (behind
 * the timelock) below the pool's fee, swapBack() and settle() revert. Before
 * the fix, settleInKind() read that failure as "cannot be sold" and closed
 * the loan in kind, with no insurance draw, though the pool could take the
 * sale. After the lender-only week, any address could do it.
 *
 * The fix. The vault records the tolerance each position's full exit last
 * passed at (admittedToleranceBps), updated only when a top-up passes the
 * same check and cleared when the position goes. When a sale fails in
 * settleInKind() under a stricter live tolerance, the vault simulates the
 * exit in the pinned pool and, if it clears the ADMITTED floor, refuses the
 * in-kind close. Restoring the tolerance then lets settle() close the loan
 * in cash, with its insurance waterfall. A pool that genuinely cannot take
 * the sale still closes in kind.
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
const BLOCKED = "Sale blocked only by a tightened tolerance - use settle()";

async function stack() {
  const [operator, lender, borrower, outsider, market] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20", operator);
  const weth = await Mock.deploy("WETH", "WETH", 18);
  // A stock token its issuer can freeze, as a tokenised equity's can.
  const x    = await (await ethers.getContractFactory("MockFreezableToken", operator)).deploy("Tokenised stock", "XSTK", 18);

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
  await registry.setMinPoolLiquidity(await weth.getAddress(), await x.getAddress(), DEEP / 10n);
  await registry.setPoolFeeTier(await weth.getAddress(), await x.getAddress(), FEE);

  const ipool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
  const twap = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
  const impl = await (await ethers.getContractFactory("Vault", {
    signer: operator, libraries: { UniswapTwap: await twap.getAddress() } })).deploy();
  const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
    await id.getAddress(), await registry.getAddress(), await ipool.getAddress(), operator.address, await impl.getAddress(), 0);
  await ipool.queueSetVaultFactory(await factory.getAddress());   // audit M-05: the first wiring is announced too
  await ipool.setVaultFactory(await factory.getAddress());
  await weth.mint(operator.address, RESERVE);
  await weth.approve(await ipool.getAddress(), RESERVE);
  await ipool.fund(await weth.getAddress(), RESERVE);

  // A 10 WETH loan; the borrower buys 9 WETH of the stock at a 200 bp tolerance.
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

  const reserve = await ipool.reserveOf(await weth.getAddress());
  return { operator, lender, borrower, outsider, weth, x, pool, registry, ipool, vault, lp,
           reserve, setTolerance, stockFalls };
}

/** After the lender-only week of in-kind settlement, when anyone may call it. */
async function toOpenInKind(vault) {
  await time.increaseTo((await vault.inKindFrom()) + (await vault.IN_KIND_LENDER_PERIOD()));
}

describe("Audit M-02 — a tightened tolerance cannot force an uninsured in-kind close (real Uniswap V3)", function () {
  this.timeout(300000);

  it("Records the tolerance a position was admitted at, and forgets it when the position goes", async function () {
    const env = await stack();
    const { borrower, x, vault } = env;
    expect(await vault.admittedToleranceBps(await x.getAddress())).to.equal(200n);
    await vault.connect(borrower).swapBack(await x.getAddress(), await vault.heldAmount(await x.getAddress()), 1n);
    expect(await vault.isHeld(await x.getAddress())).to.equal(false);
    expect(await vault.admittedToleranceBps(await x.getAddress())).to.equal(0n);
  });

  it("A top-up updates it only by passing the full-exit check at the live tolerance", async function () {
    const env = await stack();
    const { borrower, x, vault } = env;
    await env.setTolerance(150);
    expect(await vault.admittedToleranceBps(await x.getAddress())).to.equal(200n);   // a change alone moves nothing
    await vault.connect(borrower).swap(await x.getAddress(), E("0.01"), 1n, FEE);
    expect(await vault.admittedToleranceBps(await x.getAddress())).to.equal(150n);
  });

  it("Control: at the admitted tolerance the loss settles in cash and draws insurance", async function () {
    const env = await stack();
    const { lender, weth, vault, ipool } = env;
    await env.stockFalls();
    await time.increaseTo((await vault.deadline()) + 1n);
    await vault.connect(lender).settle();
    expect(await vault.settledInKind()).to.equal(false);
    expect(await vault.settledInsuranceDraw()).to.be.greaterThan(0n);
    expect(await ipool.reserveOf(await weth.getAddress())).to.be.lessThan(env.reserve);
  });

  it("The finding: at 1 bp every sale misses the floor, and an outsider's in-kind close is refused", async function () {
    const env = await stack();
    const { lender, borrower, outsider, x, weth, vault, ipool } = env;
    await env.stockFalls();
    await env.setTolerance(1);

    // The pool's 30 bp fee alone misses a 1 bp floor: no sale can pass.
    await expect(vault.connect(borrower).swapBack(await x.getAddress(), E("1"), 1n)).to.be.reverted;
    await time.increaseTo((await vault.deadline()) + 1n);
    await expect(vault.connect(lender).settle()).to.be.reverted;

    await toOpenInKind(vault);
    await expect(vault.connect(outsider).settleInKind()).to.be.revertedWith(BLOCKED);
    await expect(vault.connect(lender).settleInKind()).to.be.revertedWith(BLOCKED);
    expect(await vault.isSettled()).to.equal(false);
    expect(await ipool.reserveOf(await weth.getAddress())).to.equal(env.reserve);
  });

  it("Restoring the tolerance lets settle() close in cash, with the insurance draw", async function () {
    const env = await stack();
    const { lender, outsider, weth, vault, ipool } = env;
    await env.stockFalls();
    await env.setTolerance(1);
    await toOpenInKind(vault);
    await expect(vault.connect(outsider).settleInKind()).to.be.revertedWith(BLOCKED);

    await env.setTolerance(200);
    await vault.connect(lender).settle();
    expect(await vault.isSettled()).to.equal(true);
    expect(await vault.settledInKind()).to.equal(false);
    expect(await vault.settledInsuranceDraw()).to.be.greaterThan(0n);
    expect(await ipool.reserveOf(await weth.getAddress())).to.be.lessThan(env.reserve);
  });

  it("Sweep: every tightened tolerance the sale misses is refused; one it clears goes through settle()", async function () {
    for (const bps of [1, 10, 29, 31]) {
      const env = await stack();
      await env.stockFalls();
      await env.setTolerance(bps);
      await toOpenInKind(env.vault);
      await expect(env.vault.connect(env.outsider).settleInKind(), `${bps} bps`).to.be.revertedWith(BLOCKED);
    }
    // 150 bp still clears the pool's fee and impact: the sale succeeds, so this
    // was never an in-kind case, and the existing KRAIT-005 rule points at settle().
    const env = await stack();
    await env.stockFalls();
    await env.setTolerance(150);
    await toOpenInKind(env.vault);
    await expect(env.vault.connect(env.outsider).settleInKind()).to.be.revertedWith("Everything sold - use settle()");
  });

  it("A pool that genuinely cannot take the sale still closes in kind, without insurance, even at a tightened tolerance", async function () {
    const env = await stack();
    const { lender, x, weth, vault, ipool, pool, lp } = env;
    const stock = await vault.heldAmount(await x.getAddress());
    await env.stockFalls();
    await env.setTolerance(1);
    // The liquidity leaves for good: below the pair's minimum (audit M-01).
    await lp.removeFullRangeLiquidity(await pool.getAddress(), await pool.liquidity());

    await time.increaseTo(await vault.inKindFrom());
    await vault.connect(lender).settleInKind();
    expect(await vault.settledInKind()).to.equal(true);
    expect(await x.balanceOf(lender.address)).to.equal(stock);
    expect(await vault.settledInsuranceDraw()).to.equal(0n);
    expect(await ipool.reserveOf(await weth.getAddress())).to.equal(env.reserve);
  });

  it("A token the issuer has frozen still closes in kind at a tightened tolerance: the exit cannot run at all", async function () {
    const env = await stack();
    const { lender, x, weth, vault, ipool } = env;
    const stock = await vault.heldAmount(await x.getAddress());
    await env.stockFalls();
    await env.setTolerance(1);
    await x.setFrozen(true);

    await time.increaseTo(await vault.inKindFrom());
    await vault.connect(lender).settleInKind();
    expect(await vault.settledInKind()).to.equal(true);
    expect(await vault.settledInsuranceDraw()).to.equal(0n);
    expect(await ipool.reserveOf(await weth.getAddress())).to.equal(env.reserve);
    // Undeliverable while frozen: recorded as owed to the lender, claimed later.
    expect(await vault.owed(await x.getAddress(), lender.address)).to.equal(stock);
  });
});
