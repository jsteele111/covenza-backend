const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Audit M-1 — one recipient the token will not pay must not block a
 * settlement for everyone else.
 *
 * Settlement used to push every payout in one transaction: lender, keeper,
 * treasury, referrer, borrower. A regulated stablecoin can blacklist an
 * address, and if ANY recipient was blacklisted every settle() reverted, for
 * ever. A borrower blacklisted after a sanctions listing locked the lender's
 * principal in the vault permanently.
 *
 * Now every payout goes through Vault._pay: it pays, or, if the token refuses,
 * records the amount in owed(token, recipient) for that recipient to claim()
 * later. Everyone else is paid as normal.
 *
 * The loan asset here is MockBlacklistToken (6 decimals, USDC-style).
 */
const U = (n) => ethers.parseUnits(n, 6);
const FEE = 3000;
const P = U("10000");
const D = U("2000");

async function stack() {
  const [operator, lender, borrower, keeper, treasury, referrer] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockBlacklistToken", operator)).deploy();
  const tok = await (await ethers.getContractFactory("MockERC20", operator)).deploy("Mock TOK", "TOK", 18);

  const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
  const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();
  const uniPool = await (await ethers.getContractFactory("MockUniswapV3Pool", operator)).deploy();
  await uniFactory.setPool(await usdc.getAddress(), await tok.getAddress(), FEE, await uniPool.getAddress());
  await uniPool.setAvgTick(0);
  await router.setRate(await usdc.getAddress(), await tok.getAddress(), 1, 1);
  await router.setRate(await tok.getAddress(), await usdc.getAddress(), 1, 1);
  await usdc.mint(await router.getAddress(), U("1000000"));
  await tok.mint(await router.getAddress(), U("1000000"));

  const id = await (await ethers.getContractFactory("MockIdentityAdapter", operator)).deploy();
  await id.set(lender.address, 7);
  await id.set(borrower.address, 7);

  const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
    operator.address, await router.getAddress(), await uniFactory.getAddress(), 0);
  await registry.addAssetWithTier(await usdc.getAddress(), 0, 0);
  await registry.addAssetWithTier(await tok.getAddress(), 0, 0);
  await registry.setPoolFeeTier(await usdc.getAddress(), await tok.getAddress(), FEE);
  await registry.setOutageConfig(0, 0, 0);
  await registry.setTierConfig(0, 0, 0, 365 * 86400, 10000, 100);

  const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
  const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
  const impl = await (await ethers.getContractFactory("Vault", { signer: operator, libraries: { UniswapTwap: await twapLib.getAddress() } })).deploy();
  const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
    await id.getAddress(), await registry.getAddress(), await pool.getAddress(), treasury.address, await impl.getAddress(), 0);
  await pool.setVaultFactory(await factory.getAddress());
  await factory.setReferrerApproved(referrer.address, true);

  // A 7-day loan at 12% APR with a referrer, so every payout leg is non-zero.
  await usdc.mint(lender.address, P);
  await usdc.connect(lender).approve(await factory.getAddress(), P);
  await factory.connect(lender).deployVaultWithTier(
    await usdc.getAddress(), borrower.address, P, 1200, 7, false, D, referrer.address, 0);
  const vault = await ethers.getContractAt("Vault", await factory.allVaults(0));
  const premium = await vault.insurancePremium();
  await usdc.mint(borrower.address, D + premium);
  await usdc.connect(borrower).approve(await vault.getAddress(), D + premium);
  await vault.connect(borrower).payDeposit();

  return { operator, lender, borrower, keeper, treasury, referrer, usdc, tok, vault, factory };
}

