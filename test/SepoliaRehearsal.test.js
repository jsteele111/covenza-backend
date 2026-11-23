const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { setupCarryPool } = require("../scripts/setup-sepolia-carry-pool");
const { deployCarry, loadChainFile, DRAW_CAP_BPS } = require("../scripts/deploy-ethereum-carry");
const { verificationPlan } = require("../scripts/verify-ethereum-carry");
const { fundReserve, grant, open, settle } = require("../scripts/carry-demo-loan");
const { readPending, writePending } = require("../scripts/lib/timelock");

/**
 * The Sepolia rehearsal (deployment plan v2, decision 1), run here on the
 * local Hardhat network first, so the scripts are proven before anything
 * touches a public test network. No RPC needed: runs with the normal suite.
 *
 *   setup-sepolia-carry-pool.js -> deploy-ethereum-carry.js (CHAIN_FILE, 1-hour
 *   timelock) -> the announcements execute -> carry-demo-loan.js: fund the
 *   reserve, grant identities, open a loan, settle it.
 *   verify-ethereum-carry.js's constructor arguments are checked against the
 *   deployed contracts, since Etherscan itself can't be reached from a test.
 *
 * Writes only to temporary files, and removes its own pending-timelock entries.
 */
describe("Sepolia rehearsal scripts, run locally end to end", function () {
  this.timeout(600_000);
  const NET = "hardhat";
  const DELAY = 3600;
  const quiet = () => {};
  let deployer, borrower, chainFile, addressesPath, chain, d;

  before(async function () {
    [deployer, borrower] = await ethers.getSigners();
    const stamp = Date.now();
    chainFile = path.join(os.tmpdir(), `covenza-chain-${stamp}.json`);
    addressesPath = path.join(os.tmpdir(), `covenza-addresses-${stamp}.json`);
  });

  after(function () {
    const all = readPending();
    delete all[NET];
    writePending(all);
    for (const f of [chainFile, addressesPath]) if (f && fs.existsSync(f)) fs.unlinkSync(f);
  });

  const record = () => JSON.parse(fs.readFileSync(addressesPath, "utf8"))[NET];

  it("setup-sepolia-carry-pool.js builds a 0.01% pool at 1.25 with 1,801 history slots live, and writes the chain file", async function () {
    const s = await setupCarryPool({ ethers, deployer, outPath: chainFile, log: quiet });
    const slot0 = await s.pool.slot0();
    expect(Number(slot0.observationCardinality)).to.equal(1801);
    expect(Number(await s.pool.fee())).to.equal(100);
    chain = loadChainFile(chainFile);
    expect(chain.chainId).to.equal(31337n);
    expect(chain.pool).to.equal(await s.pool.getAddress());
  });

  it("loadChainFile refuses a file missing an address", function () {
    const bad = path.join(os.tmpdir(), `covenza-bad-${Date.now()}.json`);
    fs.writeFileSync(bad, JSON.stringify({ chainId: 1 }));
    expect(() => loadChainFile(bad)).to.throw(/has no uniswapFactory/);
    fs.unlinkSync(bad);
  });

  it("deploy-ethereum-carry.js runs against the test pool with a 1-hour timelock, and names the pool at once", async function () {
    await time.increase(1860);   // the 30 minutes of history a real run waits for
    d = await deployCarry({
      ethers, deployer, network: NET, chain, timelockDelay: DELAY, addressesPath,
      attesterKey: deployer.address, treasury: deployer.address, log: quiet,
    });
    expect(d.named).to.equal(true);
    expect(await d.registry.timelockDelay()).to.equal(BigInt(DELAY));
    expect(await d.registry.poolFeeTier(chain.wstETH, chain.weth)).to.equal(100n);
    expect(record().deployer).to.equal(deployer.address);
  });

  it("verify-ethereum-carry.js rebuilds every constructor argument the contracts were deployed with", async function () {
    const plan = Object.fromEntries(verificationPlan(record()).map((c) => [c.name, c]));
    expect(Object.keys(plan)).to.have.members(["KYCRegistry", "InsurancePool", "AssetRegistry", "UniswapTwap", "Vault", "VaultLens", "VaultFactory"]);

    expect(await d.kyc.operator()).to.equal(plan.KYCRegistry.args[0]);
    expect(await d.kyc.timelockDelay()).to.equal(BigInt(plan.KYCRegistry.args[2]));
    expect(await d.reserve.drawCapBps()).to.equal(BigInt(plan.InsurancePool.args[1]));
    expect(plan.InsurancePool.args[1]).to.equal(DRAW_CAP_BPS);
    expect(await d.registry.swapRouter()).to.equal(plan.AssetRegistry.args[1]);
    expect(await d.registry.uniswapFactory()).to.equal(plan.AssetRegistry.args[2]);
    const [k, a, i, tr, impl, dl] = plan.VaultFactory.args;
    expect(await d.factory.kycRegistry()).to.equal(k);
    expect(await d.factory.assetRegistry()).to.equal(a);
    expect(await d.factory.insurancePool()).to.equal(i);
    expect(await d.factory.treasury()).to.equal(tr);
    expect(await d.factory.vaultImplementation()).to.equal(impl);
    expect(await d.factory.timelockDelay()).to.equal(BigInt(dl));
    expect(plan.Vault.libraries.UniswapTwap).to.equal(await d.twapLib.getAddress());
  });

  it("carry-demo-loan.js: grant, wait out the timelock, fund the reserve, open a 10 tWETH loan and settle it in full", async function () {
    await grant({ ethers, d: record(), lender: deployer, borrower, network: NET, log: quiet });
    await expect(fundReserve({ ethers, d: record(), lender: deployer, amount: ethers.parseEther("50"), log: quiet }))
      .to.be.revertedWith("Pool not wired to a factory yet");

    await time.increase(DELAY + 60);
    for (const p of readPending()[NET]) {
      await (await deployer.sendTransaction({ to: p.target, data: p.data })).wait();   // execute-timelocked.js
    }
    expect(await d.registry.outageGapThreshold()).to.equal(0n);

    await fundReserve({ ethers, d: record(), lender: deployer, amount: ethers.parseEther("50"), log: quiet });
    const vault = await open({ ethers, d: record(), lender: deployer, borrower, network: NET, addressesPath,
      principal: ethers.parseEther("10"), termSeconds: 3600, log: quiet });
    expect(await vault.isHeld(chain.wstETH)).to.equal(true);

    await expectRejects(settle({ ethers, d: record(), lender: deployer, log: quiet }), /Too early/);
    await time.increaseTo(BigInt(record().demoLoan.deadline) + 1n);
    const lines = [];
    await settle({ ethers, d: record(), lender: deployer, log: (s) => lines.push(s) });
    const v = await ethers.getContractAt("Vault", record().demoLoan.vault);
    expect(await v.settledLenderPayout()).to.equal(ethers.parseEther("10") + (await v.settledFee()));
    expect(await v.settledInsuranceDraw()).to.equal(0n);
    console.log("      [" + lines.join(" ") + "]");
  });
});

/** Resolves if `promise` rejects with a message matching `re`; fails otherwise. */
async function expectRejects(promise, re) {
  let err;
  try { await promise; } catch (e) { err = e; }
  expect(err, `expected a rejection matching ${re}`).to.not.equal(undefined);
  expect(String(err.message)).to.match(re);
}
