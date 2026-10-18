const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Item 8 — no single draw may take more than maxDrawShareBps (default 5%) of
 * what is left in the reserve.
 *
 * drawCapBps limits a draw against the loan's principal, but nothing limited
 * the total. In a market-wide loss the pool paid whoever settled first in
 * full and the later lenders found it empty. Capping each draw at a share of
 * what is left slows the drain so that nobody gets zero.
 *
 * The pool's factory is pointed at a test wallet so one signer can register
 * as a "vault" and draw directly; the vault side is covered elsewhere.
 */
const E = ethers.parseEther;

async function poolWith(delay) {
  const [operator, claimant, other] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("MockERC20", operator)).deploy("Mock WETH", "WETH", 18);
  const pool = await (await ethers.getContractFactory("InsurancePool", operator))
    .deploy(operator.address, 1000, delay);                 // draw cap 10% of principal
  await pool.setVaultFactory(operator.address);
  await pool.registerVault(claimant.address);

  async function fund(amount) {
    await weth.mint(operator.address, amount);
    await weth.approve(await pool.getAddress(), amount);
    await pool.fund(await weth.getAddress(), amount);
  }

  // A loss on a 10 WETH loan: the 10% cap allows at most 1 WETH.
  async function claim() {
    const before = await weth.balanceOf(claimant.address);
    await pool.connect(claimant).draw(await weth.getAddress(), E("5"), E("10"));
    return (await weth.balanceOf(claimant.address)) - before;
  }

  return { operator, claimant, other, weth, pool, fund, claim };
}

const noDelay = () => poolWith(0);
const withDelay = () => poolWith(3600);

describe("Item 8 — each draw is limited to a share of what is left", function () {

  it("Defaults to 5% of the reserve", async function () {
    const { pool } = await loadFixture(noDelay);
    expect(await pool.maxDrawShareBps()).to.equal(500n);
  });

  it("Changes nothing while the reserve is large next to the loan", async function () {
    const { fund, claim } = await loadFixture(noDelay);
    await fund(E("1000"));                     // 5% is 50; the 1 WETH cap binds
    expect(await claim()).to.equal(E("1"));
  });

  it("Binds when the reserve is small: no draw takes more than 5% of it", async function () {
    const { weth, pool, fund, claim } = await loadFixture(noDelay);
    await fund(E("10"));                       // 5% is 0.5, below the 1 WETH cap
    expect(await claim()).to.equal(E("0.5"));
    expect(await pool.reserveOf(await weth.getAddress())).to.equal(E("9.5"));
  });

  it("A market-wide loss: 40 lenders on a 20 WETH pool all receive something", async function () {
    const { weth, pool, fund, claim } = await loadFixture(noDelay);
    await fund(E("20"));

    const paid = [];
    for (let i = 0; i < 40; i++) { paid.push(await claim()); }

    // First come first served would have paid the first 20 in full and the
    // last 20 nothing. Now the first is paid in full, each later one less,
    // and the fortieth still about 0.135 WETH.
    expect(paid[0]).to.equal(E("1"));
    for (let i = 1; i < 40; i++) { expect(paid[i]).to.be.lessThan(paid[i - 1]); }
    expect(paid[39]).to.be.closeTo(E("0.135"), E("0.001"));
    expect(await pool.reserveOf(await weth.getAddress())).to.be.closeTo(E("2.57"), E("0.01"));
  });

  it("Can never be emptied: a draw always leaves 95% behind", async function () {
    const { weth, pool, fund, claim } = await loadFixture(noDelay);
    await fund(E("1"));
    for (let i = 0; i < 10; i++) { await claim(); }
    expect(await pool.reserveOf(await weth.getAddress())).to.be.closeTo(E("0.5987"), E("0.0001"));
  });

  it("Enforces bounds, and only the operator may set it", async function () {
    const { pool, other } = await loadFixture(noDelay);
    await expect(pool.setMaxDrawShareBps(0)).to.be.revertedWith("Draw share must be 1-10000 bps");
    await expect(pool.setMaxDrawShareBps(10001)).to.be.revertedWith("Draw share must be 1-10000 bps");
    await expect(pool.connect(other).setMaxDrawShareBps(1000)).to.be.reverted;
    await expect(pool.setMaxDrawShareBps(1000)).to.emit(pool, "DrawShareUpdated").withArgs(500, 1000);
  });

  it("Waits on the timelock in both directions", async function () {
    const { pool } = await loadFixture(withDelay);
    for (const bps of [1000, 100]) {
      const data = pool.interface.encodeFunctionData("setMaxDrawShareBps", [bps]);
      await expect(pool.setMaxDrawShareBps(bps)).to.be.reverted;
      await pool.queueAction(ethers.keccak256(data));
      await expect(pool.setMaxDrawShareBps(bps)).to.be.reverted;
      await time.increase(3600);
      await pool.setMaxDrawShareBps(bps);
      expect(await pool.maxDrawShareBps()).to.equal(BigInt(bps));
    }
  });
});
