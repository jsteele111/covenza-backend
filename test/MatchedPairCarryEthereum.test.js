const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers, network } = require("hardhat");

/**
 * Product 1 — Matched-pair carry on ETHEREUM, against the REAL Uniswap V3
 * wstETH/WETH 0.01% pool, on a fork of Ethereum mainnet.
 *
 * Opt-in: runs only when BOTH are set, so the normal suite is unaffected and
 * uses no RPC credits:
 *   ETHEREUM_MAINNET_RPC_URL  in .env (an archive-capable provider, e.g. Alchemy)
 *   FORK_ETHEREUM=1           in the shell for this run
 *
 * Same contracts as everywhere else (8b7311a, unchanged). What this adds to
 * test/MatchedPairCarry.test.js is the real pool:
 *
 *   A. Price history. Our contracts refuse a pool with 1,800 or fewer history
 *      slots (KRAIT-004). The real pool has 400. Anyone may pay to extend it;
 *      the extra slots switch on only when the pool's ring wraps round.
 *      We measure the gas, and count the writes still needed to wrap.
 *   B. Depth. The largest position that can both ENTER (1% entry-impact cap)
 *      and EXIT (whole position within the 2% tolerance) at the fork block.
 *   C. The worked example at a size the pool can take, settled against the
 *      real pool, plus the gas cost of a whole loan on Ethereum.
 *
 * Nothing here touches the real chain: a fork is a private local copy.
 */

const RPC     = process.env.ETHEREUM_MAINNET_RPC_URL;
const ENABLED = !!RPC && process.env.FORK_ETHEREUM === "1";
const FORK_BLOCK = 26_462_600;   // 21 Nov 2026, just before the on-chain check in chat

// Ethereum mainnet addresses. Verify on Etherscan.
const UNI_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";  // Uniswap V3 Factory
const ROUTER02    = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";  // Uniswap SwapRouter02
const WETH_ADDR   = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WST_ADDR    = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";  // Lido wstETH
const POOL_ADDR   = "0x109830a1AAaD605BbF02a9dFA7B0B92EC2FB7dAa";  // wstETH/WETH 0.01%

const POOL_ARTIFACT = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const WETH_ABI = [
  "function deposit() payable",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const WST_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function stEthPerToken() view returns (uint256)",
];

const E  = ethers.parseEther;
const F  = (x) => Number(ethers.formatEther(x));
const FEE = 100;
const WINDOW = 1800;
const TERM = 90;
const APR = 200;                      // 2.0%
const DEPOSIT_BPS = 500n;             // 5%
const TIER = { vol: 500, minDep: 500, maxTerm: 120 * 86400, cap: 10000, prem: 25 };
const SIZES = [50, 100, 200, 300, 400, 600, 800, 1000];   // WETH principal

const Q192 = 2n ** 192n;
function isqrt(n) { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }
/** sqrtPriceX96 for `price` WETH per wstETH (wstETH is token0, WETH token1). */
const sqrtFor = (price) => isqrt((BigInt(Math.round(price * 1e9)) * Q192) / 1_000_000_000n);
const priceOf = (sqrtX96) => Number((sqrtX96 * sqrtX96 * 10n ** 12n) >> 192n) / 1e12;

const snap   = () => network.provider.send("evm_snapshot", []);
const revert = (id) => network.provider.send("evm_revert", [id]);

const report = { gas: {}, sizes: [], scenarios: [] };

