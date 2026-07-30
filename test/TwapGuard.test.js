const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * TWAP availability guard.
 *
 * Settlement's forced swap-back quotes a TWAP over registry.twapWindow()
 * seconds, at whatever fee tier the borrower originally swapped through. A
 * Uniswap V3 pool that cannot serve that window reverts — and because every
 * settlement tier routes through _forcedSwapBackAll(), the vault becomes
 * permanently unsettleable. Lender principal, borrower deposit and the
 * insurance pool's exposure all freeze.
 *
 * The trap is that liquidity and TWAP history are INDEPENDENT. A pool can
 * hold real depth — so swapping IN succeeds — while having
 * observationCardinality == 1, so quoting a TWAP to swap OUT reverts. This
 * is not hypothetical: AAPL/WETH at 0.05% on Robinhood Chain mainnet holds
 * 7.25e19 liquidity with cardinality 1 today.
 *
 * The guard refuses entry into any position the vault could not force an
 * exit from. These tests exercise it through Vault.swap() rather than
 * calling the library directly, because what matters is that the borrower
 * is stopped, not that a helper returns false.
 *
 * Note the mock: MockUniswapV3Pool.maxWindow defaults to unlimited, which
 * is why the other 91 tests are unaffected. Setting it to 0 reproduces a
 * cardinality-1 pool.
 */

const E = ethers.parseEther;
const PRINCIPAL   = E("10");
const DEPOSIT     = E("1.5");
const FEE_BPS     = 300n;
const SKIM        = E("0.06");
const DURATION    = 7200;
const GRACE       = 3600;
const TWAP_WINDOW = 1800;

const POOL_FEE = 3000;   // the healthy tier
const ALT_FEE  = 500;    // the tier under test

