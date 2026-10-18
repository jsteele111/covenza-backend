const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * MAINNET-READINESS item 16: a sequencer outage must not consume the parties'
 * grace window or hand keepers the jump in block.timestamp.
 *
 * Detection runs at its production defaults (30-minute gap threshold, 1-hour
 * recovery, 72-hour cap). A simulated heartbeat bot pings every 10 minutes;
 * an "outage" is a stretch of time with no pings at all.
 */
const E = ethers.parseEther;
const POOL_FEE = 3000;
const MIN = 60, HOUR = 3600;
const GRACE = 4 * HOUR;          // shortened global grace keeps the bot loops small
const TERM = 2 * HOUR;           // loan term, in seconds

describe("Item 16 — sequencer outages and the grace window", function () {

  async function stack() {
    const [operator, lender, borrower, keeper] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const weth = await Mock.deploy("WETH", "WETH", 18);
    const usdx = await Mock.deploy("USDX", "USDX", 18);
    const aave = await (await ethers.getContractFactory("MockAavePool", operator)).deploy();
    const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();
    const uniPool = await (await ethers.getContractFactory("MockUniswapV3Pool", operator)).deploy();
    await uniFactory.setPool(await weth.getAddress(), await usdx.getAddress(), POOL_FEE, await uniPool.getAddress());
    await uniPool.setAvgTick(0);
    await router.setRate(await weth.getAddress(), await usdx.getAddress(), 1, 1);
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 1, 1);
    await weth.mint(await router.getAddress(), E("1000"));
    await usdx.mint(await router.getAddress(), E("1000"));
    const kyc = await (await ethers.getContractFactory("KYCRegistry", operator)).deploy(operator.address, operator.address, 0);
    await kyc.verify(borrower.address);
    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await aave.getAddress(), await router.getAddress(), await uniFactory.getAddress(), await weth.getAddress(), 0);
    await registry.addAssetWithTier(await weth.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress, 0, 0);
    await registry.addAssetWithTier(await usdx.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress, 0, 0);
    await registry.setPoolFeeTier(await weth.getAddress(), await usdx.getAddress(), POOL_FEE);
    await registry.setSettlementConfig(1800, 200, GRACE, 2, 100);
    const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
    const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
    const impl = await (await ethers.getContractFactory("Vault", { signer: operator, libraries: { UniswapTwap: await twapLib.getAddress() } })).deploy();
    const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
      await kyc.getAddress(), await registry.getAddress(), await pool.getAddress(), operator.address, await impl.getAddress(), 0);
    await pool.setVaultFactory(await factory.getAddress());

    // Originate, fund, and take a position so settlement must force a sale.
    const P = E("10"), D = E("2");
    await weth.mint(lender.address, P);
    await weth.connect(lender).approve(await factory.getAddress(), P);
    await factory.connect(lender).deployVaultWithTier(
      await weth.getAddress(), borrower.address, P, 1200, TERM, true, D, ethers.ZeroAddress, 0);
    const vault = await ethers.getContractAt("Vault", await factory.allVaults(0));
    const premium = await vault.insurancePremium();
    await weth.mint(borrower.address, D + premium);
    await weth.connect(borrower).approve(await vault.getAddress(), D + premium);
    await vault.connect(borrower).payDeposit();
    await vault.connect(borrower).swap(await usdx.getAddress(), E("5"), 1, POOL_FEE);

    const deadline = await vault.deadline();
    const graceEnd = deadline + (await vault.effectiveGracePeriod());
    return { registry, vault, lender, borrower, keeper, deadline, graceEnd };
  }

  // The heartbeat bot: pings every 10 minutes until `until`.
  async function botRunsUntil(registry, until) {
    for (;;) {
      const now = BigInt(await time.latest());
      if (now + BigInt(10 * MIN) > until) break;
      await time.increase(10 * MIN);
      await registry.heartbeat();
    }
    await time.increaseTo(until);
    await registry.heartbeat();
  }

  it("With the bot running and no outage, a keeper settles straight after grace", async function () {
    const { registry, vault, keeper, graceEnd } = await loadFixture(stack);
    await botRunsUntil(registry, graceEnd + BigInt(HOUR));
    expect(await registry.outageCount()).to.equal(0);
    await vault.connect(keeper).settle();
    // Accrues from the ordinary grace end: one hour at 2 bps on 10 = 0.002.
    expect(await vault.settledBounty()).to.equal(E("0.002"));
  });

  it("A gap shorter than the threshold is not an outage", async function () {
    const { registry } = await loadFixture(stack);
    await time.increase(20 * MIN);
    await registry.heartbeat();
    expect(await registry.outageCount()).to.equal(0);
  });

  it("An outage across the grace end gives the parties back exactly the time they lost", async function () {
    const { registry, vault, lender, keeper, graceEnd } = await loadFixture(stack);
    await botRunsUntil(registry, graceEnd - BigInt(HOUR));   // last ping 1h before grace ends
    await time.increase(3 * HOUR);                            // 3h outage: no pings at all
    await registry.heartbeat();                               // chain returns; bot's first ping lands

    const [start, end] = await registry.outageAt(0);
    expect(end - start).to.be.closeTo(BigInt(3 * HOUR), 5n);
    const [extended] = await registry.settlementWindow(await vault.deadline(), graceEnd);
    expect(extended).to.equal(graceEnd + (end - start));
    // Restart is about graceEnd + 2h; the parties still have the hour they lost.
    expect(extended).to.be.gt(BigInt(await time.latest()));
    await expect(vault.connect(keeper).settle())
      .to.be.revertedWith("Grace period: only lender or borrower may settle");
    await vault.connect(lender).settle();
  });

  it("A keeper's own settle records the outage FIRST, so it cannot use the time jump", async function () {
    const { registry, vault, keeper, graceEnd } = await loadFixture(stack);
    await botRunsUntil(registry, graceEnd - BigInt(HOUR));
    await time.increase(3 * HOUR);
    // No bot ping after restart: the keeper is first in. Without detection the
    // clock says grace ended 2h ago and the keeper would be paid for it.
    await expect(vault.connect(keeper).settle())
      .to.be.revertedWith("Grace period: only lender or borrower may settle");
  });

  it("Keepers wait the recovery period after any outage, and are paid only from then", async function () {
    const { registry, vault, keeper, graceEnd } = await loadFixture(stack);
    await botRunsUntil(registry, graceEnd + BigInt(10 * MIN));  // grace over, normally
    await time.increase(2 * HOUR);                               // then a 2h outage
    await registry.heartbeat();
    const restart = BigInt(await time.latest());

    await expect(vault.connect(keeper).settle()).to.be.revertedWith("Chain recovering from an outage");

    await botRunsUntil(registry, restart + BigInt(2 * HOUR) - 10n);
    await time.setNextBlockTimestamp(restart + BigInt(2 * HOUR));
    await vault.connect(keeper).settle();
    // Paid from restart + 1h, not from the old grace end (over 3h earlier):
    // one hour of accrual at 2 bps/hour on a principal of 10 = 0.002.
    expect(await vault.settledBounty()).to.equal(E("0.002"));
  });

  it("The parties themselves are never held back by the recovery period", async function () {
    const { registry, vault, lender, graceEnd } = await loadFixture(stack);
    await botRunsUntil(registry, graceEnd + BigInt(10 * MIN));
    await time.increase(2 * HOUR);
    await vault.connect(lender).settle();   // first transaction after restart
    expect(await vault.isSettled()).to.equal(true);
  });

  it("Caps the extension at 72 hours, however long the silence", async function () {
    const { registry, vault, graceEnd } = await loadFixture(stack);
    await botRunsUntil(registry, graceEnd - BigInt(HOUR));
    await time.increase(100 * HOUR);
    await registry.heartbeat();
    const [extended] = await registry.settlementWindow(await vault.deadline(), graceEnd);
    expect(extended).to.equal(graceEnd + BigInt(72 * HOUR));
  });

  it("Ignores an outage that ended before the deadline", async function () {
    const { registry, vault, graceEnd, deadline } = await loadFixture(stack);
    await time.increase(45 * MIN);           // outage early in the loan
    await registry.heartbeat();
    expect(await registry.outageCount()).to.equal(1);
    await botRunsUntil(registry, deadline + 60n);
    const [extended, keeperFrom] = await registry.settlementWindow(deadline, graceEnd);
    expect(extended).to.equal(graceEnd);
    expect(keeperFrom).to.equal(graceEnd);
  });

  describe("Configuration", function () {
    it("Refuses a recovery period shorter than the TWAP window", async function () {
      const { registry } = await loadFixture(stack);
      await expect(registry.setOutageConfig(30 * MIN, 10 * MIN, 72 * HOUR))
        .to.be.revertedWith("Recovery shorter than the TWAP window");
    });

    it("Disables only when all three are zero", async function () {
      const { registry } = await loadFixture(stack);
      await expect(registry.setOutageConfig(0, HOUR, 0)).to.be.revertedWith("Disable all three together");
      await registry.setOutageConfig(0, 0, 0);
      await time.increase(10 * HOUR);
      await registry.heartbeat();
      expect(await registry.outageCount()).to.equal(0);
    });

    it("Waits on the timelock when the registry has a delay", async function () {
      const [operator] = await ethers.getSigners();
      const reg = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
        operator.address, operator.address, operator.address, operator.address, operator.address, 48 * HOUR);
      await expect(reg.setOutageConfig(30 * MIN, 2 * HOUR, 72 * HOUR)).to.be.revertedWith("Action was not queued");
    });
  });
});
