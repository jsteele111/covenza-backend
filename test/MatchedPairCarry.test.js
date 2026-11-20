const { expect } = require("chai");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * Product 1 — Matched-pair carry (New Products Build Brief, section 5).
 *
 * Question: can TODAY's audited contracts (8b7311a, unchanged) run a carry
 * vault — a WETH loan whose borrower holds wstETH — using settings and a
 * separate deployment alone?
 *
 * Runs against REAL Uniswap V3 (as the M-04 suite does), because the answer
 * depends on the real TWAP, real fees and real price impact.
 *
 * The deployment under test:
 *   - Loan asset WETH; the only other listed asset is wstETH.
 *   - One approved pool: wstETH/WETH at the 0.01% fee tier, started at
 *     1.20 WETH per wstETH, with deep liquidity and full price history.
 *   - The contract's three tier slots are an enum, so the "Matched pair"
 *     tier occupies the Blue chip slot in THIS deployment only:
 *     5% assumed volatility, 5% minimum deposit, 120-day maximum term,
 *     100% exposure cap, 25 bps a year premium.
 *   - Protocol fee set to zero so the numbers line up with the worked
 *     example in the brief (a real deployment would add the borrower's
 *     protocol fee on top).
 *
 * The four checks from the brief:
 *   1. The vault takes a WETH loan and values wstETH in WETH via the TWAP.
 *   2. A 100% cap and a 5% minimum deposit pass the factory's checks.
 *   3. The exposure and loss budgets behave sensibly at about 20x.
 *   4. A matched-pairs-only deployment keeps the per-asset tiers safe.
 * Plus the settlement outcomes from the worked example.
 *
 * "Discount" in the settlement scenarios is measured against the pair's FAIR
 * value at the end of the term (1.20 x 1.0074 = 1.20888), which is how the
 * brief's worked example computes them.
 */
const FACTORY_ARTIFACT = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const POOL_ARTIFACT    = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const ROUTER_ARTIFACT  = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const E  = ethers.parseEther;
const F  = (x) => Number(ethers.formatEther(x));
const f2 = (x) => F(x).toFixed(2);

const FEE        = 100;            // 0.01%: the tier real wstETH/WETH pools use
const WINDOW     = 1800;           // TWAP window, the registry default
const DEEP       = 10n ** 25n;     // pool liquidity (deep, like a major LST pool)
const BLUE_CHIP  = 0;              // enum slot used for "Matched pair" here
const SPECULATIVE = 2;

const P        = E("1000");        // principal
const APR      = 200;              // 2.0% fixed
const TERM     = 90;               // days
const D        = E("50");          // deposit, 5%
const RESERVE  = E("1000");        // protection reserve funded by the operator

const ENTRY_PRICE = 1.20;                 // WETH per wstETH at the start
const FAIR_PRICE  = ENTRY_PRICE * 1.0074; // after a normal quarter's staking yield

// --- Matched-pair tier ---
const TIER = {
  assumedVolBps:       500,        // 5%: volatility BETWEEN the pair
  minDepositBps:       500,        // 5%
  maxTermSeconds:      120 * 86400,
  maxExposureBps:      10000,      // 100%
  insurancePremiumBps: 25,         // 0.25% a year
};

const Q192 = 2n ** 192n;
function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

/** sqrtPriceX96 for `price` units of `quote` per one `base`. */
function sqrtPriceFor(baseAddr, quoteAddr, price) {
  const p = BigInt(Math.round(price * 1e9));
  const baseIsToken0 = BigInt(baseAddr) < BigInt(quoteAddr);
  return baseIsToken0 ? isqrt((p * Q192) / 1_000_000_000n) : isqrt((1_000_000_000n * Q192) / p);
}

