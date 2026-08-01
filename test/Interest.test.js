const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Annualised interest.
 *
 * The rate is now per-annum and accrues pro-rata, replacing a flat charge that
 * ignored duration entirely — under which a 7-day loan and a 365-day loan at
 * "3%" cost the borrower exactly the same. GroupB, GroupD and GroupH preserve
 * the old expected values by using a one-year term (where full-term interest
 * equals the flat formula) so they remain a regression baseline. The behaviour
 * that is actually NEW is tested here.
 *
 * Three properties, and each exists for a reason:
 *
 *   PRO-RATA, or an annualised rate would make early settlement so punitive
 *   nobody would use it.
 *
 *   A FLOOR, or pure pro-rata lets a borrower originate and settle in the same
 *   block having paid essentially nothing for capital they genuinely held.
 *
 *   The floor CAPPED at full-term interest, or a short loan's floor could
 *   exceed its own maximum interest — which is incoherent, and would mean the
 *   protocol charging more for closing early than for running to term.
 */

const E = ethers.parseEther;
const PRINCIPAL = E("100");
const DEPOSIT   = E("20");
const APR_BPS   = 300n;            // 3% per YEAR now, not 3% flat
const YEAR      = 365 * 24 * 3600;

// Full-term interest for a one-year loan: 3% of 100 = 3. Identical to what the
// old flat formula produced, which is exactly why a one-year term lets the
// legacy suites keep their constants.
const YEAR_FEE  = E("3");

const MIN_FEE_BPS = 10n;           // factory default: 0.1% of principal
const FLOOR       = E("0.1");      // 0.1% of 100

