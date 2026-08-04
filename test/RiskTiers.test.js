const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Risk tiers: ceilings, exposure caps, entry impact, deposit floors.
 *
 * Every other suite DISABLES tier limits, because they predate tiers and
 * assert settlement mechanics rather than risk policy. That makes this file the
 * only coverage these controls have, so it is written to exercise each one in
 * both directions — rejected above the limit, permitted at it.
 *
 * The controls exist because of one number. Modelling a 30-day loan against a
 * 60%-volatility asset: at a 20% deposit the lender is untouched until the
 * asset falls 19%, which is 1.15 standard deviations — not a tail. Expected
 * loss works out at 10.6% annualised, which no interest rate covers. At a 30%
 * deposit it is 1.8%. Deposits are the control; rates are the compensation.
 */

const E = ethers.parseEther;
const PRINCIPAL = E("10");
const DEPOSIT   = E("5");        // generous, so only the control under test binds
const APR_BPS   = 300n;
const DAY       = 24 * 3600;
const YEAR      = 365 * DAY;
const POOL_FEE  = 3000;

const BLUE_CHIP   = 0;
const STANDARD    = 1;
const SPECULATIVE = 2;

describe("Risk tiers", function () {

  async function fixture() {
    const [operator, lender, borrower, treasury] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const usdx = await Mock.deploy("Mock USDX", "USDX", 18);   // loan asset
    const weth = await Mock.deploy("Mock WETH", "WETH", 18);   // blue chip
    const aapl = await Mock.deploy("Mock AAPL", "AAPL", 18);   // standard
    const meme = await Mock.deploy("Mock MEME", "MEME", 18);   // speculative

    const aave = await (await ethers.getContractFactory("MockAavePool", operator)).deploy();
    await aave.configureAsset(await usdx.getAddress());

    const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();

    // One pool per pair, all at tick 0. The router's rate is set separately, so
    // execution and TWAP can be made to DISAGREE — which is what makes the
    // entry-impact check testable at all.
    const pools = {};
    for (const t of [weth, aapl, meme]) {
      const p = await (await ethers.getContractFactory("MockUniswapV3Pool", operator)).deploy();
      await p.setAvgTick(0);
      await uniFactory.setPool(await usdx.getAddress(), await t.getAddress(), POOL_FEE, await p.getAddress());
      await router.setRate(await usdx.getAddress(), await t.getAddress(), 1, 1);
      await router.setRate(await t.getAddress(), await usdx.getAddress(), 1, 1);
      await t.mint(await router.getAddress(), E("10000"));
      pools[await t.getAddress()] = p;
    }
    await usdx.mint(await router.getAddress(), E("10000"));

    const kyc = await (await ethers.getContractFactory("KYCRegistry", operator))
      .deploy(operator.address, operator.address, 0);
    await kyc.verify(borrower.address);

    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await aave.getAddress(), await router.getAddress(),
      await uniFactory.getAddress(), await usdx.getAddress()
    );
    for (const t of [usdx, weth, aapl, meme]) {
      await registry.addAsset(await t.getAddress(), ethers.ZeroAddress);
    }
    await registry.setSettlementConfig(1800, 300, 3600, 2, 100);

    // Permissive baseline. Each test tightens only the control it is testing,
    // so a failure names the control rather than the fixture.
    for (const t of [0, 1, 2]) {
      await registry.setTierConfig(t, 0, 0, YEAR, 10000, 0);
    }
    await registry.setMaxEntryImpactBps(0);

    // Every asset is tagged explicitly. A never-seen asset now defaults to
    // Speculative rather than BlueChip — "unassessed" and "safest" used to be
    // the same state, so an asset nobody had evaluated was admitted to the
    // most conservative vaults. These four tests previously leaned on that
    // default without saying so.
    await registry.setTier(await usdx.getAddress(), BLUE_CHIP);
    await registry.setTier(await weth.getAddress(), BLUE_CHIP);
    await registry.setTier(await aapl.getAddress(), STANDARD);
    await registry.setTier(await meme.getAddress(), SPECULATIVE);

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

    async function originate(maxTier, opts = {}) {
      const principal = opts.principal ?? PRINCIPAL;
      const deposit   = opts.deposit   ?? DEPOSIT;
      const term      = opts.term      ?? 30 * DAY;

      const need = principal + E("1");
      await usdx.mint(lender.address, need);
      await usdx.connect(lender).approve(await factory.getAddress(), need);

      const before = await factory.totalVaults();
      await factory.connect(lender).deployVaultWithTier(
        await usdx.getAddress(), borrower.address, principal, APR_BPS,
        term, true, deposit, ethers.ZeroAddress, maxTier
      );
      const vault = await ethers.getContractAt("Vault", await factory.allVaults(before));

      await usdx.mint(borrower.address, deposit);
      await usdx.connect(borrower).approve(await vault.getAddress(), deposit);
      await vault.connect(borrower).payDeposit();
      return vault;
    }

    return { operator, lender, borrower, usdx, weth, aapl, meme, pools,
             router, registry, pool, factory, originate };
  }

  // --- The tier ceiling ---

  it("Refuses a swap into an asset above the vault's ceiling", async function () {
    const { originate, borrower, meme } = await loadFixture(fixture);
    const vault = await originate(BLUE_CHIP);

    await expect(
      vault.connect(borrower).swap(await meme.getAddress(), E("1"), E("0.9"), POOL_FEE)
    ).to.be.revertedWith("Asset exceeds this vault's risk mandate");
  });

  it("Permits a swap into an asset exactly at the ceiling", async function () {
    const { originate, borrower, aapl } = await loadFixture(fixture);
    const vault = await originate(STANDARD);

    await expect(
      vault.connect(borrower).swap(await aapl.getAddress(), E("1"), E("0.9"), POOL_FEE)
    ).to.not.be.reverted;
  });

  it("Re-tagging an asset riskier tightens a LIVE loan", async function () {
    const { originate, borrower, registry, aapl } = await loadFixture(fixture);
    const vault = await originate(STANDARD);

    await vault.connect(borrower).swap(await aapl.getAddress(), E("1"), E("0.9"), POOL_FEE);

    // The ceiling is snapshotted, but tierOf is read live — so an operator
    // discovering an asset is riskier than thought closes it off immediately,
    // without touching loans already holding it.
    await registry.setTier(await aapl.getAddress(), SPECULATIVE);

    await expect(
      vault.connect(borrower).swap(await aapl.getAddress(), E("1"), E("0.9"), POOL_FEE)
    ).to.be.revertedWith("Asset exceeds this vault's risk mandate");
  });

  // The direction the original implementation missed. Its comment claimed
  // re-tagging "can tighten a live loan but never loosen it", and the suite
  // only ever tested tightening — so the claim and the tests agreed with each
  // other and both were wrong.
  it("Re-tagging an asset SAFER does not widen a LIVE loan", async function () {
    const { originate, borrower, registry, aapl } = await loadFixture(fixture);
    const vault = await originate(BLUE_CHIP);

    // aapl is Standard, so a Blue chip vault cannot hold it.
    await expect(
      vault.connect(borrower).swap(await aapl.getAddress(), E("1"), E("0.9"), POOL_FEE)
    ).to.be.revertedWith("Asset exceeds this vault's risk mandate");

    // The operator now decides aapl is Blue chip after all. The lender who
    // wrote this loan never agreed to back it, and their deposit was sized
    // against Blue chip volatility.
    await registry.setTier(await aapl.getAddress(), BLUE_CHIP);

    await expect(
      vault.connect(borrower).swap(await aapl.getAddress(), E("1"), E("0.9"), POOL_FEE)
    ).to.be.revertedWith("Asset exceeds this vault's risk mandate");
  });

  it("Accepts the re-tagged asset for a loan written AFTER the change", async function () {
    const { originate, borrower, registry, aapl } = await loadFixture(fixture);

    await registry.setTier(await aapl.getAddress(), BLUE_CHIP);

    // Not a blanket ban: a lender writing now is consenting to the tier as it
    // stands, which is the whole point of the ceiling being a lender choice.
    const vault = await originate(BLUE_CHIP);
    await expect(
      vault.connect(borrower).swap(await aapl.getAddress(), E("1"), E("0.9"), POOL_FEE)
    ).to.not.be.reverted;
  });

  it("Takes the WORST tier held since origination, across several re-tags", async function () {
    const { originate, borrower, registry, aapl } = await loadFixture(fixture);
    const vault = await originate(STANDARD);
    const asset = await aapl.getAddress();

    // Standard at origination, briefly Speculative, back to Standard. The
    // asset looks acceptable again by current tier alone, but the loan was
    // exposed to something the lender's ceiling never covered.
    await registry.setTier(asset, SPECULATIVE);
    await registry.setTier(asset, STANDARD);

    await expect(
      vault.connect(borrower).swap(asset, E("1"), E("0.9"), POOL_FEE)
    ).to.be.revertedWith("Asset exceeds this vault's risk mandate");
  });

  it("Leaves an asset that was never re-tagged unaffected", async function () {
    const { originate, borrower, registry, meme, aapl } = await loadFixture(fixture);
    const vault = await originate(STANDARD);

    // Churn on a DIFFERENT asset must not touch this one.
    await registry.setTier(await meme.getAddress(), BLUE_CHIP);
    await registry.setTier(await meme.getAddress(), SPECULATIVE);

    await expect(
      vault.connect(borrower).swap(await aapl.getAddress(), E("1"), E("0.9"), POOL_FEE)
    ).to.not.be.reverted;
  });

  // --- Every listing path must seed history, exactly once ---
  //
  // _addAsset does not record; each public entry point does. That is what
  // lets a tier-assigning listing write one entry instead of two, and it is
  // fragile in a specific way: a listing path that forgets leaves the asset
  // with NO history, which falls through to the empty-history case that
  // trusts the live tier — the re-tagging hole these tiers exist to close.
  //
  // Refactoring this and forgetting `addAsset` is not hypothetical. It is
  // what happened while writing the change these tests cover.

  it("Seeds tier history on the plain addAsset path", async function () {
    const { registry, operator } = await loadFixture(fixture);
    const freshToken = await (await ethers.getContractFactory("MockERC20", operator))
      .deploy("Fresh", "FRSH", 18);
    const addr = await freshToken.getAddress();

    await registry.addAsset(addr, ethers.ZeroAddress);
    expect(await registry.tierHistoryLength(addr)).to.equal(1);
  });

  it("Seeds tier history on the addAssetWithVenue path", async function () {
    const { registry, operator } = await loadFixture(fixture);
    const freshToken = await (await ethers.getContractFactory("MockERC20", operator))
      .deploy("Fresh", "FRSH", 18);
    const addr = await freshToken.getAddress();

    await registry.addAssetWithVenue(addr, ethers.ZeroAddress, 0, ethers.ZeroAddress, 0);
    expect(await registry.tierHistoryLength(addr)).to.equal(1);
  });

  it("Writes ONE entry when listing with a tier, not the default then the tier", async function () {
    const { registry, operator } = await loadFixture(fixture);
    const freshToken = await (await ethers.getContractFactory("MockERC20", operator))
      .deploy("Fresh", "FRSH", 18);
    const addr = await freshToken.getAddress();

    await registry.addAssetWithTier(addr, ethers.ZeroAddress, 0, ethers.ZeroAddress, 0, STANDARD);

    expect(await registry.tierHistoryLength(addr)).to.equal(1);
    expect(await registry.tierOf(addr)).to.equal(STANDARD);
  });

  it("Records the tier the asset was actually listed at, not the default", async function () {
    const { registry, operator } = await loadFixture(fixture);
    const freshToken = await (await ethers.getContractFactory("MockERC20", operator))
      .deploy("Fresh", "FRSH", 18);
    const addr = await freshToken.getAddress();

    await registry.addAssetWithTier(addr, ethers.ZeroAddress, 0, ethers.ZeroAddress, 0, STANDARD);

    // The sole entry must read Standard. A phantom Speculative entry sharing
    // this block would make highestTierSince report a tier the asset never
    // held, tightening loans for no reason.
    const listedAt = (await ethers.provider.getBlock("latest")).timestamp;
    expect(await registry.highestTierSince(addr, listedAt)).to.equal(STANDARD);
  });

  it("Defaults an unassessed listing to Speculative, and says so in history", async function () {
    const { registry, operator } = await loadFixture(fixture);
    const freshToken = await (await ethers.getContractFactory("MockERC20", operator))
      .deploy("Fresh", "FRSH", 18);
    const addr = await freshToken.getAddress();

    await registry.addAsset(addr, ethers.ZeroAddress);

    expect(await registry.tierOf(addr)).to.equal(SPECULATIVE);
    const listedAt = (await ethers.provider.getBlock("latest")).timestamp;
    expect(await registry.highestTierSince(addr, listedAt)).to.equal(SPECULATIVE);
  });

  it("Records the ceiling on the vault so it cannot be widened later", async function () {
    const { originate } = await loadFixture(fixture);
    const vault = await originate(BLUE_CHIP);
    expect(await vault.maxTier()).to.equal(BLUE_CHIP);
  });

  // --- Exposure cap ---

  it("Refuses a position exceeding the asset's exposure cap", async function () {
    const { originate, borrower, registry, weth } = await loadFixture(fixture);
    await registry.setTierConfig(BLUE_CHIP, 0, 0, YEAR, 2500, 0);   // 25% cap
    const vault = await originate(BLUE_CHIP);

    // 3 of 10 principal = 30%, valued 1:1 at tick 0.
    await expect(
      vault.connect(borrower).swap(await weth.getAddress(), E("3"), E("2.9"), POOL_FEE)
    ).to.be.revertedWith("Exceeds exposure cap for this asset");
  });

  it("Permits a position inside the cap, and blocks the increment that breaches it", async function () {
    const { originate, borrower, registry, weth } = await loadFixture(fixture);
    await registry.setTierConfig(BLUE_CHIP, 0, 0, YEAR, 2500, 0);
    const vault = await originate(BLUE_CHIP);

    await vault.connect(borrower).swap(await weth.getAddress(), E("2"), E("1.9"), POOL_FEE);

    // Cumulative, not per-swap: 2 already held plus 1 more breaches 25%.
    await expect(
      vault.connect(borrower).swap(await weth.getAddress(), E("1"), E("0.9"), POOL_FEE)
    ).to.be.revertedWith("Exceeds exposure cap for this asset");
  });

  // --- Entry impact ---

  it("Refuses a position whose execution falls too far below the TWAP", async function () {
    const { originate, borrower, registry, router, usdx, weth } = await loadFixture(fixture);
    await registry.setMaxEntryImpactBps(100);   // 1%

    // Router pays 2% under the pool's tick-0 TWAP — the mock's stand-in for
    // price impact, since a fixed-rate router cannot move a price itself.
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 98, 100);

    const vault = await originate(BLUE_CHIP);

    await expect(
      vault.connect(borrower).swap(await weth.getAddress(), E("1"), E("0.9"), POOL_FEE)
    ).to.be.revertedWith("Position too large for this pool's depth");
  });

  it("Permits a position whose execution stays within the impact limit", async function () {
    const { originate, borrower, registry, router, usdx, weth } = await loadFixture(fixture);
    await registry.setMaxEntryImpactBps(100);
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 995, 1000);  // 0.5%

    const vault = await originate(BLUE_CHIP);

    await expect(
      vault.connect(borrower).swap(await weth.getAddress(), E("1"), E("0.9"), POOL_FEE)
    ).to.not.be.reverted;
  });

  // --- Deposit floor ---

  it("Scales the deposit floor with the SQUARE ROOT of term", async function () {
    const { registry } = await loadFixture(fixture);
    await registry.setTierConfig(BLUE_CHIP, 6000, 0, YEAR, 10000, 0);   // 60% vol

    const thirty  = await registry.minimumDepositBpsForTier(BLUE_CHIP, 30 * DAY);
    const oneTwenty = await registry.minimumDepositBpsForTier(BLUE_CHIP, 120 * DAY);

    // Four times the term, twice the requirement — not four times. This is the
    // whole reason a linear term premium is the wrong shape.
    expect(Number(oneTwenty) / Number(thirty)).to.be.closeTo(2.0, 0.02);

    // 1.8 x 0.60 x sqrt(30/365) = 0.3096
    expect(Number(thirty)).to.be.closeTo(3096, 5);
  });

  it("Rejects an origination below the volatility floor", async function () {
    const { originate, registry } = await loadFixture(fixture);
    await registry.setTierConfig(BLUE_CHIP, 6000, 0, YEAR, 10000, 0);

    // 30-day term needs ~31%; 15% is well short.
    await expect(
      originate(BLUE_CHIP, { deposit: E("1.5"), term: 30 * DAY })
    ).to.be.revertedWith("Deposit below the volatility floor for this tier and term");
  });

  it("Accepts an origination that meets the floor exactly", async function () {
    const { originate, registry, factory } = await loadFixture(fixture);
    await registry.setTierConfig(BLUE_CHIP, 6000, 0, YEAR, 10000, 0);

    const required = await factory.quoteMinimumDeposit(PRINCIPAL, BLUE_CHIP, 30 * DAY, true);
    await expect(originate(BLUE_CHIP, { deposit: required, term: 30 * DAY })).to.not.be.reverted;
  });

  it("Applies the tier's absolute floor when volatility implies less", async function () {
    const { registry } = await loadFixture(fixture);
    await registry.setTierConfig(BLUE_CHIP, 0, 2000, YEAR, 10000, 0);   // no vol, 20% floor
    expect(await registry.minimumDepositBpsForTier(BLUE_CHIP, 30 * DAY)).to.equal(2000);
  });

  it("Caps the floor at 100% rather than demanding more than principal", async function () {
    const { registry } = await loadFixture(fixture);
    await registry.setTierConfig(SPECULATIVE, 20000, 0, YEAR, 10000, 0);   // 200% vol

    // 1.8 x 2.00 x 1.0 = 360%, which is not a deposit anyone can post.
    expect(await registry.minimumDepositBpsForTier(SPECULATIVE, YEAR)).to.equal(10000);
  });

  // --- Maximum term ---

  it("Rejects a term longer than the tier permits", async function () {
    const { originate, registry } = await loadFixture(fixture);
    await registry.setTierConfig(SPECULATIVE, 0, 0, 7 * DAY, 10000, 0);

    await expect(
      originate(SPECULATIVE, { term: 30 * DAY })
    ).to.be.revertedWith("Term exceeds the maximum for this risk tier");
  });

  it("Permits a term at the tier's limit", async function () {
    const { originate, registry } = await loadFixture(fixture);
    await registry.setTierConfig(SPECULATIVE, 0, 0, 7 * DAY, 10000, 0);
    await expect(originate(SPECULATIVE, { term: 7 * DAY })).to.not.be.reverted;
  });

  it("Binds on the vault's ceiling, not on the loan asset's own tier", async function () {
    const { originate, registry, usdx } = await loadFixture(fixture);

    // Loan denominated in a BlueChip asset, but permitting Speculative
    // exposure. The risk being underwritten is what the borrower MAY hold, so
    // the Speculative limit is what applies.
    expect(await registry.tierOf(await usdx.getAddress())).to.equal(BLUE_CHIP);
    await registry.setTierConfig(SPECULATIVE, 0, 0, 7 * DAY, 10000, 0);

    await expect(
      originate(SPECULATIVE, { term: 30 * DAY })
    ).to.be.revertedWith("Term exceeds the maximum for this risk tier");
  });
});