(ENABLED ? describe : describe.skip)("Matched-pair carry on Ethereum: real Uniswap V3 wstETH/WETH 0.01% (mainnet fork)", function () {
  this.timeout(1_800_000);

  let operator, lender, borrower, market, lpFunder;
  let weth, wst, pool, router, registry, ipool, twap, factory, lp;
  let baseFeeWei;
  let ready;   // snapshot with the pool's history extended and the deployment wired

  before(async function () {
    await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: RPC, blockNumber: FORK_BLOCK } }] });
    [operator, lender, borrower, market, lpFunder] = await ethers.getSigners();
    baseFeeWei = (await ethers.provider.getBlock(FORK_BLOCK)).baseFeePerGas;

    weth   = new ethers.Contract(WETH_ADDR, WETH_ABI, operator);
    wst    = new ethers.Contract(WST_ADDR, WST_ABI, operator);
    pool   = new ethers.Contract(POOL_ADDR, POOL_ARTIFACT.abi, operator);
    router = new ethers.Contract(ROUTER02, ROUTER_ABI, operator);

    // The market: 3,000 WETH, and 3,000 ETH staked into wstETH through Lido (about 2,400 wstETH).
    await weth.connect(market).deposit({ value: E("3000") });
    await market.sendTransaction({ to: WST_ADDR, value: E("3000") });
    await weth.connect(market).approve(ROUTER02, ethers.MaxUint256);
    await wst.connect(market).approve(ROUTER02, ethers.MaxUint256);

    // A tiny liquidity provider. Uniswap writes a history entry only when a trade moves the
    // price by at least one tick, or when liquidity is added around the current price. Small
    // trades in a pool this deep move nothing, so the test adds a sliver of liquidity instead.
    // It is also funded to stand in for liquidity providers re-centring their ranges (section C).
    lp = await (await ethers.getContractFactory("UniswapLiquidityHelper", operator)).deploy();
    await weth.connect(lpFunder).deposit({ value: E("4000") });
    await weth.connect(lpFunder).transfer(await lp.getAddress(), E("4000"));
    await lpFunder.sendTransaction({ to: WST_ADDR, value: E("4000") });
    await wst.connect(lpFunder).transfer(await lp.getAddress(), await wst.balanceOf(lpFunder.address));

    // Covenza deployment: matched pairs only (the carry registry).
    const id = await (await ethers.getContractFactory("MockIdentityAdapter", operator)).deploy();
    await id.set(lender.address, 7);
    await id.set(borrower.address, 7);
    registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(operator.address, ROUTER02, UNI_FACTORY, 0);
    await registry.setOutageConfig(0, 0, 0);          // Ethereum has no single block producer
    await registry.setTierConfig(0, TIER.vol, TIER.minDep, TIER.maxTerm, TIER.cap, TIER.prem);
    await registry.addAssetWithTier(WETH_ADDR, 0, 0);
    await registry.addAssetWithTier(WST_ADDR, 0, 0);

    ipool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
    twap  = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
    const impl = await (await ethers.getContractFactory("Vault", { signer: operator, libraries: { UniswapTwap: await twap.getAddress() } })).deploy();
    factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
      await id.getAddress(), await registry.getAddress(), await ipool.getAddress(), operator.address, await impl.getAddress(), 0);
    await factory.setProtocolFeeRateBps(0);
    await ipool.queueSetVaultFactory(await factory.getAddress());
    await ipool.setVaultFactory(await factory.getAddress());
    await weth.connect(operator).deposit({ value: E("1000") });
    await weth.connect(operator).approve(await ipool.getAddress(), E("1000"));
    await ipool.fund(WETH_ADDR, E("1000"));
  });

  after(async function () {
    // Back to a plain local chain, so any test file run after this one is unaffected.
    await network.provider.request({ method: "hardhat_reset", params: [] });
    printReport();
  });

  // ---------------------------------------------------------------- A
  describe("A. Price history: the real pool must be extended before it can be approved", function () {
    it("finds the pool, and our contracts refuse it as it stands (400 slots, KRAIT-004 needs more than 1,800)", async function () {
      const factoryC = new ethers.Contract(UNI_FACTORY, FACTORY_ABI, operator);
      expect((await factoryC.getPool(WST_ADDR, WETH_ADDR, FEE)).toLowerCase()).to.equal(POOL_ADDR.toLowerCase());
      const s0 = await pool.slot0();
      report.pool = {
        cardinality: Number(s0.observationCardinality), index: Number(s0.observationIndex),
        price: priceOf(s0.sqrtPriceX96), liquidity: await pool.liquidity(),
        wst: F(await wst.balanceOf(POOL_ADDR)), weth: F(await weth.balanceOf(POOL_ADDR)),
        stEthPerToken: F(await wst.stEthPerToken()),
      };
      expect(report.pool.cardinality).to.be.lessThanOrEqual(WINDOW);

      await registry.setMinPoolLiquidity(WST_ADDR, WETH_ADDR, report.pool.liquidity / 2n);
      await expect(registry.setPoolFeeTier(WST_ADDR, WETH_ADDR, FEE)).to.be.revertedWith("Pool keeps too little price history");
    });

    it("extends the history to 1,801 slots (anyone may do this), and measures the cost", async function () {
      let gas = 0n;
      for (const target of [800, 1200, 1500, WINDOW + 1]) {
        const rc = await (await pool.connect(operator).increaseObservationCardinalityNext(target)).wait();
        gas += rc.gasUsed;
      }
      report.gas.extendHistory = gas;
      const s0 = await pool.slot0();
      expect(Number(s0.observationCardinalityNext)).to.equal(WINDOW + 1);
      // The new slots are not live yet: the ring has to wrap round first.
      expect(Number(s0.observationCardinality)).to.equal(report.pool.cardinality);
      await expect(registry.setPoolFeeTier(WST_ADDR, WETH_ADDR, FEE)).to.be.revertedWith("Pool keeps too little price history");
    });

    it("the extra slots switch on once the pool's history wraps round; then the pool is approved", async function () {
      // Each in-range liquidity change, in its own block, writes one history entry. On mainnet the
      // same entries come from trades that move the price by a tick (about one every 65 minutes).
      let writes = 0;
      while (Number((await pool.slot0()).observationCardinality) <= WINDOW && writes < 500) {
        await poke();
        writes++;
      }
      report.writesToWrap = writes;
      expect(Number((await pool.slot0()).observationCardinality)).to.equal(WINDOW + 1);

      await time.increase(WINDOW + 60);
      await registry.setPoolFeeTier(WST_ADDR, WETH_ADDR, FEE);
      expect(await registry.poolFeeTier(WST_ADDR, WETH_ADDR)).to.equal(FEE);
      ready = await snap();
    });
  });

  // ---------------------------------------------------------------- helpers
  async function openLoan(principal) {
    const deposit = (principal * DEPOSIT_BPS) / 10000n;
    await weth.connect(lender).deposit({ value: principal });
    await weth.connect(lender).approve(await factory.getAddress(), principal);
    const rc1 = await (await factory.connect(lender).deployVaultWithTier(
      WETH_ADDR, borrower.address, principal, APR, TERM, false, deposit, ethers.ZeroAddress, 0)).wait();
    const vault = await ethers.getContractAt("Vault", await factory.allVaults((await factory.totalVaults()) - 1n));
    const premium = await vault.insurancePremium();
    await weth.connect(borrower).deposit({ value: deposit + premium });
    await weth.connect(borrower).approve(await vault.getAddress(), deposit + premium);
    const rc2 = await (await vault.connect(borrower).payDeposit()).wait();
    return { vault, deposit, premium, gasOpen: rc1.gasUsed, gasDeposit: rc2.gasUsed };
  }
  /** Adds a sliver of liquidity around the current price: always writes one history entry. */
  async function poke() {
    const tick = Number((await pool.slot0()).tick);
    await lp.addRangeLiquidity(POOL_ADDR, tick - 10, tick + 10, 1000n);
  }
  const twapValue = (amount) => twap.quote(UNI_FACTORY, WST_ADDR, WETH_ADDR, FEE, amount, WINDOW);
  const reason = (e) => (e.message.match(/reverted with reason string '([^']+)'/) || [null, e.shortMessage || e.message.split("\n")[0]])[1];

  /** The market trades the real pool to `price`, then the 30-minute average catches up. */
  async function moveTo(price, { recentre = false } = {}) {
    const target = sqrtFor(price);
    const [current] = await pool.slot0();
    if (target !== current) {
      const down = target < current;   // wstETH (token0) in pushes the price down
      const amountIn = down ? await wst.balanceOf(market.address) : await weth.balanceOf(market.address);
      await router.connect(market).exactInputSingle({
        tokenIn: down ? WST_ADDR : WETH_ADDR, tokenOut: down ? WETH_ADDR : WST_ADDR, fee: FEE,
        recipient: market.address, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: target,
      });
    }
    if (recentre) {
      // Liquidity providers move their ranges to the new price, as they do when the Lido rate
      // drifts over a quarter: the same depth the pool had at the start, around the new tick.
      const tick = Number((await pool.slot0()).tick);
      await lp.addRangeLiquidity(POOL_ADDR, tick - 10, tick + 10, report.pool.liquidity);
    }
    await time.increase(WINDOW + 60);
    await poke();                                      // write a fresh history entry
    return priceOf((await pool.slot0()).sqrtPriceX96);
  }

  // ---------------------------------------------------------------- B
  describe("B. Depth: the largest position the real pool can take in and out", function () {
    it("tries each loan size: enter within the 1% impact cap AND exit within the 2% tolerance", async function () {
      if (!ready) this.skip();
      for (const size of SIZES) {
        await revert(ready); ready = await snap();
        const principal = E(String(size));
        const { vault } = await openLoan(principal);
        const twapBefore = await twap.quote(UNI_FACTORY, WETH_ADDR, WST_ADDR, FEE, principal, WINDOW);
        try {
          await vault.connect(borrower).swap(WST_ADDR, principal, 1n, FEE);
          const held = await vault.heldAmount(WST_ADDR);
          const impactBps = Number(((twapBefore - held) * 10000n) / twapBefore);
          report.sizes.push({ size, ok: true, impactBps });
        } catch (e) {
          report.sizes.push({ size, ok: false, why: reason(e) });
        }
      }
      const ok = report.sizes.filter((s) => s.ok);
      expect(ok.length, "no size fitted the pool at all").to.be.greaterThan(0);
      report.maxSize = Math.max(...ok.map((s) => s.size));
    });
  });

  // ---------------------------------------------------------------- C
  describe("C. The worked example at the largest size that fits, settled against the real pool", function () {
    async function quarter(name, discount, recentre) {
      await revert(ready); ready = await snap();
      const principal = E(String(report.maxSize));
      const { vault, deposit, premium, gasOpen, gasDeposit } = await openLoan(principal);
      const rcSwap = await (await vault.connect(borrower).swap(WST_ADDR, principal, 1n, FEE)).wait();
      const entry = priceOf((await pool.slot0()).sqrtPriceX96);

      const deadline = await vault.deadline();
      await time.increaseTo(deadline - 3n * 3600n);
      const atSettle = await moveTo(report.pool.price * 1.0074 * (1 - discount), { recentre });
      await time.increaseTo(deadline + 1n);
      const meanLiq = await twap.meanLiquidity(UNI_FACTORY, WST_ADDR, WETH_ADDR, FEE, WINDOW);
      const row = { name: name + (recentre ? ", LPs follow" : ", LPs stay"), entry, atSettle,
                    depthPct: Number((meanLiq * 100n) / report.pool.liquidity) };
      try {
        const rcSettle = await (await vault.connect(lender).settle()).wait();
        Object.assign(row, {
          settled: true,
          returned: F(await vault.settledTotalReturned()), draw: F(await vault.settledInsuranceDraw()),
          lender: F(await vault.settledLenderPayout()), borrower: F(await vault.settledBorrowerPayout()),
        });
        row.net = row.borrower - F(deposit) - F(premium);
        report.gas.loan = gasOpen + gasDeposit + rcSwap.gasUsed + rcSettle.gasUsed;
      } catch (e) {
        Object.assign(row, { settled: false, why: reason(e) });
      }
      report.scenarios.push(row);
      return { row, principal };
    }

    it("normal quarter (+0.74%), LPs follow the price: settles in cash and the lender is paid in full", async function () {
      if (!report.maxSize) this.skip();
      const { row, principal } = await quarter("Normal quarter (+0.74%)", 0, true);
      expect(row.settled, row.why).to.equal(true);
      expect(row.lender).to.be.greaterThanOrEqual(F(principal));
    });

    it("normal quarter (+0.74%), LPs stay put: reports what happens", async function () {
      if (!report.maxSize) this.skip();
      await quarter("Normal quarter (+0.74%)", 0, false);
    });

    for (const d of [0.03, 0.08]) {
      for (const follow of [true, false]) {
        it(`${d * 100}% discount at settlement, LPs ${follow ? "follow" : "stay"}: reports how the real pool settles it`, async function () {
          if (!report.maxSize) this.skip();
          await quarter(`${d * 100}% discount at settlement`, d, follow);
        });
      }
    }
  });

  // ---------------------------------------------------------------- report
  function printReport() {
    const L = (s) => console.log("      " + s);
    const eth = (gas) => (Number(gas * baseFeeWei) / 1e18).toFixed(5);
    console.log("");
    L(`Ethereum mainnet fork at block ${FORK_BLOCK} (base fee ${(Number(baseFeeWei) / 1e9).toFixed(3)} gwei)`);
    if (report.pool) {
      const p = report.pool;
      L(`Pool ${POOL_ADDR}: price ${p.price.toFixed(4)} WETH per wstETH (Lido rate ${p.stEthPerToken.toFixed(4)});`);
      L(`  holds ${p.wst.toFixed(0)} wstETH + ${p.weth.toFixed(0)} WETH; history slots ${p.cardinality} (index ${p.index})`);
    }
    if (report.gas.extendHistory) L(`Extending history to ${WINDOW + 1} slots: ${report.gas.extendHistory} gas = ${eth(report.gas.extendHistory)} ETH at this base fee`);
    if (report.writesToWrap !== undefined) L(`History entries still needed before the new slots switch on: ${report.writesToWrap} (one per block with a trade in this pool)`);
    if (report.sizes.length) {
      L("Loan size (WETH)   Result");
      for (const s of report.sizes) L(`${String(s.size).padStart(8)}           ${s.ok ? `fits (entry ${s.impactBps} bps below the 30-min average, incl. fee)` : `refused: ${s.why}`}`);
      L(`Largest size that fits: ${report.maxSize ?? "none"} WETH`);
    }
    if (report.scenarios.length) {
      L(`Loan: ${report.maxSize} WETH for ${TERM} days at 2.0%, 5% deposit. Depth = pool depth over the last 30 min vs at the start (the minimum set here is 50%).`);
      L("Scenario                                        Settle   Depth   Vault     Reserve  Lender     Borrower  Net");
      for (const r of report.scenarios) {
        const head = `${r.name.padEnd(46)} ${r.atSettle.toFixed(4)} ${String(r.depthPct + "%").padStart(6)}`;
        if (r.settled) L(`${head}  ${r.returned.toFixed(2).padStart(8)} ${r.draw.toFixed(2).padStart(8)} ${r.lender.toFixed(2).padStart(9)} ${r.borrower.toFixed(2).padStart(9)} ${r.net.toFixed(2).padStart(7)}`);
        else L(`${head}  settle refused: ${r.why} (in-kind fallback opens 7 days after grace)`);
      }
    }
    if (report.gas.loan) L(`Gas for one whole loan (open, deposit, buy, settle): ${report.gas.loan} = ${eth(report.gas.loan)} ETH at this base fee`);
    console.log("");
  }
});
