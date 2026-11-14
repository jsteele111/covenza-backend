/**
 * Audit KRAIT-004: AssetRegistry.setPoolFeeTier refuses a pool that keeps no
 * more price-history slots (observationCardinality) than the TWAP window has
 * seconds, because anyone could then make its TWAP unreadable at will.
 *
 * Call this before setPoolFeeTier so a script explains the problem and skips
 * the pool, instead of failing on a revert.
 *
 * To fix a pool, grow its ring past the window, in steps (each slot costs
 * ~20k gas): pool.increaseObservationCardinalityNext(n), or
 * UniswapLiquidityHelper.warmUpOracle(pool, n), up to twapWindow + 1. The new
 * size takes effect once the pool next writes an observation (any swap that
 * moves the price, or any mint or burn).
 *
 * Audit M-01: setPoolFeeTier also refuses a pool until the pair has a
 * minimum pool liquidity (AssetRegistry.setMinPoolLiquidity) and the pool
 * currently holds at least that much. ensureMinPoolLiquidity sets it first,
 * from the pool config's `minLiquidity` if given, otherwise a TESTNET default
 * of a tenth of the pool's current liquidity. On mainnet, choose it per pair
 * from the depth the pool normally carries: the pool must stay above it on
 * average across the TWAP window for vaults to price or cash-settle there.
 */
const POOL_ABI = [
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];
const FACTORY_ABI = ["function getPool(address, address, uint24) view returns (address)"];

async function checkPoolHistory(registry, tokenA, tokenB, fee, runner) {
  const factory = new (require("ethers").Contract)(await registry.uniswapFactory(), FACTORY_ABI, runner);
  const poolAddr = await factory.getPool(tokenA, tokenB, fee);
  const window = Number(await registry.twapWindow());
  if (poolAddr === "0x0000000000000000000000000000000000000000") {
    return { ok: false, pool: poolAddr, cardinality: 0, window, reason: "no pool at this fee tier" };
  }
  const pool = new (require("ethers").Contract)(poolAddr, POOL_ABI, runner);
  const s = await pool.slot0();
  const cardinality = Number(s.observationCardinality);
  const liquidity = await pool.liquidity();
  const ok = cardinality > window;
  return {
    ok, pool: poolAddr, cardinality, window, liquidity,
    reason: ok ? "" :
      `pool ${poolAddr} keeps ${cardinality} history slots; the ${window}s TWAP window needs more than ${window}. ` +
      `Grow it with increaseObservationCardinalityNext (in steps) to at least ${window + 1}, let it write one observation, then approve it.`,
  };
}

/**
 * Sets the pair's minimum pool liquidity if none is set yet (audit M-01).
 * `send(method, args, label)` performs the call (directly or via sendOrQueue).
 * Returns { ok, reason }.
 */
async function ensureMinPoolLiquidity(registry, tokenA, tokenB, history, configured, send) {
  let min = await registry.minPoolLiquidity(tokenA, tokenB);
  if (min === 0n) {
    min = configured !== undefined ? BigInt(configured) : history.liquidity / 10n;
    if (min === 0n) { return { ok: false, reason: `pool ${history.pool} has no liquidity in range` }; }
    await send("setMinPoolLiquidity", [tokenA, tokenB, min], `minimum pool liquidity ${min}`);
  }
  if (history.liquidity < min) {
    return { ok: false, reason: `pool ${history.pool} holds liquidity ${history.liquidity}, below the pair's minimum ${min}` };
  }
  return { ok: true, reason: "" };
}

module.exports = { checkPoolHistory, ensureMinPoolLiquidity };
