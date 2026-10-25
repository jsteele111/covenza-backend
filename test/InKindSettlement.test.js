const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Item 14 — a last-resort settlement for a vault whose forced exit cannot
 * complete.
 *
 * Before this, settle() either sold every held asset at the TWAP floor or
 * reverted in full, with nothing bounding how long that could last. A frozen
 * tokenised equity, or a pool too thin or too far from its TWAP, locked the
 * whole vault: the lender received nothing, not even the cash already in it.
 *
 * settleInKind() opens IN_KIND_DELAY (7 days) after the grace period ends
 * (never during an outage's recovery hold), to the lender alone for the first
 * IN_KIND_LENDER_PERIOD (7 days) and to anyone after that. It draws no
 * insurance. It sells what it can, pays the cash to the lender first, and hands
 * each unsold asset over in kind: to the lender up to what they are still
 * owed (valued at the TWAP), the rest to the borrower. An asset that cannot
 * be priced goes wholly to the lender if anything is still owed.
 *
 * Every case below opens a position of 8 USDX from a 10 WETH loan with a
 * 1.5 WETH deposit, leaving 3.5 WETH of cash in the vault.
 */
const E = ethers.parseEther;
const POOL_FEE = 3000;
const P = E("10");
const D = E("1.5");
const BOUGHT = E("8");
const CASH = P + D - BOUGHT; // 3.5 WETH

function tickFor(baseAddr, quoteAddr, magnitude) {
  return BigInt(baseAddr.toLowerCase()) < BigInt(quoteAddr.toLowerCase())
    ? magnitude
    : -magnitude;
}

async function stack() {
  const [operator, lender, borrower, stranger] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("MockERC20", operator)).deploy("Mock WETH", "WETH", 18);
  // The held asset: a token its issuer can freeze, like a tokenised equity.
  const usdx = await (await ethers.getContractFactory("MockFreezableToken", operator)).deploy("Mock USDX", "USDX", 18);
  const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
  const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();
  const uniPool = await (await ethers.getContractFactory("MockUniswapV3Pool", operator)).deploy();
  await uniFactory.setPool(await weth.getAddress(), await usdx.getAddress(), POOL_FEE, await uniPool.getAddress());
  await uniPool.setAvgTick(0);                                   // TWAP 1:1
  await router.setRate(await weth.getAddress(), await usdx.getAddress(), 1, 1);
  await router.setRate(await usdx.getAddress(), await weth.getAddress(), 1, 1);
  await weth.mint(await router.getAddress(), E("1000"));
  await usdx.mint(await router.getAddress(), E("1000"));

  const kyc = await (await ethers.getContractFactory("KYCRegistry", operator)).deploy(operator.address, operator.address, 0);
  await kyc.verify(borrower.address, 7, ethers.id("test-fixture"));
  await kyc.verify(lender.address, 7, ethers.id("test-fixture"));

  const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
    operator.address, await router.getAddress(), await uniFactory.getAddress(), 0);
  await registry.addAssetWithTier(await weth.getAddress(), 0, 0);
  await registry.addAssetWithTier(await usdx.getAddress(), 0, 0);
  await registry.setPoolFeeTier(await weth.getAddress(), await usdx.getAddress(), POOL_FEE);
  // Outage detection off: these tests jump the clock by days, which would
  // otherwise be recorded as a sequencer outage and move every window.
  await registry.setOutageConfig(0, 0, 0);

  const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
  const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
  const impl = await (await ethers.getContractFactory("Vault", { signer: operator, libraries: { UniswapTwap: await twapLib.getAddress() } })).deploy();
  const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
    await kyc.getAddress(), await registry.getAddress(), await pool.getAddress(), operator.address, await impl.getAddress(), 0);
  await pool.setVaultFactory(await factory.getAddress());

  // Reserve of 100 WETH, so the 5% per-draw share (item 8) is 5 WETH and the
  // 10% draw cap (1 WETH on a 10 WETH loan) is what binds.
  await weth.mint(operator.address, E("100"));
  await weth.approve(await pool.getAddress(), E("100"));
  await pool.fund(await weth.getAddress(), E("100"));

  // A 7-day loan; the borrower buys 8 USDX at 1:1.
  await weth.mint(lender.address, P);
  await weth.connect(lender).approve(await factory.getAddress(), P);
  await factory.connect(lender).deployVaultWithTier(
    await weth.getAddress(), borrower.address, P, 1200, 7, false, D, ethers.ZeroAddress, 0);
  const vault = await ethers.getContractAt("Vault", await factory.allVaults(0));
  const premium = await vault.insurancePremium();
  await weth.mint(borrower.address, D + premium);
  await weth.connect(borrower).approve(await vault.getAddress(), D + premium);
  await vault.connect(borrower).payDeposit();
  await vault.connect(borrower).swap(await usdx.getAddress(), BOUGHT, 1, POOL_FEE);

  // Makes the forced sale fail: spot collapses while the TWAP holds, so no
  // sale clears the floor (a thin or moved pool).
  async function breakTheSale() {
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 1, 100);
  }

  async function toInKindWindow() {
    await time.increaseTo(await vault.inKindFrom());
  }

  return { operator, lender, borrower, stranger, weth, usdx, router, uniPool, registry, pool, vault,
           breakTheSale, toInKindWindow };
}

