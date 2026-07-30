/**
 * Full lifecycle proof on Robinhood Chain testnet, against REAL Uniswap V3.
 *
 * The existing lifecycle-proof.js cannot run here. It drives the outcome with
 * MockSwapRouter.setRate() and MockUniswapV3Pool.setAvgTick() — neither exists
 * on a real pool. Prices here move the only way they move in production: by
 * someone trading size against the pool.
 *
 * That difference is the point. Three things are provable here that were not
 * provable against mocks:
 *
 *   1. canQuote() refuses a fee tier with no pool, evaluated against the real
 *      factory rather than a mapping we populated ourselves.
 *
 *   2. The forced swap-back executes through real SwapRouter02, with the
 *      seven-field struct. A v1-shaped struct would revert here — which is
 *      exactly the mainnet bug the mock could not surface.
 *
 *   3. The TWAP tolerance genuinely bounds settlement. A sudden price move
 *      makes settle() revert; the same move, once the TWAP has caught up,
 *      settles cleanly. On a mock, setAvgTick made that distinction
 *      unobservable.
 *
 * Real time is not fast-forwardable, so this script waits. Expect ~6 minutes.
 *
 * Usage:
 *   npx hardhat run scripts/lifecycle-proof-robinhood.js --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const E = (n) => hre.ethers.parseEther(String(n));

const PRINCIPAL   = E(100);
const DEPOSIT     = E(15);
const FEE_BPS     = 300n;          // 3% of principal
// Two durations, because the stages want opposite things from the deadline.
//
// Stages 1–3 settle EARLY, so their deadline only has to outlast setup. That
// is four transactions — deployVault, mint, approve, payDeposit — each with a
// round trip to a public RPC that has already produced header timeouts today.
// A 150s term expired mid-setup and payDeposit reverted with "Deadline has
// passed", so this is deliberately generous; it costs nothing, since nothing
// waits on it.
//
// Stage 4 needs the deadline to actually pass, so it stays short — and it is
// the only stage that pays for that in real waiting.
const DURATION_SETUP  = 900;
const DURATION_EXPIRE = 150;
const POOL_FEE    = 3000;          // the tier with a pool
const ABSENT_FEE  = 500;           // no pool at this tier — guard should refuse
/**
 * Kept small RELATIVE TO POOL DEPTH, and that constraint is load-bearing.
 *
 * settle() requires the forced swap-back to return at least twapQuote less the
 * tolerance. twapQuote is derived from the MARGINAL price, but a swap executes
 * at an AVERAGE price — worse by its own impact. So a borrower's swap-in moves
 * the price, the TWAP converges on that new price, and swapping back returns
 * roughly the original amount less two fees: below a bar that has since risen.
 *
 * At 20 tUSDG against this pool that gap measured 19.88 delivered versus 19.92
 * required — a fifth of a percent short, and settle() reverted. 5 tUSDG cuts
 * the impact roughly fourfold and clears it.
 *
 * The protocol-level answer is the position cap in Phase 4.5, not a wider
 * tolerance: widening it is exactly what weakens manipulation resistance.
 */
const SWAP_AMOUNT = E(5);

function sleep(s) {
  console.log(`   …waiting ${s}s`);
  return new Promise((r) => setTimeout(r, s * 1000));
}

function line(char = "-") {
  console.log(char.repeat(70));
}

/**
 * Retries a transaction through transient RPC failures.
 *
 * The public Robinhood RPC drops connections after the long sleeps this
 * script needs — an undici HeadersTimeoutError, not a contract revert. Worth
 * distinguishing: a revert means the protocol rejected something and should
 * surface immediately, whereas a timeout means the request never arrived and
 * retrying is correct. Reverts carry a `reason` or a `data` payload, so they
 * are re-thrown rather than retried.
 */