describe("TWAP availability guard", function () {

  async function fixture() {
    const [operator, lender, borrower, treasury] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const weth = await Mock.deploy("Mock WETH", "WETH", 18);
    const usdx = await Mock.deploy("Mock USDX", "USDX", 18);

    const aave = await (await ethers.getContractFactory("MockAavePool", operator)).deploy();
    await aave.configureAsset(await weth.getAddress());
    const aTokenWeth = await aave.aTokenOf(await weth.getAddress());

    const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();

    // Healthy pool at 0.3% — full observation history.
    const uniPool = await (await ethers.getContractFactory("MockUniswapV3Pool", operator)).deploy();
    await uniFactory.setPool(await weth.getAddress(), await usdx.getAddress(), POOL_FEE, await uniPool.getAddress());
    await uniPool.setAvgTick(0);

    // Router rates are set per PAIR, not per fee tier, so a swap at the alt
    // tier would execute perfectly well if the guard let it through. That is
    // what makes these tests meaningful: only the guard stops it.
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
    await registry.setSettlementConfig(TWAP_WINDOW, 200, GRACE, 2, 100);

    const pool = await (await ethers.getContractFactory("InsurancePool", operator))
      .deploy(operator.address, 1000);

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

    await weth.mint(lender.address, PRINCIPAL + SKIM);
    await weth.connect(lender).approve(await factory.getAddress(), PRINCIPAL + SKIM);
    await factory.connect(lender).deployVault(
      await weth.getAddress(), borrower.address, PRINCIPAL, FEE_BPS, DURATION, true, DEPOSIT,
      ethers.ZeroAddress
    );
    const vault = await ethers.getContractAt("Vault", await factory.allVaults(0));

    await weth.mint(borrower.address, DEPOSIT);
    await weth.connect(borrower).approve(await vault.getAddress(), DEPOSIT);
    await vault.connect(borrower).payDeposit();

    // Deploys a second pool at the alt fee tier with a bounded history.
    async function poolWithWindow(maxWindow) {
      const p = await (await ethers.getContractFactory("MockUniswapV3Pool", operator)).deploy();
      await p.setAvgTick(0);
      await p.setMaxWindow(maxWindow);
      await uniFactory.setPool(await weth.getAddress(), await usdx.getAddress(), ALT_FEE, await p.getAddress());
      return p;
    }

    return { operator, lender, borrower, weth, usdx, router, uniFactory, uniPool,
             registry, vault, poolWithWindow };
  }

  // --- Rejection cases ---

  it("Rejects a swap when no pool exists at the chosen fee tier", async function () {
    const { vault, borrower, usdx } = await loadFixture(fixture);

    // Nothing registered at ALT_FEE — getPool returns address(0).
    await expect(
      vault.connect(borrower).swap(await usdx.getAddress(), E("1"), E("0.9"), ALT_FEE)
    ).to.be.revertedWith("No TWAP history for this pair and fee tier");
  });

  it("Rejects a swap into a pool that has liquidity but no TWAP history", async function () {
    const { vault, borrower, usdx, poolWithWindow } = await loadFixture(fixture);

    // Cardinality 1: the pool exists, the router would happily fill the
    // swap, but observe() reverts for any non-zero window. This is the
    // fund-freeze case.
    await poolWithWindow(0);

    await expect(
      vault.connect(borrower).swap(await usdx.getAddress(), E("1"), E("0.9"), ALT_FEE)
    ).to.be.revertedWith("No TWAP history for this pair and fee tier");
  });

  it("Rejects a swap when the pool's history is shorter than the TWAP window", async function () {
    const { vault, borrower, usdx, poolWithWindow } = await loadFixture(fixture);

    // Ten minutes of history against an 1800s window — a pool mid-way
    // through cardinality expansion.
    await poolWithWindow(600);

    await expect(
      vault.connect(borrower).swap(await usdx.getAddress(), E("1"), E("0.9"), ALT_FEE)
    ).to.be.revertedWith("No TWAP history for this pair and fee tier");
  });

  it("Leaves vault balances untouched when a swap is rejected", async function () {
    const { vault, borrower, weth, usdx, poolWithWindow } = await loadFixture(fixture);
    await poolWithWindow(0);

    const wethBefore = await weth.balanceOf(await vault.getAddress());

    await expect(
      vault.connect(borrower).swap(await usdx.getAddress(), E("1"), E("0.9"), ALT_FEE)
    ).to.be.reverted;

    expect(await weth.balanceOf(await vault.getAddress())).to.equal(wethBefore);
    expect(await usdx.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await vault.heldAssetCount()).to.equal(0n);
  });

  // --- The per-tier property ---

  it("Accepts and rejects the SAME asset at different fee tiers", async function () {
    const { vault, borrower, usdx, poolWithWindow } = await loadFixture(fixture);

    // Exactly the AAPL/USDG situation: healthy at one tier, unquotable at
    // another. Whitelisting is per-asset, so only a per-tier check catches this.
    await poolWithWindow(0);

    await expect(
      vault.connect(borrower).swap(await usdx.getAddress(), E("1"), E("0.9"), ALT_FEE)
    ).to.be.revertedWith("No TWAP history for this pair and fee tier");

    await expect(
      vault.connect(borrower).swap(await usdx.getAddress(), E("1"), E("0.9"), POOL_FEE)
    ).to.not.be.reverted;
  });

  // --- Regression: the happy path still works ---

  it("Allows a swap through a pool that can serve the window", async function () {
    const { vault, borrower, usdx } = await loadFixture(fixture);

    await vault.connect(borrower).swap(await usdx.getAddress(), E("1"), E("0.9"), POOL_FEE);

    expect(await usdx.balanceOf(await vault.getAddress())).to.equal(E("1"));
    expect(await vault.heldAssetCount()).to.equal(1n);
  });

  it("A guarded swap still force-settles cleanly", async function () {
    const { vault, borrower, weth, usdx } = await loadFixture(fixture);

    await vault.connect(borrower).swap(await usdx.getAddress(), E("1"), E("0.9"), POOL_FEE);
    await vault.connect(borrower).settle();

    // The whole point of the guard: whatever the borrower was allowed into,
    // settlement can always get back out of.
    expect(await usdx.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await vault.heldAssetCount()).to.equal(0n);
    expect(await vault.isSettled()).to.equal(true);
  });
});
