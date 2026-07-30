const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Group H — protocol fee.
 *
 * The fee is an ADD-ON charged to the borrower, taken from the residual at
 * settlement. Two properties matter above all others and are tested here
 * directly rather than inferred:
 *
 *   1. The lender's payout is NEVER reduced by it. A lender's advertised
 *      yield is what they receive, regardless of protocol revenue.
 *   2. A loss yields ZERO protocol fee. Because the fee comes only from
 *      what survives after the lender is made whole, the protocol earns
 *      nothing precisely when the lender didn't.
 *
 * Also covered: the keeper bounty ranks ahead of the fee (the settlement
 * incentive must not be starvable by protocol revenue), terms are
 * snapshotted at origination so a rate change cannot be applied
 * retroactively to a live loan, and the configuration caps hold.
 *
 * GroupB and GroupD disable the fee so their exact-payout assertions stay
 * valid as a regression baseline; all fee behaviour lives here.
 */

const E = ethers.parseEther;
const PRINCIPAL   = E("10");
const DEPOSIT     = E("1.5");
const FEE_BPS     = 300n;              // 3% -> fee 0.3, lender target 10.3
const FEE         = E("0.3");
const SKIM        = E("0.06");         // 20% of fee (factory default)
const TARGET      = PRINCIPAL + FEE;
const DURATION    = 365 * 24 * 3600;    // one year — see atDeadline() below
const GRACE       = 3600;
const POOL_FEE    = 3000;

const FEE_RATE_BPS = 1000n;            // 10% of the loan fee (factory default)
const PROTOCOL_FEE = E("0.03");        // 0.3 * 10%
const REFERRER_SHARE_BPS = 3000n;      // 30% of the protocol fee
const REFERRER_CUT = E("0.009");       // 0.03 * 30%
const TREASURY_CUT = E("0.021");       // 0.03 - 0.009

function tickFor(baseAddr, quoteAddr, magnitude) {
  return BigInt(baseAddr.toLowerCase()) < BigInt(quoteAddr.toLowerCase())
    ? magnitude
    : -magnitude;
}

// With interest annualised, the fee depends on ELAPSED time. Settling in the
// same block as origination would accrue almost nothing, so the constants
// above would all be wrong.
//
// Two things make them right again. The term is a full year, so
// fullTermFee = principal * aprBps / 10000 — identical to the old flat
// formula. And for early-close tests, this puts the settling block exactly ON
// the deadline: still "early" (the check is block.timestamp <= deadline) but
// with the whole term elapsed, so accrued interest equals the full-term
// amount. Every expected value below therefore stands unchanged.
async function atDeadline(vault) {
  await time.setNextBlockTimestamp(await vault.deadline());
}

