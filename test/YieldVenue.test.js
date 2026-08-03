const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Pluggable yield venue, and per-asset swap-back grace.
 *
 * The venue is the ERC-4626 STANDARD rather than a named protocol, so any
 * compliant vault works on any chain. The behaviour that distinguishes it
 * from Aave — and the reason it needs its own tests rather than reusing the
 * Aave ones — is that 4626 shares APPRECIATE against the underlying, where
 * an aToken rebases 1:1. Share count and value are the same number for Aave
 * and diverge here.
 *
 * The safety property tested hardest is the venue SNAPSHOT. A vault settles
 * against the venue it actually supplied to, not whatever the registry says
 * at settlement time, so an operator repointing an asset mid-loan cannot
 * strand a live position. Same reasoning as the fee terms being snapshotted
 * at origination.
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

const VENUE_NONE = 0;
const VENUE_AAVE = 1;
const VENUE_4626 = 2;

describe("Yield venue and per-asset grace", function () {

  async function fixture() {
    const [operator, lender, borrower, keeper, treasury] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const weth = await Mock.deploy("Mock WETH", "WETH", 18);   // loan asset
    const usdx = await Mock.deploy("Mock USDX", "USDX", 18);   // continuously traded
    const aapl = await Mock.deploy("Mock AAPL", "AAPL", 18);   // 24/5, needs longer grace

    const aave = await (await ethers.getContractFactory("MockAavePool", operator)).deploy();
    await aave.configureAsset(await weth.getAddress());
    const aTokenWeth = await aave.aTokenOf(await weth.getAddress());

    // Two distinct 4626 vaults over the same underlying, so a repoint is
    // observable: funds must come out of the one actually supplied to.
    const Vault4626 = await ethers.getContractFactory("MockERC4626", operator);
    const venueA = await Vault4626.deploy(await weth.getAddress());
    const venueB = await Vault4626.deploy(await weth.getAddress());

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
    await kyc.verify(borrower.address);

    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await aave.getAddress(), await router.getAddress(),
      await uniFactory.getAddress(), await weth.getAddress()
    );
    await registry.addAsset(await weth.getAddress(), aTokenWeth);       // -> Aave venue
    await registry.addAsset(await usdx.getAddress(), ethers.ZeroAddress); // -> None
    await registry.addAssetWithVenue(
      await aapl.getAddress(), ethers.ZeroAddress, VENUE_NONE, ethers.ZeroAddress, EXTENSION
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

    async function use4626(venue) {
      return registry.setVenue(await weth.getAddress(), VENUE_4626, await venue.getAddress());
    }

    return { operator, lender, borrower, keeper, treasury,
             weth, usdx, aapl, aave, aTokenWeth, venueA, venueB,
             router, registry, pool, factory, originate, use4626 };
  }

  // --- ERC-4626 venue ---

  it("Supplies the loan asset to an ERC-4626 vault and records the venue", async function () {
    const { originate, use4626, venueA, borrower, weth } = await loadFixture(fixture);
    await use4626(venueA);
    const vault = await originate();

    await vault.connect(borrower).supplyToYield(E("5"));

    expect(await venueA.balanceOf(await vault.getAddress())).to.equal(E("5"));
    expect(await weth.balanceOf(await venueA.getAddress())).to.equal(E("5"));
    expect(await vault.yieldVenueKind()).to.equal(VENUE_4626);
    expect(await vault.yieldVenue()).to.equal(await venueA.getAddress());
  });

  it("Values the position in underlying, not shares, once the share price moves", async function () {
    const { originate, use4626, venueA, borrower, weth } = await loadFixture(fixture);
    await use4626(venueA);
    const vault = await originate();

    await vault.connect(borrower).supplyToYield(E("5"));
    expect(await vault.yieldPositionValue()).to.equal(E("5"));

    // Yield: underlying arrives, share count does not change.
    await weth.mint(await venueA.getAddress(), E("1"));

    expect(await venueA.balanceOf(await vault.getAddress())).to.equal(E("5"));   // shares unchanged
    expect(await vault.yieldPositionValue()).to.equal(E("6"));                   // value up
  });

  it("Credits 4626 yield to the vault at settlement", async function () {
    const { originate, use4626, venueA, borrower, weth } = await loadFixture(fixture);
    await use4626(venueA);
    const vault = await originate();

    await vault.connect(borrower).supplyToYield(E("5"));
    await weth.mint(await venueA.getAddress(), E("1"));

    await vault.connect(borrower).settle();

    // 11.5 in, 1 earned. The gain lands in the residual, which is the
    // borrower's — the lender's target is fixed at origination either way.
    expect(await vault.settledTotalReturned()).to.equal(PRINCIPAL + DEPOSIT + E("1"));
    expect(await venueA.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("Withdraws an exact underlying amount from a 4626 venue mid-term", async function () {
    const { originate, use4626, venueA, borrower, weth } = await loadFixture(fixture);
    await use4626(venueA);
    const vault = await originate();

    await vault.connect(borrower).supplyToYield(E("5"));
    await weth.mint(await venueA.getAddress(), E("5"));   // share price doubles

    await vault.connect(borrower).withdrawFromYield(E("2"));

    // 2 underlying at 2:1 costs 1 share, leaving 4 shares worth 8.
    expect(await venueA.balanceOf(await vault.getAddress())).to.equal(E("4"));
    expect(await vault.yieldPositionValue()).to.equal(E("8"));
  });

  it("Rejects a supply when the asset has no yield venue", async function () {
    const { originate, registry, weth, borrower } = await loadFixture(fixture);
    await registry.setVenue(await weth.getAddress(), VENUE_NONE, ethers.ZeroAddress);
    const vault = await originate();

    await expect(
      vault.connect(borrower).supplyToYield(E("5"))
    ).to.be.revertedWith("Asset has no yield venue");
  });

  it("Still enforces the deposit invariant on the 4626 path", async function () {
    const { originate, use4626, venueA, borrower } = await loadFixture(fixture);
    await use4626(venueA);
    const vault = await originate();

    // Vault holds principal + deposit; the deposit may never leave.
    await expect(
      vault.connect(borrower).supplyToYield(PRINCIPAL + 1n)
    ).to.be.reverted;

    await expect(vault.connect(borrower).supplyToYield(PRINCIPAL)).to.not.be.reverted;
  });

  // --- The snapshot property ---

  it("Settles against the venue it supplied to, even after the registry is repointed", async function () {
    const { originate, use4626, venueA, venueB, borrower, weth } = await loadFixture(fixture);
    await use4626(venueA);
    const vault = await originate();

    await vault.connect(borrower).supplyToYield(E("5"));

    // Operator repoints the asset to a different vault mid-loan. Without the
    // snapshot, settlement would look for a position in venueB, find none,
    // and strand 5 WETH in venueA permanently.
    await use4626(venueB);

    await vault.connect(borrower).settle();

    expect(await venueA.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await weth.balanceOf(await venueA.getAddress())).to.equal(0n);
    expect(await vault.settledTotalReturned()).to.equal(PRINCIPAL + DEPOSIT);
  });

  it("Refuses a second supply once the venue KIND has changed underneath", async function () {
    const { originate, use4626, venueA, registry, weth, aTokenWeth, borrower } = await loadFixture(fixture);
    await use4626(venueA);
    const vault = await originate();

    await vault.connect(borrower).supplyToYield(E("2"));
    await registry.setVenue(await weth.getAddress(), VENUE_AAVE, ethers.ZeroAddress);

    // Splitting a position across two venues with only one recorded is
    // exactly how funds get stranded — so it is refused outright.
    await expect(
      vault.connect(borrower).supplyToYield(E("2"))
    ).to.be.revertedWith("Yield venue changed mid-loan");
  });

  // --- Aave regression ---

  it("Aave still works through the generalised path and its aliases", async function () {
    const { originate, borrower, aTokenWeth } = await loadFixture(fixture);
    const vault = await originate();

    await vault.connect(borrower).supplyToAave(E("4"));
    expect(await vault.yieldVenueKind()).to.equal(VENUE_AAVE);

    const aToken = (await ethers.getContractFactory("MockAToken")).attach(aTokenWeth);
    expect(await aToken.balanceOf(await vault.getAddress())).to.equal(E("4"));

    // aToken rebases 1:1, so value equals balance with no conversion.
    expect(await vault.yieldPositionValue()).to.equal(E("4"));

    await vault.connect(borrower).withdrawFromAave(E("1"));
    expect(await vault.yieldPositionValue()).to.equal(E("3"));
  });

  // --- Per-asset grace ---

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
