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
    const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();

    const kyc = await (await ethers.getContractFactory("KYCRegistry", operator))
      .deploy(operator.address, operator.address, 0);
    await kyc.verify(borrower.address, 7, ethers.id("test-fixture"));
    await kyc.verify(lender.address, 7, ethers.id("test-fixture"));  // lenders are screened too (#7)
    await kyc.verify(outsider.address, 7, ethers.id("test-fixture"));   // verified, but not the permitted borrower

    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await router.getAddress(),
      await uniFactory.getAddress(), 0
    );
    await registry.addAsset(usdxAddr, 0);
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
    await pool.queueSetVaultFactory(await factory.getAddress());   // audit M-05: the first wiring is announced too
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
      totalCapacity: E("1000"),     // item 13: total across all fills
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
      maxInsuranceSkimRateBps: 0,   // audit L-01: consents to no skim (the default rate)
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

  // --- Where the protocol floor binds instead of the mandate's own ---
  //
  // The fixture above deliberately zeroes tier volatility and tier minimum
  // deposit, so that only the mandate's bounds bind. That isolation is why the
  // suite passed while the interaction below was wrong: with a tier floor of
  // zero, "credit above the mandate minimum" and "credit above the binding
  // minimum" are the same expression.
  //
  // These tests give the tier real parameters, so the floor overtakes the
  // mandate's minimum partway along the term axis — which is the situation
  // every real deployment is in.

  async function withBindingFloor(registry) {
    // Blue chip: 60% assumed volatility, 10% absolute floor. At the default
    // 1.8 coefficient the volatility term overtakes 15% at roughly a week, so
    // a 1-30 day mandate spans both regimes.
    await registry.setTierConfig(BLUE_CHIP, 6000, 1000, 365 * DAY, 10000, PREMIUM_BPS);
  }

  it("Reports the binding deposit as the greater of the two floors", async function () {
    const { publish, factory, registry } = await loadFixture(fixture);
    await withBindingFloor(registry);
    const id = await publish();

    // At one day the tier's absolute 10% floor is beneath the mandate's 15%,
    // so the mandate binds.
    expect(await factory.bindingDepositBps(id, DAY)).to.equal(MIN_DEPOSIT);

    // At thirty days the volatility term has long overtaken it.
    const tierFloor = await registry.minimumDepositBpsForTier(BLUE_CHIP, 30 * DAY);
    expect(tierFloor).to.be.greaterThan(MIN_DEPOSIT);
    expect(await factory.bindingDepositBps(id, 30 * DAY)).to.equal(tierFloor);
  });

  it("Pays no credit for deposit the protocol compelled", async function () {
    const { publish, factory, registry } = await loadFixture(fixture);
    await withBindingFloor(registry);
    const id = await publish();

    const tierFloor = await registry.minimumDepositBpsForTier(BLUE_CHIP, 30 * DAY);

    // A borrower posting exactly the floor had no choice about any of it, so
    // the rate is the undiscounted 30-day rate: 900 + 2x30 = 960.
    expect(await factory.quoteMandateApr(id, 30 * DAY, tierFloor)).to.equal(960n);
  });

  it("Credits only the deposit a borrower chose to add", async function () {
    const { publish, factory, registry } = await loadFixture(fixture);
    await withBindingFloor(registry);
    const id = await publish();

    const tierFloor = await registry.minimumDepositBpsForTier(BLUE_CHIP, 30 * DAY);
    const chosen = tierFloor + 500n;   // five points above what was required

    // 960 - 10 x 500/100 = 960 - 50 = 910
    expect(await factory.quoteMandateApr(id, 30 * DAY, chosen)).to.equal(910n);
  });

  it("Leaves the lender's advertised rate achievable at every term", async function () {
    const { publish, factory, registry } = await loadFixture(fixture);
    await withBindingFloor(registry);
    const id = await publish();

    // The regression this guards: the lender's quoted rate at a term must be
    // obtainable by SOME permitted borrower. Previously the cheapest legal
    // deposit at 30 days already carried a 160bp discount, so the advertised
    // 9.60% could never be received.
    for (const days of [1, 7, 14, 30]) {
      const term = days * DAY;
      const binding = await factory.bindingDepositBps(id, term);
      const advertised = BASE_APR + TERM_PREMIUM * BigInt(days);
      expect(await factory.quoteMandateApr(id, term, binding)).to.equal(advertised);
    }
  });

  it("Still credits normally where the mandate's own minimum binds", async function () {
    const { publish, factory, registry } = await loadFixture(fixture);
    await withBindingFloor(registry);
    const id = await publish();

    // At one day the mandate's 15% binds, so behaviour is unchanged from
    // before: 900 + 2 = 902, less 10 x (2000-1500)/100 = 50.
    expect(await factory.quoteMandateApr(id, DAY, 2000n)).to.equal(852n);
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
    expect(await factory.quoteMandatePrincipalCapacity(id)).to.equal(E("200"));

    // Drop the allowance below the offer and it binds instead.
    await usdx.connect(lender).approve(factoryAddr, E("50"));
    expect(await factory.quoteMandatePrincipalCapacity(id)).to.equal(E("50"));
  });

  it("Reports zero fillable once the allowance is revoked", async function () {
    const { publish, factory, lender, usdx, factoryAddr } = await loadFixture(fixture);
    const id = await publish();

    // An allowance is not a commitment — it can be withdrawn for free at any
    // moment. A book showing intent rather than capacity is a book of offers
    // that cannot be taken.
    await usdx.connect(lender).approve(factoryAddr, 0);
    expect(await factory.quoteMandatePrincipalCapacity(id)).to.equal(0);
  });

  // --- Filling ---

  it("Fills, originating a vault priced by the formula", async function () {
    const { publish, factory, borrower, lender } = await loadFixture(fixture);
    const id = await publish();

    await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256);

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

    await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256);
    const vault = await ethers.getContractAt("Vault", await factory.allVaults(0));

    expect(await vault.depositPaid()).to.equal(true);
    expect(await vault.deposit()).to.equal(DEPOSIT);
    expect(await usdx.balanceOf(await vault.getAddress())).to.equal(PRINCIPAL + DEPOSIT);
  });

  it("Routes the borrower's premium into the pool in the same transaction", async function () {
    const { publish, factory, borrower, pool, usdxAddr } = await loadFixture(fixture);
    const id = await publish();

    const before = await pool.reserveOf(usdxAddr);
    await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256);

    // Audit M-06: priced on the term plus the 5-day insured window.
    const expected = (PRINCIPAL * PREMIUM_BPS * BigInt(30 * DAY + 5 * DAY)) / (10000n * BigInt(YEAR));
    expect(await pool.reserveOf(usdxAddr) - before).to.equal(expected);
  });

  it("Draws the principal from the LENDER, not the filler", async function () {
    const { publish, factory, borrower, lender, usdx } = await loadFixture(fixture);
    const id = await publish();

    const lenderBefore = await usdx.balanceOf(lender.address);
    await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256);

    expect(lenderBefore - await usdx.balanceOf(lender.address)).to.equal(PRINCIPAL);
  });

  // --- Bounds ---

  it("Refuses a fill priced above the borrower's limit (audit L-6)", async function () {
    const { publish, factory, borrower } = await loadFixture(fixture);
    const id = await publish();
    const apr = await factory.quoteMandateApr(id, 30 * DAY, (DEPOSIT * 10000n) / PRINCIPAL);

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, apr - 1n))
      .to.be.revertedWith("APR above the borrower's limit");
    await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, apr);
  });

  it("Refuses a principal outside the mandate", async function () {
    const { publish, factory, borrower } = await loadFixture(fixture);
    const id = await publish();

    await expect(factory.connect(borrower).fillMandate(id, E("500"), 30 * DAY, true, E("100"), ethers.MaxUint256))
      .to.be.revertedWith("Principal outside the mandate's bounds");
  });

  it("Refuses a term outside the mandate", async function () {
    const { publish, factory, borrower } = await loadFixture(fixture);
    const id = await publish();

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 60 * DAY, true, DEPOSIT, ethers.MaxUint256))
      .to.be.revertedWith("Term outside the mandate's bounds");
  });

  it("Refuses a deposit below the mandate's minimum", async function () {
    const { publish, factory, borrower } = await loadFixture(fixture);
    const id = await publish();

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, E("10"), ethers.MaxUint256))
      .to.be.revertedWith("Deposit below the mandate's minimum");
  });

  it("Refuses anyone but the permitted borrower when one is named", async function () {
    const { publish, factory, borrower, outsider } = await loadFixture(fixture);
    const id = await publish({ permittedBorrower: borrower.address });

    await expect(factory.connect(outsider).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256))
      .to.be.revertedWith("Not the permitted borrower for this mandate");

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256))
      .to.not.be.reverted;
  });

  it("Refuses a mandate that is no longer live", async function () {
    const { publish, factory, borrower, lender } = await loadFixture(fixture);
    const id = await publish();
    await factory.connect(lender).cancelMandate(id);

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256))
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

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256))
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

    await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256))
      .to.be.reverted;

    // The lender's principal must not have moved. Without atomicity this is
    // the griefing vector: fill every mandate, fund none, and lock the book's
    // capital until each deadline for the price of gas.
    expect(await usdx.balanceOf(lender.address)).to.equal(lenderBefore);
    expect(await factory.totalVaults()).to.equal(0);
  });

  // --- Capacity (MAINNET-READINESS item 13) ---

  it("Refuses a total capacity below the per-loan maximum", async function () {
    const { publish } = await loadFixture(fixture);
    await expect(publish({ totalCapacity: E("100") }))  // max per loan is 200
      .to.be.revertedWith("Capacity below the per-loan maximum");
  });

  it("Stops lending once its TOTAL capacity is used, across borrowers", async function () {
    const { publish, factory, borrower } = await loadFixture(fixture);
    const id = await publish({ maxPrincipal: E("100"), totalCapacity: E("250") });

    await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256);
    await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256);
    expect(await factory.mandateRemaining(id)).to.equal(E("50"));
    expect(await factory.quoteMandatePrincipalCapacity(id)).to.equal(E("50"));

    // A third full-size loan no longer fits...
    await expect(
      factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256)
    ).to.be.revertedWith("Exceeds the mandate's remaining capacity");

    // ...but the remainder can still be taken.
    await factory.connect(borrower).fillMandate(id, E("50"), 30 * DAY, true, E("10"), ethers.MaxUint256);
    expect(await factory.mandateRemaining(id)).to.equal(0);
    expect(await factory.quoteMandatePrincipalCapacity(id)).to.equal(0);
  });

  it("A fill that fails uses up none of the capacity", async function () {
    const { publish, factory, borrower, lender, usdx, factoryAddr } = await loadFixture(fixture);
    const id = await publish({ totalCapacity: E("250") });
    await usdx.connect(lender).approve(factoryAddr, 0);

    await expect(
      factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256)
    ).to.be.reverted;
    expect(await factory.mandateRemaining(id)).to.equal(E("250"));
  });

  // --- Audit L-01 (Zealynx): the lender's consent to the insurance skim ---
  //
  // The skim comes out of the LENDER's wallet on top of the principal, at the
  // rate in force when a borrower fills — possibly long after the lender
  // published. A mandate now names the highest rate its lender accepts, and a
  // fill above it reverts before anything moves.

  describe("Audit L-01 — a raised insurance skim cannot be charged to an older mandate", function () {
    it("The finding: after a raise from 0, filling the old mandate reverts and the lender's balance is untouched", async function () {
      const { publish, factory, borrower, lender, usdx } = await loadFixture(fixture);
      const id = await publish();                       // published at 0, consenting to 0
      await factory.setInsuranceSkimRateBps(2000);
      const before = await usdx.balanceOf(lender.address);

      await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256))
        .to.be.revertedWith("Insurance skim above the mandate's limit");
      expect(await usdx.balanceOf(lender.address)).to.equal(before);
      expect((await factory.mandate(id)).filled).to.equal(0n);
    });

    it("A mandate republished to accept the rate fills, and debits only principal plus the quoted skim", async function () {
      const { publish, factory, borrower, lender, usdx } = await loadFixture(fixture);
      await factory.setInsuranceSkimRateBps(2000);
      const id = await publish({ maxInsuranceSkimRateBps: 2000 });
      expect((await factory.mandate(id)).maxInsuranceSkimRateBps).to.equal(2000n);
      const before = await usdx.balanceOf(lender.address);

      await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256);
      const vault = await ethers.getContractAt("Vault", await factory.allVaults(0));
      const skim = await factory.quoteInsuranceSkim(PRINCIPAL, await vault.aprBps(), 30 * DAY, true);
      expect(skim).to.be.greaterThan(0n);
      expect(before - (await usdx.balanceOf(lender.address))).to.equal(PRINCIPAL + skim);
    });

    it("The ceiling is a ceiling: a lower rate fills, a higher one is refused", async function () {
      const { publish, factory, borrower } = await loadFixture(fixture);
      const id = await publish({ maxInsuranceSkimRateBps: 2000 });
      await factory.setInsuranceSkimRateBps(1000);
      await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256);
      await factory.setInsuranceSkimRateBps(2001);
      await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256))
        .to.be.revertedWith("Insurance skim above the mandate's limit");
    });

    it("Refuses a ceiling above 100%", async function () {
      const { publish } = await loadFixture(fixture);
      await expect(publish({ maxInsuranceSkimRateBps: 10001 })).to.be.revertedWith("Skim ceiling above 100%");
    });
  });

  // --- Audit L-04 (Zealynx): what can actually be filled ---
  //
  // quoteMandateFillable returned the smaller of lender liquidity and the
  // remaining offer. It ignored the mandate's minimum principal (a remainder
  // too small to fill was advertised) and the insurance skim the lender pays on
  // top of principal (an allowance of exactly the principal was advertised as
  // fillable). It is now quoteMandatePrincipalCapacity, an upper bound that is
  // zero when nothing can be filled, and previewMandateFill answers for a
  // specific principal, term and deposit.

  describe("Audit L-04 — the fill preview matches what fillMandate will do", function () {
    const OK = 0n, PRINCIPAL_BOUNDS = 3n, CAPACITY = 4n, TERM_BOUNDS = 5n, DEPOSIT_MANDATE = 6n,
          SKIM_LIMIT = 7n, SAME_PARTY = 8n, BORROWER_KYC = 9n, LENDER_FUNDS = 13n;

    const preview = (factory, id, who, principal, days, deposit) =>
      factory.previewMandateFill(id, who.address, principal, days * DAY, true, deposit);

    it("The finding: a 50 remainder under a 60 minimum is no longer advertised, and the preview says why", async function () {
      const { publish, factory, borrower } = await loadFixture(fixture);
      const id = await publish({ minPrincipal: E("60"), maxPrincipal: E("100"), totalCapacity: E("150") });
      await factory.connect(borrower).fillMandate(id, E("100"), 30 * DAY, true, DEPOSIT, ethers.MaxUint256);
      expect(await factory.mandateRemaining(id)).to.equal(E("50"));

      expect(await factory.quoteMandatePrincipalCapacity(id)).to.equal(0n);           // was 50
      expect((await preview(factory, id, borrower, E("50"), 30, E("10"))).code).to.equal(PRINCIPAL_BOUNDS);
      expect((await preview(factory, id, borrower, E("60"), 30, E("12"))).code).to.equal(CAPACITY);
      await expect(factory.connect(borrower).fillMandate(id, E("50"), 30 * DAY, true, E("10"), ethers.MaxUint256))
        .to.be.revertedWith("Principal outside the mandate's bounds");
    });

    it("A 50 remainder under a 50 minimum is advertised, previews as fillable, and fills", async function () {
      const { publish, factory, borrower } = await loadFixture(fixture);
      const id = await publish({ minPrincipal: E("50"), maxPrincipal: E("100"), totalCapacity: E("150") });
      await factory.connect(borrower).fillMandate(id, E("100"), 30 * DAY, true, DEPOSIT, ethers.MaxUint256);

      expect(await factory.quoteMandatePrincipalCapacity(id)).to.equal(E("50"));
      const p = await preview(factory, id, borrower, E("50"), 30, E("10"));
      expect(p.code).to.equal(OK);
      await factory.connect(borrower).fillMandate(id, E("50"), 30 * DAY, true, E("10"), ethers.MaxUint256);
      expect(await factory.mandateRemaining(id)).to.equal(0n);
    });

    it("The skim: an allowance of exactly the principal previews as short; principal plus skim fills, debiting exactly that", async function () {
      const { publish, factory, borrower, lender, usdx, factoryAddr } = await loadFixture(fixture);
      await factory.setInsuranceSkimRateBps(10000);                 // 100% of the full-term fee
      const id = await publish({ maxInsuranceSkimRateBps: 10000 });

      await usdx.connect(lender).approve(factoryAddr, PRINCIPAL);
      const short = await preview(factory, id, borrower, PRINCIPAL, 30, DEPOSIT);
      expect(short.code).to.equal(LENDER_FUNDS);
      expect(short.lenderDebit).to.be.greaterThan(PRINCIPAL);
      expect(await factory.quoteMandatePrincipalCapacity(id)).to.equal(PRINCIPAL);   // an upper bound only
      await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256))
        .to.be.reverted;

      await usdx.connect(lender).approve(factoryAddr, short.lenderDebit);
      const ok = await preview(factory, id, borrower, PRINCIPAL, 30, DEPOSIT);
      expect(ok.code).to.equal(OK);
      expect(ok.lenderDebit).to.equal(short.lenderDebit);
      const before = await usdx.balanceOf(lender.address);
      await factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256);
      expect(before - (await usdx.balanceOf(lender.address))).to.equal(ok.lenderDebit);
    });

    it("The term: an allowance that covers a one-day skim previews the one-day fill as fillable and the 30-day fill as short", async function () {
      const { publish, factory, borrower, lender, usdx, factoryAddr } = await loadFixture(fixture);
      await factory.setInsuranceSkimRateBps(10000);
      const id = await publish({ maxInsuranceSkimRateBps: 10000 });

      const oneDay = await preview(factory, id, borrower, PRINCIPAL, 1, DEPOSIT);
      await usdx.connect(lender).approve(factoryAddr, oneDay.lenderDebit);
      expect((await preview(factory, id, borrower, PRINCIPAL, 1, DEPOSIT)).code).to.equal(OK);
      expect((await preview(factory, id, borrower, PRINCIPAL, 30, DEPOSIT)).code).to.equal(LENDER_FUNDS);

      await expect(factory.connect(borrower).fillMandate(id, PRINCIPAL, 30 * DAY, true, DEPOSIT, ethers.MaxUint256))
        .to.be.reverted;
      await factory.connect(borrower).fillMandate(id, PRINCIPAL, DAY, true, DEPOSIT, ethers.MaxUint256);
    });

    it("The balance counts as well as the allowance", async function () {
      const { publish, factory, borrower, lender, outsider, usdx } = await loadFixture(fixture);
      await factory.setInsuranceSkimRateBps(10000);
      const id = await publish({ maxInsuranceSkimRateBps: 10000 });
      const need = (await preview(factory, id, borrower, PRINCIPAL, 30, DEPOSIT)).lenderDebit;

      await usdx.connect(lender).transfer(outsider.address, (await usdx.balanceOf(lender.address)) - need + 1n);
      expect((await preview(factory, id, borrower, PRINCIPAL, 30, DEPOSIT)).code).to.equal(LENDER_FUNDS);
      await usdx.connect(outsider).transfer(lender.address, 1n);
      expect((await preview(factory, id, borrower, PRINCIPAL, 30, DEPOSIT)).code).to.equal(OK);
    });

    it("Reports the other refusals fillMandate would make, and the APR it would charge", async function () {
      const { publish, factory, borrower, lender } = await loadFixture(fixture);
      const id = await publish();
      const ok = await preview(factory, id, borrower, PRINCIPAL, 30, DEPOSIT);
      expect(ok.code).to.equal(OK);
      expect(ok.aprBps).to.equal(910n);                              // the formula's 30-day, 20% price
      expect((await preview(factory, id, borrower, PRINCIPAL, 31, DEPOSIT)).code).to.equal(TERM_BOUNDS);
      expect((await preview(factory, id, borrower, PRINCIPAL, 30, E("1"))).code).to.equal(DEPOSIT_MANDATE);
      expect((await preview(factory, id, lender, PRINCIPAL, 30, DEPOSIT)).code).to.equal(SAME_PARTY);
      const stranger = (await ethers.getSigners())[12];             // never verified
      expect((await preview(factory, id, stranger, PRINCIPAL, 30, DEPOSIT)).code).to.equal(BORROWER_KYC);
      await factory.setInsuranceSkimRateBps(1);
      expect((await preview(factory, id, borrower, PRINCIPAL, 30, DEPOSIT)).code).to.equal(SKIM_LIMIT);
    });
  });
});
