const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Group D — edge-case suite for Vault v2 / VaultFactory v2.
 * Re-expresses the v1 test suite's guard-rail coverage in v2 terms, plus
 * v2-specific edges GroupB.test.js doesn't touch. GroupB covers the happy
 * paths and the settlement waterfall; this file covers the fences.
 */

const E = ethers.parseEther;
const PRINCIPAL = E("10");
const DEPOSIT   = E("1.5");
const FEE_BPS   = 300n;
const FEE       = E("0.3");
const SKIM      = E("0.06");
const TARGET    = PRINCIPAL + FEE;
const DURATION  = 7200;
const GRACE     = 3600;
const POOL_FEE  = 3000;

function tickFor(baseAddr, quoteAddr, magnitude) {
  return BigInt(baseAddr.toLowerCase()) < BigInt(quoteAddr.toLowerCase())
    ? magnitude
    : -magnitude;
}

describe("Group D — guard rails and edge cases", function () {

  async function deployStackFixture() {
    const [operator, lender, borrower, keeper, unverified] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const weth = await Mock.deploy("Mock WETH", "WETH", 18);
    const usdx = await Mock.deploy("Mock USDX", "USDX", 18);

    const aave = await (await ethers.getContractFactory("MockAavePool", operator)).deploy();
    await aave.configureAsset(await weth.getAddress());
    const aTokenWeth = await aave.aTokenOf(await weth.getAddress());

    const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();
    const uniPool = await (await ethers.getContractFactory("MockUniswapV3Pool", operator)).deploy();
    await uniFactory.setPool(await weth.getAddress(), await usdx.getAddress(), POOL_FEE, await uniPool.getAddress());
    await uniPool.setAvgTick(0);
    await router.setRate(await weth.getAddress(), await usdx.getAddress(), 1, 1);
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 1, 1);
    await weth.mint(await router.getAddress(), E("1000"));
    await usdx.mint(await router.getAddress(), E("1000"));

    const kyc = await (await ethers.getContractFactory("KYCRegistry", operator))
      .deploy(operator.address, operator.address);
    await kyc.verify(borrower.address);

    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await aave.getAddress(), await router.getAddress(),
      await uniFactory.getAddress(), await weth.getAddress()
    );
    await registry.addAsset(await weth.getAddress(), aTokenWeth);
    await registry.addAsset(await usdx.getAddress(), ethers.ZeroAddress);
    await registry.setSettlementConfig(1800, 200, GRACE, 2, 100);

    const pool = await (await ethers.getContractFactory("InsurancePool", operator))
      .deploy(operator.address, 1000);

    const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
      await kyc.getAddress(), await registry.getAddress(), await pool.getAddress()
    );
    await pool.setVaultFactory(await factory.getAddress());

    await weth.mint(lender.address, PRINCIPAL + SKIM);
    await weth.connect(lender).approve(await factory.getAddress(), PRINCIPAL + SKIM);
    await factory.connect(lender).deployVault(
      await weth.getAddress(), borrower.address, PRINCIPAL, FEE_BPS, DURATION, true, DEPOSIT
    );
    const vault = (await ethers.getContractFactory("Vault", operator))
      .attach(await factory.allVaults(0));

    return { operator, lender, borrower, keeper, unverified, weth, usdx, aave, aTokenWeth,
             router, uniPool, kyc, registry, pool, factory, vault };
  }

  async function fundedVaultFixture() {
    const ctx = await deployStackFixture();
    await ctx.weth.mint(ctx.borrower.address, DEPOSIT);
    await ctx.weth.connect(ctx.borrower).approve(await ctx.vault.getAddress(), DEPOSIT);
    await ctx.vault.connect(ctx.borrower).payDeposit();
    return ctx;
  }

  // --- Factory gates ---

  it("Factory: rejects an unverified borrower", async function () {
    const { factory, lender, weth, unverified } = await loadFixture(deployStackFixture);
    await weth.mint(lender.address, PRINCIPAL + SKIM);
    await weth.connect(lender).approve(await factory.getAddress(), PRINCIPAL + SKIM);
    await expect(
      factory.connect(lender).deployVault(
        await weth.getAddress(), unverified.address, PRINCIPAL, FEE_BPS, DURATION, true, DEPOSIT)
    ).to.be.revertedWith("Borrower is not KYC verified");
  });

  it("Factory: rejects a non-whitelisted loan asset", async function () {
    const { factory, lender, borrower, operator } = await loadFixture(deployStackFixture);
    const rogue = await (await ethers.getContractFactory("MockERC20", operator)).deploy("Rogue", "RGE", 18);
    await expect(
      factory.connect(lender).deployVault(
        await rogue.getAddress(), borrower.address, PRINCIPAL, FEE_BPS, DURATION, true, DEPOSIT)
    ).to.be.revertedWith("Loan asset is not whitelisted");
  });

  it("Factory: rejects origination without sufficient lender approval (principal + skim)", async function () {
    const { factory, lender, borrower, weth } = await loadFixture(deployStackFixture);
    await weth.mint(lender.address, PRINCIPAL + SKIM);
    // Approve principal only — the skim pull must fail.
    await weth.connect(lender).approve(await factory.getAddress(), PRINCIPAL);
    await expect(
      factory.connect(lender).deployVault(
        await weth.getAddress(), borrower.address, PRINCIPAL, FEE_BPS, DURATION, true, DEPOSIT)
    ).to.be.reverted;
  });

  it("Factory: zero-value parameters are each rejected", async function () {
    const { factory, lender, borrower, weth } = await loadFixture(deployStackFixture);
    const w = await weth.getAddress();
    const d = factory.connect(lender);
    await expect(d.deployVault(w, borrower.address, 0, FEE_BPS, DURATION, true, DEPOSIT))
      .to.be.revertedWith("Principal must be greater than zero");
    await expect(d.deployVault(w, borrower.address, PRINCIPAL, 0, DURATION, true, DEPOSIT))
      .to.be.revertedWith("Fee rate must be greater than zero");
    await expect(d.deployVault(w, borrower.address, PRINCIPAL, FEE_BPS, 0, true, DEPOSIT))
      .to.be.revertedWith("Duration must be greater than zero");
    await expect(d.deployVault(w, borrower.address, PRINCIPAL, FEE_BPS, DURATION, true, 0))
      .to.be.revertedWith("Deposit must be greater than zero");
  });

  it("Factory: tracks vaults by borrower and lender", async function () {
    const { factory, lender, borrower, vault } = await loadFixture(deployStackFixture);
    expect(await factory.totalVaults()).to.equal(1);
    expect(await factory.getVaultsByBorrower(borrower.address)).to.deep.equal([await vault.getAddress()]);
    expect(await factory.getVaultsByLender(lender.address)).to.deep.equal([await vault.getAddress()]);
  });

  it("KYC revocation mid-loan: existing vault still functions (KYC gates origination only)", async function () {
    const { kyc, vault, borrower, weth } = await loadFixture(fundedVaultFixture);
    await kyc.revoke(borrower.address);
    // Borrower can still operate and close their existing loan.
    await vault.connect(borrower).supplyToAave(E("1"));
    await vault.connect(borrower).settle();
    expect(await vault.isSettled()).to.equal(true);
  });

  // --- Deposit edges ---

  it("payDeposit: only borrower; no double-pay; rejected after deadline; needs approval", async function () {
    const { vault, borrower, lender, weth } = await loadFixture(deployStackFixture);

    await expect(vault.connect(lender).payDeposit())
      .to.be.revertedWith("Only borrower can pay deposit");

    // No approval yet: transferFrom must fail.
    await weth.mint(borrower.address, DEPOSIT);
    await expect(vault.connect(borrower).payDeposit()).to.be.reverted;

    await weth.connect(borrower).approve(await vault.getAddress(), DEPOSIT);
    await vault.connect(borrower).payDeposit();

    await expect(vault.connect(borrower).payDeposit())
      .to.be.revertedWith("Deposit already paid");
  });

  it("payDeposit: rejected once the deadline has passed", async function () {
    const { vault, borrower, weth } = await loadFixture(deployStackFixture);
    await weth.mint(borrower.address, DEPOSIT);
    await weth.connect(borrower).approve(await vault.getAddress(), DEPOSIT);
    await time.increase(DURATION + 1);
    await expect(vault.connect(borrower).payDeposit())
      .to.be.revertedWith("Deadline has passed");
  });

  it("Actions before deposit is paid are rejected (onlyActiveBorrower)", async function () {
    const { vault, borrower } = await loadFixture(deployStackFixture);
    await expect(vault.connect(borrower).supplyToAave(E("1")))
      .to.be.revertedWith("Deposit not yet paid");
    await expect(vault.connect(borrower).settle())
      .to.be.revertedWith("Deposit not yet paid");
  });

  // --- Invariant under combined actions ---

  it("Invariant holds across combined Aave + swap activity", async function () {
    const { vault, borrower, usdx } = await loadFixture(fundedVaultFixture);
    const usdxAddr = await usdx.getAddress();

    await vault.connect(borrower).supplyToAave(E("6"));
    await vault.connect(borrower).swap(usdxAddr, E("4"), E("4"), POOL_FEE);
    // Loan-asset balance is now exactly the deposit — one more wei out must fail.
    await expect(vault.connect(borrower).swap(usdxAddr, 1n, 1n, POOL_FEE))
      .to.be.revertedWith("Action would touch the deposit - deposit is not investable");
    await expect(vault.connect(borrower).supplyToAave(1n))
      .to.be.revertedWith("Action would touch the deposit - deposit is not investable");
  });

  it("withdrawFromAave mid-term restores investable balance", async function () {
    const { vault, borrower, weth } = await loadFixture(fundedVaultFixture);
    await vault.connect(borrower).supplyToAave(PRINCIPAL);
    await vault.connect(borrower).withdrawFromAave(E("3"));
    expect(await weth.balanceOf(await vault.getAddress())).to.equal(E("3") + DEPOSIT);
    await vault.connect(borrower).supplyToAave(E("3")); // re-invest is fine
  });

  it("swapBack: rejects assets that are not actually held", async function () {
    const { vault, borrower, usdx } = await loadFixture(fundedVaultFixture);
    await expect(vault.connect(borrower).swapBack(await usdx.getAddress(), E("1"), E("1")))
      .to.be.revertedWith("Not a held asset");
  });

  // --- Settlement edges ---

  it("settle: double settlement is rejected", async function () {
    const { vault, borrower } = await loadFixture(fundedVaultFixture);
    await vault.connect(borrower).settle();
    await expect(vault.connect(borrower).settle())
      .to.be.revertedWith("Loan already settled");
  });

  it("settle: early close by non-borrower is rejected", async function () {
    const { vault, lender, keeper } = await loadFixture(fundedVaultFixture);
    await expect(vault.connect(lender).settle())
      .to.be.revertedWith("Only borrower can close early");
    await expect(vault.connect(keeper).settle())
      .to.be.revertedWith("Only borrower can close early");
  });

  it("settle: exactly at the deadline still counts as early (borrower-only)", async function () {
    const { vault, borrower, keeper } = await loadFixture(fundedVaultFixture);
    const deadline = await vault.deadline();
    await time.setNextBlockTimestamp(deadline);
    await expect(vault.connect(keeper).settle())
      .to.be.revertedWith("Only borrower can close early");
  });

  it("Bounty: accrual is capped at bountyCapBps of principal", async function () {
    const { vault, borrower, keeper, weth, usdx } = await loadFixture(fundedVaultFixture);
    await vault.connect(borrower).swap(await usdx.getAddress(), PRINCIPAL, PRINCIPAL, POOL_FEE);
    // 200h past grace: 2bps/hr would be 400bps — cap is 100bps = 0.1 WETH.
    await time.increase(DURATION + GRACE + 200 * 3600);
    await vault.connect(keeper).settle();
    expect(await vault.settledBounty()).to.equal(E("0.1"));
    expect(await weth.balanceOf(keeper.address)).to.equal(E("0.1"));
  });

  it("Bounty: capped at zero when the borrower residual is zero (lender unaffected)", async function () {
    const { vault, borrower, keeper, router, uniPool, weth, usdx } = await loadFixture(fundedVaultFixture);
    const usdxAddr = await usdx.getAddress();
    const wethAddr = await weth.getAddress();

    await vault.connect(borrower).swap(usdxAddr, PRINCIPAL, PRINCIPAL, POOL_FEE);
    // 20% genuine drop: residual will be zero after the loss.
    await router.setRate(usdxAddr, wethAddr, 8, 10);
    await uniPool.setAvgTick(tickFor(usdxAddr, wethAddr, -2232));

    await time.increase(DURATION + GRACE + 10 * 3600);
    await vault.connect(keeper).settle();

    expect(await vault.settledBounty()).to.equal(0);
    expect(await weth.balanceOf(keeper.address)).to.equal(0);
    expect(await vault.isSettled()).to.equal(true); // settlement itself unaffected
  });
});