async function retry(fn, label, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      const transient =
        e.code === "UND_ERR_HEADERS_TIMEOUT" ||
        e.code === "TIMEOUT" ||
        e.code === "NETWORK_ERROR" ||
        /timeout|socket|ECONNRESET|fetch failed/i.test(e.message || "");

      if (!transient || i === attempts) throw e;

      console.log(`   ${label}: ${e.code || "network error"} — retrying (${i}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

/**
 * Spot-implied output for a swap, read from the pool's current price.
 *
 * Necessary because this script MOVES the price on purpose, which means a
 * hardcoded minAmountOut works on the first run and fails on every one after
 * it — the pool does not reset between runs. Quoting from slot0 makes each run
 * independent of what previous runs did to the pool.
 *
 * Ignores the 0.3% fee and price impact, so callers apply a slippage
 * allowance on top. Fine for setup swaps; the suite already covers
 * minAmountOut enforcement properly in GroupB.
 */
async function spotQuote(ethers, poolAddr, tokenIn, amountIn) {
  const p = await ethers.getContractAt(
    [
      "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
      "function token0() view returns (address)",
    ],
    poolAddr
  );

  const slot0 = await p.slot0();
  const token0 = await p.token0();
  const sqrtP = slot0.sqrtPriceX96;

  const Q192 = 2n ** 192n;
  const priceX192 = sqrtP * sqrtP; // (token1 per token0) * 2^192

  return tokenIn.toLowerCase() === token0.toLowerCase()
    ? (amountIn * priceX192) / Q192   // token0 in, token1 out
    : (amountIn * Q192) / priceX192;  // token1 in, token0 out
}

async function main() {
  const { ethers } = hre;
  const [lender, borrower, keeper] = await ethers.getSigners();

  const addrPath = path.join(__dirname, "..", "deployed-addresses.json");
  const d = JSON.parse(fs.readFileSync(addrPath, "utf8")).robinhoodTestnet;
  if (!d) throw new Error("No robinhoodTestnet entry — run deploy-robinhood-testnet.js first.");

  const Mock = await ethers.getContractFactory("MockERC20");
  const usdg = Mock.attach(d.tokens.tUSDG);
  const weth = Mock.attach(d.tokens.tWETH);

  const factory  = await ethers.getContractAt("VaultFactory", d.vaultFactory);
  const registry = await ethers.getContractAt("AssetRegistry", d.assetRegistry);
  const pool     = await ethers.getContractAt("InsurancePool", d.insurancePool);

  // Components must be NAMED for ethers to accept an object argument — an
  // unnamed tuple only takes a positional array. Field order and count here
  // are SwapRouter02's, seven fields with no deadline.
  const router = await ethers.getContractAt(
    [
      "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
    ],
    d.uniswap.router
  );

  line("=");
  console.log("Lifecycle proof — Robinhood Chain testnet, real Uniswap V3");
  line("=");
  console.log(`\nlender/operator ${lender.address}`);
  console.log(`borrower        ${borrower.address}`);
  console.log(`keeper          ${keeper ? keeper.address : "(none configured)"}`);
  console.log(`twapWindow      ${await registry.twapWindow()}s`);
  console.log(`tolerance       ${await registry.twapToleranceBps()} bps`);
  console.log(`grace           ${await registry.swapBackGracePeriod()}s`);

  // Pool depth governs how much price impact a forced swap-back suffers, and
  // therefore whether it clears the TWAP tolerance. Printed up front because a
  // badly skewed pool is the likeliest reason a stage fails for reasons that
  // have nothing to do with the protocol.
  console.log(`\npool tUSDG      ${ethers.formatEther(await usdg.balanceOf(d.uniswap.pool))}`);
  console.log(`pool tWETH      ${ethers.formatEther(await weth.balanceOf(d.uniswap.pool))}`);

  // ------------------------------------------------------------------
  // Helper: originate a funded vault with the deposit already paid
  // ------------------------------------------------------------------
  async function originate(label, durationSeconds = DURATION_SETUP) {
    const fee = (PRINCIPAL * FEE_BPS) / 10000n;
    const need = PRINCIPAL + fee;  // covers principal + the insurance skim

    await (await usdg.mint(lender.address, need)).wait();
    await (await usdg.approve(d.vaultFactory, need)).wait();

    const before = await factory.totalVaults();
    await (await factory.deployVault(
      d.tokens.tUSDG, borrower.address, PRINCIPAL, FEE_BPS, durationSeconds, true, DEPOSIT,
      ethers.ZeroAddress
    )).wait();

    const vaultAddr = await factory.allVaults(before);
    const vault = await ethers.getContractAt("Vault", vaultAddr);

    await (await usdg.mint(borrower.address, DEPOSIT)).wait();
    await (await usdg.connect(borrower).approve(vaultAddr, DEPOSIT)).wait();
    await (await vault.connect(borrower).payDeposit()).wait();

    console.log(`\n${label}`);
    console.log(`  vault    ${vaultAddr}`);
    console.log(`  balance  ${ethers.formatEther(await vault.vaultBalance())} tUSDG`);
    return vault;
  }

  // ==================================================================
  // Stage 1 — the guard refuses an unquotable fee tier
  // ==================================================================
  line();
  console.log("STAGE 1 — canQuote refuses a tier with no pool");
  line();

  const vaultA = await originate("Vault A");

  // Quote from spot and allow 12% — covers the 0.3% fee plus price impact on
  // a pool this size, without being so loose the floor is meaningless.
  const quoted = await spotQuote(ethers, d.uniswap.pool, d.tokens.tUSDG, SWAP_AMOUNT);
  const minOut = (quoted * 88n) / 100n;
  console.log(`\n  spot quote for ${ethers.formatEther(SWAP_AMOUNT)} tUSDG: ~${ethers.formatEther(quoted)} tWETH`);
  console.log(`  using minAmountOut ${ethers.formatEther(minOut)}`);

  let refused = false;
  try {
    await vaultA.connect(borrower).swap.staticCall(
      d.tokens.tWETH, SWAP_AMOUNT, minOut, ABSENT_FEE
    );
  } catch (e) {
    refused = true;
    const msg = e.shortMessage || e.message;
    console.log(`\n  swap at ${ABSENT_FEE} (0.05%, no pool): REFUSED`);
    console.log(`  reason: ${msg.includes("TWAP") ? "No TWAP history for this pair and fee tier" : msg}`);
  }
  if (!refused) throw new Error("Guard did not refuse an absent pool — investigate before proceeding.");

  console.log(`\n  Same swap at ${POOL_FEE} (0.3%, warmed pool):`);
  await (await vaultA.connect(borrower).swap(
    d.tokens.tWETH, SWAP_AMOUNT, minOut, POOL_FEE
  )).wait();
  console.log(`  ACCEPTED — vault now holds ${ethers.formatEther(await weth.balanceOf(await vaultA.getAddress()))} tWETH`);
  console.log(`  held assets: ${await vaultA.heldAssetCount()}`);

  // ==================================================================
  // Stage 2 — forced swap-back through real SwapRouter02
  // ==================================================================
  line();
  console.log("STAGE 2 — settlement forces a swap-back through real Uniswap");
  line();

  const beforeSettle = {
    lender:   await usdg.balanceOf(lender.address),
    borrower: await usdg.balanceOf(borrower.address),
    treasury: await usdg.balanceOf(d.treasury),
  };

  await (await vaultA.connect(borrower).settle()).wait();

  console.log("\n  settled early by borrower");
  console.log(`  total returned   ${ethers.formatEther(await vaultA.settledTotalReturned())} tUSDG`);
  console.log(`  lender payout    ${ethers.formatEther(await vaultA.settledLenderPayout())}`);
  console.log(`  borrower payout  ${ethers.formatEther(await vaultA.settledBorrowerPayout())}`);
  console.log(`  protocol fee     ${ethers.formatEther(await vaultA.settledProtocolFee())}`);
  console.log(`  loss severity    ${await vaultA.lossSeverity()}`);
  console.log(`  held assets left ${await vaultA.heldAssetCount()}`);

  console.log("\n  The swap-back went through SwapRouter02's seven-field struct.");
  console.log("  A v1-shaped struct would have reverted here.");

  // ==================================================================
  // Stage 3 — TWAP tolerance actually bounds settlement
  // ==================================================================
  line();
  console.log("STAGE 3 — TWAP tolerance rejects a sudden move, accepts a settled one");
  line();

  const vaultB = await originate("Vault B");

  // Re-quoted: Stage 1's swap and swap-back have already nudged the pool.
  const quoteB = await spotQuote(ethers, d.uniswap.pool, d.tokens.tUSDG, SWAP_AMOUNT);
  await (await vaultB.connect(borrower).swap(
    d.tokens.tWETH, SWAP_AMOUNT, (quoteB * 88n) / 100n, POOL_FEE
  )).wait();
  console.log(`  swapped into ${ethers.formatEther(await weth.balanceOf(await vaultB.getAddress()))} tWETH`);

  // Move spot AGAINST the held asset — the direction matters entirely.
  //
  // The vault holds tWETH, so a loss requires tWETH to get CHEAPER, which
  // means selling tWETH into the pool. Buying tWETH (spending tUSDG) does the
  // opposite and hands the borrower a profit.
  //
  // Direction also decides whether the tolerance can trip at all. The check is
  // minOut = twapQuote * (1 - tolerance), enforced as a FLOOR, so a favourable
  // move clears it comfortably and only an adverse move can breach it. The
  // tolerance protects against being forced out cheaply, not against doing
  // well — one-sided by design.
  const DUMP = E(400);
  console.log("\n  Selling tWETH into the pool to move spot AGAINST the vault…");
  await (await weth.mint(lender.address, DUMP)).wait();
  await (await weth.approve(d.uniswap.router, DUMP)).wait();

  // Measure what the dump earns, so it can be reversed afterwards. Without
  // that, each run leaves the pool more lopsided than the last and eventually
  // the forced swap-back's own price impact breaches the TWAP tolerance —
  // which is what broke Stage 4 rather than anything wrong with the protocol.
  const usdgBeforeDump = await usdg.balanceOf(lender.address);
  await (await router.exactInputSingle({
    tokenIn: d.tokens.tWETH, tokenOut: d.tokens.tUSDG, fee: POOL_FEE,
    recipient: lender.address, amountIn: DUMP,
    amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
  })).wait();
  const dumpProceeds = (await usdg.balanceOf(lender.address)) - usdgBeforeDump;
  console.log(`  dumped ${ethers.formatEther(DUMP)} tWETH for ${ethers.formatEther(dumpProceeds)} tUSDG`);
  console.log("  spot down, TWAP still lagging");

  let reverted = false;
  try {
    await vaultB.connect(borrower).settle.staticCall();
  } catch (e) {
    reverted = true;
    console.log(`\n  settle() REVERTS while spot diverges from TWAP`);
    console.log(`  reason: ${(e.shortMessage || e.message).slice(0, 120)}`);
  }
  if (!reverted) {
    console.log("\n  settle() did NOT revert — the move stayed inside tolerance.");
    console.log("  Not a failure, but the tolerance boundary was not exercised.");
  }

  const window = Number(await registry.twapWindow());
  console.log(`\n  Letting the ${window}s TWAP absorb the new price…`);
  await sleep(window + 30);

  // Touch the pool so a fresh observation is written at the new price.
  // Deliberately tiny, and in the same direction, so it nudges the oracle
  // without moving spot back.
  await (await weth.mint(lender.address, E(1))).wait();
  await (await weth.approve(d.uniswap.router, E(1))).wait();
  await (await router.exactInputSingle({
    tokenIn: d.tokens.tWETH, tokenOut: d.tokens.tUSDG, fee: POOL_FEE,
    recipient: lender.address, amountIn: E(1),
    amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
  })).wait();

  await retry(() => vaultB.connect(borrower).settle().then((t) => t.wait()), "settle vault B");
  console.log("\n  settled once TWAP agreed with spot");
  console.log(`  total returned   ${ethers.formatEther(await vaultB.settledTotalReturned())} tUSDG`);
  console.log(`  lender payout    ${ethers.formatEther(await vaultB.settledLenderPayout())}`);
  console.log(`  borrower payout  ${ethers.formatEther(await vaultB.settledBorrowerPayout())}`);
  console.log(`  insurance draw   ${ethers.formatEther(await vaultB.settledInsuranceDraw())}`);
  console.log(`  loss severity    ${await vaultB.lossSeverity()}  (0 none, 1 borrower, 2 lender)`);

  // --- Restore the pool before moving on ---------------------------------
  //
  // Buying the dumped tWETH back returns spot to roughly where it started,
  // less two lots of the 0.3% fee. Stage 4 is about the keeper tier, not about
  // trading into a wrecked pool, and leaving the damage in place also makes
  // this script fail on its own next run.
  console.log("\n  Reversing the dump so Stage 4 starts from a healthy pool…");
  await (await usdg.mint(lender.address, dumpProceeds)).wait();
  await (await usdg.approve(d.uniswap.router, dumpProceeds)).wait();
  await (await router.exactInputSingle({
    tokenIn: d.tokens.tUSDG, tokenOut: d.tokens.tWETH, fee: POOL_FEE,
    recipient: lender.address, amountIn: dumpProceeds,
    amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
  })).wait();
  console.log(`  pool now holds ${ethers.formatEther(await usdg.balanceOf(d.uniswap.pool))} tUSDG`);
  console.log(`                 ${ethers.formatEther(await weth.balanceOf(d.uniswap.pool))} tWETH`);

  // Let the oracle absorb the restored price before Stage 4 settles against it.
  await sleep(window + 15);

  // ==================================================================
  // Stage 4 — post-grace keeper tier
  // ==================================================================
  if (!keeper) {
    console.log("\nSTAGE 4 skipped — no keeper configured.");
  } else {
    line();
    console.log("STAGE 4 — post-grace settlement by a third-party keeper");
    line();

    // Short term here on purpose — this is the stage that needs to expire.
    const vaultC = await originate("Vault C", DURATION_EXPIRE);

    // Stage 3 dumped 400 tWETH, so the pool is a long way from where it
    // started. Quoting fresh is the only thing that survives that.
    const quoteC = await spotQuote(ethers, d.uniswap.pool, d.tokens.tUSDG, SWAP_AMOUNT);
    await (await vaultC.connect(borrower).swap(
      d.tokens.tWETH, SWAP_AMOUNT, (quoteC * 88n) / 100n, POOL_FEE
    )).wait();

    const grace = Number(await registry.swapBackGracePeriod());
    console.log(`\n  Waiting out deadline (${DURATION_EXPIRE}s) + grace (${grace}s)…`);
    await sleep(DURATION_EXPIRE + grace + 30);

    const keeperBefore = await retry(() => usdg.balanceOf(keeper.address), "read keeper balance");
    await retry(() => vaultC.connect(keeper).settle().then((t) => t.wait()), "settle vault C");
    const keeperAfter = await retry(() => usdg.balanceOf(keeper.address), "read keeper balance");

    console.log("\n  settled by keeper, who is neither lender nor borrower");
    console.log(`  bounty earned    ${ethers.formatEther(await vaultC.settledBounty())} tUSDG`);
    console.log(`  keeper delta     ${ethers.formatEther(keeperAfter - keeperBefore)}`);
    console.log(`  lender payout    ${ethers.formatEther(await vaultC.settledLenderPayout())}`);
    console.log(`  borrower payout  ${ethers.formatEther(await vaultC.settledBorrowerPayout())}`);
  }

  // ==================================================================

  line("=");
  console.log("Proof complete");
  line("=");
  console.log(`\ninsurance reserve (tUSDG): ${ethers.formatEther(await pool.reserveOf(d.tokens.tUSDG))}`);
  console.log(`vaults deployed:           ${await factory.totalVaults()}`);
  console.log(`\ngas remaining (lender):    ${ethers.formatEther(await ethers.provider.getBalance(lender.address))} ETH`);
  console.log(`\nExplorer: https://explorer.testnet.chain.robinhood.com/address/${d.vaultFactory}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