describe("Audit M-1 — a payout the token refuses is deferred, not fatal", function () {

  it("A blacklisted borrower no longer locks the lender out: lender paid, borrower's share held", async function () {
    const { lender, borrower, usdc, vault } = await loadFixture(stack);
    await time.increase(7 * 86400 + 1);
    await usdc.setBlacklisted(borrower.address, true);   // e.g. a sanctions listing

    const before = await usdc.balanceOf(lender.address);
    await expect(vault.connect(lender).settle()).to.emit(vault, "PaymentDeferred");
    expect(await usdc.balanceOf(lender.address) - before).to.equal(P + (await vault.settledFee()));
    expect(await vault.owed(await usdc.getAddress(), borrower.address)).to.equal(await vault.settledBorrowerPayout());
    // Held in the vault, for the borrower alone.
    expect(await usdc.balanceOf(await vault.getAddress())).to.equal(await vault.settledBorrowerPayout());
  });

  it("The held share is claimable only by its owner, and only once the token allows it", async function () {
    const { lender, borrower, keeper, usdc, vault } = await loadFixture(stack);
    await time.increase(7 * 86400 + 1);
    await usdc.setBlacklisted(borrower.address, true);
    await vault.connect(lender).settle();
    const share = await vault.owed(await usdc.getAddress(), borrower.address);
    expect(share).to.be.greaterThan(0n);

    await expect(vault.connect(borrower).claim(await usdc.getAddress())).to.be.revertedWith("Token transfer failed");
    await expect(vault.connect(keeper).claim(await usdc.getAddress())).to.be.revertedWith("Nothing owed");

    await usdc.setBlacklisted(borrower.address, false);
    await expect(vault.connect(borrower).claim(await usdc.getAddress()))
      .to.emit(vault, "Claimed").withArgs(await usdc.getAddress(), borrower.address, share);
    expect(await usdc.balanceOf(borrower.address)).to.equal(share);
    await expect(vault.connect(borrower).claim(await usdc.getAddress())).to.be.revertedWith("Nothing owed");
  });

  it("A blacklisted lender does not hold the borrower's surplus hostage", async function () {
    const { lender, borrower, usdc, vault } = await loadFixture(stack);
    await time.increase(7 * 86400 + 1);
    await usdc.setBlacklisted(lender.address, true);

    const before = await usdc.balanceOf(borrower.address);
    await vault.connect(borrower).settle();
    expect(await usdc.balanceOf(borrower.address) - before).to.equal(await vault.settledBorrowerPayout());
    expect(await vault.owed(await usdc.getAddress(), lender.address)).to.equal(P + (await vault.settledFee()));
  });

  it("A blacklisted treasury or referrer blocks nobody", async function () {
    const { lender, borrower, treasury, referrer, usdc, vault } = await loadFixture(stack);
    await time.increase(7 * 86400 + 1);
    await usdc.setBlacklisted(treasury.address, true);
    await usdc.setBlacklisted(referrer.address, true);

    await vault.connect(lender).settle();
    expect(await vault.owed(await usdc.getAddress(), treasury.address)).to.equal(await vault.settledProtocolFee());
    expect(await vault.owed(await usdc.getAddress(), referrer.address)).to.equal(await vault.settledReferrerFee());
    expect(await usdc.balanceOf(borrower.address)).to.equal(await vault.settledBorrowerPayout());
  });

  it("A cancelled vault defers a blacklisted lender's principal the same way", async function () {
    const { lender, borrower, usdc, factory } = await loadFixture(stack);
    await usdc.mint(lender.address, P);
    await usdc.connect(lender).approve(await factory.getAddress(), P);
    await factory.connect(lender).deployVaultWithTier(await usdc.getAddress(), borrower.address, P, 1200, 1, false, D, ethers.ZeroAddress, 0);
    const unfunded = await ethers.getContractAt("Vault", await factory.allVaults(1));
    await time.increase(86400 + 1);
    await usdc.setBlacklisted(lender.address, true);

    await unfunded.cancel();
    expect(await unfunded.owed(await usdc.getAddress(), lender.address)).to.equal(P);
  });

  it("A token that rejects zero-value transfers does not block settlement (audit L-5)", async function () {
    // No referrer and no keeper bounty: two payout legs are zero. Each one
    // used to be sent anyway, and a token that reverts on a zero transfer
    // reverted the whole settlement. The same applies to the lender's leg in
    // a total loss.
    const { lender, borrower, usdc, factory } = await loadFixture(stack);
    await usdc.mint(lender.address, P);
    await usdc.connect(lender).approve(await factory.getAddress(), P);
    await factory.connect(lender).deployVaultWithTier(
      await usdc.getAddress(), borrower.address, P, 1200, 7, false, D, ethers.ZeroAddress, 0);
    const vault = await ethers.getContractAt("Vault", await factory.allVaults(1));
    const premium = await vault.insurancePremium();
    await usdc.mint(borrower.address, D + premium);
    await usdc.connect(borrower).approve(await vault.getAddress(), D + premium);
    await vault.connect(borrower).payDeposit();
    await time.increase(7 * 86400 + 1);

    await usdc.setRejectZero(true);
    await expect(vault.connect(lender).settle()).to.not.emit(vault, "PaymentDeferred");
    expect(await vault.settledReferrerFee()).to.equal(0n);
    expect(await usdc.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("Nothing changes when every recipient can be paid", async function () {
    const { lender, borrower, treasury, referrer, usdc, vault } = await loadFixture(stack);
    await time.increase(7 * 86400 + 1);
    await expect(vault.connect(lender).settle()).to.not.emit(vault, "PaymentDeferred");
    for (const a of [lender, borrower, treasury, referrer]) {
      expect(await vault.owed(await usdc.getAddress(), a.address)).to.equal(0n);
    }
    expect(await usdc.balanceOf(await vault.getAddress())).to.equal(0n);
  });
});
