const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Regression tests for the findings Krait (Zealynx Security) raised on
 * 1 October 2026, adapted from its executed proofs of concept. Each attack
 * that previously succeeded must now fail, and the legitimate path beside it
 * must keep working. See MAINNET-READINESS items 18 and 19.
 *
 * Production tier defaults from the AssetRegistry constructor are left in
 * place (BlueChip: 10% floor, 100% exposure, 100bps premium).
 */
const E = ethers.parseEther;
const POOL_FEE = 3000;

// Uniswap tick sign follows token ADDRESS order, so derive it from the
// deployed addresses rather than hardcoding (same helper as GroupB).
function tickFor(baseAddr, quoteAddr, magnitude) {
  return BigInt(baseAddr.toLowerCase()) < BigInt(quoteAddr.toLowerCase())
    ? magnitude
    : -magnitude;
}

async function stack() {
  const [operator, lender, borrower, attacker] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20", operator);
  const weth = await Mock.deploy("Mock WETH", "WETH", 18);
  const usdx = await Mock.deploy("Mock USDX", "USDX", 18);

  const aave = await (await ethers.getContractFactory("MockAavePool", operator)).deploy();
  const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
  const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();
  const uniPool = await (await ethers.getContractFactory("MockUniswapV3Pool", operator)).deploy();
  await uniFactory.setPool(await weth.getAddress(), await usdx.getAddress(), POOL_FEE, await uniPool.getAddress());
  await uniPool.setAvgTick(0);                                   // TWAP 1:1
  await router.setRate(await weth.getAddress(), await usdx.getAddress(), 1, 1);
  await router.setRate(await usdx.getAddress(), await weth.getAddress(), 1, 1);
  await weth.mint(await router.getAddress(), E("1000"));
  await usdx.mint(await router.getAddress(), E("1000"));

  const kyc = await (await ethers.getContractFactory("KYCRegistry", operator)).deploy(operator.address, operator.address, 0);
  await kyc.verify(borrower.address);
  await kyc.verify(attacker.address);

  const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
    operator.address, await aave.getAddress(), await router.getAddress(), await uniFactory.getAddress(), await weth.getAddress());
  await registry.addAssetWithTier(await weth.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress, 0, 0);
  await registry.addAssetWithTier(await usdx.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress, 0, 0);

  const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
  const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
  const impl = await (await ethers.getContractFactory("Vault", { signer: operator, libraries: { UniswapTwap: await twapLib.getAddress() } })).deploy();
  const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
    await kyc.getAddress(), await registry.getAddress(), await pool.getAddress(), operator.address, await impl.getAddress(), 0);
  await pool.setVaultFactory(await factory.getAddress());

  // Insurance reserve funded by other borrowers' premiums: 100 WETH.
  await weth.mint(operator.address, E("100"));
  await weth.approve(await pool.getAddress(), E("100"));
  await pool.fund(await weth.getAddress(), E("100"));

  return { operator, lender, borrower, attacker, weth, usdx, router, registry, pool, factory, uniPool };
}


async function originate(f, P, D, aprBps, term, useSeconds, lenderSigner, borrowerSigner) {
  const { weth, factory } = f;
  await weth.mint(lenderSigner.address, P);
  await weth.connect(lenderSigner).approve(await factory.getAddress(), P);
  await factory.connect(lenderSigner).deployVaultWithTier(
    await weth.getAddress(), borrowerSigner.address, P, aprBps, term, useSeconds, D, ethers.ZeroAddress, 0);
  const vault = await ethers.getContractAt("Vault", await factory.allVaults((await factory.totalVaults()) - 1n));
  const premium = await vault.insurancePremium();
  await weth.mint(borrowerSigner.address, D + premium);
  await weth.connect(borrowerSigner).approve(await vault.getAddress(), D + premium);
  await vault.connect(borrowerSigner).payDeposit();
  return vault;
}

