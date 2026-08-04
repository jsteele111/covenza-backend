const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Who funds the insurance pool, and what happens when a borrower never turns up.
 *
 * The premium moved from the lender to the borrower. The lender's skim was 20%
 * of their interest, so a lender quoting 12% netted 9.6% — a hidden haircut on
 * the headline figure, and the worst possible friction to put on the scarce side
 * of a two-sided market. Credit enhancement is borrower-funded almost everywhere
 * it exists, for the same reason.
 *
 * The mechanical requirement that drives the design: the premium is collected
 * UPFRONT. Accrued to settlement, a loan ending in a loss might never pay it —
 * correlating claim events with premium failures, which is the one property an
 * insurance fund cannot have.
 *
 * Cancellation exists because of a testnet finding. An unfunded vault could be
 * settled after its deadline: it holds only principal, the lender is owed
 * principal plus interest, and the shortfall came from an INSURANCE DRAW. The
 * shared pool was subsidising a loan that never started.
 */

const E = ethers.parseEther;
const PRINCIPAL = E("100");
const DEPOSIT   = E("20");
const APR_BPS   = 300n;
const DAY       = 24 * 3600;
const YEAR      = 365 * DAY;

const BLUE_CHIP = 0;
const PREMIUM_BPS = 100n;        // 1% annualised
const YEAR_PREMIUM = E("1");     // 1% of 100 over a full year

