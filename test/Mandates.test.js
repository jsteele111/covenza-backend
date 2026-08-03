const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Mandates: a lender publishes terms, a borrower fills them.
 *
 * Capital stays in the lender's wallet until a fill, so nothing is locked up
 * waiting for a counterparty — the friction that otherwise kills the scarce
 * side of a two-sided market.
 *
 * Two properties carry most of the weight here.
 *
 * THE PRICING IS A FORMULA, NOT A RANGE. A mandate quoting "9-15% APR over
 * 1-30 days on a 15-40% deposit" is not a range of acceptable terms; it is the
 * lender's WORST terms with decoration, because every borrower takes 9% at 30
 * days on a 15% deposit. A formula prices every point, so the lender is
 * indifferent across the surface instead of exposed at one corner.
 *
 * FILLS ARE ATOMIC. The mandate flow reverses who initiates: the borrower
 * acts, so a fill that left the vault unfunded would let anyone lock a
 * lender's capital until the deadline for the price of gas, across every
 * mandate on the book.
 */

const E = ethers.parseEther;
const PRINCIPAL = E("100");
const DEPOSIT   = E("20");        // 20% — above the mandate's 15% minimum
const DAY       = 24 * 3600;
const YEAR      = 365 * DAY;

const BLUE_CHIP = 0;
const PREMIUM_BPS = 100n;         // 1% annualised, so the premium is observable

// The mandate's pricing surface.
const BASE_APR       = 900n;      // 9% at minimum term and deposit
const TERM_PREMIUM   = 2n;        // +2 bps per day
const DEPOSIT_CREDIT = 10n;       // -10 bps per whole % of deposit above minimum
const MIN_DEPOSIT    = 1500n;     // 15%
const MIN_APR        = 500n;      // 5% floor

