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
 */
const POOL_ABI = [
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
  const ok = cardinality > window;
  return {
    ok, pool: poolAddr, cardinality, window,
    reason: ok ? "" :
      `pool ${poolAddr} keeps ${cardinality} history slots; the ${window}s TWAP window needs more than ${window}. ` +
      `Grow it with increaseObservationCardinalityNext (in steps) to at least ${window + 1}, let it write one observation, then approve it.`,
  };
}

module.exports = { checkPoolHistory };