async function deployStack() {
  const [operator, lender, borrower, market, keeper, lender2, borrower2] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20", operator);
  const weth = await Mock.deploy("Wrapped Ether", "WETH", 18);
  const wst  = await Mock.deploy("Wrapped staked ETH (mock)", "wstETH", 18);
  const usdc = await Mock.deploy("USD Coin (mock, 18dp)", "USDC", 18);
  const xstk = await Mock.deploy("Stock X", "XSTK", 18);

  // --- Real Uniswap V3, with the 0.01% fee tier switched on as on mainnet ---
  const uniFactory = await new ethers.ContractFactory(FACTORY_ARTIFACT.abi, FACTORY_ARTIFACT.bytecode, operator).deploy();
  await uniFactory.enableFeeAmount(FEE, 1);
  const router = await new ethers.ContractFactory(ROUTER_ARTIFACT.abi, ROUTER_ARTIFACT.bytecode, operator)
    .deploy(ethers.ZeroAddress, await uniFactory.getAddress(), ethers.ZeroAddress, await weth.getAddress());
  const lp = await (await ethers.getContractFactory("UniswapLiquidityHelper", operator)).deploy();
  for (const t of [weth, wst, usdc, xstk]) {
    await t.mint(await lp.getAddress(), E("1000000000"));
    await t.mint(market.address, E("1000000000"));
    await t.connect(market).approve(await router.getAddress(), ethers.MaxUint256);
  }

  async function makePool(base, quote, price, liquidity) {
    await uniFactory.createPool(await base.getAddress(), await quote.getAddress(), FEE);
    const pool = new ethers.Contract(
      await uniFactory.getPool(await base.getAddress(), await quote.getAddress(), FEE), POOL_ARTIFACT.abi, operator);
    await pool.initialize(sqrtPriceFor(await base.getAddress(), await quote.getAddress(), price));
    await lp.addFullRangeLiquidity(await pool.getAddress(), liquidity);
    for (let c = 300; c < WINDOW + 1; c += 300) {
      await lp.warmUpOracle(await pool.getAddress(), c, { gasLimit: 16_000_000 });
    }
    await lp.warmUpOracle(await pool.getAddress(), WINDOW + 1, { gasLimit: 16_000_000 });
    return pool;
  }

  // The matched pair. Also: a wstETH/USDC pool and a Stock X/WETH pool that
  // EXIST on Uniswap, so check 4 can show what the deployment does with them.
  const pairPool  = await makePool(wst, weth, ENTRY_PRICE, DEEP);
  const crossPool = await makePool(wst, usdc, 3600, 10n ** 24n);
  const stockPool = await makePool(xstk, weth, 0.05, 10n ** 24n);
  for (let i = 0; i < 4; i++) {
    for (const pool of [pairPool, crossPool, stockPool]) { await lp.addFullRangeLiquidity(await pool.getAddress(), 1000n); }
    await time.increase(700);
  }

  // --- Identity: everyone attested ---
  const id = await (await ethers.getContractFactory("MockIdentityAdapter", operator)).deploy();
  for (const s of [lender, borrower, lender2, borrower2]) { await id.set(s.address, 7); }

  // --- Registry: the matched-pairs-only deployment ---
  const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
    operator.address, await router.getAddress(), await uniFactory.getAddress(), 0);
  await registry.setOutageConfig(0, 0, 0);
  await registry.setTierConfig(BLUE_CHIP, TIER.assumedVolBps, TIER.minDepositBps, TIER.maxTermSeconds,
    TIER.maxExposureBps, TIER.insurancePremiumBps);
  await registry.addAssetWithTier(await weth.getAddress(), 0, BLUE_CHIP);
  await registry.addAssetWithTier(await wst.getAddress(), 0, BLUE_CHIP);
  await registry.setMinPoolLiquidity(await wst.getAddress(), await weth.getAddress(), DEEP / 10n);
  await registry.setPoolFeeTier(await wst.getAddress(), await weth.getAddress(), FEE);

  // --- Protection reserve, factory ---
  const ipool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
  const twap = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
  const impl = await (await ethers.getContractFactory("Vault", {
    signer: operator, libraries: { UniswapTwap: await twap.getAddress() } })).deploy();
  const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
    await id.getAddress(), await registry.getAddress(), await ipool.getAddress(), operator.address, await impl.getAddress(), 0);
  await factory.setProtocolFeeRateBps(0);
  await ipool.queueSetVaultFactory(await factory.getAddress());
  await ipool.setVaultFactory(await factory.getAddress());
  await weth.mint(operator.address, RESERVE);
  await weth.approve(await ipool.getAddress(), RESERVE);
  await ipool.fund(await weth.getAddress(), RESERVE);

  return { operator, lender, borrower, market, keeper, lender2, borrower2,
           weth, wst, usdc, xstk, uniFactory, router, lp, pairPool, crossPool, stockPool,
           id, registry, ipool, twap, factory };
}

// --- Helpers -----------------------------------------------------------------