describe("Mandates", function () {

  async function fixture() {
    const [operator, lender, borrower, treasury, outsider] = await ethers.getSigners();

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
    await kyc.verify(outsider.address);   // verified, but not the permitted borrower

    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await aave.getAddress(), await router.getAddress(),
      await uniFactory.getAddress(), usdxAddr
    );
    await registry.addAsset(usdxAddr, await aave.aTokenOf(usdxAddr));
    await registry.setSettlementConfig(1800, 200, 3600, 2, 100);

    // Permissive tiers so only the MANDATE's own bounds bind. Tier enforcement
    // has its own suite; mixing the two would make failures ambiguous.
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

    const factoryAddr = await factory.getAddress();

    // The lender's capital stays in their own wallet — only an allowance is
    // granted. That is the whole point of a mandate.
    await usdx.mint(lender.address, E("1000"));
    await usdx.connect(lender).approve(factoryAddr, E("1000"));

    await usdx.mint(borrower.address, E("500"));
    await usdx.connect(borrower).approve(factoryAddr, E("500"));

    const baseTerms = {
      asset: usdxAddr,
      minPrincipal: E("10"),
      maxPrincipal: E("200"),
      minTermSeconds: DAY,
      maxTermSeconds: 30 * DAY,
      validForSeconds: 6 * 3600,
      maxTier: BLUE_CHIP,
      permittedBorrower: ethers.ZeroAddress,
      baseAprBps: BASE_APR,
      termPremiumBpsPerDay: TERM_PREMIUM,
      depositCreditBpsPerPoint: DEPOSIT_CREDIT,
      minDepositBps: MIN_DEPOSIT,
      minAprBps: MIN_APR,
    };

    async function publish(overrides = {}, signer = lender) {
      const terms = { ...baseTerms, ...overrides };
      const before = await factory.totalMandates();
      await factory.connect(signer).publishMandate(terms);
      return Number(before);
    }

    return { operator, lender, borrower, treasury, outsider, usdx, usdxAddr,
             registry, pool, factory, factoryAddr, publish, baseTerms };
  }

  // --- Publishing ---

  it("Publishes a mandate and reports it live", async function () {
    const { publish, factory, lender, usdxAddr } = await loadFixture(fixture);
    const id = await publish();

    const m = await factory.mandate(id);
    expect(m.lender).to.equal(lender.address);
    expect(m.asset).to.equal(usdxAddr);
    expect(await factory.isMandateLive(id)).to.equal(true);
  });

  it("Refuses a lifetime beyond the protocol's ceiling", async function () {
    const { publish } = await loadFixture(fixture);
    await expect(publish({ validForSeconds: 30 * DAY }))
      .to.be.revertedWith("Mandate lifetime too long");
  });

  it("Refuses a maximum term the tier does not permit", async function () {
    const { publish, registry } = await loadFixture(fixture);
    await registry.setTierConfig(BLUE_CHIP, 0, 0, 7 * DAY, 10000, 0);

    await expect(publish({ maxTermSeconds: 30 * DAY }))
      .to.be.revertedWith("Maximum term exceeds the tier's limit");
  });

  it("Refuses a floor APR above the base", async function () {
    const { publish } = await loadFixture(fixture);
    await expect(publish({ minAprBps: 1200n })).to.be.revertedWith("Minimum APR above base");
  });

  // --- The pricing surface ---

  it("Charges the base rate at the minimum term and deposit", async function () {
    const { publish, factory } = await loadFixture(fixture);
    const id = await publish();

    // 1 day, 15% deposit: 900 + 2x1 - 0 = 902
    expect(await factory.quoteMandateApr(id, DAY, MIN_DEPOSIT)).to.equal(902n);
  });

  it("Adds a premium for a longer term", async function () {
    const { publish, factory } = await loadFixture(fixture);
    const id = await publish();

    // 30 days: 900 + 2x30 = 960
    expect(await factory.quoteMandateApr(id, 30 * DAY, MIN_DEPOSIT)).to.equal(960n);
  });

  it("Credits a larger deposit", async function () {
    const { publish, factory } = await loadFixture(fixture);
    const id = await publish();

    // 30 days at 30% deposit: 960 - 10 x (3000-1500)/100 = 960 - 150 = 810
    expect(await factory.quoteMandateApr(id, 30 * DAY, 3000n)).to.equal(810n);
  });

  it("Never prices below the mandate's floor", async function () {
    const { publish, factory } = await loadFixture(fixture);
    const id = await publish();

    // 100% deposit would compute 960 - 850 = 110, beneath the 500 floor.
    expect(await factory.quoteMandateApr(id, 30 * DAY, 10000n)).to.equal(MIN_APR);
  });

  it("Leaves no cheap corner — every point on the surface is priced", async function () {
    const { publish, factory } = await loadFixture(fixture);
    const id = await publish();

    // Under a RANGE, a borrower takes the longest term and smallest deposit and
    // pays the minimum. Under a formula that combination is the DEAREST.
    const cheapestCorner = await factory.quoteMandateApr(id, 30 * DAY, MIN_DEPOSIT);
    const shortSmall     = await factory.quoteMandateApr(id, DAY, MIN_DEPOSIT);
    const longLarge      = await factory.quoteMandateApr(id, 30 * DAY, 4000n);

    expect(cheapestCorner).to.be.greaterThan(shortSmall);
    expect(cheapestCorner).to.be.greaterThan(longLarge);
  });

  // --- Validity and withdrawal ---

  it("Stops being live once it expires", async function () {
    const { publish, factory } = await loadFixture(fixture);
    const id = await publish();

    await time.increase(6 * 3600 + 1);
    expect(await factory.isMandateLive(id)).to.equal(false);
  });

  it("Stops being live once cancelled", async function () {
    const { publish, factory, lender } = await loadFixture(fixture);
    const id = await publish();

    await factory.connect(lender).cancelMandate(id);
    expect(await factory.isMandateLive(id)).to.equal(false);
  });

  it("Refuses cancellation by anyone but the lender", async function () {
    const { publish, factory, borrower } = await loadFixture(fixture);
    const id = await publish();

    await expect(factory.connect(borrower).cancelMandate(id))
      .to.be.revertedWith("Not your mandate");
  });

  it("Kills every mandate at once via the nonce", async function () {
    const { publish, factory, lender } = await loadFixture(fixture);
    const a = await publish();
    const b = await publish();
    const c = await publish();

    // One transaction, however many are standing. If withdrawing during a rate
    // move were expensive, lenders would leave stale mandates up rather than
    // pay to remove them.
    await factory.connect(lender).cancelAllMandates();

    for (const id of [a, b, c]) {
      expect(await factory.isMandateLive(id)).to.equal(false);
    }
  });

  // --- Fillable size, not offered size ---

  it("Reports fillable as the lesser of allowance, balance and offer", async function () {
    const { publish, factory, lender, usdx, factoryAddr } = await loadFixture(fixture);
    const id = await publish();

    // Offer is 200; allowance 1000; balance 1000. Offer binds.
    expect(await factory.quoteMandateFillable(id)).to.equal(E("200"));

    // Drop the allowance below the offer and it binds instead.
    await usdx.connect(lender).approve(factoryAddr, E("50"));
    expect(await factory.quoteMandateFillable(id)).to.equal(E("50"));
  });

  it("Reports zero fillable once the allowance is revoked", async function () {
    const { publish, factory, lender, usdx, factoryAddr } = await loadFixture(fixture);
    const id = await publish();

    // An allowance is not a commitment — it can be withdrawn for free at any
    // moment. A book showing intent rather than capacity is a book of offers
    // that cannot be taken.
    await usdx.connect(lender).approve(factoryAddr, 0);
    expect(await factory.quoteMandateFillable(id)).to.equal(0);
  });

  // --- Filling ---

  it("Fills, originating a vault priced by the formula", async function () {
    const { publish, factory, borrower, lender } = await loadFixture(fixture);
    const id = await publish();

    await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT);

    const vault = await ethers.getContractAt("Vault", await factory.allVaults(0));
    expect(await vault.lender()).to.equal(lender.address);
    expect(await vault.borrower()).to.equal(borrower.address);
    expect(await vault.principal()).to.equal(PRINCIPAL);

    // 30 days at 20% deposit: 960 - 10 x (2000-1500)/100 = 960 - 50 = 910
    expect(await vault.aprBps()).to.equal(910n);
  });

  it("Leaves the vault fully funded — no second transaction required", async function () {
    const { publish, factory, borrower, usdx } = await loadFixture(fixture);
    const id = await publish();

    await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT);
    const vault = await ethers.getContractAt("Vault", await factory.allVaults(0));

    expect(await vault.depositPaid()).to.equal(true);
    expect(await vault.deposit()).to.equal(DEPOSIT);
    expect(await usdx.balanceOf(await vault.getAddress())).to.equal(PRINCIPAL + DEPOSIT);
  });

  it("Routes the borrower's premium into the pool in the same transaction", async function () {
    const { publish, factory, borrower, pool, usdxAddr } = await loadFixture(fixture);
    const id = await publish();

    const before = await pool.reserveOf(usdxAddr);
    await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT);

    const expected = (PRINCIPAL * PREMIUM_BPS * BigInt(30 * DAY)) / (10000n * BigInt(YEAR));
    expect(await pool.reserveOf(usdxAddr) - before).to.equal(expected);
  });

  it("Draws the principal from the LENDER, not the filler", async function () {
    const { publish, factory, borrower, lender, usdx } = await loadFixture(fixture);
    const id = await publish();

    const lenderBefore = await usdx.balanceOf(lender.address);
    await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT);

    expect(lenderBefore - await usdx.balanceOf(lender.address)).to.equal(PRINCIPAL);
  });

  // --- Bounds ---

  it("Refuses a principal outside the mandate", async function () {
    const { publish, factory, borrower } = await loadFixture(fixture);
    const id = await publish();

    await expect(factory.connect(borrower).fillMandate(id, E("500"), 30 * DAY, true, E("100")))
      .to.be.revertedWith("Principal outside the mandate's bounds");
  });

  it("Refuses a term outside the mandate", async function () {
    const { publish, factory, borrower } = await loadFixture(fixture);
    const id = await publish();

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 60 * DAY, true, DEPOSIT))
      .to.be.revertedWith("Term outside the mandate's bounds");
  });

  it("Refuses a deposit below the mandate's minimum", async function () {
    const { publish, factory, borrower } = await loadFixture(fixture);
    const id = await publish();

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, E("10")))
      .to.be.revertedWith("Deposit below the mandate's minimum");
  });

  it("Refuses anyone but the permitted borrower when one is named", async function () {
    const { publish, factory, borrower, outsider } = await loadFixture(fixture);
    const id = await publish({ permittedBorrower: borrower.address });

    await expect(factory.connect(outsider).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT))
      .to.be.revertedWith("Not the permitted borrower for this mandate");

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT))
      .to.not.be.reverted;
  });

  it("Refuses a mandate that is no longer live", async function () {
    const { publish, factory, borrower, lender } = await loadFixture(fixture);
    const id = await publish();
    await factory.connect(lender).cancelMandate(id);

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT))
      .to.be.revertedWith("Mandate is not live");
  });

  // --- Atomicity ---

  it("Leaves NOTHING behind when the lender's allowance is gone", async function () {
    const { publish, factory, borrower, lender, usdx, factoryAddr } = await loadFixture(fixture);
    const id = await publish();

    // The lender revoked between publishing and the fill — which they may do
    // at any moment, for free.
    await usdx.connect(lender).approve(factoryAddr, 0);

    const borrowerBefore = await usdx.balanceOf(borrower.address);

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT))
      .to.be.reverted;

    // No vault, no moved funds, and the mandate is still there to be filled if
    // the lender re-approves.
    expect(await factory.totalVaults()).to.equal(0);
    expect(await usdx.balanceOf(borrower.address)).to.equal(borrowerBefore);
    expect(await factory.isMandateLive(id)).to.equal(true);
  });

  it("Leaves NOTHING behind when the borrower cannot cover the deposit", async function () {
    const { publish, factory, borrower, usdx, factoryAddr, lender } = await loadFixture(fixture);
    const id = await publish();

    await usdx.connect(borrower).approve(factoryAddr, 0);
    const lenderBefore = await usdx.balanceOf(lender.address);

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT))
      .to.be.reverted;

    // The lender's principal must not have moved. Without atomicity this is
    // the griefing vector: fill every mandate, fund none, and lock the book's
    // capital until each deadline for the price of gas.
    expect(await usdx.balanceOf(lender.address)).to.equal(lenderBefore);
    expect(await factory.totalVaults()).to.equal(0);
  });
});
