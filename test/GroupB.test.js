const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Group B/D integration tests — the full Vault v2 lifecycle against mock
 * Aave, mock Uniswap router, and a mock TWAP source. Covers swap mechanics,
 * the deposit invariant, forced swap-back (aligned and diverged TWAP),
 * insurance draws, the three-tier access model, and the keeper bounty.
 *
 * Tick reference (1.0001^tick):  0 = 1:1,  -1054 ~ 0.90,  -2232 ~ 0.80
 */

const E = ethers.parseEther;
const PRINCIPAL = E("10");
const DEPOSIT   = E("1.5");
const FEE_BPS   = 300n;                 // 3% -> fee 0.3, lender target 10.3
const FEE       = E("0.3");
const SKIM      = E("0.06");            // 20% of fee (factory default)
const TARGET    = PRINCIPAL + FEE;
const DURATION  = 7200;                 // 2h loan (seconds mode)
const GRACE     = 3600;                 // 1h grace period
const POOL_FEE  = 3000;

/**
 * Uniswap tick values are relative to the pair's ADDRESS ordering
 * (token0 = lower address). This helper returns the tick that makes the
 * TWAP price of `base` -> `quote` equal 1.0001^magnitude, regardless of
 * which side of the ordering the two mock tokens landed on when deployed.
 * (Hardcoding the sign caused 3 test failures on first run — the mock
 * tokens deployed in the opposite order to the one assumed.)
 */
function tickFor(baseAddr, quoteAddr, magnitude) {
  return BigInt(baseAddr.toLowerCase()) < BigInt(quoteAddr.toLowerCase())
    ? magnitude
    : -magnitude;
}

