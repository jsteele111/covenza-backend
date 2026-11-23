const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers, network } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { deployCarry, approvePool, ETHEREUM, TIERS, TIMELOCK_DELAY } = require("../scripts/deploy-ethereum-carry");
const { inspectPool, growPoolHistory } = require("../scripts/grow-pool-history");
const { guardProductionConfig } = require("../scripts/lib/production-guards");
const { sendOrQueue, readPending, writePending } = require("../scripts/lib/timelock");

/**
 * scripts/deploy-ethereum-carry.js, rehearsed end to end on a fork of Ethereum
 * mainnet with the REAL 2-day timelock (Ethereum deployment plan, step 3a).
 *
 * Opt-in, like the other fork tests:
 *   ETHEREUM_MAINNET_RPC_URL in .env, and FORK_ETHEREUM=1 in the shell.
 *
 * Writes addresses to a temporary file, never to deployed-addresses.json, and
 * removes its own entries from pending-timelock.json afterwards.
 */

const RPC     = process.env.ETHEREUM_MAINNET_RPC_URL;
const ENABLED = !!RPC && process.env.FORK_ETHEREUM === "1";
const FORK_BLOCK = 26_462_600;
const NET = "hardhat";   // the network name the script sees on a fork
const E = ethers.parseEther;

/** Resolves if `promise` rejects with a message matching `re`; fails otherwise. */
async function expectRejects(promise, re) {
  let err;
  try { await promise; } catch (e) { err = e; }
  expect(err, `expected a rejection matching ${re}`).to.not.equal(undefined);
  expect(String(err.message)).to.match(re);
}