/** Lender opens a loan; borrower pays deposit + premium. */
async function openLoan(env, { asset, principal = P, apr = APR, termDays = TERM, deposit = D,
                               maxTier = BLUE_CHIP, lender, borrower } = {}) {
  asset    = asset    || env.weth;
  lender   = lender   || env.lender;
  borrower = borrower || env.borrower;
  await asset.mint(lender.address, principal);
  await asset.connect(lender).approve(await env.factory.getAddress(), principal);
  await env.factory.connect(lender).deployVaultWithTier(
    await asset.getAddress(), borrower.address, principal, apr, termDays, false, deposit, ethers.ZeroAddress, maxTier);
  const vault = await ethers.getContractAt("Vault", await env.factory.allVaults((await env.factory.totalVaults()) - 1n));
  const premium = await vault.insurancePremium();
  await asset.mint(borrower.address, deposit + premium);
  await asset.connect(borrower).approve(await vault.getAddress(), deposit + premium);
  await vault.connect(borrower).payDeposit();
  return { vault, premium };
}

/** Value of `amount` wstETH in WETH at the vault's TWAP. */
async function twapValue(env, amount) {
  if (amount === 0n) return 0n;
  return env.twap.quote(env.uniFactory.getAddress(), env.wst.getAddress(), env.weth.getAddress(), FEE, amount, WINDOW);
}

/** The market trades the pool to `price` (quote per base), then the TWAP catches up. */
async function moveTo(env, pool, base, quote, price) {
  const target = sqrtPriceFor(await base.getAddress(), await quote.getAddress(), price);
  const [current] = await pool.slot0();
  if (target !== current) {
    const zeroForOne = target < current;
    const token0 = await pool.token0();
    const [tokenIn, tokenOut] = (zeroForOne === (token0.toLowerCase() === (await base.getAddress()).toLowerCase()))
      ? [base, quote] : [quote, base];
    await env.router.connect(env.market).exactInputSingle({
      tokenIn: await tokenIn.getAddress(), tokenOut: await tokenOut.getAddress(), fee: FEE,
      recipient: env.market.address, amountIn: E("100000000"), amountOutMinimum: 0n, sqrtPriceLimitX96: target,
    });
  }
  await time.increase(WINDOW + 60);
  await env.lp.addFullRangeLiquidity(await pool.getAddress(), 1000n);
}
const movePair = (env, price) => moveTo(env, env.pairPool, env.wst, env.weth, price);

const buyAll = async (env, vault) => {
  const cash = await env.weth.balanceOf(await vault.getAddress());
  await vault.connect(env.borrower).swap(env.wst.getAddress(), cash - (await vault.deposit()), 1n, FEE);
};

/** Opens the worked-example loan, holds to the deadline, settles. */
async function runQuarter(env, settlementDiscount, { midTermDip = 0 } = {}) {
  const { vault, premium } = await openLoan(env);
  await buyAll(env, vault);
  const held = await vault.heldAmount(await env.wst.getAddress());

  if (midTermDip > 0) {
    await time.increase(45 * 86400);
    await movePair(env, FAIR_PRICE * (1 - midTermDip));
    // Nobody but the borrower can end the loan before its deadline.
    await expect(vault.connect(env.lender).settle()).to.be.revertedWith("Only borrower can close early");
    await expect(vault.connect(env.keeper).settle()).to.be.revertedWith("Only borrower can close early");
  }

  const deadline = await vault.deadline();
  await time.increaseTo(deadline - 3n * 3600n);
  await movePair(env, FAIR_PRICE * (1 - settlementDiscount));
  await time.increaseTo(deadline + 1n);
  await vault.connect(env.lender).settle();

  const r = {
    held,
    returned: await vault.settledTotalReturned(),
    draw:     await vault.settledInsuranceDraw(),
    lender:   await vault.settledLenderPayout(),
    borrower: await vault.settledBorrowerPayout(),
    fee:      await vault.settledFee(),
    premium,
  };
  r.net = F(r.borrower) - F(D) - F(premium);
  return r;
}

const results = [];

// --- Tests -------------------------------------------------------------------

