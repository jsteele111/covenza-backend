const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Admin powers that can move money must be announced before they are used.
 *
 * Found in the 1 October 2026 pre-audit review: InsurancePool.setVaultFactory
 * was instant. The factory decides who may register as a vault, and a
 * registered vault may draw against any principal it names, so repointing the
 * factory drained the pool in two transactions and made the adminWithdraw
 * timelock decorative. These tests pin the side door shut.
 */
describe("Admin timelocks — InsurancePool factory", function () {

  const DRAW_CAP_BPS = 1000n;       // 10% of principal
  const DELAY        = 48n * 3600n; // 48h, as in production

  async function deployFixture() {
    const [operator, factory, attacker, vault, other] = await ethers.getSigners();

    const Pool = await ethers.getContractFactory("InsurancePool", operator);
    const pool = await Pool.deploy(operator.address, DRAW_CAP_BPS, DELAY);

    const Mock = await ethers.getContractFactory("MockERC20", operator);
    const usdc = await Mock.deploy("Mock USDC", "USDC", 6);

    // A funded reserve worth stealing.
    await usdc.mint(other.address, 1_000_000_000n);
    await usdc.connect(other).approve(await pool.getAddress(), 1_000_000_000n);
    await pool.connect(other).fund(await usdc.getAddress(), 1_000_000_000n);

    return { pool, usdc, operator, factory, attacker, vault, other };
  }

  it("Wires the FIRST factory instantly, so deployment still works", async function () {
    const { pool, factory } = await loadFixture(deployFixture);

    await expect(pool.setVaultFactory(factory.address))
      .to.emit(pool, "VaultFactoryUpdated")
      .withArgs(ethers.ZeroAddress, factory.address);
    expect(await pool.vaultFactory()).to.equal(factory.address);
  });

  it("Refuses to repoint an already-wired factory without an announcement", async function () {
    const { pool, factory, attacker } = await loadFixture(deployFixture);
    await pool.setVaultFactory(factory.address);

    await expect(pool.setVaultFactory(attacker.address))
      .to.be.revertedWith("Action was not queued");
    expect(await pool.vaultFactory()).to.equal(factory.address);
  });

  it("Closes the drain: a repointed factory cannot register a fake vault in the same block", async function () {
    const { pool, usdc, factory, attacker } = await loadFixture(deployFixture);
    await pool.setVaultFactory(factory.address);

    // The attack as it was: repoint, register self, draw against a huge principal.
    await expect(pool.setVaultFactory(attacker.address)).to.be.reverted;
    await expect(pool.connect(attacker).registerVault(attacker.address))
      .to.be.revertedWith("Only factory can register vaults");
    await expect(
      pool.connect(attacker).draw(await usdc.getAddress(), 1_000_000_000n, 10n ** 18n)
    ).to.be.revertedWith("Only registered vaults can draw");

    expect(await pool.reserveOf(await usdc.getAddress())).to.equal(1_000_000_000n);
  });

  it("Refuses execution before the delay has elapsed", async function () {
    const { pool, factory, attacker } = await loadFixture(deployFixture);
    await pool.setVaultFactory(factory.address);

    await pool.queueSetVaultFactory(attacker.address);
    await time.increase(DELAY - 10n);

    await expect(pool.setVaultFactory(attacker.address))
      .to.be.revertedWith("Timelock has not elapsed");
  });

  it("Executes a legitimate migration after the delay", async function () {
    const { pool, factory, other } = await loadFixture(deployFixture);
    await pool.setVaultFactory(factory.address);

    await pool.queueSetVaultFactory(other.address);
    await time.increase(DELAY);

    await expect(pool.setVaultFactory(other.address))
      .to.emit(pool, "VaultFactoryUpdated")
      .withArgs(factory.address, other.address);
    expect(await pool.vaultFactory()).to.equal(other.address);
  });

  it("Binds the queue to the address: approving one factory does not authorise another", async function () {
    const { pool, factory, attacker, other } = await loadFixture(deployFixture);
    await pool.setVaultFactory(factory.address);

    await pool.queueSetVaultFactory(other.address);
    await time.increase(DELAY);

    await expect(pool.setVaultFactory(attacker.address))
      .to.be.revertedWith("Action was not queued");
  });

  it("Consumes the announcement, so it cannot be replayed", async function () {
    const { pool, factory, other } = await loadFixture(deployFixture);
    await pool.setVaultFactory(factory.address);

    await pool.queueSetVaultFactory(other.address);
    await time.increase(DELAY);
    await pool.setVaultFactory(other.address);

    // Point back at the original factory — that too must be announced.
    await pool.queueSetVaultFactory(factory.address);
    await time.increase(DELAY);
    await pool.setVaultFactory(factory.address);

    await expect(pool.setVaultFactory(other.address))
      .to.be.revertedWith("Action was not queued");
  });

  it("Lets the operator cancel a queued change instantly", async function () {
    const { pool, factory, other } = await loadFixture(deployFixture);
    await pool.setVaultFactory(factory.address);

    await pool.queueSetVaultFactory(other.address);
    await pool.cancelSetVaultFactory(other.address);
    await time.increase(DELAY);

    await expect(pool.setVaultFactory(other.address))
      .to.be.revertedWith("Action was not queued");
  });

  it("Refuses to queue before the first factory is wired", async function () {
    const { pool, factory } = await loadFixture(deployFixture);
    await expect(pool.queueSetVaultFactory(factory.address))
      .to.be.revertedWith("First factory is set directly");
  });

  it("Restricts queueing and cancelling to the operator", async function () {
    const { pool, factory, attacker } = await loadFixture(deployFixture);
    await pool.setVaultFactory(factory.address);

    await expect(pool.connect(attacker).queueSetVaultFactory(attacker.address))
      .to.be.revertedWith("Caller is not the operator");
    await pool.queueSetVaultFactory(attacker.address);
    await expect(pool.connect(attacker).cancelSetVaultFactory(attacker.address))
      .to.be.revertedWith("Caller is not the operator");
  });

  it("Keeps vaults registered by the old factory able to draw after a migration", async function () {
    const { pool, usdc, factory, vault, other } = await loadFixture(deployFixture);
    await pool.setVaultFactory(factory.address);
    await pool.connect(factory).registerVault(vault.address);

    await pool.queueSetVaultFactory(other.address);
    await time.increase(DELAY);
    await pool.setVaultFactory(other.address);

    // 10% cap on a 1,000-unit principal = 100.
    await expect(pool.connect(vault).draw(await usdc.getAddress(), 500n, 1_000n))
      .to.emit(pool, "Drawn")
      .withArgs(await usdc.getAddress(), vault.address, 500n, 100n);
  });
});

