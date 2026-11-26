/**
 * RoutedVault — security review, 26 November 2026.
 *
 * Each test proves one control from the review of step 1 of the aggregator
 * build (Swap Executor and Price Module Design Note v2). The executor stand-in
 * is deliberately WORSE than the real one must be: it passes an aggregator's
 * revert data straight back. The vault must be safe even then.
 *
 *   R1  a forged exit quote cannot pass the full-exit check (M-02)
 *   R2  the exit is always proved through the fallback pool, never through a
 *       route the borrower built (the KRAIT-003 pattern)
 *   D1  every token needs a fallback pool (decision 1); size caps hold
 *   R4  a route chosen by a party must pay at least the fallback pool
 *       (swapBack and settlement), so one side cannot skim the other
 *   R6  every trade records which route it used
 *   plus: keepers cannot choose routes (decision 3), re-entry is refused,
 *   short and partial deliveries revert (item 17, M-03), and an unreadable
 *   price blocks purchases and floored sales.
 */
const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

const E = ethers.parseEther;
const PRINCIPAL = E("10");
const DEPOSIT = E("1.5");
const YEAR = 365 * 24 * 3600;
const GRACE = 3600;
const FALLBACK = { target: ethers.ZeroAddress, data: "0x" };

describe("RoutedVault — security review controls", function () {
  async function stack() {
    const [operator, lender, borrower, keeper] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const weth = await Mock.deploy("Loan WETH", "WETH", 18);
    const tkn = await Mock.deploy("Held token", "TKN", 18);
    const W = await weth.getAddress(), T = await tkn.getAddress();

    const price = await (await ethers.getContractFactory("MockPriceRouter")).deploy();
    await price.setRate(W, T, 1, 1);
    const exec = await (await ethers.getContractFactory("MockSwapExecutor")).deploy();
    await exec.setFallback(W, T, 1, 1);
    const Agg = await ethers.getContractFactory("MockAggregator");
    const agg = await Agg.deploy(), forger = await Agg.deploy();
    await forger.setMode(1);
    for (const c of [exec, agg]) { await weth.mint(await c.getAddress(), E("1000")); await tkn.mint(await c.getAddress(), E("1000")); }

    const kyc = await (await ethers.getContractFactory("KYCRegistry")).deploy(operator.address, operator.address, 0);
    await kyc.verify(borrower.address, 7, ethers.id("t")); await kyc.verify(lender.address, 7, ethers.id("t"));
    // The registry's Uniswap addresses are unused by RoutedVault; any contracts do.
    const registry = await (await ethers.getContractFactory("AssetRegistry")).deploy(
      operator.address, await exec.getAddress(), await price.getAddress(), 0);
    await registry.addAsset(W, 0); await registry.addAsset(T, 0);
    await registry.setSettlementConfig(1800, 200, GRACE, 2, 100);   // 2% tolerance
    for (const t of [0, 1, 2]) await registry.setTierConfig(t, 0, 0, YEAR, 10000, 0);
    await registry.setOutageConfig(0, 0, 0);

    const pool = await (await ethers.getContractFactory("InsurancePool")).deploy(operator.address, 1000, 0);
    await pool.setMaxDrawShareBps(10000);
    const impl = await (await ethers.getContractFactory("RoutedVault")).deploy(await price.getAddress(), await exec.getAddress());
    const factory = await (await ethers.getContractFactory("VaultFactory")).deploy(
      await kyc.getAddress(), await registry.getAddress(), await pool.getAddress(), operator.address, await impl.getAddress(), 0);
    await pool.queueSetVaultFactory(await factory.getAddress()); await pool.setVaultFactory(await factory.getAddress());
    await factory.setProtocolFeeRateBps(0);

    await weth.mint(lender.address, PRINCIPAL);
    await weth.connect(lender).approve(await factory.getAddress(), PRINCIPAL);
    await factory.connect(lender).deployVault(W, borrower.address, PRINCIPAL, 300, YEAR, true, DEPOSIT, ethers.ZeroAddress);
    const vault = await ethers.getContractAt("RoutedVault", await factory.allVaults(0));
    await weth.mint(borrower.address, DEPOSIT + (await vault.insurancePremium()));
    await weth.connect(borrower).approve(await vault.getAddress(), DEPOSIT + (await vault.insurancePremium()));
    await vault.connect(borrower).payDeposit();

    const via = (a, tokenIn, tokenOut, amount) => ({ target: a.target, data: a.interface.encodeFunctionData("swap", [tokenIn, tokenOut, amount]) });
    return { operator, lender, borrower, keeper, weth, tkn, W, T, price, exec, agg, forger, registry, vault, via, Agg };
  }

  it("buys through an approved aggregator, proves the exit through the fallback pool, and records the route (R6)", async function () {
    const { vault, borrower, agg, W, T, via, tkn } = await loadFixture(stack);
    await expect(vault.connect(borrower).swap(T, E("8"), E("7.9"), via(agg, W, T, E("8"))))
      .to.emit(vault, "RouteUsed").withArgs(W, T, agg.target);
    expect(await vault.heldAmount(T)).to.equal(E("8"));
    expect(await tkn.balanceOf(vault.target)).to.equal(E("8"));
  });

  describe("R1 — a forged exit quote cannot pass the full-exit check", function () {
    it("refuses a purchase when the exit simulation reverts with a forged ExitQuote(huge)", async function () {
      const { vault, borrower, agg, exec, W, T, via } = await loadFixture(stack);
      await exec.setForgeOnSell(T, true);
      await expect(vault.connect(borrower).swap(T, E("8"), 1n, via(agg, W, T, E("8"))))
        .to.be.revertedWith("Position too large to exit within tolerance");
    });
    it("control: the same purchase with an honest fallback pool goes through", async function () {
      const { vault, borrower, agg, W, T, via } = await loadFixture(stack);
      await vault.connect(borrower).swap(T, E("8"), 1n, via(agg, W, T, E("8")));
      expect(await vault.heldAmount(T)).to.equal(E("8"));
    });
  });

  describe("R2 — the exit is always proved through the fallback pool", function () {
    it("refuses when the fallback pool cannot take the exit, however good the aggregator route", async function () {
      const { vault, borrower, agg, exec, W, T, via } = await loadFixture(stack);
      await exec.setFallback(W, T, 1, 1);
      await exec.setFallback(T, W, 90, 100);          // the fallback pays only 0.90 per token on the way out
      await expect(vault.connect(borrower).swap(T, E("8"), 1n, via(agg, W, T, E("8"))))
        .to.be.revertedWith("Position too large to exit within tolerance");
    });
  });

  describe("D1 — every token needs a fallback pool; size caps hold", function () {
    it("refuses to buy a token with no fallback pool, whatever the route", async function () {
      const { vault, borrower, agg, exec, W, T, via } = await loadFixture(stack);
      await exec.clearFallback(W, T);
      await expect(vault.connect(borrower).swap(T, E("8"), 1n, via(agg, W, T, E("8"))))
        .to.be.revertedWith("No fallback pool for this asset");
    });
    it("holds a purchase to the token's size cap", async function () {
      const { vault, borrower, agg, price, W, T, via } = await loadFixture(stack);
      await price.setMaxPosition(T, W, E("5"));
      await expect(vault.connect(borrower).swap(T, E("8"), 1n, via(agg, W, T, E("8"))))
        .to.be.revertedWith("Exceeds the size cap for this asset");
      await vault.connect(borrower).swap(T, E("5"), 1n, via(agg, W, T, E("5")));
    });
  });

  describe("R4 — a party's own route must pay at least the fallback pool", function () {
    it("swapBack: refuses a route paying 1.5% below the fallback pool, though above the 2% floor", async function () {
      const { vault, borrower, agg, Agg, W, T, via, weth, tkn } = await loadFixture(stack);
      await vault.connect(borrower).swap(T, E("8"), 1n, FALLBACK);
      const skimmer = await Agg.deploy(); await skimmer.setRate(985, 1000);
      await weth.mint(skimmer.target, E("100"));
      await expect(vault.connect(borrower).swapBack(T, E("8"), 1n, via(skimmer, T, W, E("8"))))
        .to.be.revertedWith("Received less than minimum");
      await vault.connect(borrower).swapBack(T, E("8"), 1n, via(agg, T, W, E("8")));   // a fair route is fine
      expect(await tkn.balanceOf(vault.target)).to.equal(0n);
    });
    it("settlement: the lender cannot sell the borrower's holding through a skimming route; the fallback settles", async function () {
      const { vault, borrower, lender, Agg, W, T, via, weth } = await loadFixture(stack);
      await vault.connect(borrower).swap(T, E("8"), 1n, FALLBACK);
      await time.increaseTo((await vault.deadline()) + 10n);
      const skimmer = await Agg.deploy(); await skimmer.setRate(985, 1000);
      await weth.mint(skimmer.target, E("100"));
      await expect(vault.connect(lender).settle([T], [via(skimmer, T, W, E("8"))]))
        .to.be.revertedWith("Received less than minimum");
      await vault.connect(lender).settle([], []);
      expect(await vault.settledLenderPayout()).to.equal(PRINCIPAL + E("0.3"));
    });
  });

  describe("Decision 3 — keepers sell through the fallback pool only", function () {
    it("refuses a keeper's route after grace, and settles through the fallback pool", async function () {
      const { vault, borrower, keeper, agg, W, T, via } = await loadFixture(stack);
      await vault.connect(borrower).swap(T, E("8"), 1n, FALLBACK);
      await time.increaseTo((await vault.deadline()) + BigInt(GRACE) + 3600n);
      await expect(vault.connect(keeper).settle([T], [via(agg, T, W, E("8"))]))
        .to.be.revertedWith("Only the parties may choose routes");
      await vault.connect(keeper).settle([], []);
      expect(await vault.isSettled()).to.equal(true);
    });
  });

  describe("Hostile aggregators", function () {
    it("re-entry from the aggregator mid-trade is refused", async function () {
      const { vault, borrower, Agg, W, T, via, weth, tkn } = await loadFixture(stack);
      const r = await Agg.deploy(); await r.setMode(3); await r.setVault(vault.target);
      await tkn.mint(r.target, E("100"));
      await expect(vault.connect(borrower).swap(T, E("8"), 1n, via(r, W, T, E("8"))))
        .to.be.revertedWith("Re-entry");
    });
    it("a short delivery fails the entry check against the reference price", async function () {
      const { vault, borrower, Agg, W, T, via, tkn } = await loadFixture(stack);
      const s = await Agg.deploy(); await s.setMode(2); await tkn.mint(s.target, E("100"));
      await expect(vault.connect(borrower).swap(T, E("8"), 1n, via(s, W, T, E("8"))))
        .to.be.revertedWith("Execution too far below the reference price");
    });
    it("a partial fill reverts (M-03), leaving the vault untouched", async function () {
      const { vault, borrower, Agg, W, T, via, tkn, weth } = await loadFixture(stack);
      const p = await Agg.deploy(); await p.setMode(4); await tkn.mint(p.target, E("100"));
      const before = await weth.balanceOf(vault.target);
      await expect(vault.connect(borrower).swap(T, E("8"), 1n, via(p, W, T, E("8"))))
        .to.be.revertedWith("Swap did not spend the full amount");
      expect(await weth.balanceOf(vault.target)).to.equal(before);
    });
  });

  describe("Unreadable price", function () {
    it("blocks new purchases, and settlement waits rather than selling without a floor", async function () {
      const { vault, borrower, lender, price, W, T } = await loadFixture(stack);
      await vault.connect(borrower).swap(T, E("8"), 1n, FALLBACK);
      await price.setUnreadable(T, true);
      await expect(vault.connect(borrower).swap(T, E("1"), 1n, FALLBACK)).to.be.revertedWith("Price unavailable");
      await time.increaseTo((await vault.deadline()) + 10n);
      await expect(vault.connect(lender).settle([], [])).to.be.revertedWith("Price unavailable");
      await price.setUnreadable(T, false);
      await vault.connect(lender).settle([], []);
    });
  });
});