describe("Matched-pair carry: a WETH loan holding wstETH, on today's audited contracts (real Uniswap V3)", function () {
  this.timeout(600000);

  describe("Check 1: the vault takes a WETH loan and values wstETH in WETH through the TWAP", function () {
    it("opens a 1,000 WETH, 90-day loan at 2% and puts all the principal into wstETH at about 1.20", async function () {
      const env = await loadFixture(deployStack);
      const { vault, premium } = await openLoan(env);
      expect(await vault.fullTermFee()).to.equal((P * 200n * 90n) / (10000n * 365n));
      expect(premium).to.equal((P * 25n * (90n + 5n) * 86400n) / (10000n * 365n * 86400n));

      await buyAll(env, vault);
      const held = await vault.heldAmount(await env.wst.getAddress());
      const value = await twapValue(env, held);
      console.log(`      [interest ${f2(await vault.fullTermFee())} WETH, premium ${f2(premium)} WETH; ` +
                  `bought ${F(held).toFixed(3)} wstETH, worth ${f2(value)} WETH at the TWAP]`);
      expect(held).to.be.within(E("833.0"), E("833.34"));       // 1,000 / 1.20 less 0.01% fee and impact
      expect(value).to.be.within(E("999.5"), E("1000"));
      // The deposit stayed in the vault as cash.
      expect(await env.weth.balanceOf(await vault.getAddress())).to.equal(D);
    });

    it("re-values the holding at the average price as the pair's rate rises", async function () {
      const env = await loadFixture(deployStack);
      const { vault } = await openLoan(env);
      await buyAll(env, vault);
      await movePair(env, FAIR_PRICE);
      const value = await twapValue(env, await vault.heldAmount(await env.wst.getAddress()));
      console.log(`      [after a +0.74% rate rise the holding is worth ${f2(value)} WETH]`);
      expect(value).to.be.within(E("1006.8"), E("1007.5"));
    });
  });

  describe("Check 2: the factory accepts a 100% cap and a 5% minimum deposit", function () {
    it("stores the matched-pair tier and sets the 90-day floor at 5% (the volatility formula gives ~4.6%)", async function () {
      const env = await loadFixture(deployStack);
      const cfg = await env.registry.tierConfig(BLUE_CHIP);
      expect(cfg.maxExposureBps).to.equal(10000n);
      expect(cfg.minDepositBps).to.equal(500n);

      // Volatility part alone: 1.8 x 5% x sqrt((90 + 5) / 365) = 459 bps; the 5% minimum binds.
      const floor = await env.registry.minimumDepositBpsForTier(BLUE_CHIP, 90 * 86400);
      expect(floor).to.equal(500n);
      expect(await env.factory.quoteMinimumDeposit(P, BLUE_CHIP, 90, false)).to.equal(D);
      const volOnly = 1.8 * 0.05 * Math.sqrt(95 / 365);
      console.log(`      [volatility floor ${(volOnly * 100).toFixed(2)}%, tier minimum 5.00%, required deposit ${f2(D)} WETH]`);
    });

    it("refuses a deposit below 5%", async function () {
      const env = await loadFixture(deployStack);
      await env.weth.mint(env.lender.address, P);
      await env.weth.connect(env.lender).approve(await env.factory.getAddress(), P);
      await expect(env.factory.connect(env.lender).deployVaultWithTier(
        await env.weth.getAddress(), env.borrower.address, P, APR, TERM, false, E("40"), ethers.ZeroAddress, BLUE_CHIP))
        .to.be.revertedWith("Deposit below the volatility floor for this tier and term");
    });

    it("refuses a term beyond the tier's 120-day maximum", async function () {
      const env = await loadFixture(deployStack);
      await env.weth.mint(env.lender.address, P);
      await env.weth.connect(env.lender).approve(await env.factory.getAddress(), P);
      await expect(env.factory.connect(env.lender).deployVaultWithTier(
        await env.weth.getAddress(), env.borrower.address, P, APR, 121, false, E("60"), ethers.ZeroAddress, BLUE_CHIP))
        .to.be.revertedWith("Term exceeds the maximum for this risk tier");
    });
  });

  describe("Check 3: the exposure and loss budgets at about 20x", function () {
    it("lets the whole principal into wstETH, but never the deposit", async function () {
      const env = await loadFixture(deployStack);
      const { vault } = await openLoan(env);
      await buyAll(env, vault);
      await expect(vault.connect(env.borrower).swap(env.wst.getAddress(), E("1"), 1n, FEE))
        .to.be.revertedWith("Action would touch the deposit - deposit is not investable");
      const held = await twapValue(env, await vault.heldAmount(await env.wst.getAddress()));
      const exposure = (F(held) + F(D)) / F(D);
      console.log(`      [exposure ${f2(held)} WETH on a ${f2(D)} WETH deposit: ${exposure.toFixed(1)}x]`);
    });

    it("exposure budget: after the pair rises, profits can't be re-bought past 100% of principal", async function () {
      const env = await loadFixture(deployStack);
      const { vault } = await openLoan(env);
      await buyAll(env, vault);
      await movePair(env, ENTRY_PRICE * 1.03);
      // Selling part of the position is always allowed.
      await vault.connect(env.borrower).swapBack(env.wst.getAddress(), E("100"), 1n);
      const spare = (await env.weth.balanceOf(await vault.getAddress())) - D;
      // Buying all of it back would put more than 100% of principal into wstETH.
      await expect(vault.connect(env.borrower).swap(env.wst.getAddress(), spare, 1n, FEE))
        .to.be.revertedWith("Holdings exceed exposure budget");
      // Buying back up to the budget is fine.
      await vault.connect(env.borrower).swap(env.wst.getAddress(), E("50"), 1n, FEE);
      const value = await twapValue(env, await vault.heldAmount(await env.wst.getAddress()));
      expect(value).to.be.lessThanOrEqual(P);
    });

    it("loss budget: a ~4% discount stops new purchases but never sales, and nobody can force a close", async function () {
      const env = await loadFixture(deployStack);
      const { vault } = await openLoan(env);
      await buyAll(env, vault);
      await movePair(env, ENTRY_PRICE * 0.96);

      await expect(vault.connect(env.lender).settle()).to.be.revertedWith("Only borrower can close early");
      await vault.connect(env.borrower).swapBack(env.wst.getAddress(), E("10"), 1n);      // sale allowed
      await expect(vault.connect(env.borrower).swap(env.wst.getAddress(), E("5"), 1n, FEE))
        .to.be.revertedWith("Trading losses would exceed the deposit");

      // Where purchases stop: cash + holdings x (1 - 2% tolerance) must stay >= principal.
      const keep = 1 - Number(await env.registry.twapToleranceBps()) / 10000;
      const entryValue = 1000 * 0.9997;
      const stopAt = 1 - (F(P) - F(D)) / (entryValue * keep);
      console.log(`      [purchases stop once the pair is ~${(stopAt * 100).toFixed(1)}% below entry; ` +
                  `the 2% tolerance haircut uses ~${((1 - keep) * entryValue).toFixed(0)} of the ${F(D)} WETH deposit's room]`);
    });
  });

  describe("Settlement: the worked example (90 days, discount measured against fair value 1.20888)", function () {
    after(function () {
      if (results.length === 0) return;
      console.log("\n      Worked example, as settled by the contracts (WETH):");
      console.log("      Scenario                         Vault    Reserve   Lender    Borrower  Borrower net");
      for (const r of results) {
        console.log(`      ${r.name.padEnd(32)} ${f2(r.returned).padStart(8)} ${f2(r.draw).padStart(9)} ` +
          `${f2(r.lender).padStart(9)} ${f2(r.borrower).padStart(10)} ${r.net.toFixed(2).padStart(12)}`);
      }
      console.log("      (Borrower net = payout - 50 deposit - premium. Brief: +1.42, +1.42, -28.8, -50.65.)\n");
    });

    it("normal quarter: lender paid in full, borrower about +1.4 WETH net", async function () {
      const env = await loadFixture(deployStack);
      const r = await runQuarter(env, 0);
      results.push({ name: "Normal quarter (+0.74%)", ...r });
      expect(r.draw).to.equal(0n);
      expect(r.lender).to.equal(P + r.fee);
      expect(F(r.borrower)).to.be.closeTo(52.07, 0.6);
      expect(r.net).to.be.closeTo(1.42, 0.6);
    });

    it("a temporary 4% discount mid-term changes nothing: no liquidation, same outcome", async function () {
      const env = await loadFixture(deployStack);
      const r = await runQuarter(env, 0, { midTermDip: 0.04 });
      results.push({ name: "4% dip mid-term, recovers", ...r });
      expect(r.draw).to.equal(0n);
      expect(r.lender).to.equal(P + r.fee);
      expect(r.net).to.be.closeTo(1.42, 0.6);
    });

    it("3% discount still there at settlement: borrower loses ~29, lender paid in full", async function () {
      const env = await loadFixture(deployStack);
      const r = await runQuarter(env, 0.03);
      results.push({ name: "3% discount at settlement", ...r });
      expect(r.draw).to.equal(0n);
      expect(r.lender).to.equal(P + r.fee);
      expect(r.net).to.be.closeTo(-28.8, 0.6);
    });

    it("8% discount at settlement: reserve restores principal, interest lost, borrower gets 0", async function () {
      const env = await loadFixture(deployStack);
      const r = await runQuarter(env, 0.08);
      results.push({ name: "8% discount at settlement", ...r });
      expect(F(r.returned)).to.be.closeTo(976.4, 0.6);
      expect(r.draw).to.equal(P - r.returned);
      expect(r.lender).to.equal(P);
      expect(r.borrower).to.equal(0n);
    });
  });

  describe("Check 4: a matched-pairs-only deployment keeps per-asset tiers safe", function () {
    it("an asset the deployment hasn't listed can't be bought, even with a Uniswap pool", async function () {
      const env = await loadFixture(deployStack);
      const { vault } = await openLoan(env);
      await expect(vault.connect(env.borrower).swap(env.xstk.getAddress(), E("10"), 1n, FEE))
        .to.be.revertedWith("Destination asset not whitelisted");
    });

    it("a listed asset in a riskier tier is refused by a matched-pair loan", async function () {
      const env = await loadFixture(deployStack);
      await env.registry.addAssetWithTier(await env.xstk.getAddress(), 0, SPECULATIVE);
      await env.registry.setMinPoolLiquidity(await env.xstk.getAddress(), await env.weth.getAddress(), 10n ** 23n);
      await env.registry.setPoolFeeTier(await env.xstk.getAddress(), await env.weth.getAddress(), FEE);
      const { vault } = await openLoan(env);
      await expect(vault.connect(env.borrower).swap(env.xstk.getAddress(), E("10"), 1n, FEE))
        .to.be.revertedWith("Asset exceeds this vault's risk mandate");
    });

    it("with no cross-pair pool approved, a USDC loan can't hold wstETH on the 5% tier", async function () {
      const env = await loadFixture(deployStack);
      await env.registry.addAssetWithTier(await env.usdc.getAddress(), 0, BLUE_CHIP);
      const { vault } = await openLoan(env, {
        asset: env.usdc, principal: E("100000"), deposit: E("5000"), lender: env.lender2, borrower: env.borrower2 });
      await expect(vault.connect(env.borrower2).swap(env.wst.getAddress(), E("95000"), 1n, FEE))
        .to.be.revertedWith("No approved pool for this pair");
    });

    it("OPERATOR RULE: if a cross-pair pool were approved, the contracts would allow it", async function () {
      // This test passes when the hazard is REAL. Tiers belong to assets, not
      // pairs: approving wstETH/USDC would let a USDC loan hold wstETH (~60%
      // volatility against USDC) with a deposit sized for 5%. Only the
      // operator's pool approvals prevent it.
      const env = await loadFixture(deployStack);
      await env.registry.addAssetWithTier(await env.usdc.getAddress(), 0, BLUE_CHIP);
      await env.registry.setMinPoolLiquidity(await env.wst.getAddress(), await env.usdc.getAddress(), 10n ** 23n);
      await env.registry.setPoolFeeTier(await env.wst.getAddress(), await env.usdc.getAddress(), FEE);
      const { vault } = await openLoan(env, {
        asset: env.usdc, principal: E("100000"), deposit: E("5000"), lender: env.lender2, borrower: env.borrower2 });
      await vault.connect(env.borrower2).swap(env.wst.getAddress(), E("95000"), 1n, FEE);
      expect(await vault.isHeld(await env.wst.getAddress())).to.equal(true);
      console.log("      [confirmed: the safety of the 5% tier rests on approving matched-pair pools only]");
    });

    it("OPERATOR RULE: one draw is capped at 5% of the reserve, so size the reserve to the largest loan", async function () {
      const env = await loadFixture(deployStack);
      // Shrink the reserve to 100 WETH (+ premiums) through the timelocked withdrawal.
      await env.ipool.queueAdminWithdraw(await env.weth.getAddress(), env.operator.address, E("900"));
      await env.ipool.adminWithdraw(await env.weth.getAddress(), env.operator.address, E("900"));
      const r = await runQuarter(env, 0.08);
      const shareBps = await env.ipool.maxDrawShareBps();
      console.log(`      [8% discount, 100 WETH reserve: draw ${f2(r.draw)} WETH (cap ${Number(shareBps) / 100}% of reserve), ` +
                  `lender receives ${f2(r.lender)} of ${f2(P)} principal]`);
      expect(r.draw).to.be.lessThan(P - r.returned);
      expect(r.lender).to.be.lessThan(P);
    });
  });
});
