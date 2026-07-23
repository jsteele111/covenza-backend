const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Group A unit tests — AssetRegistry and InsurancePool in isolation.
 * (Vault/VaultFactory integration is covered separately in Group D.)
 */

describe("Group A — AssetRegistry", function () {

  async function deployRegistryFixture() {
    const [operator, other] = await ethers.getSigners();

    // Placeholder integration addresses — plain EOAs are fine for
    // registry-only tests; nothing here calls into them.
    const addrs = {
      aavePool:       "0x0000000000000000000000000000000000000A01",
      swapRouter:     "0x0000000000000000000000000000000000000A02",
      uniswapFactory: "0x0000000000000000000000000000000000000A03",
      weth:           "0x0000000000000000000000000000000000000A04",
    };

    const Registry = await ethers.getContractFactory("AssetRegistry", operator);
    const registry = await Registry.deploy(
      operator.address, addrs.aavePool, addrs.swapRouter, addrs.uniswapFactory, addrs.weth
    );

    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const usdc = await Mock.deploy("Mock USDC", "USDC", 6);
    const wbtc = await Mock.deploy("Mock WBTC", "WBTC", 8);

    const aTokenUsdc = "0x0000000000000000000000000000000000000B01";

    return { registry, operator, other, usdc, wbtc, aTokenUsdc, addrs };
  }

  it("Should reject deployment with any zero address", async function () {
    const [operator] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("AssetRegistry");
    const good = "0x0000000000000000000000000000000000000A01";
    await expect(
      Registry.deploy(ethers.ZeroAddress, good, good, good, good)
    ).to.be.revertedWith("Invalid operator address");
    await expect(
      Registry.deploy(operator.address, ethers.ZeroAddress, good, good, good)
    ).to.be.revertedWith("Invalid Aave pool address");
  });

  it("Should allow the operator to whitelist an asset with its aToken", async function () {
    const { registry, usdc, aTokenUsdc } = await loadFixture(deployRegistryFixture);

    await expect(registry.addAsset(await usdc.getAddress(), aTokenUsdc))
      .to.emit(registry, "AssetAdded")
      .withArgs(await usdc.getAddress(), aTokenUsdc);

    expect(await registry.isWhitelisted(await usdc.getAddress())).to.equal(true);
    expect(await registry.aTokenOf(await usdc.getAddress())).to.equal(aTokenUsdc);
  });

  it("Should reject whitelist changes from non-operators", async function () {
    const { registry, other, usdc, aTokenUsdc } = await loadFixture(deployRegistryFixture);

    await expect(
      registry.connect(other).addAsset(await usdc.getAddress(), aTokenUsdc)
    ).to.be.revertedWith("Caller is not the operator");
  });

  it("Should reject double-whitelisting", async function () {
    const { registry, usdc, aTokenUsdc } = await loadFixture(deployRegistryFixture);
    await registry.addAsset(await usdc.getAddress(), aTokenUsdc);
    await expect(
      registry.addAsset(await usdc.getAddress(), aTokenUsdc)
    ).to.be.revertedWith("Asset already whitelisted");
  });

  it("Should remove an asset but keep its aToken readable (in-flight vault safety)", async function () {
    const { registry, usdc, aTokenUsdc } = await loadFixture(deployRegistryFixture);
    const usdcAddr = await usdc.getAddress();

    await registry.addAsset(usdcAddr, aTokenUsdc);
    await expect(registry.removeAsset(usdcAddr))
      .to.emit(registry, "AssetRemoved").withArgs(usdcAddr);

    expect(await registry.isWhitelisted(usdcAddr)).to.equal(false);
    // The critical safety property: aToken stays readable after removal.
    expect(await registry.aTokenOf(usdcAddr)).to.equal(aTokenUsdc);
  });

  it("Should return only currently-whitelisted assets from getWhitelistedAssets", async function () {
    const { registry, usdc, wbtc, aTokenUsdc } = await loadFixture(deployRegistryFixture);
    const usdcAddr = await usdc.getAddress();
    const wbtcAddr = await wbtc.getAddress();

    await registry.addAsset(usdcAddr, aTokenUsdc);
    await registry.addAsset(wbtcAddr, ethers.ZeroAddress);
    await registry.removeAsset(usdcAddr);

    const listed = await registry.getWhitelistedAssets();
    expect(listed).to.deep.equal([wbtcAddr]);
    expect(await registry.totalAssets()).to.equal(2); // history retained
  });

  it("Should allow re-whitelisting a previously removed asset without duplicating history", async function () {
    const { registry, usdc, aTokenUsdc } = await loadFixture(deployRegistryFixture);
    const usdcAddr = await usdc.getAddress();

    await registry.addAsset(usdcAddr, aTokenUsdc);
    await registry.removeAsset(usdcAddr);
    await registry.addAsset(usdcAddr, aTokenUsdc);

    expect(await registry.isWhitelisted(usdcAddr)).to.equal(true);
    expect(await registry.totalAssets()).to.equal(1);
  });

  it("Should enforce settlement config bounds and emit on update", async function () {
    const { registry } = await loadFixture(deployRegistryFixture);

    await expect(
      registry.setSettlementConfig(30, 200, 3600, 2, 100)
    ).to.be.revertedWith("TWAP window too short");

    await expect(
      registry.setSettlementConfig(1800, 0, 3600, 2, 100)
    ).to.be.revertedWith("Tolerance must be 1-1000 bps");

    await expect(
      registry.setSettlementConfig(1800, 200, 3600, 2, 5000)
    ).to.be.revertedWith("Bounty cap must be <= 1000 bps");

    await expect(registry.setSettlementConfig(900, 150, 24 * 3600, 3, 150))
      .to.emit(registry, "SettlementConfigUpdated")
      .withArgs(900, 150, 24 * 3600, 3, 150);

    expect(await registry.twapWindow()).to.equal(900);
    expect(await registry.swapBackGracePeriod()).to.equal(24 * 3600);
  });

  it("Should transfer the operator role and reject the old operator afterwards", async function () {
    const { registry, operator, other, usdc, aTokenUsdc } = await loadFixture(deployRegistryFixture);

    await registry.transferOperator(other.address);
    await expect(
      registry.connect(operator).addAsset(await usdc.getAddress(), aTokenUsdc)
    ).to.be.revertedWith("Caller is not the operator");

    await expect(registry.connect(other).addAsset(await usdc.getAddress(), aTokenUsdc))
      .to.emit(registry, "AssetAdded");
  });
});