describe("Krait findings — regression (KRAIT-001, KRAIT-002)", function () {

  describe("KRAIT-001: swapBack is held to the TWAP floor", function () {

    it("Refuses a swap-back into a manipulated price, even with a token minimum of 1", async function () {
      const f = await loadFixture(stack);
      const { lender, borrower, usdx, router, weth } = f;
      const vault = await originate(f, E("10"), E("1.5"), 1200, 7, false, lender, borrower);

      await vault.connect(borrower).swap(await usdx.getAddress(), E("8"), 1, POOL_FEE);
      await router.setRate(await usdx.getAddress(), await weth.getAddress(), 1, 100); // spot 1:100, TWAP 1:1

      await expect(
        vault.connect(borrower).swapBack(await usdx.getAddress(), E("8"), 1)
      ).to.be.revertedWith("Too little received");

      // Nothing left the vault: the 8 USDX position is intact.
      expect(await usdx.balanceOf(await vault.getAddress())).to.equal(E("8"));
    });

    it("Closes the drain end to end: the lender is repaid in full at settlement", async function () {
      const f = await loadFixture(stack);
      const { lender, borrower, usdx, router, weth } = f;
      const vault = await originate(f, E("10"), E("1.5"), 1200, 7, false, lender, borrower);

      await vault.connect(borrower).swap(await usdx.getAddress(), E("8"), 1, POOL_FEE);
      await router.setRate(await usdx.getAddress(), await weth.getAddress(), 1, 100);
      await expect(vault.connect(borrower).swapBack(await usdx.getAddress(), E("8"), 1)).to.be.reverted;

      // Price returns to fair; settlement force-sells at TWAP and pays the lender.
      await router.setRate(await usdx.getAddress(), await weth.getAddress(), 1, 1);
      await time.increase(7 * 86400 + 1);
      await vault.connect(lender).settle();

      const target = E("10") + (await vault.settledFee());
      expect(await vault.settledLenderPayout()).to.equal(target);
      expect(await vault.settledInsuranceDraw()).to.equal(0);
    });

    it("Still permits a swap-back at a fair price", async function () {
      const f = await loadFixture(stack);
      const { lender, borrower, usdx, weth } = f;
      const vault = await originate(f, E("10"), E("1.5"), 1200, 7, false, lender, borrower);

      await vault.connect(borrower).swap(await usdx.getAddress(), E("8"), 1, POOL_FEE);
      await vault.connect(borrower).swapBack(await usdx.getAddress(), E("8"), 1);

      expect(await weth.balanceOf(await vault.getAddress())).to.equal(E("11.5"));
      expect(await vault.heldAssetCount()).to.equal(0);
    });

    it("Lets the borrower demand MORE than the floor, never less", async function () {
      const f = await loadFixture(stack);
      const { lender, borrower, usdx } = f;
      const vault = await originate(f, E("10"), E("1.5"), 1200, 7, false, lender, borrower);

      await vault.connect(borrower).swap(await usdx.getAddress(), E("8"), 1, POOL_FEE);
      // At 1:1 the swap returns exactly 8; asking for 8.01 must fail on the borrower's own minimum.
      await expect(
        vault.connect(borrower).swapBack(await usdx.getAddress(), E("8"), E("8.01"))
      ).to.be.revertedWith("Too little received");
    });
  });

  describe("KRAIT-002: the insurance pool covers principal only", function () {

    it("Self-dealing at an absurd APR draws nothing from the pool", async function () {
      const f = await loadFixture(stack);
      const { attacker, weth, pool } = f;
      const reserve0 = await pool.reserveOf(await weth.getAddress());
      const start = await weth.balanceOf(attacker.address);

      for (let i = 0; i < 3; i++) {
        const vault = await originate(f, E("10"), E("1"), 2_000_000_000n, 60, true, attacker, attacker);
        await time.increase(61);
        await vault.connect(attacker).settle();
        expect(await vault.settledInsuranceDraw()).to.equal(0);
      }

      // The reserve only GROWS (by the premiums the attacker paid in).
      expect(await pool.reserveOf(await weth.getAddress())).to.be.gte(reserve0);
      // The attacker ends with no more than they started with (minted funds aside).
      const minted = 3n * (E("10") + E("1"));
      expect((await weth.balanceOf(attacker.address)) - start).to.be.lte(minted);
    });

    it("A genuine loss of principal is still covered, up to the cap", async function () {
      const f = await loadFixture(stack);
      const { lender, borrower, usdx, router, weth, pool } = f;
      const vault = await originate(f, E("10"), E("1.5"), 1200, 7, false, lender, borrower);

      // Borrower takes the whole principal into USDX; the market then falls 20%
      // in spot and TWAP together, so the forced swap-back is honest.
      await vault.connect(borrower).swap(await usdx.getAddress(), E("10"), 1, POOL_FEE);
      await router.setRate(await usdx.getAddress(), await weth.getAddress(), 8, 10);
      await f.uniPool.setAvgTick(tickFor(await usdx.getAddress(), await weth.getAddress(), -2232));

      await time.increase(7 * 86400 + 61);
      await vault.connect(lender).settle();

      // Returned 8 + 1.5 = 9.5; principal shortfall 0.5; cap 1.0 -> pool pays 0.5.
      expect(await vault.settledInsuranceDraw()).to.equal(E("0.5"));
      expect(await vault.settledLenderPayout()).to.equal(E("10"));
    });
  });
});