/**
 * Found in the same review: AssetRegistry.setIntegrationAddresses was instant,
 * and vaults read the swap router and Uniswap factory live at every swap and
 * at settlement. A repointed router could take a vault's held assets; a
 * repointed factory could serve a TWAP from a pool of the operator's choosing.
 * The fix removes the setter entirely and makes the addresses immutable.
 */
describe("Admin timelocks — AssetRegistry integration addresses", function () {

  // Normalised to checksum form, since that is how ethers returns addresses
  // read from a contract.
  const addrs = {
    aavePool:       ethers.getAddress("0x0000000000000000000000000000000000000a01"),
    swapRouter:     ethers.getAddress("0x0000000000000000000000000000000000000a02"),
    uniswapFactory: ethers.getAddress("0x0000000000000000000000000000000000000a03"),
    weth:           ethers.getAddress("0x0000000000000000000000000000000000000a04"),
  };

  async function deployFixture() {
    const [operator, attacker] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("AssetRegistry", operator);
    const registry = await Registry.deploy(
      operator.address, addrs.aavePool, addrs.swapRouter, addrs.uniswapFactory, addrs.weth
    );
    return { registry, operator, attacker };
  }

  it("Records the integration addresses given at deployment", async function () {
    const { registry } = await loadFixture(deployFixture);
    expect(await registry.aavePool()).to.equal(addrs.aavePool);
    expect(await registry.swapRouter()).to.equal(addrs.swapRouter);
    expect(await registry.uniswapFactory()).to.equal(addrs.uniswapFactory);
    expect(await registry.weth()).to.equal(addrs.weth);
  });

  it("Exposes no function that can change them", async function () {
    const { registry } = await loadFixture(deployFixture);
    expect(registry.interface.getFunction("setIntegrationAddresses")).to.equal(null);
  });

  it("Rejects a raw call to the removed setter, even from the operator", async function () {
    const { registry, operator } = await loadFixture(deployFixture);

    // Encode the old signature by hand: the ABI no longer has it, so this is
    // what an operator script written against the old contract would send.
    const old = new ethers.Interface([
      "function setIntegrationAddresses(address,address,address,address)",
    ]);
    const data = old.encodeFunctionData("setIntegrationAddresses", [
      operator.address, operator.address, operator.address, operator.address,
    ]);

    await expect(
      operator.sendTransaction({ to: await registry.getAddress(), data })
    ).to.be.reverted;
    expect(await registry.swapRouter()).to.equal(addrs.swapRouter);
    expect(await registry.uniswapFactory()).to.equal(addrs.uniswapFactory);
  });
});