describe("Annualised interest", function () {

  async function fixture() {
    const [operator, lender, borrower, treasury] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const usdx = await Mock.deploy("Mock USDX", "USDX", 18);
    const usdxAddr = await usdx.getAddress();

    const aave = await (await ethers.getContractFactory("MockAavePool", operator)).deploy();
    await aave.configureAsset(usdxAddr);

    const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();

    const kyc = await (await ethers.getContractFactory("KYCRegistry", operator))
      .deploy(operator.address, operator.address);
    await kyc.verify(borrower.address);

    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await aave.getAddress(), await router.getAddress(),
      await uniFactory.getAddress(), usdxAddr
    );
    await registry.addAsset(usdxAddr, await aave.aTokenOf(usdxAddr));
    await registry.setSettlementConfig(1800, 200, 3600, 2, 100);

    // Tier limits disabled for this suite. These tests predate the risk tiers
    // and assert settlement mechanics, not risk policy — same reasoning as
    // setProtocolFeeRateBps(0). Left enabled, the volatility deposit floor
    // alone would reject every fixture: a one-year loan against 60% assumed
    // volatility requires a 100% deposit, which is the model being correct
    // rather than the fixtures being wrong.
    for (const t of [0, 1, 2]) {
      await registry.setTierConfig(t, 0, 0, 365 * 24 * 3600, 10000, 0);
    }

    const pool = await (await ethers.getContractFactory("InsurancePool", operator))
      .deploy(operator.address, 1000);

    // Vaults are EIP-1167 clones of one implementation, so the factory no
    // longer embeds Vault bytecode and needs no library link. The
    // IMPLEMENTATION does — it delegatecalls UniswapTwap.
    const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
    await twapLib.waitForDeployment();
    const vaultImpl = await (await ethers.getContractFactory("Vault", {
      signer: operator,
      libraries: { UniswapTwap: await twapLib.getAddress() },
    })).deploy();
    await vaultImpl.waitForDeployment();
    const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
      await kyc.getAddress(), await registry.getAddress(), await pool.getAddress(),
      treasury.address,
      await vaultImpl.getAddress()   // clone source
    );
    await pool.setVaultFactory(await factory.getAddress());

    // The lender skim now defaults to ZERO — the insurance pool is funded by the
    // borrower's per-tier premium instead, and charging both sides would
    // double-fund it. Re-enabled here because these suites assert skim
    // behaviour specifically, and the mechanism is retained as a dial rather
    // than deleted.
    await factory.setInsuranceSkimRateBps(2000);

    // Terms vary per test, so origination is parameterised by duration.
    async function originate(durationSeconds) {
      const need = PRINCIPAL + YEAR_FEE;   // generous: covers principal + skim
      await usdx.mint(lender.address, need);
      await usdx.connect(lender).approve(await factory.getAddress(), need);

      const before = await factory.totalVaults();
      await factory.connect(lender).deployVault(
        usdxAddr, borrower.address, PRINCIPAL, APR_BPS, durationSeconds, true, DEPOSIT,
        ethers.ZeroAddress
      );
      const vault = await ethers.getContractAt("Vault", await factory.allVaults(before));

      await usdx.mint(borrower.address, DEPOSIT);
      await usdx.connect(borrower).approve(await vault.getAddress(), DEPOSIT);
      await vault.connect(borrower).payDeposit();
      return vault;
    }

    return { operator, lender, borrower, treasury, usdx, usdxAddr, registry, pool, factory, originate };
  }

  // --- The headline property ---

  it("A one-week loan costs a week's interest, not a year's", async function () {
    const { originate } = await loadFixture(fixture);
    const vault = await originate(7 * 24 * 3600);

    const week = await vault.fullTermFee();

    // Under the old flat fee this was 3.0 — a full year's interest for seven
    // days' use of the money. A week should cost roughly a fifty-second of it.
    expect(week).to.be.lessThan(YEAR_FEE / 50n);
    expect(week).to.be.greaterThan(YEAR_FEE / 55n);
  });

  it("Full-term interest on a one-year loan equals the annual rate", async function () {
    const { originate } = await loadFixture(fixture);
    const vault = await originate(YEAR);
    expect(await vault.fullTermFee()).to.equal(YEAR_FEE);
  });

  // --- Pro-rata accrual ---

  it("Accrues exactly half the interest at half the term", async function () {
    const { originate } = await loadFixture(fixture);
    const vault = await originate(YEAR);

    const originatedAt = await vault.originatedAt();
    // increaseTo MINES a block at that timestamp, so the view below evaluates
    // against it. setNextBlockTimestamp would only affect the next tx.
    await time.increaseTo(originatedAt + BigInt(YEAR / 2));

    expect(await vault.accruedFee()).to.equal(YEAR_FEE / 2n);
  });

  it("Accrues a quarter at a quarter of the term", async function () {
    const { originate } = await loadFixture(fixture);
    const vault = await originate(YEAR);

    const originatedAt = await vault.originatedAt();
    await time.increaseTo(originatedAt + BigInt(YEAR / 4));

    expect(await vault.accruedFee()).to.equal(YEAR_FEE / 4n);
  });

  it("Never accrues beyond the full term, however long the loan sits unsettled", async function () {
    const { originate } = await loadFixture(fixture);
    const vault = await originate(YEAR);

    // Three years past the deadline. Interest is not a penalty that keeps
    // running — the keeper bounty is what escalates, deliberately separately.
    await time.increase(4 * YEAR);

    expect(await vault.accruedFee()).to.equal(YEAR_FEE);
  });

  // --- The floor ---

  it("Applies the minimum charge when pro-rata would be less", async function () {
    const { originate } = await loadFixture(fixture);
    const vault = await originate(YEAR);

    // One day of a one-year loan accrues 3/365 = 0.0082, well below the
    // 0.1 floor, so the floor governs.
    const originatedAt = await vault.originatedAt();
    await time.increaseTo(originatedAt + BigInt(24 * 3600));

    expect(await vault.accruedFee()).to.equal(FLOOR);
  });

  it("Stops applying the floor once pro-rata overtakes it", async function () {
    const { originate } = await loadFixture(fixture);
    const vault = await originate(YEAR);

    // The floor is 0.1, which pro-rata passes at YEAR/30 ≈ 12.2 days.
    const originatedAt = await vault.originatedAt();
    await time.increaseTo(originatedAt + BigInt(60 * 24 * 3600));

    const accrued = await vault.accruedFee();
    expect(accrued).to.be.greaterThan(FLOOR);
    expect(accrued).to.equal((PRINCIPAL * APR_BPS * BigInt(60 * 24 * 3600)) / (10000n * BigInt(YEAR)));
  });

  it("Caps the floor at full-term interest on a very short loan", async function () {
    const { originate } = await loadFixture(fixture);
    const vault = await originate(3600);   // one hour

    const full = await vault.fullTermFee();

    // A one-hour loan's entire interest is ~0.000034, far below the 0.1 floor.
    // Charging the floor would mean the borrower paying roughly 3000x the
    // loan's own maximum interest for closing early — so the cap governs.
    expect(full).to.be.lessThan(FLOOR);
    expect(await vault.accruedFee()).to.equal(full);
  });

  // --- Settlement uses the accrued amount ---

  it("Pays the lender principal plus interest ACCRUED, not the full term", async function () {
    const { originate, lender, borrower, usdx } = await loadFixture(fixture);
    const vault = await originate(YEAR);

    const before = await usdx.balanceOf(lender.address);
    const originatedAt = await vault.originatedAt();

    // Settle at exactly half term. setNextBlockTimestamp here rather than
    // increaseTo, because it is the settle TRANSACTION that needs the pinned
    // timestamp, not a view read.
    await time.setNextBlockTimestamp(originatedAt + BigInt(YEAR / 2));
    await vault.connect(borrower).settle();

    const half = YEAR_FEE / 2n;
    expect(await vault.settledFee()).to.equal(half);
    expect(await usdx.balanceOf(lender.address) - before).to.equal(PRINCIPAL + half);
  });

  // --- Skim is priced on the full term ---

  it("Skims the insurance pool on FULL-term interest, not the accrued amount", async function () {
    const { factory, pool, usdxAddr, originate } = await loadFixture(fixture);

    const quoted = await factory.quoteInsuranceSkim(PRINCIPAL, APR_BPS, YEAR, true);
    const before = await pool.reserveOf(usdxAddr);

    await originate(YEAR);

    // 20% of the full-term interest, taken up front. Deliberately not the
    // realised amount: the pool must be funded for maximum exposure before any
    // loss can occur, and the realised interest is unknown at origination.
    expect(quoted).to.equal((YEAR_FEE * 2000n) / 10000n);
    expect(await pool.reserveOf(usdxAddr) - before).to.equal(quoted);
  });

  it("quoteFullTermFee agrees with the vault's own fullTermFee", async function () {
    const { factory, originate } = await loadFixture(fixture);

    for (const days of [1, 7, 30, 365]) {
      const secs = days * 24 * 3600;
      const vault = await originate(secs);
      expect(await vault.fullTermFee()).to.equal(
        await factory.quoteFullTermFee(PRINCIPAL, APR_BPS, secs, true)
      );
    }
  });
});