(ENABLED ? describe : describe.skip)("deploy-ethereum-carry.js, rehearsed on an Ethereum mainnet fork (2-day timelock)", function () {
  this.timeout(1_800_000);

  let deployer, attester, operatorSafe, treasury, lender, borrower;
  let d;                 // what deployCarry returned
  let addressesPath;
  const logs = [];

  before(async function () {
    await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: RPC, blockNumber: FORK_BLOCK } }] });
    [deployer, attester, operatorSafe, treasury, lender, borrower] = await ethers.getSigners();
    addressesPath = path.join(os.tmpdir(), `covenza-carry-rehearsal-${Date.now()}.json`);
  });

  after(async function () {
    const all = readPending();
    delete all[NET];
    writePending(all);
    if (addressesPath && fs.existsSync(addressesPath)) fs.unlinkSync(addressesPath);
    await network.provider.request({ method: "hardhat_reset", params: [] });
  });

  it("refuses a mainnet run without the partner's attester, Safe and treasury, before deploying anything", async function () {
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    await expectRejects(deployCarry({ ethers, deployer, network: "mainnet", operatorSafe: operatorSafe.address, treasury: treasury.address }), /ATTESTER_KEY must be set/);
    await expectRejects(deployCarry({ ethers, deployer, network: "mainnet",
      attesterKey: deployer.address, operatorSafe: operatorSafe.address, treasury: treasury.address }), /initial attester is the deploying key/);
    await expectRejects(deployCarry({ ethers, deployer, network: "mainnet",
      attesterKey: attester.address, operatorSafe: deployer.address, treasury: treasury.address }), /operator is the deploying EOA/);
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);   // nothing sent
  });

  it("phase 1: deploys, applies what may apply now, and announces what must wait 2 days", async function () {
    const before = await ethers.provider.getBalance(deployer.address);
    d = await deployCarry({
      ethers, deployer, network: NET, addressesPath,
      attesterKey: attester.address, operatorSafe: operatorSafe.address, treasury: treasury.address,
      log: (s) => logs.push(s),
    });
    const spent = before - (await ethers.provider.getBalance(deployer.address));
    console.log(`      [phase 1 cost on the fork: ${ethers.formatEther(spent)} ETH at block ${FORK_BLOCK}'s fees]`);

    // Every contract carries the 2-day timelock.
    for (const c of [d.kyc, d.reserve, d.registry, d.factory]) {
      expect(await c.timelockDelay()).to.equal(BigInt(TIMELOCK_DELAY));
    }
    // Tiers as in the plan.
    for (const t of TIERS) {
      const c = await d.registry.tierConfig(t.slot);
      expect([c.assumedVolBps, c.minDepositBps, c.maxTermSeconds, c.maxExposureBps, c.insurancePremiumBps].map(Number)).to.deep.equal(t.cfg);
    }
    // Matched pairs only.
    const listed = (await d.registry.getWhitelistedAssets()).map((a) => a.toLowerCase());
    expect(listed).to.have.members([ETHEREUM.weth.toLowerCase(), ETHEREUM.wstETH.toLowerCase()]);
    // Minimum depth set to a quarter of today's in-range depth; pool not yet named.
    const liq = await new ethers.Contract(d.poolAddr, ["function liquidity() view returns (uint128)"], deployer).liquidity();
    expect(await d.registry.minPoolLiquidity(ETHEREUM.wstETH, ETHEREUM.weth)).to.equal(liq / 4n);
    expect(d.named).to.equal(false);
    expect(await d.registry.poolFeeTier(ETHEREUM.wstETH, ETHEREUM.weth)).to.equal(0n);
    // Announced, not yet applied: outage detection still on, reserve not yet wired.
    expect(await d.registry.outageGapThreshold()).to.equal(1800n);
    expect(await d.reserve.vaultFactory()).to.equal(ethers.ZeroAddress);
    const pending = readPending()[NET] || [];
    expect(pending.map((p) => p.method)).to.have.members(["setOutageConfig", "setVaultFactory"]);
    // Recorded in the (temporary) addresses file.
    const rec = JSON.parse(fs.readFileSync(addressesPath, "utf8"))[NET];
    expect(rec.vaultFactory).to.equal(await d.factory.getAddress());
    expect(rec.guidance.maxLoanWeth).to.equal(500);
    expect(await d.factory.treasury()).to.equal(treasury.address);
  });

  it("after 2 days the announcements execute; the live settings then pass the mainnet guard", async function () {
    // Manual identity grants for the test's lender and borrower wait on the same timelock.
    for (const w of [lender, borrower]) {
      await sendOrQueue(d.kyc, "verify", [w.address, 7, ethers.id(`rehearsal-${w.address}`)], { network: NET, label: `grant ${w.address}` });
    }
    // Nothing can execute early.
    const early = readPending()[NET].find((p) => p.method === "setOutageConfig");
    await expect(deployer.sendTransaction({ to: early.target, data: early.data })).to.be.reverted;

    await time.increase(TIMELOCK_DELAY + 60);
    for (const p of readPending()[NET]) {
      await (await deployer.sendTransaction({ to: p.target, data: p.data })).wait();   // what execute-timelocked.js does
    }

    expect(await d.registry.outageGapThreshold()).to.equal(0n);
    expect(await d.reserve.vaultFactory()).to.equal(await d.factory.getAddress());
    expect(() => guardProductionConfig("mainnet", {
      timelockDelay: Number(TIMELOCK_DELAY), twapWindow: Number(1800),
      outageGapThreshold: Number(0), operator: operatorSafe.address, attesterKey: attester.address, deployer: deployer.address,
    })).to.not.throw();
  });

  it("phase 2: refuses to name the pool until its history is live, then names it", async function () {
    expect(await approvePool({ ethers, deployer, network: NET, registry: d.registry, log: (s) => logs.push(s) })).to.equal(false);

    // Grow the pool's history, then stand in for the market until the new slots switch on.
    const cfg = { factory: ETHEREUM.uniswapFactory, tokenA: ETHEREUM.wstETH, tokenB: ETHEREUM.weth, fee: ETHEREUM.poolFee, window: 1800 };
    let r = await inspectPool({ ethers, ...cfg });
    await growPoolHistory({ ethers, signer: deployer, pool: r.pool, target: r.target });
    r = await inspectPool({ ethers, ...cfg });

    const lp = await (await ethers.getContractFactory("UniswapLiquidityHelper", deployer)).deploy();
    const weth = new ethers.Contract(ETHEREUM.weth, ["function deposit() payable", "function transfer(address,uint256) returns (bool)"], deployer);
    const wst  = new ethers.Contract(ETHEREUM.wstETH, ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], deployer);
    await weth.deposit({ value: E("2") });
    await weth.transfer(await lp.getAddress(), E("2"));
    await deployer.sendTransaction({ to: ETHEREUM.wstETH, value: E("2") });
    await wst.transfer(await lp.getAddress(), await wst.balanceOf(deployer.address));
    const pool = new ethers.Contract(d.poolAddr, ["function slot0() view returns (uint160, int24 tick, uint16, uint16, uint16, uint8, bool)"], deployer);
    for (let i = 0; i < r.entriesToSwitchOn; i++) {
      const tick = Number((await pool.slot0()).tick);
      await lp.addRangeLiquidity(d.poolAddr, tick - 10, tick + 10, 1000n);
    }
    await time.increase(1860);

    expect(await approvePool({ ethers, deployer, network: NET, registry: d.registry, log: (s) => logs.push(s) })).to.equal(true);
    expect(await d.registry.poolFeeTier(ETHEREUM.wstETH, ETHEREUM.weth)).to.equal(BigInt(ETHEREUM.poolFee));
  });

  it("with the partner's 500 WETH reserve in place, a 500 WETH loan opens, buys wstETH and settles in full", async function () {
    const weth = new ethers.Contract(ETHEREUM.weth, [
      "function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)",
    ], deployer);

    // The partner funds the reserve (decision 4).
    await weth.deposit({ value: E("500") });
    await weth.approve(await d.reserve.getAddress(), E("500"));
    await d.reserve.fund(ETHEREUM.weth, E("500"));
    expect(await d.reserve.reserveOf(ETHEREUM.weth)).to.equal(E("500"));

    // A 500 WETH, 90-day loan at 2% with the 5% deposit (decision 3's maximum).
    const P = E("500");
    await weth.connect(lender).deposit({ value: P });
    await weth.connect(lender).approve(await d.factory.getAddress(), P);
    expect(await d.factory.quoteMinimumDeposit(P, 0, 90, false)).to.equal(E("25"));
    await d.factory.connect(lender).deployVaultWithTier(ETHEREUM.weth, borrower.address, P, 200, 90, false, E("25"), ethers.ZeroAddress, 0);
    const vault = await ethers.getContractAt("Vault", await d.factory.allVaults(0));
    const premium = await vault.insurancePremium();
    await weth.connect(borrower).deposit({ value: E("25") + premium });
    await weth.connect(borrower).approve(await vault.getAddress(), E("25") + premium);
    await vault.connect(borrower).payDeposit();
    await vault.connect(borrower).swap(ETHEREUM.wstETH, P, 1n, ETHEREUM.poolFee);
    expect(await vault.isHeld(ETHEREUM.wstETH)).to.equal(true);

    await time.increaseTo((await vault.deadline()) + 1n);
    const lenderBefore = await weth.balanceOf(lender.address);
    await vault.connect(lender).settle();
    const fee = await vault.settledFee();
    expect((await weth.balanceOf(lender.address)) - lenderBefore).to.equal(P + fee);
    expect(await vault.settledInsuranceDraw()).to.equal(0n);
    console.log(`      [500 WETH loan settled: lender received ${ethers.formatEther(P + fee)} WETH; borrower ${ethers.formatEther(await vault.settledBorrowerPayout())} WETH]`);
  });
});