describe("Insurance funding and cancellation", function () {

  async function fixture() {
    const [operator, lender, borrower, treasury, keeper] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const usdx = await Mock.deploy("Mock USDX", "USDX", 18);
    const usdxAddr = await usdx.getAddress();

    const aave = await (await ethers.getContractFactory("MockAavePool", operator)).deploy();
    await aave.configureAsset(usdxAddr);

    const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();

    const kyc = await (await ethers.getContractFactory("KYCRegistry", operator))
      .deploy(operator.address, operator.address, 0);
    await kyc.verify(borrower.address);

    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await aave.getAddress(), await router.getAddress(),
      await uniFactory.getAddress(), usdxAddr
    );
    await registry.addAsset(usdxAddr, await aave.aTokenOf(usdxAddr));
    // Explicit: a never-seen asset defaults to Speculative, not BlueChip. This
    // suite asserts that the vault's CEILING prices the premium rather than
    // the loan asset's own tier, which needs the loan asset to be tagged
    // deliberately rather than inherited from a default.
    await registry.setTier(usdxAddr, 0);
    await registry.setSettlementConfig(1800, 200, 3600, 2, 100);

    // Permissive everywhere except the premium, which is what this suite tests.
    for (const t of [0, 1, 2]) {
      await registry.setTierConfig(t, 0, 0, YEAR, 10000, PREMIUM_BPS);
    }

    const pool = await (await ethers.getContractFactory("InsurancePool", operator))
      .deploy(operator.address, 1000, 0);

    const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
    await twapLib.waitForDeployment();
    const vaultImpl = await (await ethers.getContractFactory("Vault", {
      signer: operator,
      libraries: { UniswapTwap: await twapLib.getAddress() },
    })).deploy();
    await vaultImpl.waitForDeployment();

    const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
      await kyc.getAddress(), await registry.getAddress(), await pool.getAddress(),
      treasury.address, await vaultImpl.getAddress()
    , 0);
    await pool.setVaultFactory(await factory.getAddress());
    await factory.setProtocolFeeRateBps(0);

    // Originates but does NOT pay the deposit — the cancellation tests need
    // that state, and the funded helper builds on it.
    async function originate(term = YEAR) {
      const need = PRINCIPAL + E("10");
      await usdx.mint(lender.address, need);
      await usdx.connect(lender).approve(await factory.getAddress(), need);

      const before = await factory.totalVaults();
      await factory.connect(lender).deployVaultWithTier(
        usdxAddr, borrower.address, PRINCIPAL, APR_BPS, term, true, DEPOSIT,
        ethers.ZeroAddress, BLUE_CHIP
      );
      return ethers.getContractAt("Vault", await factory.allVaults(before));
    }

    async function fund(vault) {
      const premium = await vault.insurancePremium();
      const total = DEPOSIT + premium;
      await usdx.mint(borrower.address, total);
      await usdx.connect(borrower).approve(await vault.getAddress(), total);
      await vault.connect(borrower).payDeposit();
      return premium;
    }

    return { operator, lender, borrower, treasury, keeper, usdx, usdxAddr,
             registry, pool, factory, originate, fund };
  }

  // --- Pricing ---

  it("Prices the premium on the FULL term, not on time elapsed", async function () {
    const { originate } = await loadFixture(fixture);

    const yearVault = await originate(YEAR);
    expect(await yearVault.insurancePremium()).to.equal(YEAR_PREMIUM);

    // Thirty days is 30/365 of the annual figure.
    const monthVault = await originate(30 * DAY);
    const expected = (PRINCIPAL * PREMIUM_BPS * BigInt(30 * DAY)) / (10000n * BigInt(YEAR));
    expect(await monthVault.insurancePremium()).to.equal(expected);
  });

  it("Prices from the vault's risk CEILING, not the loan asset's own tier", async function () {
    const { originate, registry, usdxAddr } = await loadFixture(fixture);

    // The loan asset is BlueChip; the ceiling is what the borrower may hold.
    await registry.setTierConfig(2, 0, 0, YEAR, 10000, 600n);   // Speculative: 6%
    expect(await registry.tierOf(usdxAddr)).to.equal(BLUE_CHIP);

    const blueVault = await originate(YEAR);
    expect(await blueVault.insurancePremium()).to.equal(YEAR_PREMIUM);
  });

  it("Snapshots the premium so a later repricing cannot touch a live loan", async function () {
    const { originate, registry } = await loadFixture(fixture);
    const vault = await originate(YEAR);

    await registry.setTierConfig(BLUE_CHIP, 0, 0, YEAR, 10000, 900n);   // 9%

    expect(await vault.insurancePremium()).to.equal(YEAR_PREMIUM);
  });

  // --- Collection ---

  it("Collects the premium from the BORROWER, alongside the deposit", async function () {
    const { originate, fund, borrower, usdx } = await loadFixture(fixture);
    const vault = await originate(YEAR);

    const before = await usdx.balanceOf(borrower.address);
    const premium = await fund(vault);

    // Borrower was minted exactly deposit + premium, and paid all of it.
    expect(premium).to.equal(YEAR_PREMIUM);
    expect(await usdx.balanceOf(borrower.address)).to.equal(before);
  });

  it("Routes the premium straight into the pool's reserve", async function () {
    const { originate, fund, pool, usdxAddr } = await loadFixture(fixture);
    const vault = await originate(YEAR);

    const before = await pool.reserveOf(usdxAddr);
    await fund(vault);

    expect(await pool.reserveOf(usdxAddr) - before).to.equal(YEAR_PREMIUM);
  });

  it("Does NOT count the premium as deposit", async function () {
    const { originate, fund, usdx } = await loadFixture(fixture);
    const vault = await originate(YEAR);
    await fund(vault);

    // The premium arrives in the same transfer and leaves immediately. Counting
    // it would inflate the segregation invariant and every payout after it.
    expect(await vault.deposit()).to.equal(DEPOSIT);
    expect(await usdx.balanceOf(await vault.getAddress())).to.equal(PRINCIPAL + DEPOSIT);
  });

  it("Does not refund the premium on early settlement", async function () {
    const { originate, fund, borrower, pool, usdxAddr } = await loadFixture(fixture);
    const vault = await originate(YEAR);
    await fund(vault);

    const reserveAfterFunding = await pool.reserveOf(usdxAddr);
    await vault.connect(borrower).settle();

    // Insurance premiums are not refunded pro-rata, and the pool cannot return
    // capital it may already have paid out in claims.
    expect(await pool.reserveOf(usdxAddr)).to.equal(reserveAfterFunding);
  });

  // --- The skim, retained as a dial ---

  it("Collects no lender skim by default", async function () {
    const { factory } = await loadFixture(fixture);
    expect(await factory.insuranceSkimRateBps()).to.equal(0);
    expect(await factory.quoteInsuranceSkim(PRINCIPAL, APR_BPS, YEAR, true)).to.equal(0);
  });

  it("Can fund the pool from BOTH sides when the operator wants a split", async function () {
    const { originate, fund, factory, pool, usdxAddr } = await loadFixture(fixture);
    await factory.setInsuranceSkimRateBps(2000);   // 20% of interest, from the lender

    const before = await pool.reserveOf(usdxAddr);
    const vault = await originate(YEAR);
    await fund(vault);

    // Interest is 3% of 100 = 3; a 20% skim is 0.6. Plus the 1.0 premium.
    const expected = E("0.6") + YEAR_PREMIUM;
    expect(await pool.reserveOf(usdxAddr) - before).to.equal(expected);
  });

  // --- Cancellation ---

  it("Returns principal to the lender when the borrower never funded", async function () {
    const { originate, lender, usdx, keeper } = await loadFixture(fixture);
    const vault = await originate(YEAR);

    await time.increase(YEAR + 1);

    const before = await usdx.balanceOf(lender.address);
    await vault.connect(keeper).cancel();   // anyone may call; there is no discretion

    expect(await usdx.balanceOf(lender.address) - before).to.equal(PRINCIPAL);
    expect(await vault.isSettled()).to.equal(true);
  });

  it("Draws NOTHING from the insurance pool when cancelling", async function () {
    const { originate, pool, usdxAddr, keeper } = await loadFixture(fixture);
    const vault = await originate(YEAR);
    await time.increase(YEAR + 1);

    const before = await pool.reserveOf(usdxAddr);
    await vault.connect(keeper).cancel();

    // The whole point. Settling this vault would have covered the lender's
    // interest shortfall from the shared pool — 3% of principal for a loan
    // that never started, paid for by every other lender who funded it.
    expect(await pool.reserveOf(usdxAddr)).to.equal(before);
  });

  it("Refuses to cancel before the deadline", async function () {
    const { originate, keeper } = await loadFixture(fixture);
    const vault = await originate(YEAR);

    await expect(vault.connect(keeper).cancel())
      .to.be.revertedWith("Deadline has not passed");
  });

  it("Refuses to cancel a vault whose deposit WAS paid", async function () {
    const { originate, fund, keeper } = await loadFixture(fixture);
    const vault = await originate(YEAR);
    await fund(vault);
    await time.increase(YEAR + 1);

    await expect(vault.connect(keeper).cancel())
      .to.be.revertedWith("Deposit was paid - settle instead");
  });

  it("Refuses to settle an unfunded vault, pointing at cancel()", async function () {
    const { originate, keeper } = await loadFixture(fixture);
    const vault = await originate(YEAR);
    await time.increase(YEAR + 1);

    await expect(vault.connect(keeper).settle())
      .to.be.revertedWith("Deposit was never paid - use cancel()");
  });

  it("Refuses to cancel twice", async function () {
    const { originate, keeper } = await loadFixture(fixture);
    const vault = await originate(YEAR);
    await time.increase(YEAR + 1);

    await vault.connect(keeper).cancel();
    await expect(vault.connect(keeper).cancel())
      .to.be.revertedWith("Loan already settled");
  });
});
