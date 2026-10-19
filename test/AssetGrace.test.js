const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Per-asset swap-back grace.
 *
 * (Formerly also covered yield venues, removed from the contracts before
 * audit; see MAINNET-READINESS.)
 *
 * Grace: driven by the HELD asset, longest wins, never below the global
 * default. Tokenised equities trade 24/5, so a vault holding one over a
 * weekend needs a longer window than a vault holding only crypto — and a
 * crypto-only vault must not be slowed down by a rule that exists for
 * equities.
 */

const E = ethers.parseEther;
const PRINCIPAL = E("10");
const DEPOSIT   = E("1.5");
const FEE_BPS   = 300n;
const SKIM      = E("0.06");
const DURATION  = 7200;
const GRACE     = 3600;          // global default
const EXTENSION = 72 * 3600;     // per-asset, covering a weekend
const POOL_FEE  = 3000;

describe("Per-asset grace", function () {

  async function fixture() {
    const [operator, lender, borrower, keeper, treasury] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const weth = await Mock.deploy("Mock WETH", "WETH", 18);   // loan asset
    const usdx = await Mock.deploy("Mock USDX", "USDX", 18);   // continuously traded
    const aapl = await Mock.deploy("Mock AAPL", "AAPL", 18);   // 24/5, needs longer grace

    const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();

    async function pairPool(tokenA, tokenB) {
      const p = await (await ethers.getContractFactory("MockUniswapV3Pool", operator)).deploy();
      await p.setAvgTick(0);
      await uniFactory.setPool(await tokenA.getAddress(), await tokenB.getAddress(), POOL_FEE, await p.getAddress());
      return p;
    }
    await pairPool(weth, usdx);
    await pairPool(weth, aapl);

    for (const [a, b] of [[weth, usdx], [usdx, weth], [weth, aapl], [aapl, weth]]) {
      await router.setRate(await a.getAddress(), await b.getAddress(), 1, 1);
    }
    for (const t of [weth, usdx, aapl]) {
      await t.mint(await router.getAddress(), E("1000"));
    }

    const kyc = await (await ethers.getContractFactory("KYCRegistry", operator))
      .deploy(operator.address, operator.address, 0);
    await kyc.verify(borrower.address, 7, ethers.id("test-fixture"));
    await kyc.verify(lender.address, 7, ethers.id("test-fixture"));  // lenders are screened too (#7)

    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await router.getAddress(),
      await uniFactory.getAddress(), 0
    );
    await registry.addAsset(await weth.getAddress(), 0);
    await registry.addAsset(await usdx.getAddress(), 0);
    await registry.addAsset(
      await aapl.getAddress(), EXTENSION
    );
    await registry.setSettlementConfig(1800, 200, GRACE, 2, 100);

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
      .deploy(operator.address, 1000, 0);

    // Vaults are EIP-1167 clones of one implementation, so the factory no
    // longer embeds Vault bytecode and needs no library link. The
    // IMPLEMENTATION does — it delegatecalls UniswapTwap.
    // The protocol names the pool vaults trade through (KRAIT-003 / item 20).
    await registry.setPoolFeeTier(await weth.getAddress(), await usdx.getAddress(), POOL_FEE);
    await registry.setPoolFeeTier(await weth.getAddress(), await aapl.getAddress(), POOL_FEE);
    // These suites warp the clock by days with no heartbeats, which outage
    // detection would (correctly) read as an outage. They test bounty and
    // grace arithmetic, so detection is off here; OutageGrace.test.js covers it.
    await registry.setOutageConfig(0, 0, 0);
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
    , 0);
    await pool.setVaultFactory(await factory.getAddress());
    await factory.setProtocolFeeRateBps(0);   // keeps payout arithmetic readable

    async function originate() {
      await weth.mint(lender.address, PRINCIPAL + SKIM);
      await weth.connect(lender).approve(await factory.getAddress(), PRINCIPAL + SKIM);
      const before = await factory.totalVaults();
      await factory.connect(lender).deployVault(
        await weth.getAddress(), borrower.address, PRINCIPAL, FEE_BPS, DURATION, true, DEPOSIT,
        ethers.ZeroAddress
      );
      const vault = await ethers.getContractAt("Vault", await factory.allVaults(before));

      await weth.mint(borrower.address, DEPOSIT);
      await weth.connect(borrower).approve(await vault.getAddress(), DEPOSIT);
      await vault.connect(borrower).payDeposit();
      return vault;
    }

    return { operator, lender, borrower, keeper, treasury,
             weth, usdx, aapl,
             router, registry, pool, factory, originate };
  }

  it("A vault holding only continuously-traded assets uses the global grace", async function () {
    const { originate, borrower, usdx } = await loadFixture(fixture);
    const vault = await originate();

    await vault.connect(borrower).swap(await usdx.getAddress(), E("1"), E("0.9"), POOL_FEE);

    expect(await vault.effectiveGracePeriod()).to.equal(BigInt(GRACE));
  });

  it("A vault holding a 24/5 asset gets the extended window", async function () {
    const { originate, borrower, aapl } = await loadFixture(fixture);
    const vault = await originate();

    await vault.connect(borrower).swap(await aapl.getAddress(), E("1"), E("0.9"), POOL_FEE);

    expect(await vault.effectiveGracePeriod()).to.equal(BigInt(GRACE + EXTENSION));
  });

  it("Holding both, the longest grace governs", async function () {
    const { originate, borrower, usdx, aapl } = await loadFixture(fixture);
    const vault = await originate();

    await vault.connect(borrower).swap(await usdx.getAddress(), E("1"), E("0.9"), POOL_FEE);
    await vault.connect(borrower).swap(await aapl.getAddress(), E("1"), E("0.9"), POOL_FEE);

    expect(await vault.effectiveGracePeriod()).to.equal(BigInt(GRACE + EXTENSION));
  });

  it("A keeper is held off for the extended window, and the parties are not", async function () {
    const { originate, borrower, lender, keeper, aapl } = await loadFixture(fixture);
    const vault = await originate();

    await vault.connect(borrower).swap(await aapl.getAddress(), E("1"), E("0.9"), POOL_FEE);

    // Past the deadline and past the GLOBAL grace, but inside the extension
    // that exists because the market this asset tracks is shut.
    await time.increase(DURATION + GRACE + 3600);

    await expect(
      vault.connect(keeper).settle()
    ).to.be.revertedWith("Grace period: only lender or borrower may settle");

    await expect(vault.connect(lender).settle()).to.not.be.reverted;
  });

  it("Past the extended window, a keeper may settle and earn a bounty", async function () {
    const { originate, borrower, keeper, aapl } = await loadFixture(fixture);
    const vault = await originate();

    await vault.connect(borrower).swap(await aapl.getAddress(), E("1"), E("0.9"), POOL_FEE);
    await time.increase(DURATION + GRACE + EXTENSION + 7200);

    await vault.connect(keeper).settle();

    expect(await vault.isSettled()).to.equal(true);
    expect(await vault.settledBounty()).to.be.greaterThan(0n);
  });
});
