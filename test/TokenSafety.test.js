const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * MAINNET-READINESS item 15.
 *  Part A: token calls accept tokens that return nothing (USDT-style), while
 *          still failing on tokens that return false.
 *  Part B: a queued timelock action lapses 14 days after it matures.
 */
const E = ethers.parseEther;

describe("Item 15 — token safety and timelock expiry", function () {

  // A full loan whose LOAN ASSET returns no data from transfer/approve.
  async function noReturnStack() {
    const [operator, lender, borrower, treasury] = await ethers.getSigners();
    const nr = await (await ethers.getContractFactory("MockNoReturnToken", operator)).deploy();

    const aave = await (await ethers.getContractFactory("MockAavePool", operator)).deploy();
    const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();
    const kyc = await (await ethers.getContractFactory("KYCRegistry", operator)).deploy(operator.address, operator.address, 0);
    await kyc.verify(borrower.address);

    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await aave.getAddress(), await router.getAddress(), await uniFactory.getAddress(), await nr.getAddress());
    await registry.addAssetWithTier(await nr.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress, 0, 0);

    const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
    const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
    const impl = await (await ethers.getContractFactory("Vault", { signer: operator, libraries: { UniswapTwap: await twapLib.getAddress() } })).deploy();
    const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
      await kyc.getAddress(), await registry.getAddress(), await pool.getAddress(), treasury.address, await impl.getAddress(), 0);
    await pool.setVaultFactory(await factory.getAddress());

    return { operator, lender, borrower, treasury, nr, pool, factory };
  }

  describe("Part A — tokens that return nothing", function () {

    it("Runs a whole loan in a USDT-style token: fund, deposit, premium, settle, payouts", async function () {
      const { lender, borrower, nr, pool, factory } = await loadFixture(noReturnStack);
      const P = E("10"), D = E("1.5");

      await nr.mint(lender.address, P);
      await nr.connect(lender).approve(await factory.getAddress(), P);
      await factory.connect(lender).deployVaultWithTier(
        await nr.getAddress(), borrower.address, P, 1200, 7, false, D, ethers.ZeroAddress, 0);
      const vault = await ethers.getContractAt("Vault", await factory.allVaults(0));

      const premium = await vault.insurancePremium();
      await nr.mint(borrower.address, D + premium);
      await nr.connect(borrower).approve(await vault.getAddress(), D + premium);
      await vault.connect(borrower).payDeposit();
      expect(await pool.reserveOf(await nr.getAddress())).to.equal(premium);

      await time.increase(7 * 86400 + 1);
      await vault.connect(lender).settle();

      const lenderGot = await vault.settledLenderPayout();
      expect(lenderGot).to.equal(P + (await vault.settledFee()));
      expect(await nr.balanceOf(lender.address)).to.equal(lenderGot);
      expect(await nr.balanceOf(await vault.getAddress())).to.equal(0);
    });

    it("Funds and withdraws the insurance pool in a USDT-style token", async function () {
      const { operator, nr, pool } = await loadFixture(noReturnStack);
      await nr.mint(operator.address, E("5"));
      await nr.approve(await pool.getAddress(), E("5"));
      await pool.fund(await nr.getAddress(), E("5"));

      await pool.queueAdminWithdraw(await nr.getAddress(), operator.address, E("2"));
      await pool.adminWithdraw(await nr.getAddress(), operator.address, E("2"));
      expect(await nr.balanceOf(operator.address)).to.equal(E("2"));
    });

    it("Still FAILS when a token returns false, rather than treating it as paid", async function () {
      const [operator] = await ethers.getSigners();
      const bad = await (await ethers.getContractFactory("MockFalseToken", operator)).deploy();
      const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
      await bad.mint(operator.address, E("5"));
      await bad.approve(await pool.getAddress(), E("5"));
      await pool.fund(await bad.getAddress(), E("5"));

      await bad.setFailTransfers(true);
      await pool.queueAdminWithdraw(await bad.getAddress(), operator.address, E("1"));
      await expect(
        pool.adminWithdraw(await bad.getAddress(), operator.address, E("1"))
      ).to.be.revertedWith("Token transfer failed");
      expect(await pool.reserveOf(await bad.getAddress())).to.equal(E("5"));
    });

    it("Refuses a 'token' with no code, which would otherwise look like a silent success", async function () {
      const [operator, , , , nobody] = await ethers.getSigners();
      const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
      await expect(
        pool.fund(nobody.address, E("1"))
      ).to.be.revertedWith("Token transfer failed");
    });
  });

  describe("Part B — queued admin actions expire", function () {
    const DELAY = 48 * 3600;
    const WINDOW = 14 * 86400;

    async function poolStack() {
      const [operator] = await ethers.getSigners();
      const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, DELAY);
      const weth = await (await ethers.getContractFactory("MockERC20", operator)).deploy("WETH", "WETH", 18);
      await weth.mint(operator.address, E("100"));
      await weth.approve(await pool.getAddress(), E("100"));
      await pool.fund(await weth.getAddress(), E("100"));
      return { operator, pool, weth };
    }

    it("Executes within the window", async function () {
      const { operator, pool, weth } = await loadFixture(poolStack);
      await pool.queueAdminWithdraw(await weth.getAddress(), operator.address, E("50"));
      await time.increase(DELAY + WINDOW - 60);
      await pool.adminWithdraw(await weth.getAddress(), operator.address, E("50"));
      expect(await pool.reserveOf(await weth.getAddress())).to.equal(E("50"));
    });

    it("Refuses an approval that has lapsed", async function () {
      const { operator, pool, weth } = await loadFixture(poolStack);
      await pool.queueAdminWithdraw(await weth.getAddress(), operator.address, E("50"));
      await time.increase(DELAY + WINDOW + 1);
      await expect(
        pool.adminWithdraw(await weth.getAddress(), operator.address, E("50"))
      ).to.be.revertedWith("Timelock approval expired");
      expect(await pool.reserveOf(await weth.getAddress())).to.equal(E("100"));
    });

    it("Lets a lapsed action be queued again, and makes it wait the full delay again", async function () {
      const { operator, pool, weth } = await loadFixture(poolStack);
      const args = [await weth.getAddress(), operator.address, E("50")];
      await pool.queueAdminWithdraw(...args);
      await time.increase(DELAY + WINDOW + 1);

      await pool.queueAdminWithdraw(...args);
      await expect(pool.adminWithdraw(...args)).to.be.revertedWith("Timelock has not elapsed");
      await time.increase(DELAY);
      await pool.adminWithdraw(...args);
    });

    it("Refuses to re-queue an action that is still live", async function () {
      const { operator, pool, weth } = await loadFixture(poolStack);
      const args = [await weth.getAddress(), operator.address, E("50")];
      await pool.queueAdminWithdraw(...args);
      await time.increase(DELAY + 60);
      await expect(pool.queueAdminWithdraw(...args)).to.be.revertedWith("Already queued");
    });

    it("Publishes the deadline, and stops reporting a lapsed action as executable", async function () {
      const { operator, pool, weth } = await loadFixture(poolStack);
      await pool.queueAdminWithdraw(await weth.getAddress(), operator.address, E("50"));
      const queued = BigInt(await time.latest());
      const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "address", "address", "uint256"],
        ["adminWithdraw", await weth.getAddress(), operator.address, E("50")]));
      expect(await pool.executionDeadline(id)).to.equal(queued + BigInt(DELAY + WINDOW));
      await time.increase(DELAY + 60);
      expect(await pool.isExecutable(id)).to.equal(true);
      await time.increase(WINDOW);
      expect(await pool.isExecutable(id)).to.equal(false);
    });
  });
});
