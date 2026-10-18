const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * MAINNET-READINESS item 12: parameters that open loans read live may not
 * change underneath them without notice. Risk-reducing changes stay instant.
 * Every test here runs with a REAL 48-hour delay.
 */
const E = ethers.parseEther;
const DELAY = 48 * 3600;
const POOL_FEE = 3000, ALT_FEE = 10000;

// Announce a call by the hash of its exact calldata, wait, then make it.
async function announce(contract, fn, args) {
  const data = contract.interface.encodeFunctionData(fn, args);
  await contract.queueAction(ethers.keccak256(data));
}

describe("Item 12 — live-loan parameters are timelocked", function () {

  async function registryStack() {
    const [operator, stranger] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const weth = await Mock.deploy("WETH", "WETH", 18);
    const usdx = await Mock.deploy("USDX", "USDX", 18);
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();
    for (const fee of [POOL_FEE, ALT_FEE]) {
      const p = await (await ethers.getContractFactory("MockUniswapV3Pool", operator)).deploy();
      await uniFactory.setPool(await weth.getAddress(), await usdx.getAddress(), fee, await p.getAddress());
    }
    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, operator.address, operator.address, await uniFactory.getAddress(), await weth.getAddress(), DELAY);
    await registry.addAsset(await weth.getAddress(), ethers.ZeroAddress);
    await registry.addAsset(await usdx.getAddress(), ethers.ZeroAddress);
    const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, DELAY);
    return { operator, stranger, weth, usdx, registry, pool };
  }

  describe("Settlement config (tolerance, TWAP window, grace, bounty)", function () {
    const ARGS = [1800, 1000, 36 * 3600, 2, 100]; // tolerance widened 2% -> 10%

    it("Refuses a change that was not announced", async function () {
      const { registry } = await loadFixture(registryStack);
      await expect(registry.setSettlementConfig(...ARGS)).to.be.revertedWith("Action was not queued");
    });

    it("Refuses it before the delay, applies it after", async function () {
      const { registry } = await loadFixture(registryStack);
      await announce(registry, "setSettlementConfig", ARGS);
      await expect(registry.setSettlementConfig(...ARGS)).to.be.revertedWith("Timelock has not elapsed");
      await time.increase(DELAY);
      await registry.setSettlementConfig(...ARGS);
      expect(await registry.twapToleranceBps()).to.equal(1000);
    });

    it("Binds the announcement to its arguments: announcing 5% does not authorise 10%", async function () {
      const { registry } = await loadFixture(registryStack);
      await announce(registry, "setSettlementConfig", [1800, 500, 36 * 3600, 2, 100]);
      await time.increase(DELAY);
      await expect(registry.setSettlementConfig(...ARGS)).to.be.revertedWith("Action was not queued");
    });

    it("Waits even when tightening, because every direction hurts someone", async function () {
      const { registry } = await loadFixture(registryStack);
      await expect(registry.setSettlementConfig(1800, 100, 36 * 3600, 2, 100))
        .to.be.revertedWith("Action was not queued");
    });

    it("Lets the operator cancel an announcement, and only the operator queue one", async function () {
      const { registry, stranger } = await loadFixture(registryStack);
      const id = ethers.keccak256(registry.interface.encodeFunctionData("setSettlementConfig", ARGS));
      await expect(registry.connect(stranger).queueAction(id)).to.be.reverted;
      await registry.queueAction(id);
      await registry.cancelAction(id);
      await time.increase(DELAY);
      await expect(registry.setSettlementConfig(...ARGS)).to.be.revertedWith("Action was not queued");
    });
  });

  describe("Entry-impact limit", function () {
    it("Tightens instantly", async function () {
      const { registry } = await loadFixture(registryStack);
      await registry.setMaxEntryImpactBps(50); // 100 -> 50
      expect(await registry.maxEntryImpactBps()).to.equal(50);
    });

    it("Waits to loosen", async function () {
      const { registry } = await loadFixture(registryStack);
      await expect(registry.setMaxEntryImpactBps(300)).to.be.revertedWith("Action was not queued");
      await announce(registry, "setMaxEntryImpactBps", [300]);
      await time.increase(DELAY);
      await registry.setMaxEntryImpactBps(300);
    });

    it("Waits to switch the check off entirely", async function () {
      const { registry } = await loadFixture(registryStack);
      await expect(registry.setMaxEntryImpactBps(0)).to.be.revertedWith("Action was not queued");
    });
  });

  describe("Tier exposure cap", function () {
    it("Lowers a cap instantly", async function () {
      const { registry } = await loadFixture(registryStack);
      await registry.setTierConfig(1, 10000, 2000, 90 * 86400, 2000, 250); // Standard 50% -> 20%
      expect((await registry.tierConfig(1)).maxExposureBps).to.equal(2000);
    });

    it("Waits to raise a cap", async function () {
      const { registry } = await loadFixture(registryStack);
      const args = [1, 10000, 2000, 90 * 86400, 8000, 250]; // Standard 50% -> 80%
      await expect(registry.setTierConfig(...args)).to.be.revertedWith("Action was not queued");
      await announce(registry, "setTierConfig", args);
      await time.increase(DELAY);
      await registry.setTierConfig(...args);
      expect((await registry.tierConfig(1)).maxExposureBps).to.equal(8000);
    });

    it("Leaves origination-only fields instant when the cap does not rise", async function () {
      const { registry } = await loadFixture(registryStack);
      await registry.setTierConfig(1, 12000, 2500, 60 * 86400, 5000, 300);
      expect((await registry.tierConfig(1)).minDepositBps).to.equal(2500);
    });
  });

  describe("Approved pool and yield venue", function () {
    it("Names the FIRST pool for a pair instantly, but waits to change it", async function () {
      const { registry, weth, usdx } = await loadFixture(registryStack);
      const a = await weth.getAddress(), b = await usdx.getAddress();
      await registry.setPoolFeeTier(a, b, POOL_FEE);
      await expect(registry.setPoolFeeTier(a, b, ALT_FEE)).to.be.revertedWith("Action was not queued");
      await announce(registry, "setPoolFeeTier", [a, b, ALT_FEE]);
      await time.increase(DELAY);
      await registry.setPoolFeeTier(a, b, ALT_FEE);
      expect(await registry.poolFeeTier(b, a)).to.equal(ALT_FEE);
    });

    it("Waits to point an asset at a yield venue, but removes one instantly", async function () {
      const { registry, usdx, stranger } = await loadFixture(registryStack);
      const asset = await usdx.getAddress();
      await expect(registry.setVenue(asset, 2, stranger.address)).to.be.revertedWith("Action was not queued");
      await announce(registry, "setVenue", [asset, 2, stranger.address]);
      await time.increase(DELAY);
      await registry.setVenue(asset, 2, stranger.address);
      await registry.setVenue(asset, 0, ethers.ZeroAddress); // back to None, instantly
    });
  });

  describe("Insurance draw cap", function () {
    it("Waits in both directions", async function () {
      const { pool } = await loadFixture(registryStack);
      await expect(pool.setDrawCapBps(500)).to.be.revertedWith("Action was not queued");
      await expect(pool.setDrawCapBps(2000)).to.be.revertedWith("Action was not queued");
      await announce(pool, "setDrawCapBps", [500]);
      await time.increase(DELAY);
      await pool.setDrawCapBps(500);
      expect(await pool.drawCapBps()).to.equal(500);
    });
  });
});