describe("Group B — Vault v2 lifecycle (integration)", function () {

  async function deployStackFixture() {
    const [operator, lender, borrower, keeper] = await ethers.getSigners();

    // --- Tokens (both 18dp so tick 0 = exact 1:1) ---
    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const weth = await Mock.deploy("Mock WETH", "WETH", 18);
    const usdx = await Mock.deploy("Mock USDX", "USDX", 18);

    // --- Mock integrations ---
    const aave = await (await ethers.getContractFactory("MockAavePool", operator)).deploy();
    await aave.configureAsset(await weth.getAddress());
    const aTokenWeth = await aave.aTokenOf(await weth.getAddress());

    const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();
    const uniPool = await (await ethers.getContractFactory("MockUniswapV3Pool", operator)).deploy();
    await uniFactory.setPool(await weth.getAddress(), await usdx.getAddress(), POOL_FEE, await uniPool.getAddress());
    // Default: TWAP parity and 1:1 spot, both directions.
    await uniPool.setAvgTick(0);
    await router.setRate(await weth.getAddress(), await usdx.getAddress(), 1, 1);
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 1, 1);
    // Router inventory for payouts in both directions.
    await weth.mint(await router.getAddress(), E("1000"));
    await usdx.mint(await router.getAddress(), E("1000"));

    // --- Protocol contracts ---
    const kyc = await (await ethers.getContractFactory("KYCRegistry", operator))
      .deploy(operator.address, operator.address);
    await kyc.verify(borrower.address);

    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await aave.getAddress(), await router.getAddress(),
      await uniFactory.getAddress(), await weth.getAddress()
    );
    await registry.addAsset(await weth.getAddress(), aTokenWeth);
    await registry.addAsset(await usdx.getAddress(), ethers.ZeroAddress);
    await registry.setSettlementConfig(1800, 200, GRACE, 2, 100); // 2% tol, 1h grace, 2bps/hr, 1% cap

    const pool = await (await ethers.getContractFactory("InsurancePool", operator))
      .deploy(operator.address, 1000); // draw cap 10% of principal

    const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
      await kyc.getAddress(), await registry.getAddress(), await pool.getAddress()
    );
    await pool.setVaultFactory(await factory.getAddress());

    // --- Originate a WETH loan ---
    await weth.mint(lender.address, PRINCIPAL + SKIM);
    await weth.connect(lender).approve(await factory.getAddress(), PRINCIPAL + SKIM);
    await factory.connect(lender).deployVault(
      await weth.getAddress(), borrower.address, PRINCIPAL, FEE_BPS, DURATION, true, DEPOSIT
    );
    const vault = (await ethers.getContractFactory("Vault", operator))
      .attach(await factory.allVaults(0));

    // --- Borrower pays deposit ---
    await weth.mint(borrower.address, DEPOSIT);
    await weth.connect(borrower).approve(await vault.getAddress(), DEPOSIT);
    await vault.connect(borrower).payDeposit();

    return { operator, lender, borrower, keeper, weth, usdx, aave, aTokenWeth,
             router, uniPool, kyc, registry, pool, factory, vault };
  }

  // --- Origination & funding ---

  it("Origination: vault funded with principal, skim in pool reserve, vault registered", async function () {
    const { vault, weth, pool, factory } = await loadFixture(deployStackFixture);

    expect(await weth.balanceOf(await vault.getAddress())).to.equal(PRINCIPAL + DEPOSIT);
    expect(await pool.reserveOf(await weth.getAddress())).to.equal(SKIM);
    expect(await pool.isRegisteredVault(await vault.getAddress())).to.equal(true);
    expect(await factory.quoteInsuranceSkim(PRINCIPAL, FEE_BPS)).to.equal(SKIM);
  });

  // --- Deposit invariant ---

  it("Invariant: Aave supply of full principal succeeds; one wei more is blocked", async function () {
    const { vault, borrower, aTokenWeth } = await loadFixture(deployStackFixture);

    await expect(vault.connect(borrower).supplyToAave(PRINCIPAL + 1n))
      .to.be.revertedWith("Action would touch the deposit - deposit is not investable");

    await vault.connect(borrower).supplyToAave(PRINCIPAL);
    const aToken = await ethers.getContractAt("MockAToken", aTokenWeth);
    expect(await aToken.balanceOf(await vault.getAddress())).to.equal(PRINCIPAL);
  });

  it("Invariant: swapping out the full principal succeeds; one wei more is blocked", async function () {
    const { vault, borrower, usdx } = await loadFixture(deployStackFixture);
    const usdxAddr = await usdx.getAddress();

    await expect(vault.connect(borrower).swap(usdxAddr, PRINCIPAL + 1n, 1n, POOL_FEE))
      .to.be.revertedWith("Action would touch the deposit - deposit is not investable");

    await vault.connect(borrower).swap(usdxAddr, PRINCIPAL, PRINCIPAL, POOL_FEE);
    expect(await usdx.balanceOf(await vault.getAddress())).to.equal(PRINCIPAL);
    expect(await vault.heldAssetCount()).to.equal(1);
    expect(await vault.isHeld(usdxAddr)).to.equal(true);
  });

  // --- Swap rules ---

  it("Swap: rejects non-whitelisted destinations and enforces minAmountOut", async function () {
    const { vault, borrower, operator, usdx, router, weth } = await loadFixture(deployStackFixture);
    const usdxAddr = await usdx.getAddress();

    const rogue = await (await ethers.getContractFactory("MockERC20", operator)).deploy("Rogue", "RGE", 18);
    await expect(
      vault.connect(borrower).swap(await rogue.getAddress(), E("1"), 1n, POOL_FEE)
    ).to.be.revertedWith("Destination asset not whitelisted");

    // Slippage floor: rate 1:1 but borrower demands more than 1:1 back.
    await expect(
      vault.connect(borrower).swap(usdxAddr, E("1"), E("1.01"), POOL_FEE)
    ).to.be.revertedWith("Too little received");
  });

  it("Swap-back: permitted even after the asset is removed from the whitelist", async function () {
    const { vault, borrower, registry, usdx, weth } = await loadFixture(deployStackFixture);
    const usdxAddr = await usdx.getAddress();

    await vault.connect(borrower).swap(usdxAddr, E("4"), E("4"), POOL_FEE);
    await registry.removeAsset(usdxAddr);

    // New exposure blocked...
    await expect(
      vault.connect(borrower).swap(usdxAddr, E("1"), 1n, POOL_FEE)
    ).to.be.revertedWith("Destination asset not whitelisted");

    // ...but the way back is always open (stranding safety).
    await vault.connect(borrower).swapBack(usdxAddr, E("4"), E("4"));
    expect(await vault.isHeld(usdxAddr)).to.equal(false);
    expect(await weth.balanceOf(await vault.getAddress())).to.equal(PRINCIPAL + DEPOSIT);
  });

  // --- Early close ---

  it("Early close: profit path pays lender target and borrower the residual", async function () {
    const { vault, borrower, lender, weth, aave } = await loadFixture(deployStackFixture);
    const wethAddr = await weth.getAddress();

    await vault.connect(borrower).supplyToAave(PRINCIPAL);
    // Simulate 0.5 WETH yield: extra aTokens to vault + underlying to Aave.
    await aave.simulateYield(wethAddr, await vault.getAddress(), E("0.5"));
    await weth.mint(await aave.getAddress(), E("0.5"));

    await vault.connect(borrower).settle();

    expect(await weth.balanceOf(lender.address)).to.equal(TARGET);
    expect(await weth.balanceOf(borrower.address)).to.equal(DEPOSIT + E("0.5") - FEE);
    expect(await vault.lossSeverity()).to.equal(0);
    expect(await vault.settledInsuranceDraw()).to.equal(0);
  });

  it("Early close: blocked when a realised swap loss exceeds what the fee absorbs", async function () {
    const { vault, borrower, router, uniPool, weth, usdx } = await loadFixture(deployStackFixture);

    await vault.connect(borrower).swap(await usdx.getAddress(), PRINCIPAL, PRINCIPAL, POOL_FEE);
    // Market drops 20%: spot AND TWAP move together (genuine move, not manipulation).
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 8, 10);
    await uniPool.setAvgTick(tickFor(await usdx.getAddress(), await weth.getAddress(), -2232));

    await expect(vault.connect(borrower).settle())
      .to.be.revertedWith("Cannot close early at a loss beyond deposit");
  });

  // --- Post-deadline: no foreign assets ---

  it("Post-deadline, no foreign assets: anyone may settle immediately, no bounty", async function () {
    const { vault, keeper, lender, weth } = await loadFixture(deployStackFixture);

    await time.increase(DURATION + 1);
    await vault.connect(keeper).settle();

    expect(await weth.balanceOf(lender.address)).to.equal(TARGET);
    expect(await vault.settledBounty()).to.equal(0);
  });

  // --- Post-deadline: foreign assets, three-tier access ---

  it("Grace period: keeper rejected, lender may settle; forced swap-back executes", async function () {
    const { vault, borrower, lender, keeper, weth, usdx } = await loadFixture(deployStackFixture);

    await vault.connect(borrower).swap(await usdx.getAddress(), PRINCIPAL, PRINCIPAL, POOL_FEE);
    await time.increase(DURATION + 60); // past deadline, inside 1h grace

    await expect(vault.connect(keeper).settle())
      .to.be.revertedWith("Grace period: only lender or borrower may settle");

    await expect(vault.connect(lender).settle()).to.emit(vault, "ForcedSwapBack");
    expect(await weth.balanceOf(lender.address)).to.equal(TARGET);
    expect(await vault.settledBounty()).to.equal(0);
  });

  it("Past grace: keeper settles and earns the linear bounty from borrower residual", async function () {
    const { vault, borrower, keeper, lender, weth, usdx } = await loadFixture(deployStackFixture);

    await vault.connect(borrower).swap(await usdx.getAddress(), PRINCIPAL, PRINCIPAL, POOL_FEE);
    // 5h past grace end: 2bps/hr * 5h = 10bps of principal = 0.01 WETH.
    await time.increase(DURATION + GRACE + 5 * 3600);

    await vault.connect(keeper).settle();

    const bounty = await vault.settledBounty();
    expect(bounty).to.equal(E("0.01"));
    expect(await weth.balanceOf(keeper.address)).to.equal(bounty);
    expect(await weth.balanceOf(lender.address)).to.equal(TARGET);
    // Residual 1.2 (deposit 1.5 - fee 0.3) minus bounty.
    expect(await weth.balanceOf(borrower.address)).to.equal(E("1.19"));
  });

  // --- Forced swap-back: TWAP safety ---

  it("TWAP divergence: settlement reverts entirely when spot is beyond tolerance of TWAP", async function () {
    const { vault, borrower, lender, router, weth, usdx } = await loadFixture(deployStackFixture);

    await vault.connect(borrower).swap(await usdx.getAddress(), PRINCIPAL, PRINCIPAL, POOL_FEE);
    // Spot collapses 20% but TWAP still says parity — manipulation signature.
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 8, 10);

    await time.increase(DURATION + 60);
    await expect(vault.connect(lender).settle()).to.be.revertedWith("Too little received");
    expect(await vault.isSettled()).to.equal(false); // fully retryable
  });

  // --- Insurance pool in the waterfall ---

  it("Loss beyond deposit: insurance pool draw makes the lender whole (severity 1)", async function () {
    const { vault, borrower, lender, operator, router, uniPool, pool, weth, usdx } = await loadFixture(deployStackFixture);
    const wethAddr = await weth.getAddress();

    // Top the pool up so it can cover the coming shortfall.
    await weth.mint(operator.address, E("2"));
    await weth.connect(operator).approve(await pool.getAddress(), E("2"));
    await pool.connect(operator).fund(wethAddr, E("2"));

    await vault.connect(borrower).swap(await usdx.getAddress(), PRINCIPAL, PRINCIPAL, POOL_FEE);
    // Genuine 20% market drop (spot + TWAP together).
    await router.setRate(await usdx.getAddress(), wethAddr, 8, 10);
    await uniPool.setAvgTick(tickFor(await usdx.getAddress(), wethAddr, -2232));

    await time.increase(DURATION + GRACE + 61);
    await vault.connect(lender).settle();

    // Returned: 8 + 1.5 = 9.5; shortfall 0.8; cap 1.0; pool pays 0.8 in full.
    expect(await vault.settledInsuranceDraw()).to.equal(E("0.8"));
    expect(await weth.balanceOf(lender.address)).to.equal(TARGET);
    expect(await vault.lossSeverity()).to.equal(1); // loss happened; pool absorbed it
    expect(await pool.reserveOf(wethAddr)).to.equal(E("2") + SKIM - E("0.8"));
  });

  it("Thin pool: settlement still completes; lender takes the shortfall (severity 2)", async function () {
    const { vault, borrower, lender, router, uniPool, weth, usdx } = await loadFixture(deployStackFixture);

    await vault.connect(borrower).swap(await usdx.getAddress(), PRINCIPAL, PRINCIPAL, POOL_FEE);
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 8, 10);
    await uniPool.setAvgTick(tickFor(await usdx.getAddress(), await weth.getAddress(), -2232));

    await time.increase(DURATION + GRACE + 61);
    await vault.connect(lender).settle();

    // Pool held only the 0.06 skim: draw pays 0.06, lender gets 9.56 < 10.3.
    expect(await vault.settledInsuranceDraw()).to.equal(SKIM);
    expect(await weth.balanceOf(lender.address)).to.equal(E("9.5") + SKIM);
    expect(await vault.lossSeverity()).to.equal(2);
  });
});