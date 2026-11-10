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
  await registry.setMinPoolLiquidity(await usdc.getAddress(), await tok.getAddress(), 1n);   // audit M-01
  await registry.setPoolFeeTier(await usdc.getAddress(), await tok.getAddress(), FEE);
  await registry.setOutageConfig(0, 0, 0);
  await registry.setTierConfig(0, 0, 0, 365 * 86400, 10000, 100);

  const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
  const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
  const impl = await (await ethers.getContractFactory("Vault", { signer: operator, libraries: { UniswapTwap: await twapLib.getAddress() } })).deploy();
  const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
    await id.getAddress(), await registry.getAddress(), await pool.getAddress(), treasury.address, await impl.getAddress(), 0);
  await pool.queueSetVaultFactory(await factory.getAddress());   // audit M-05: the first wiring is announced too
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

  return { operator, lender, borrower, keeper, treasury, referrer, usdc, tok, vault, factory, router, uniPool, pool };
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

  // --- Q8 (Covenza's answer to Zealynx's kickoff question 8) ---
  //
  // If the token refused the insurance pool's transfer to the vault (paused,
  // or the pool blocked by its issuer), the draw reverted and the whole
  // settlement with it: nobody was paid. The pool now holds that insurance
  // for the lender, outside the reserve, and the vault settles with its cash.
  describe("Q8 — a refused insurance transfer is held for the lender, not fatal", function () {
    const RESERVE = U("100000");

    /** The loan buys 9,000 of TOK, which then halves: 7,500 left against 10,000 of principal. */
    async function lossStack() {
      const env = await loadFixture(stack);
      const { operator, borrower, usdc, tok, vault, router, uniPool, pool } = env;
      await usdc.mint(operator.address, RESERVE);
      await usdc.approve(await pool.getAddress(), RESERVE);
      await pool.fund(await usdc.getAddress(), RESERVE);
      await vault.connect(borrower).swap(await tok.getAddress(), U("9000"), 1, FEE);

      await router.setRate(await tok.getAddress(), await usdc.getAddress(), 1, 2);
      const half = BigInt((await tok.getAddress()).toLowerCase()) < BigInt((await usdc.getAddress()).toLowerCase()) ? -6932n : 6932n;
      await uniPool.setAvgTick(half);
      await time.increaseTo((await vault.deadline()) + 1n);
      const reserve = await pool.reserveOf(await usdc.getAddress());
      return { ...env, reserve };
    }

    it("Control: when the transfer works, the draw is paid at settlement as before", async function () {
      const { lender, usdc, vault, pool, reserve } = await lossStack();
      const before = await usdc.balanceOf(lender.address);
      await vault.connect(lender).settle();
      expect(await vault.settledInsuranceDraw()).to.equal(U("1000"));      // the 10% cap binds
      expect(await vault.settledInsuranceDeferred()).to.equal(0n);
      expect(await usdc.balanceOf(lender.address) - before).to.equal(U("8500"));
      expect(await pool.reserveOf(await usdc.getAddress())).to.equal(reserve - U("1000"));
    });

    it("The change: the token refuses the pool's transfer, settlement still completes, and the insurance is held for the lender", async function () {
      const { lender, borrower, usdc, vault, pool, reserve } = await lossStack();
      await usdc.setBlacklisted(await pool.getAddress(), true);           // the issuer blocks the pool
      const poolBalance = await usdc.balanceOf(await pool.getAddress());
      const before = await usdc.balanceOf(lender.address);

      await expect(vault.connect(lender).settle())
        .to.emit(pool, "DrawDeferred").withArgs(await usdc.getAddress(), await vault.getAddress(), lender.address, U("1000"));
      expect(await vault.isSettled()).to.equal(true);

      // The vault's own cash goes to the lender now; the waterfall order is unchanged.
      expect(await usdc.balanceOf(lender.address) - before).to.equal(U("7500"));
      expect(await vault.settledInsuranceDraw()).to.equal(0n);
      expect(await vault.settledInsuranceDeferred()).to.equal(U("1000"));
      expect(await vault.settledBorrowerPayout()).to.equal(0n);           // the deposit was first-loss
      expect(await usdc.balanceOf(borrower.address)).to.equal(0n);

      // The pool holds it outside the reserve, so no other draw or withdrawal can spend it.
      expect(await pool.deferredDrawOf(await usdc.getAddress(), lender.address)).to.equal(U("1000"));
      expect(await pool.reserveOf(await usdc.getAddress())).to.equal(reserve - U("1000"));
      expect(await usdc.balanceOf(await pool.getAddress())).to.equal(poolBalance);
    });

    it("The lender claims it once the token allows, exactly once", async function () {
      const { lender, usdc, vault, pool } = await lossStack();
      await usdc.setBlacklisted(await pool.getAddress(), true);
      await vault.connect(lender).settle();

      await expect(pool.connect(lender).claimDeferredDraw(await usdc.getAddress())).to.be.reverted;   // still blocked; claim kept
      expect(await pool.deferredDrawOf(await usdc.getAddress(), lender.address)).to.equal(U("1000"));

      await usdc.setBlacklisted(await pool.getAddress(), false);
      const before = await usdc.balanceOf(lender.address);
      await expect(pool.connect(lender).claimDeferredDraw(await usdc.getAddress()))
        .to.emit(pool, "DeferredDrawClaimed").withArgs(await usdc.getAddress(), lender.address, U("1000"));
      expect(await usdc.balanceOf(lender.address) - before).to.equal(U("1000"));
      await expect(pool.connect(lender).claimDeferredDraw(await usdc.getAddress())).to.be.revertedWith("Nothing deferred");
    });

    // Audit L-06's own scenario: a CASH-ONLY vault. The loan bought TOK and
    // sold it all back at a loss, so nothing is held and settleInKind() offers
    // no way out. Before Q8 a refused pool transfer reverted settle() and the
    // lender received none of the cash the vault did hold.
    async function cashOnlyStack() {
      const env = await loadFixture(stack);
      const { operator, borrower, usdc, tok, vault, router, uniPool, pool } = env;
      await usdc.mint(operator.address, RESERVE);
      await usdc.approve(await pool.getAddress(), RESERVE);
      await pool.fund(await usdc.getAddress(), RESERVE);
      await vault.connect(borrower).swap(await tok.getAddress(), U("9000"), 1, FEE);

      await router.setRate(await tok.getAddress(), await usdc.getAddress(), 1, 2);
      const half = BigInt((await tok.getAddress()).toLowerCase()) < BigInt((await usdc.getAddress()).toLowerCase()) ? -6932n : 6932n;
      await uniPool.setAvgTick(half);
      await vault.connect(borrower).swapBack(await tok.getAddress(), U("9000"), 1);   // 3,000 + 4,500 = 7,500 cash
      await time.increaseTo((await vault.deadline()) + 1n);
      const reserve = await pool.reserveOf(await usdc.getAddress());
      return { ...env, reserve };
    }

    it("L-06: a cash-only vault settles while the pool is blocked, and every token is accounted for", async function () {
      const { lender, borrower, usdc, tok, vault, pool, reserve } = await cashOnlyStack();
      expect(await vault.heldAmount(await tok.getAddress())).to.equal(0n);
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(U("7500"));
      await expect(vault.connect(lender).settleInKind()).to.be.revertedWith("Nothing held - use settle()");

      await usdc.setBlacklisted(await pool.getAddress(), true);           // the issuer blocks the pool
      const poolBalance = await usdc.balanceOf(await pool.getAddress());
      const before = await usdc.balanceOf(lender.address);
      await vault.connect(lender).settle();

      // Payout conservation: the vault paid out exactly its cash plus the
      // insurance that actually arrived (none), and kept nothing.
      expect(await vault.settledTotalReturned()).to.equal(U("7500"));
      expect(await vault.settledInsuranceDraw()).to.equal(0n);
      expect(await usdc.balanceOf(lender.address) - before).to.equal(U("7500"));
      expect(await usdc.balanceOf(borrower.address)).to.equal(0n);
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(0n);

      // Reserve conservation: the allocated draw left the reserve and is held
      // for the lender; the pool's tokens are exactly reserve plus that claim.
      expect(await vault.settledInsuranceDeferred()).to.equal(U("1000"));
      expect(await pool.deferredDrawOf(await usdc.getAddress(), lender.address)).to.equal(U("1000"));
      expect(await pool.reserveOf(await usdc.getAddress())).to.equal(reserve - U("1000"));
      expect(await usdc.balanceOf(await pool.getAddress())).to.equal(poolBalance);
      expect(await pool.reserveOf(await usdc.getAddress()) + await pool.deferredDrawOf(await usdc.getAddress(), lender.address))
        .to.equal(poolBalance);

      // Once the block lifts the lender collects it, and the lender's total
      // equals what an unblocked settlement would have paid.
      await usdc.setBlacklisted(await pool.getAddress(), false);
      await pool.connect(lender).claimDeferredDraw(await usdc.getAddress());
      expect(await usdc.balanceOf(lender.address) - before).to.equal(U("8500"));
    });

    it("L-06 control: the same cash-only vault with the pool unblocked pays the same 8,500 at settlement", async function () {
      const { lender, usdc, vault, pool, reserve } = await cashOnlyStack();
      const before = await usdc.balanceOf(lender.address);
      await vault.connect(lender).settle();
      expect(await vault.settledInsuranceDraw()).to.equal(U("1000"));
      expect(await vault.settledInsuranceDeferred()).to.equal(0n);
      expect(await usdc.balanceOf(lender.address) - before).to.equal(U("8500"));
      expect(await pool.reserveOf(await usdc.getAddress())).to.equal(reserve - U("1000"));
    });

    it("Nobody else can claim the lender's deferred insurance", async function () {
      const { lender, keeper, usdc, vault, pool } = await lossStack();
      await usdc.setBlacklisted(await pool.getAddress(), true);
      await vault.connect(lender).settle();
      await usdc.setBlacklisted(await pool.getAddress(), false);
      await expect(pool.connect(keeper).claimDeferredDraw(await usdc.getAddress())).to.be.revertedWith("Nothing deferred");
    });
  });
});