describe("Krait observation — exposure cap uses the worst tier since origination", function () {

  async function stack() {
    const [operator, lender, borrower] = await ethers.getSigners();
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
    await registry.addAssetWithTier(await usdx.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress, 0, 2); // Speculative: 25% cap
    await registry.setPoolFeeTier(await weth.getAddress(), await usdx.getAddress(), POOL_FEE);
    const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
    const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
    const impl = await (await ethers.getContractFactory("Vault", { signer: operator, libraries: { UniswapTwap: await twapLib.getAddress() } })).deploy();
    const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
      await kyc.getAddress(), await registry.getAddress(), await pool.getAddress(), operator.address, await impl.getAddress(), 0);
    await pool.setVaultFactory(await factory.getAddress());
    return { lender, borrower, weth, usdx, registry, factory };
  }

  async function originate(f, ceiling) {
    const { weth, factory, lender, borrower } = f;
    const P = E("10"), D = E("6");
    await weth.mint(lender.address, P);
    await weth.connect(lender).approve(await factory.getAddress(), P);
    await factory.connect(lender).deployVaultWithTier(
      await weth.getAddress(), borrower.address, P, 1200, 7, false, D, ethers.ZeroAddress, ceiling);
    const vault = await ethers.getContractAt("Vault", await factory.allVaults((await factory.totalVaults()) - 1n));
    const premium = await vault.insurancePremium();
    await weth.mint(borrower.address, D + premium);
    await weth.connect(borrower).approve(await vault.getAddress(), D + premium);
    await vault.connect(borrower).payDeposit();
    return vault;
  }

  it("Re-tagging an asset SAFER does not loosen the cap on a loan already open", async function () {
    const f = await loadFixture(stack);
    const { borrower, usdx, registry } = f;
    const vault = await originate(f, 2);

    await vault.connect(borrower).swap(await usdx.getAddress(), E("2"), 1, POOL_FEE); // 20% of principal
    await registry.setTier(await usdx.getAddress(), 1); // Speculative -> Standard (50% cap)

    await expect(
      vault.connect(borrower).swap(await usdx.getAddress(), E("1"), 1, POOL_FEE) // would be 30%
    ).to.be.revertedWith("Exceeds exposure cap for this asset");
  });

  it("A loan written AFTER the re-tag gets the new, wider cap", async function () {
    const f = await loadFixture(stack);
    const { borrower, usdx, registry } = f;
    await registry.setTier(await usdx.getAddress(), 1);
    await time.increase(10);
    const vault = await originate(f, 1);

    await vault.connect(borrower).swap(await usdx.getAddress(), E("4"), 1, POOL_FEE); // 40%, inside 50%
    expect(await vault.heldAmount(await usdx.getAddress())).to.equal(E("4"));
  });
});