describe("Item 14 — in-kind settlement when a held asset cannot be sold", function () {

  it("The problem: settle() reverts for as long as the asset cannot be sold", async function () {
    const { lender, vault, breakTheSale, toInKindWindow } = await loadFixture(stack);
    await breakTheSale();
    await toInKindWindow();
    await expect(vault.connect(lender).settle()).to.be.revertedWith("Too little received");
  });

  it("Opens 7 days after grace ends, and not a second before", async function () {
    const { lender, vault, registry, breakTheSale } = await loadFixture(stack);
    await breakTheSale();

    const graceEnd = (await vault.deadline()) + (await registry.swapBackGracePeriod());
    expect(await vault.inKindFrom()).to.equal(graceEnd + 7n * 86400n);
    expect(await vault.IN_KIND_DELAY()).to.equal(7n * 86400n);

    await time.setNextBlockTimestamp((await vault.inKindFrom()) - 1n);
    await expect(vault.connect(lender).settleInKind()).to.be.revertedWith("In-kind settlement not yet open");

    await time.setNextBlockTimestamp(await vault.inKindFrom());
    await expect(vault.connect(lender).settleInKind()).to.not.be.reverted;
  });

  it("Pays the cash to the lender first, then the asset up to what is still owed, the rest to the borrower", async function () {
    const { lender, borrower, weth, usdx, vault, breakTheSale, toInKindWindow } = await loadFixture(stack);
    await breakTheSale();
    await toInKindWindow();

    const lenderWeth = await weth.balanceOf(lender.address);
    const borrowerWeth = await weth.balanceOf(borrower.address);
    await vault.connect(lender).settleInKind();

    const owed = P + (await vault.settledFee());
    const stillOwed = owed - CASH;                       // 6.5 WETH + interest
    // Valued at the TWAP of 1:1, the lender takes that many USDX.
    expect(await weth.balanceOf(lender.address) - lenderWeth).to.equal(CASH);
    expect(await usdx.balanceOf(lender.address)).to.equal(stillOwed);
    expect(await usdx.balanceOf(borrower.address)).to.equal(BOUGHT - stillOwed);
    expect(await weth.balanceOf(borrower.address)).to.equal(borrowerWeth);

    expect(await vault.isSettled()).to.equal(true);
    expect(await vault.settledInKind()).to.equal(true);
    expect(await vault.settledInsuranceDraw()).to.equal(0);   // cash + value covers principal
    expect(await vault.heldAssetCount()).to.equal(0);
  });

  it("Reports an in-kind close as severity 3, not as a lender loss (audit I-3)", async function () {
    // Here the lender is made whole: 3.5 WETH of cash plus USDX worth the
    // rest at the TWAP. Comparing cash alone would have reported 2.
    const { lender, usdx, vault, breakTheSale, toInKindWindow } = await loadFixture(stack);
    await breakTheSale();
    await toInKindWindow();
    expect(await vault.lossSeverity()).to.equal(0);   // unsettled
    await vault.connect(lender).settleInKind();

    expect(await vault.settledLenderPayout()).to.be.lessThan(P + (await vault.settledFee()));
    expect(await usdx.balanceOf(lender.address)).to.be.greaterThan(0n);
    expect(await vault.lossSeverity()).to.equal(3);
  });

  it("Opens to the lender first, and to anyone a week later; pays the caller nothing (audit M-2)", async function () {
    const { stranger, borrower, weth, usdx, vault, breakTheSale, toInKindWindow } = await loadFixture(stack);
    await breakTheSale();
    await toInKindWindow();

    // The lender bears the TWAP valuation, so the lender chooses the moment.
    await expect(vault.connect(stranger).settleInKind()).to.be.revertedWith("Lender-only period");
    await expect(vault.connect(borrower).settleInKind()).to.be.revertedWith("Lender-only period");

    await time.increaseTo((await vault.inKindFrom()) + (await vault.IN_KIND_LENDER_PERIOD()));
    await vault.connect(stranger).settleInKind();
    expect(await weth.balanceOf(stranger.address)).to.equal(0);
    expect(await usdx.balanceOf(stranger.address)).to.equal(0);
    expect(await vault.settledBounty()).to.equal(0);
    expect(await vault.settledProtocolFee()).to.equal(0);
  });

  it("Refuses when every asset sells, and points at settle(), which draws insurance for a loss (audit KRAIT-005)", async function () {
    const { lender, stranger, usdx, router, uniPool, vault, toInKindWindow } = await loadFixture(stack);
    // A loss: USDX is now worth half a WETH, at spot and at the TWAP alike.
    await router.setRate(await usdx.getAddress(), await vault.asset(), 1, 2);
    await uniPool.setAvgTick(tickFor(await usdx.getAddress(), await vault.asset(), -6932));
    await toInKindWindow();
    await time.increase(7 * 86400);   // past the lender-only period: anyone may call

    // Every sale clears its floor here, so nothing would be handed over in
    // kind. Before the fix this ran as a cash settlement that skipped the
    // insurance draw, the bounty and the protocol fee.
    await expect(vault.connect(stranger).settleInKind()).to.be.revertedWith("Everything sold - use settle()");

    await vault.connect(stranger).settle();
    expect(await vault.settledInKind()).to.equal(false);
    // 3.5 cash + 8 USDX sold for 4 = 7.5 against 10 principal: a 1 WETH draw (10% cap).
    expect(await vault.settledInsuranceDraw()).to.equal(E("1"));
    expect(await usdx.balanceOf(await vault.getAddress())).to.equal(0);
    expect(await usdx.balanceOf(lender.address)).to.equal(0);
  });

  it("Leaves settle() available throughout; whichever succeeds first closes the loan", async function () {
    const { lender, router, usdx, weth, vault, breakTheSale, toInKindWindow } = await loadFixture(stack);
    await breakTheSale();
    await toInKindWindow();
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 1, 1);   // the pool recovers

    await vault.connect(lender).settle();
    expect(await vault.settledInKind()).to.equal(false);
    await expect(vault.connect(lender).settleInKind()).to.be.revertedWith("Loan already settled");
  });

  it("A frozen token: cash goes out now, and each side claims its share when the freeze lifts", async function () {
    const { lender, borrower, weth, usdx, vault, toInKindWindow } = await loadFixture(stack);
    await usdx.setFrozen(true);   // the issuer halts the token: no sale, no transfer
    await toInKindWindow();

    const lenderWeth = await weth.balanceOf(lender.address);
    await vault.connect(lender).settleInKind();
    expect(await weth.balanceOf(lender.address) - lenderWeth).to.equal(CASH);

    const stillOwed = P + (await vault.settledFee()) - CASH;
    expect(await vault.owed(await usdx.getAddress(), lender.address)).to.equal(stillOwed);
    expect(await vault.owed(await usdx.getAddress(), borrower.address)).to.equal(BOUGHT - stillOwed);

    await expect(vault.connect(lender).claim(await usdx.getAddress())).to.be.revertedWith("Token transfer failed");

    await usdx.setFrozen(false);
    await expect(vault.connect(lender).claim(await usdx.getAddress()))
      .to.emit(vault, "Claimed").withArgs(await usdx.getAddress(), lender.address, stillOwed);
    await vault.connect(borrower).claim(await usdx.getAddress());
    expect(await usdx.balanceOf(lender.address)).to.equal(stillOwed);
    expect(await usdx.balanceOf(borrower.address)).to.equal(BOUGHT - stillOwed);

    await expect(vault.connect(lender).claim(await usdx.getAddress())).to.be.revertedWith("Nothing owed");
  });

  it("An asset with no price goes wholly to the lender, and draws no insurance", async function () {
    const { lender, borrower, weth, usdx, uniPool, vault, breakTheSale, toInKindWindow } = await loadFixture(stack);
    await breakTheSale();
    await uniPool.setMaxWindow(0);   // the pool has no usable history: no TWAP
    await toInKindWindow();

    const lenderWeth = await weth.balanceOf(lender.address);
    await expect(vault.connect(lender).settleInKind())
      .to.emit(vault, "InKindAllocated").withArgs(await usdx.getAddress(), BOUGHT, 0, 0, false);

    // Cash alone (3.5) is below principal, but the asset might be worth
    // anything: paying a claim on top of handing it over could pay twice.
    expect(await vault.settledInsuranceDraw()).to.equal(0);
    expect(await weth.balanceOf(lender.address) - lenderWeth).to.equal(CASH);
    expect(await usdx.balanceOf(lender.address)).to.equal(BOUGHT);
    expect(await usdx.balanceOf(borrower.address)).to.equal(0);
  });

  it("An unpriceable asset goes to the borrower when the cash already repaid the lender", async function () {
    const { lender, borrower, weth, usdx, uniPool, vault, toInKindWindow } = await loadFixture(stack);
    // Borrower sells back most of the position first, leaving 1 USDX held
    // and 10.5 WETH of cash — more than the lender is owed.
    await vault.connect(borrower).swapBack(await usdx.getAddress(), E("7"), 1);
    await uniPool.setMaxWindow(0);
    await toInKindWindow();

    await vault.connect(lender).settleInKind();
    expect(await vault.settledLenderPayout()).to.equal(P + (await vault.settledFee()));
    expect(await usdx.balanceOf(lender.address)).to.equal(0);
    expect(await usdx.balanceOf(borrower.address)).to.equal(E("1"));
  });

  it("Draws no insurance, however large the shortfall (audit M-2)", async function () {
    const { lender, weth, usdx, uniPool, vault, breakTheSale, toInKindWindow } = await loadFixture(stack);
    await breakTheSale();
    // The TWAP falls to about 0.25 WETH per USDX: 8 USDX is worth ~2 WETH, so
    // cash 3.5 + 2 leaves ~4.5 of principal uncovered. Drawing on that
    // shortfall let whoever depressed a thin pool's TWAP take the asset AND a
    // payout; the lender now takes the asset instead of a claim.
    await uniPool.setAvgTick(tickFor(await usdx.getAddress(), await weth.getAddress(), -13863));
    await toInKindWindow();

    const lenderWeth = await weth.balanceOf(lender.address);
    await vault.connect(lender).settleInKind();

    expect(await vault.settledInsuranceDraw()).to.equal(0);
    expect(await weth.balanceOf(lender.address) - lenderWeth).to.equal(CASH);
    // Still owed more than the asset is worth, so the lender takes all of it.
    expect(await usdx.balanceOf(lender.address)).to.equal(BOUGHT);
  });

  it("Opens after an outage once the chain has recovered, not seven days later (found by the invariant fuzzer)", async function () {
    const { lender, usdx, registry, vault, breakTheSale } = await loadFixture(stack);
    // Outage detection on, and no heartbeat bot: the chain is simply quiet.
    await registry.setOutageConfig(1800, 3600, 72 * 3600);
    await breakTheSale();
    // A silence spanning the grace period also counts as an outage that ate
    // it, so grace is extended by the 72-hour cap first.
    await time.increaseTo((await vault.deadline()) + (await registry.swapBackGracePeriod())
      + 72n * 3600n + 7n * 86400n + 1n);

    // The first heartbeat in days records the silence as an outage, so the
    // recovery hour applies. The lender (or anyone) keeps the chain alive
    // through it, as the bot would.
    await registry.heartbeat();
    for (let i = 0; i < 3; i++) { await time.increase(20 * 60); await registry.heartbeat(); }

    // Previously the seven days were counted from the END of that recovery,
    // so a quiet chain pushed the in-kind window back by a week every time.
    await expect(vault.connect(lender).settleInKind()).to.not.be.reverted;
    expect(await usdx.balanceOf(lender.address)).to.be.greaterThan(0n);
  });

  it("Is refused while nothing is held, and the sale helper cannot be called from outside", async function () {
    const { lender, borrower, usdx, vault, toInKindWindow } = await loadFixture(stack);
    await expect(vault.connect(lender).exitHeld(await usdx.getAddress())).to.be.revertedWith("Only the vault itself");

    await vault.connect(borrower).swapBack(await usdx.getAddress(), BOUGHT, 1);
    await toInKindWindow();
    await expect(vault.connect(lender).settleInKind()).to.be.revertedWith("Nothing held - use settle()");
  });
});