describe("Group H — protocol fee", function () {

  // Shared stack. `referrer` is passed per-origination, so the fixture
  // returns the factory unbound and each test originates what it needs.
  async function baseFixture() {
    const [operator, lender, borrower, keeper, treasury, referrer] = await ethers.getSigners();

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

    // Fee left at the factory defaults: 10% of fee, 30% referrer share.
    // UniswapTwap is a deployed library now, not inlined — VaultFactory
    // embeds Vault, which delegatecalls into it, so the address must be
    // linked at deploy time.
    const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
    await twapLib.waitForDeployment();
    const factory = await (await ethers.getContractFactory("VaultFactory", {
      signer: operator,
      libraries: { UniswapTwap: await twapLib.getAddress() },
    })).deploy(
      await kyc.getAddress(), await registry.getAddress(), await pool.getAddress(),
      treasury.address
    );
    await pool.setVaultFactory(await factory.getAddress());

    async function originate(referrerAddr = ethers.ZeroAddress) {
      await weth.mint(lender.address, PRINCIPAL + SKIM);
      await weth.connect(lender).approve(await factory.getAddress(), PRINCIPAL + SKIM);
      const before = await factory.totalVaults();
      await factory.connect(lender).deployVault(
        await weth.getAddress(), borrower.address, PRINCIPAL, FEE_BPS, DURATION, true, DEPOSIT,
        referrerAddr
      );
      const vault = await ethers.getContractAt("Vault", await factory.allVaults(before));

      await weth.mint(borrower.address, DEPOSIT);
      await weth.connect(borrower).approve(await vault.getAddress(), DEPOSIT);
      await vault.connect(borrower).payDeposit();
      return vault;
    }

    return { operator, lender, borrower, keeper, treasury, referrer,
             weth, usdx, aave, aTokenWeth, router, uniPool, kyc, registry, pool,
             factory, originate };
  }

  // --- Core behaviour ---

  it("Clean settlement pays the protocol fee to the treasury", async function () {
    const { originate, borrower, treasury, weth } = await loadFixture(baseFixture);
    const vault = await originate();

    await atDeadline(vault);
    await vault.connect(borrower).settle();

    expect(await vault.settledProtocolFee()).to.equal(PROTOCOL_FEE);
    expect(await weth.balanceOf(treasury.address)).to.equal(PROTOCOL_FEE);
  });

  it("The lender's payout is untouched by the fee — it is an add-on, not a haircut", async function () {
    const { originate, borrower, lender, weth } = await loadFixture(baseFixture);
    const vault = await originate();

    await atDeadline(vault);
    await vault.connect(borrower).settle();

    // Exactly the same figure GroupB asserts with the fee disabled.
    expect(await weth.balanceOf(lender.address)).to.equal(TARGET);
    expect(await vault.settledLenderPayout()).to.equal(TARGET);
  });

  it("The fee is borne by the borrower, out of their returned deposit", async function () {
    const { originate, borrower, weth } = await loadFixture(baseFixture);
    const vault = await originate();

    await atDeadline(vault);
    await vault.connect(borrower).settle();

    // Residual is deposit 1.5 - fee 0.3 = 1.2, less the 0.03 protocol fee.
    expect(await weth.balanceOf(borrower.address)).to.equal(E("1.17"));
    expect(await vault.settledBorrowerPayout()).to.equal(E("1.17"));
  });

  // --- The property that matters most ---

  it("A loss yields ZERO protocol fee — the protocol earns only when the lender does", async function () {
    const { originate, borrower, lender, treasury, router, uniPool, weth, usdx } =
      await loadFixture(baseFixture);
    const vault = await originate();

    await vault.connect(borrower).swap(await usdx.getAddress(), PRINCIPAL, PRINCIPAL, POOL_FEE);
    // Genuine 20% market drop — spot and TWAP move together.
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 8, 10);
    await uniPool.setAvgTick(tickFor(await usdx.getAddress(), await weth.getAddress(), -2232));

    await time.increase(DURATION + GRACE + 61);
    await vault.connect(lender).settle();

    expect(await vault.settledProtocolFee()).to.equal(0);
    expect(await vault.settledReferrerFee()).to.equal(0);
    expect(await weth.balanceOf(treasury.address)).to.equal(0);
    expect(await vault.lossSeverity()).to.equal(2);
  });

  // --- Referrer split ---

  it("With a referrer, the fee splits 70/30 between treasury and referrer", async function () {
    const { originate, borrower, treasury, referrer, weth } = await loadFixture(baseFixture);
    const vault = await originate(referrer.address);

    await atDeadline(vault);
    await vault.connect(borrower).settle();

    expect(await vault.settledProtocolFee()).to.equal(TREASURY_CUT);
    expect(await vault.settledReferrerFee()).to.equal(REFERRER_CUT);
    expect(await weth.balanceOf(treasury.address)).to.equal(TREASURY_CUT);
    expect(await weth.balanceOf(referrer.address)).to.equal(REFERRER_CUT);
    // The split is internal to the fee — the borrower pays the same either way.
    expect(await weth.balanceOf(borrower.address)).to.equal(E("1.17"));
  });

  it("Without a referrer, the treasury receives the whole protocol fee", async function () {
    const { originate, borrower, treasury, referrer, weth } = await loadFixture(baseFixture);
    const vault = await originate(ethers.ZeroAddress);

    await atDeadline(vault);
    await vault.connect(borrower).settle();

    expect(await vault.settledProtocolFee()).to.equal(PROTOCOL_FEE);
    expect(await vault.settledReferrerFee()).to.equal(0);
    expect(await weth.balanceOf(referrer.address)).to.equal(0);
  });

  it("Emits ProtocolFeePaid with both amounts", async function () {
    const { originate, borrower, treasury, referrer } = await loadFixture(baseFixture);
    const vault = await originate(referrer.address);

    await atDeadline(vault);
    await expect(vault.connect(borrower).settle())
      .to.emit(vault, "ProtocolFeePaid")
      .withArgs(treasury.address, referrer.address, TREASURY_CUT, REFERRER_CUT);
  });

  // --- Ordering against the keeper bounty ---

  it("Keeper bounty is paid in FULL before the protocol fee when the residual is tight", async function () {
    const { originate, borrower, keeper, lender, treasury, router, uniPool, weth, usdx } =
      await loadFixture(baseFixture);
    const vault = await originate();

    await vault.connect(borrower).swap(await usdx.getAddress(), PRINCIPAL, PRINCIPAL, POOL_FEE);
    // Engineered ~11.8% drop: swap-back returns 8.82, plus deposit 1.5 = 10.32.
    // Lender target is 10.3, leaving a residual of just 0.02 — smaller than
    // bounty (0.01) + protocol fee (0.03) combined.
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 882, 1000);
    await uniPool.setAvgTick(tickFor(await usdx.getAddress(), await weth.getAddress(), -1255));

    // 5h past grace end: 2bps/hr * 5 = 10bps of principal = 0.01.
    await time.increase(DURATION + GRACE + 5 * 3600);
    await vault.connect(keeper).settle();

    expect(await weth.balanceOf(lender.address)).to.equal(TARGET);
    // Bounty survives in full...
    expect(await vault.settledBounty()).to.equal(E("0.01"));
    expect(await weth.balanceOf(keeper.address)).to.equal(E("0.01"));
    // ...and the protocol fee is squeezed to whatever remained.
    expect(await vault.settledProtocolFee()).to.equal(E("0.01"));
    expect(await weth.balanceOf(treasury.address)).to.equal(E("0.01"));
    expect(await vault.settledBorrowerPayout()).to.equal(0);
  });

  // --- Snapshotting: no retroactive rate changes ---

  it("Raising the rate does NOT affect a vault that is already live", async function () {
    const { originate, factory, borrower, treasury, weth } = await loadFixture(baseFixture);
    const vault = await originate();

    // Double the rate after the loan exists.
    await factory.setProtocolFeeRateBps(2000);
    expect(await factory.protocolFeeRateBps()).to.equal(2000);

    // The vault keeps the terms it was created with.
    expect(await vault.protocolFeeRateBps()).to.equal(FEE_RATE_BPS);

    await atDeadline(vault);
    await vault.connect(borrower).settle();
    expect(await vault.settledProtocolFee()).to.equal(PROTOCOL_FEE);   // 0.03, not 0.06
    expect(await weth.balanceOf(treasury.address)).to.equal(PROTOCOL_FEE);
  });

  it("A rate of zero takes no fee and settlement still completes", async function () {
    const { factory, originate, borrower, lender, treasury, weth } = await loadFixture(baseFixture);
    await factory.setProtocolFeeRateBps(0);
    const vault = await originate();

    await atDeadline(vault);
    await vault.connect(borrower).settle();

    expect(await vault.settledProtocolFee()).to.equal(0);
    expect(await weth.balanceOf(treasury.address)).to.equal(0);
    expect(await weth.balanceOf(lender.address)).to.equal(TARGET);
    expect(await weth.balanceOf(borrower.address)).to.equal(E("1.2"));  // full residual
  });

  // --- Configuration bounds ---

  it("Rejects a protocol fee rate above the hard cap", async function () {
    const { factory } = await loadFixture(baseFixture);
    const cap = await factory.MAX_PROTOCOL_FEE_RATE_BPS();
    await expect(factory.setProtocolFeeRateBps(cap + 1n))
      .to.be.revertedWith("Exceeds maximum protocol fee rate");
    await factory.setProtocolFeeRateBps(cap);   // the cap itself is allowed
    expect(await factory.protocolFeeRateBps()).to.equal(cap);
  });

  it("Rejects a referrer share above the hard cap", async function () {
    const { factory } = await loadFixture(baseFixture);
    const cap = await factory.MAX_REFERRER_SHARE_BPS();
    await expect(factory.setReferrerShareBps(cap + 1n))
      .to.be.revertedWith("Exceeds maximum referrer share");
  });

  it("Fee configuration is owner-only, and the treasury cannot be zeroed", async function () {
    const { factory, lender } = await loadFixture(baseFixture);
    await expect(factory.connect(lender).setProtocolFeeRateBps(500))
      .to.be.revertedWith("Caller is not the owner");
    await expect(factory.connect(lender).setTreasury(lender.address))
      .to.be.revertedWith("Caller is not the owner");
    await expect(factory.setTreasury(ethers.ZeroAddress))
      .to.be.revertedWith("Invalid treasury address");
  });

  it("Changing the treasury applies to new vaults only", async function () {
    const { factory, originate, borrower, operator, treasury, weth } = await loadFixture(baseFixture);
    const firstVault = await originate();

    await factory.setTreasury(operator.address);
    const secondVault = await originate();

    expect(await firstVault.treasury()).to.equal(treasury.address);
    expect(await secondVault.treasury()).to.equal(operator.address);
  });

  // --- Quoting ---

  it("quoteProtocolFee reports the borrower's add-on cost at the current rate", async function () {
    const { factory } = await loadFixture(baseFixture);
    expect(await factory.quoteProtocolFee(PRINCIPAL, FEE_BPS, DURATION, true)).to.equal(PROTOCOL_FEE);

    await factory.setProtocolFeeRateBps(0);
    expect(await factory.quoteProtocolFee(PRINCIPAL, FEE_BPS, DURATION, true)).to.equal(0);
  });
});