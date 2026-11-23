const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { inspectPool, growPoolHistory, summarise, ETHEREUM } = require("../scripts/grow-pool-history");

/**
 * scripts/grow-pool-history.js against the REAL Ethereum wstETH/WETH 0.01%
 * pool, on a fork of Ethereum mainnet (Ethereum deployment plan, step 2).
 *
 * Opt-in, like test/MatchedPairCarryEthereum.test.js:
 *   ETHEREUM_MAINNET_RPC_URL in .env, and FORK_ETHEREUM=1 in the shell.
 *
 * Same fork block, so the numbers line up with that test: 400 live slots,
 * entry 255, 31.27M gas to reserve 1,801, 145 entries until they switch on.
 */

const RPC     = process.env.ETHEREUM_MAINNET_RPC_URL;
const ENABLED = !!RPC && process.env.FORK_ETHEREUM === "1";
const FORK_BLOCK = 26_462_600;
const ROUTER02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const POOL = "0x109830a1AAaD605BbF02a9dFA7B0B92EC2FB7dAa";
const WINDOW = 1800;

const CFG = { factory: ETHEREUM.factory, tokenA: ETHEREUM.tokenA, tokenB: ETHEREUM.tokenB, fee: ETHEREUM.fee, window: WINDOW };

(ENABLED ? describe : describe.skip)("grow-pool-history.js on the real Ethereum wstETH/WETH pool (mainnet fork)", function () {
  this.timeout(1_800_000);
  let signer;

  before(async function () {
    await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: RPC, blockNumber: FORK_BLOCK } }] });
    [signer] = await ethers.getSigners();
  });

  after(async function () {
    await network.provider.request({ method: "hardhat_reset", params: [] });
  });

  it("reports the pool as NOT READY, sends nothing, and estimates its pace", async function () {
    const r = await inspectPool({ ethers, ...CFG });
    console.log("\n" + summarise(r).replace(/^/gm, "      ") + "\n");
    expect(r.pool.toLowerCase()).to.equal(POOL.toLowerCase());
    expect(r.ok).to.equal(false);
    expect(r.cardinality).to.equal(400);
    expect(r.cardinalityNext).to.equal(400);
    expect(r.index).to.equal(255);
    expect(r.reserved).to.equal(false);
    expect(r.entriesToSwitchOn).to.equal(null);
    expect(r.secondsPerEntry).to.be.greaterThan(60 * 30);   // quieter than one entry per half-hour
  });

  it("GROW: reserves 1,801 slots in steps, for about 31M gas", async function () {
    const r = await inspectPool({ ethers, ...CFG });
    const g = await growPoolHistory({ ethers, signer, pool: r.pool, target: r.target });
    expect(g.sent).to.equal(4);                       // 400 -> 800 -> 1200 -> 1600 -> 1801
    expect(g.gasUsed).to.be.within(30_000_000n, 33_000_000n);

    const after = await inspectPool({ ethers, ...CFG });
    console.log("\n" + summarise(after).replace(/^/gm, "      ") + "\n");
    expect(after.cardinalityNext).to.equal(WINDOW + 1);
    expect(after.cardinality).to.equal(400);           // reserved, not yet live
    expect(after.ok).to.equal(false);
    expect(after.reserved).to.equal(true);
    expect(after.entriesToSwitchOn).to.equal(145);
    expect(after.etaSeconds).to.be.greaterThan(86_400); // more than a day at the pool's pace
  });

  it("running GROW again sends nothing: the slots are already reserved", async function () {
    const r = await inspectPool({ ethers, ...CFG });
    const g = await growPoolHistory({ ethers, signer, pool: r.pool, target: r.target });
    expect(g.sent).to.equal(0);
    expect(g.gasUsed).to.equal(0n);
  });

  it("once 145 more entries are written, it reports READY, and the registry agrees", async function () {
    // Stand in for the market: a sliver of liquidity around the price writes one entry per block.
    const lp = await (await ethers.getContractFactory("UniswapLiquidityHelper", signer)).deploy();
    const weth = new ethers.Contract(ETHEREUM.tokenB, ["function deposit() payable", "function transfer(address,uint256) returns (bool)"], signer);
    const wst  = new ethers.Contract(ETHEREUM.tokenA, ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], signer);
    await weth.deposit({ value: ethers.parseEther("2") });
    await weth.transfer(await lp.getAddress(), ethers.parseEther("2"));
    await signer.sendTransaction({ to: ETHEREUM.tokenA, value: ethers.parseEther("2") });
    await wst.transfer(await lp.getAddress(), await wst.balanceOf(signer.address));
    const pool = new ethers.Contract(POOL, ["function slot0() view returns (uint160, int24 tick, uint16, uint16, uint16, uint8, bool)"], signer);

    const before = await inspectPool({ ethers, ...CFG });
    for (let i = 0; i < before.entriesToSwitchOn; i++) {
      const tick = Number((await pool.slot0()).tick);
      await lp.addRangeLiquidity(POOL, tick - 10, tick + 10, 1000n);
    }

    const r = await inspectPool({ ethers, ...CFG });
    console.log("\n" + summarise(r).replace(/^/gm, "      ") + "\n");
    expect(r.ok).to.equal(true);
    expect(r.cardinality).to.equal(WINDOW + 1);

    // The asset registry accepts it, through the same check.
    await network.provider.send("evm_increaseTime", [WINDOW + 60]);
    await network.provider.send("evm_mine", []);
    const registry = await (await ethers.getContractFactory("AssetRegistry", signer)).deploy(signer.address, ROUTER02, ETHEREUM.factory, 0);
    await registry.addAssetWithTier(ETHEREUM.tokenA, 0, 0);   // both tokens must be listed first
    await registry.addAssetWithTier(ETHEREUM.tokenB, 0, 0);
    await registry.setMinPoolLiquidity(ETHEREUM.tokenA, ETHEREUM.tokenB, r.liquidity / 4n);
    await registry.setPoolFeeTier(ETHEREUM.tokenA, ETHEREUM.tokenB, ETHEREUM.fee);
    expect(await registry.poolFeeTier(ETHEREUM.tokenA, ETHEREUM.tokenB)).to.equal(ETHEREUM.fee);
  });
});