describe("Group A — InsurancePool", function () {

  const DRAW_CAP_BPS = 1000n; // 10% of principal

  async function deployPoolFixture() {
    const [operator, factorySigner, vaultSigner, other] = await ethers.getSigners();

    const Pool = await ethers.getContractFactory("InsurancePool", operator);
    const pool = await Pool.deploy(operator.address, DRAW_CAP_BPS);

    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const usdc = await Mock.deploy("Mock USDC", "USDC", 6);

    // Wire a signer as the "factory", and register another signer as a
    // "vault" — lets us unit-test draw permissions without real vaults.
    await pool.setVaultFactory(factorySigner.address);
    await pool.connect(factorySigner).registerVault(vaultSigner.address);

    // Fund `other` with USDC and approve the pool, ready to contribute.
    await usdc.mint(other.address, 1_000_000_000n); // 1,000 USDC (6 dp)
    await usdc.connect(other).approve(await pool.getAddress(), 1_000_000_000n);

    return { pool, usdc, operator, factorySigner, vaultSigner, other };
  }

  it("Should reject deployment with out-of-bounds draw cap", async function () {
    const [operator] = await ethers.getSigners();
    const Pool = await ethers.getContractFactory("InsurancePool");
    await expect(Pool.deploy(operator.address, 0)).to.be.revertedWith("Draw cap must be 1-10000 bps");
    await expect(Pool.deploy(operator.address, 10001)).to.be.revertedWith("Draw cap must be 1-10000 bps");
  });

  it("Should accept funding and track the reserve per asset", async function () {
    const { pool, usdc, other } = await loadFixture(deployPoolFixture);
    const usdcAddr = await usdc.getAddress();

    await expect(pool.connect(other).fund(usdcAddr, 500_000_000n))
      .to.emit(pool, "Funded")
      .withArgs(usdcAddr, other.address, 500_000_000n);

    expect(await pool.reserveOf(usdcAddr)).to.equal(500_000_000n);
    expect(await usdc.balanceOf(await pool.getAddress())).to.equal(500_000_000n);
  });

  it("Should not count tokens sent directly (bypassing fund) as reserves", async function () {
    const { pool, usdc, other } = await loadFixture(deployPoolFixture);
    const usdcAddr = await usdc.getAddress();

    await usdc.connect(other).transfer(await pool.getAddress(), 100_000_000n);
    expect(await pool.reserveOf(usdcAddr)).to.equal(0);
  });

  it("Should reject draws from unregistered callers", async function () {
    const { pool, usdc, other } = await loadFixture(deployPoolFixture);
    await expect(
      pool.connect(other).draw(await usdc.getAddress(), 1000n, 10_000n)
    ).to.be.revertedWith("Only registered vaults can draw");
  });

  it("Should pay the full shortfall when within cap and reserves", async function () {
    const { pool, usdc, vaultSigner, other } = await loadFixture(deployPoolFixture);
    const usdcAddr = await usdc.getAddress();
    await pool.connect(other).fund(usdcAddr, 500_000_000n);

    // principal 1,000 USDC -> cap = 10% = 100 USDC. Shortfall 50 USDC: fully paid.
    await expect(pool.connect(vaultSigner).draw(usdcAddr, 50_000_000n, 1_000_000_000n))
      .to.emit(pool, "Drawn")
      .withArgs(usdcAddr, vaultSigner.address, 50_000_000n, 50_000_000n);

    expect(await usdc.balanceOf(vaultSigner.address)).to.equal(50_000_000n);
    expect(await pool.reserveOf(usdcAddr)).to.equal(450_000_000n);
  });

  it("Should cap the draw at drawCapBps of principal", async function () {
    const { pool, usdc, vaultSigner, other } = await loadFixture(deployPoolFixture);
    const usdcAddr = await usdc.getAddress();
    await pool.connect(other).fund(usdcAddr, 500_000_000n);

    // Shortfall 300 USDC but cap = 10% of 1,000 = 100 USDC: pays exactly 100.
    await expect(pool.connect(vaultSigner).draw(usdcAddr, 300_000_000n, 1_000_000_000n))
      .to.emit(pool, "Drawn")
      .withArgs(usdcAddr, vaultSigner.address, 300_000_000n, 100_000_000n);

    expect(await usdc.balanceOf(vaultSigner.address)).to.equal(100_000_000n);
  });

  it("Should cap the draw at the asset's remaining reserve", async function () {
    const { pool, usdc, vaultSigner, other } = await loadFixture(deployPoolFixture);
    const usdcAddr = await usdc.getAddress();
    await pool.connect(other).fund(usdcAddr, 30_000_000n); // only 30 USDC in reserve

    await expect(pool.connect(vaultSigner).draw(usdcAddr, 80_000_000n, 1_000_000_000n))
      .to.emit(pool, "Drawn")
      .withArgs(usdcAddr, vaultSigner.address, 80_000_000n, 30_000_000n);

    expect(await pool.reserveOf(usdcAddr)).to.equal(0);
  });

  it("Should never revert on an empty reserve - pays zero and reports it", async function () {
    const { pool, usdc, vaultSigner } = await loadFixture(deployPoolFixture);
    const usdcAddr = await usdc.getAddress();

    await expect(pool.connect(vaultSigner).draw(usdcAddr, 80_000_000n, 1_000_000_000n))
      .to.emit(pool, "Drawn")
      .withArgs(usdcAddr, vaultSigner.address, 80_000_000n, 0);
  });

  it("Should restrict vault registration to the configured factory", async function () {
    const { pool, other } = await loadFixture(deployPoolFixture);
    await expect(
      pool.connect(other).registerVault(other.address)
    ).to.be.revertedWith("Only factory can register vaults");
  });

  it("Should allow operator-only administrative withdrawal within reserves", async function () {
    const { pool, usdc, operator, other } = await loadFixture(deployPoolFixture);
    const usdcAddr = await usdc.getAddress();
    await pool.connect(other).fund(usdcAddr, 200_000_000n);

    await expect(
      pool.connect(other).adminWithdraw(usdcAddr, other.address, 100_000_000n)
    ).to.be.revertedWith("Caller is not the operator");

    await expect(
      pool.adminWithdraw(usdcAddr, operator.address, 300_000_000n)
    ).to.be.revertedWith("Amount exceeds reserve");

    await expect(pool.adminWithdraw(usdcAddr, operator.address, 150_000_000n))
      .to.emit(pool, "AdminWithdrawal")
      .withArgs(usdcAddr, operator.address, 150_000_000n);

    expect(await pool.reserveOf(usdcAddr)).to.equal(50_000_000n);
  });

  it("Should enforce draw cap configuration bounds", async function () {
    const { pool } = await loadFixture(deployPoolFixture);
    await expect(pool.setDrawCapBps(0)).to.be.revertedWith("Draw cap must be 1-10000 bps");
    await expect(pool.setDrawCapBps(10001)).to.be.revertedWith("Draw cap must be 1-10000 bps");
    await expect(pool.setDrawCapBps(500)).to.emit(pool, "DrawCapUpdated").withArgs(DRAW_CAP_BPS, 500);
  });
});