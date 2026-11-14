const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
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
    const nvda = await Mock.deploy("Mock NVDA", "NVDA", 18);   // a second standard asset (audit M-07)

    const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();

    // One pool per pair, all at tick 0. The router's rate is set separately, so
    // execution and TWAP can be made to DISAGREE — which is what makes the
    // entry-impact check testable at all.
    const pools = {};
    for (const t of [weth, aapl, meme, nvda]) {
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
    await kyc.verify(borrower.address, 7, ethers.id("test-fixture"));
    await kyc.verify(lender.address, 7, ethers.id("test-fixture"));  // lenders are screened too (#7)

    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await router.getAddress(),
      await uniFactory.getAddress(), 0
    );
    for (const t of [usdx, weth, aapl, meme, nvda]) {
      await registry.addAsset(await t.getAddress(), 0);
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
    await registry.setTier(await nvda.getAddress(), STANDARD);

    const pool = await (await ethers.getContractFactory("InsurancePool", operator))
      .deploy(operator.address, 1000, 0);

    // The protocol names the pool vaults trade through (KRAIT-003 / item 20).

    await registry.setMinPoolLiquidity(await usdx.getAddress(), await weth.getAddress(), 1n);   // audit M-01
    await registry.setPoolFeeTier(await usdx.getAddress(), await weth.getAddress(), POOL_FEE);

    await registry.setMinPoolLiquidity(await usdx.getAddress(), await aapl.getAddress(), 1n);   // audit M-01
    await registry.setPoolFeeTier(await usdx.getAddress(), await aapl.getAddress(), POOL_FEE);

    await registry.setMinPoolLiquidity(await usdx.getAddress(), await meme.getAddress(), 1n);   // audit M-01
    await registry.setPoolFeeTier(await usdx.getAddress(), await meme.getAddress(), POOL_FEE);

    await registry.setMinPoolLiquidity(await usdx.getAddress(), await nvda.getAddress(), 1n);   // audit M-01
    await registry.setPoolFeeTier(await usdx.getAddress(), await nvda.getAddress(), POOL_FEE);

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

      // Deposit plus any insurance premium the tier charges (audit M-06 tests set one).
      const due = deposit + await vault.insurancePremium();
      await usdx.mint(borrower.address, due);
      await usdx.connect(borrower).approve(await vault.getAddress(), due);
      await vault.connect(borrower).payDeposit();
      return vault;
    }

    return { operator, lender, borrower, usdx, weth, aapl, meme, nvda, pools,
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

    await registry.addAsset(addr, 0);
    expect(await registry.tierHistoryLength(addr)).to.equal(1);
  });

  it("Writes ONE entry when listing with a tier, not the default then the tier", async function () {
    const { registry, operator } = await loadFixture(fixture);
    const freshToken = await (await ethers.getContractFactory("MockERC20", operator))
      .deploy("Fresh", "FRSH", 18);
    const addr = await freshToken.getAddress();

    await registry.addAssetWithTier(addr, 0, STANDARD);

    expect(await registry.tierHistoryLength(addr)).to.equal(1);
    expect(await registry.tierOf(addr)).to.equal(STANDARD);
  });

  it("Records the tier the asset was actually listed at, not the default", async function () {
    const { registry, operator } = await loadFixture(fixture);
    const freshToken = await (await ethers.getContractFactory("MockERC20", operator))
      .deploy("Fresh", "FRSH", 18);
    const addr = await freshToken.getAddress();

    await registry.addAssetWithTier(addr, 0, STANDARD);

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

    await registry.addAsset(addr, 0);

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

    // Audit M-06: the horizon is the term plus the 5-day insured window, so
    // 25 and 115 days of term are 30 and 120 days of priced risk.
    const thirty  = await registry.minimumDepositBpsForTier(BLUE_CHIP, 25 * DAY);
    const oneTwenty = await registry.minimumDepositBpsForTier(BLUE_CHIP, 115 * DAY);

    // Four times the horizon, twice the requirement — not four times. This is
    // the whole reason a linear term premium is the wrong shape.
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

  // --- Audit L-02 (Zealynx): a re-tag in the origination block ---
  //
  // Tier history is timestamped, and two transactions in one block share a
  // timestamp. highestTierSince stopped at the first entry at or before
  // origination, so a downgrade mined in the SAME block as the loan hid the
  // tier the asset held when the loan was written.

  describe("Audit L-02 — a same-block re-tag cannot admit a riskier asset to an older loan", function () {
    /** Sends each transaction with automine off, then mines them all into ONE block, in order. */
    async function inOneBlock(sends) {
      await ethers.provider.send("evm_setAutomine", [false]);
      try {
        for (const send of sends) { await send(); }
        await ethers.provider.send("evm_mine", []);
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }
    }

    /** A Blue chip loan whose origination and the re-tag of meme to Blue chip share a block. */
    async function originateWithRetag(env, retagFirst) {
      const { lender, borrower, usdx, registry, factory, meme } = env;
      await usdx.mint(lender.address, PRINCIPAL + E("1"));
      await usdx.connect(lender).approve(await factory.getAddress(), PRINCIPAL + E("1"));
      const before = await factory.totalVaults();

      const originateTx = () => factory.connect(lender).deployVaultWithTier(
        usdx.getAddress(), borrower.address, PRINCIPAL, APR_BPS, 30 * DAY, true, DEPOSIT,
        ethers.ZeroAddress, BLUE_CHIP, { gasLimit: 3_000_000 });
      const retagTx = () => registry.setTier(meme.getAddress(), BLUE_CHIP, { gasLimit: 300_000 });
      await inOneBlock(retagFirst ? [retagTx, originateTx] : [originateTx, retagTx]);

      const vault = await ethers.getContractAt("Vault", await factory.allVaults(before));
      expect(await registry.tierOf(meme.getAddress())).to.equal(BLUE_CHIP);
      const block = await ethers.provider.getBlock("latest");
      expect(await vault.originatedAt()).to.equal(BigInt(block.timestamp));   // same block, same second

      await usdx.mint(borrower.address, DEPOSIT);
      await usdx.connect(borrower).approve(await vault.getAddress(), DEPOSIT);
      await vault.connect(borrower).payDeposit();
      return vault;
    }

    it("The finding: origination, then a downgrade to Blue chip in the same block — the asset is still refused", async function () {
      const env = await loadFixture(fixture);
      const vault = await originateWithRetag(env, false);
      expect(await env.registry.highestTierSince(env.meme.getAddress(), await vault.originatedAt())).to.equal(SPECULATIVE);
      await expect(vault.connect(env.borrower).swap(env.meme.getAddress(), E("1"), E("0.9"), POOL_FEE))
        .to.be.revertedWith("Asset exceeds this vault's risk mandate");
    });

    it("The other order: a downgrade earlier in the origination block is also counted (errs strict)", async function () {
      const env = await loadFixture(fixture);
      const vault = await originateWithRetag(env, true);
      await expect(vault.connect(env.borrower).swap(env.meme.getAddress(), E("1"), E("0.9"), POOL_FEE))
        .to.be.revertedWith("Asset exceeds this vault's risk mandate");
    });

    it("A downgrade in a later block is refused, and a loan written in a later block accepts the asset", async function () {
      const { originate, borrower, registry, meme } = await loadFixture(fixture);
      const older = await originate(BLUE_CHIP);
      await registry.setTier(meme.getAddress(), BLUE_CHIP);
      await expect(older.connect(borrower).swap(meme.getAddress(), E("1"), E("0.9"), POOL_FEE))
        .to.be.revertedWith("Asset exceeds this vault's risk mandate");

      const newer = await originate(BLUE_CHIP);
      await newer.connect(borrower).swap(meme.getAddress(), E("1"), E("0.9"), POOL_FEE);
      expect(await newer.isHeld(meme.getAddress())).to.equal(true);
    });
  });
  // Audit M-07 (Zealynx): the exposure cap was checked one asset at a time, so
  // a vault could hold several assets each at its own cap — more risk than the
  // single capped exposure its deposit and premium were priced on. Holdings
  // now share one budget: each uses value / (its cap x principal), and the
  // total may not exceed 100%. Caps here are the launch shape: Blue chip 70%,
  // Standard 50%, Speculative 25%. Principal is 10; every pool is at 1:1.
  describe("Audit M-07 — holdings share one exposure budget", function () {
    async function m07() {
      const env = await loadFixture(fixture);
      const { registry } = env;
      await registry.setTierConfig(BLUE_CHIP,   0, 0, YEAR, 7000, 0);
      await registry.setTierConfig(STANDARD,    0, 0, YEAR, 5000, 0);
      await registry.setTierConfig(SPECULATIVE, 0, 0, YEAR, 2500, 0);
      return env;
    }
    const buy = (vault, who, token, amt) =>
      vault.connect(who).swap(token.getAddress(), E(amt), 1, POOL_FEE);

    it("The finding: a Standard vault can no longer hold two Standard assets at 50% each", async function () {
      const { originate, borrower, aapl, nvda } = await m07();
      const vault = await originate(STANDARD);
      await buy(vault, borrower, aapl, "5");                       // 50%: the whole budget
      await expect(buy(vault, borrower, nvda, "5"))                // passed its own 50% cap before
        .to.be.revertedWith("Holdings exceed exposure budget");
      await expect(buy(vault, borrower, nvda, "0.01"))
        .to.be.revertedWith("Holdings exceed exposure budget");
      expect(await vault.isHeld(nvda.getAddress())).to.equal(false);
    });

    it("Splits the budget between riskier assets: 25% + 25% fills it, and nothing more fits", async function () {
      const { originate, borrower, aapl, nvda } = await m07();
      const vault = await originate(STANDARD);
      await buy(vault, borrower, aapl, "2.5");
      await buy(vault, borrower, nvda, "2.5");
      await expect(buy(vault, borrower, nvda, "0.01"))
        .to.be.revertedWith("Holdings exceed exposure budget");
    });

    it("A safer asset uses less budget: 25% Standard + 35% Blue chip is allowed, 60% invested", async function () {
      const { originate, borrower, usdx, aapl, weth } = await m07();
      const vault = await originate(STANDARD);
      await buy(vault, borrower, aapl, "2.5");                     // half the budget
      await buy(vault, borrower, weth, "3.5");                     // 3.5 / 7 = the other half
      await expect(buy(vault, borrower, weth, "0.01"))
        .to.be.revertedWith("Holdings exceed exposure budget");
      // 6 of the 10 principal invested, against 5 if the budget ignored tiers.
      expect(await usdx.balanceOf(vault.getAddress())).to.equal(E("9"));   // 10 + 5 deposit - 6
    });

    it("A vault can still fill a single asset's cap, and selling frees budget for another", async function () {
      const { originate, borrower, aapl, weth } = await m07();
      const vault = await originate(STANDARD);
      await buy(vault, borrower, weth, "7");                       // Blue chip at its own 70% cap
      await expect(buy(vault, borrower, aapl, "0.01"))
        .to.be.revertedWith("Holdings exceed exposure budget");
      await vault.connect(borrower).swapBack(weth.getAddress(), E("3.5"), 1);
      await buy(vault, borrower, aapl, "2.5");                     // half freed, half used
    });

    it("Caps are configurable: with Standard at 100%, two Standard assets can take the whole principal", async function () {
      const { originate, borrower, registry, aapl, nvda } = await m07();
      await registry.setTierConfig(STANDARD, 0, 0, YEAR, 10000, 0);
      const vault = await originate(STANDARD);
      await buy(vault, borrower, aapl, "5");
      await buy(vault, borrower, nvda, "5");
      expect(await vault.isHeld(nvda.getAddress())).to.equal(true);
    });

    it("Reads each holding's riskiest tier since origination: a later re-tag safer does not free budget", async function () {
      const { originate, borrower, registry, aapl, weth } = await m07();
      const vault = await originate(STANDARD);
      await buy(vault, borrower, aapl, "5");
      await registry.setTier(aapl.getAddress(), BLUE_CHIP);        // now nominally a 70% asset
      await expect(buy(vault, borrower, weth, "1"))
        .to.be.revertedWith("Holdings exceed exposure budget");
    });

    it("With the budget full across two Standard assets, a joint 50% fall stays within the deposit: no reserve draw", async function () {
      const { originate, operator, lender, borrower, router, pools, pool, usdx, aapl, nvda } = await m07();
      await usdx.mint(operator.address, E("100"));
      await usdx.approve(pool.getAddress(), E("100"));
      await pool.fund(usdx.getAddress(), E("100"));                // a reserve that COULD be drawn

      const vault = await originate(STANDARD, { deposit: E("3") });
      await buy(vault, borrower, aapl, "2.5");
      await buy(vault, borrower, nvda, "2.5");                     // the whole budget, two assets

      for (const t of [aapl, nvda]) {                              // both halve, spot and TWAP together
        await router.setRate(t.getAddress(), usdx.getAddress(), 1, 2);
        const half = BigInt(await t.getAddress()) < BigInt(await usdx.getAddress()) ? -6932 : 6932;
        await pools[await t.getAddress()].setAvgTick(half);
      }
      await time.increaseTo((await vault.deadline()) + 1n);
      await vault.connect(lender).settle();

      expect(await vault.settledTotalReturned()).to.be.gte(E("10"));   // principal back from the vault alone
      expect(await vault.settledInsuranceDraw()).to.equal(0n);
      expect(await pool.reserveOf(usdx.getAddress())).to.equal(E("100"));
    });

    it("Control: the same fall on 5 + 5 (the frozen code's limit, here via a 100% cap) draws on the reserve", async function () {
      const { originate, operator, lender, borrower, registry, router, pools, pool, usdx, aapl, nvda } = await m07();
      await registry.setTierConfig(STANDARD, 0, 0, YEAR, 10000, 0);
      await usdx.mint(operator.address, E("100"));
      await usdx.approve(pool.getAddress(), E("100"));
      await pool.fund(usdx.getAddress(), E("100"));

      const vault = await originate(STANDARD, { deposit: E("3") });
      await buy(vault, borrower, aapl, "5");
      await buy(vault, borrower, nvda, "5");

      for (const t of [aapl, nvda]) {
        await router.setRate(t.getAddress(), usdx.getAddress(), 1, 2);
        const half = BigInt(await t.getAddress()) < BigInt(await usdx.getAddress()) ? -6932 : 6932;
        await pools[await t.getAddress()].setAvgTick(half);
      }
      await time.increaseTo((await vault.deadline()) + 1n);
      await vault.connect(lender).settle();

      expect(await vault.settledTotalReturned()).to.equal(E("8"));     // 3 deposit + 5 from the sales
      expect(await vault.settledInsuranceDraw()).to.equal(E("1"));     // capped at 10% of principal
    });

    it("A holding that cannot be valued blocks purchases until it reprices", async function () {
      const { originate, borrower, registry, pools, usdx, aapl, weth } = await m07();
      const vault = await originate(STANDARD);
      await buy(vault, borrower, aapl, "1");
      // AAPL's pool falls below its minimum across the window (audit M-01):
      // the holding can no longer be priced.
      const aaplPool = pools[await aapl.getAddress()];
      await aaplPool.setMeanLiquidity(1000);
      await registry.setMinPoolLiquidity(usdx.getAddress(), aapl.getAddress(), 1001n);
      await expect(buy(vault, borrower, weth, "1"))
        .to.be.revertedWith("Holdings exceed exposure budget");
      await registry.setMinPoolLiquidity(usdx.getAddress(), aapl.getAddress(), 900n);   // or the minimum is lowered
      await buy(vault, borrower, weth, "1");
    });
  });

  // Audit M-06 (Zealynx): the deposit floor and premium were priced on the
  // term alone, while insurance paid on a settlement at ANY time after the
  // deadline. A 60-second loan held through 36 hours of grace carried hours of
  // risk at a minute's price, with cover that never expired. Every loan is now
  // priced on term + the insured window (5 days), snapshots that window at
  // origination, and draws insurance only on a settlement by deadline + window,
  // extended by any recorded outage that overlaps it.
  describe("Audit M-06 — loans are priced and insured for term + the insured window", function () {
    const WINDOW = 5 * DAY;
    const sqrtYears = (seconds) => Math.sqrt(seconds / YEAR);

    it("Defaults the insured window to 5 days, and prices the deposit floor on term + window", async function () {
      const { registry } = await loadFixture(fixture);
      expect(await registry.insuredWindow()).to.equal(WINDOW);
      await registry.setTierConfig(BLUE_CHIP, 6000, 1000, YEAR, 10000, 0);   // 60% vol, 10% minimum

      // 1.8 x 0.60 x sqrt((60 s + 5 d) / 365 d) = 12.6%: above the 10% minimum
      // that used to bind a 60-second loan.
      const floor = Number(await registry.minimumDepositBpsForTier(BLUE_CHIP, 60));
      expect(floor).to.be.closeTo(Math.round(18000 * 0.6 * sqrtYears(60 + WINDOW)), 2);
      expect(floor).to.be.greaterThan(1000);
    });

    it("The finding: a 60-second Blue chip loan at a 10% deposit is refused; the quoted floor is accepted", async function () {
      const { originate, registry, factory } = await loadFixture(fixture);
      await registry.setTierConfig(BLUE_CHIP, 6000, 1000, YEAR, 10000, 0);

      await expect(originate(BLUE_CHIP, { term: 60, deposit: E("1") }))
        .to.be.revertedWith("Deposit below the volatility floor for this tier and term");

      const quoted = await factory.quoteMinimumDeposit(PRINCIPAL, BLUE_CHIP, 60, true);
      const vault = await originate(BLUE_CHIP, { term: 60, deposit: quoted });
      expect(await vault.depositPaid()).to.equal(true);
    });

    it("Charges the premium on term + window, across short and long terms", async function () {
      const { originate, registry } = await loadFixture(fixture);
      await registry.setTierConfig(BLUE_CHIP, 0, 0, YEAR, 10000, 250);      // 2.5% a year
      for (const term of [60, DAY, 30 * DAY]) {
        const vault = await originate(BLUE_CHIP, { term });
        const expected = (PRINCIPAL * 250n * BigInt(term + WINDOW)) / (10000n * BigInt(YEAR));
        expect(await vault.insurancePremium(), `term ${term}`).to.equal(expected);
        expect(await vault.insuredUntil()).to.equal((await vault.deadline()) + BigInt(WINDOW));
      }
    });

    // A loss beyond the deposit, so insurance has something to pay:
    // 7 of 10 principal in WETH at a 1 deposit, and WETH halves.
    async function lossStack(opts = {}) {
      const env = await loadFixture(fixture);
      const { operator, borrower, registry, router, pools, pool, usdx, weth, originate } = env;
      await registry.setOutageConfig(...(opts.outages ?? [0, 0, 0]));
      await usdx.mint(operator.address, E("100"));
      await usdx.approve(pool.getAddress(), E("100"));
      await pool.fund(usdx.getAddress(), E("100"));

      const vault = await originate(BLUE_CHIP, { deposit: E("1"), term: 7 * DAY });
      await vault.connect(borrower).swap(weth.getAddress(), E("7"), 1, POOL_FEE);
      await router.setRate(weth.getAddress(), usdx.getAddress(), 1, 2);
      const half = BigInt(await weth.getAddress()) < BigInt(await usdx.getAddress()) ? -6932 : 6932;
      await pools[await weth.getAddress()].setAvgTick(half);
      return { ...env, vault };
    }

    it("Draws insurance on a settlement inside the window", async function () {
      const { lender, vault } = await lossStack();
      await time.increaseTo((await vault.deadline()) + BigInt(WINDOW - DAY));
      await vault.connect(lender).settle();
      expect(await vault.settledTotalReturned()).to.equal(E("7.5"));      // 4 cash (incl. deposit) + 3.5 from the sale
      expect(await vault.settledInsuranceDraw()).to.equal(E("1"));        // 10% cap
    });

    it("Draws nothing after the window; the cash settlement still pays out the vault's own funds", async function () {
      const { lender, usdx, pool, vault } = await lossStack();
      const reserve = await pool.reserveOf(usdx.getAddress());
      await time.increaseTo((await vault.deadline()) + BigInt(WINDOW + DAY));
      const before = await usdx.balanceOf(lender.address);
      await vault.connect(lender).settle();
      expect(await vault.settledInsuranceDraw()).to.equal(0n);
      expect(await usdx.balanceOf(lender.address) - before).to.equal(E("7.5"));
      expect(await pool.reserveOf(usdx.getAddress())).to.equal(reserve);
    });

    it("Extends the cut-off by a recorded outage that overlaps the window", async function () {
      // Outage detection on: a silence over an hour is an outage, capped at 72 h.
      const { lender, registry, vault } = await lossStack({ outages: [3600, 3600, 72 * 3600] });
      await registry.heartbeat();
      // Two days of silence that span the deadline: the window ends two days later.
      await time.increaseTo((await vault.deadline()) + BigInt(DAY));
      await registry.heartbeat();
      // A day after the unextended window ends, but inside the extended one.
      await time.increaseTo((await vault.deadline()) + BigInt(WINDOW + DAY));
      await vault.connect(lender).settle();
      expect(await vault.settledInsuranceDraw()).to.equal(E("1"));
    });

    it("Snapshots the window: a later change does not reach a live loan", async function () {
      const { lender, registry, vault } = await lossStack();
      await registry.setInsuredWindow(28 * DAY);
      await time.increaseTo((await vault.deadline()) + BigInt(WINDOW + DAY));
      await vault.connect(lender).settle();
      expect(await vault.settledInsuranceDraw()).to.equal(0n);           // still the 5-day window
    });

    it("Bounds the window: never shorter than grace, never over 28 days, and grace cannot outgrow it", async function () {
      const { registry } = await loadFixture(fixture);
      const grace = Number(await registry.swapBackGracePeriod());
      await expect(registry.setInsuredWindow(grace - 1)).to.be.revertedWith("Insured window out of range");
      await expect(registry.setInsuredWindow(28 * DAY + 1)).to.be.revertedWith("Insured window out of range");
      await registry.setInsuredWindow(grace);
      await expect(registry.setSettlementConfig(1800, 300, grace + 1, 2, 100))
        .to.be.revertedWith("Grace longer than insured window");
      await expect(registry.connect((await ethers.getSigners())[2]).setInsuredWindow(WINDOW))
        .to.be.reverted;                                                   // operator only
    });
  });
});
