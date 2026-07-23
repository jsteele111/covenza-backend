// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockUniswapV3Pool / MockUniswapV3Factory
 * @notice Simulates the two Uniswap V3 pieces UniswapTwap.quote() touches —
 *         Factory.getPool() and Pool.observe() — for LOCAL TESTING ONLY.
 *
 *         The pool exposes setAvgTick(): observe() returns tick cumulatives
 *         constructed so the consulted average tick over ANY window equals
 *         exactly the configured value. Tests set the tick that implies
 *         their intended TWAP price:
 *           tick 0      => 1:1 (raw units) between the pair
 *           tick 6932   => ~2:1   (1.0001^6932 ~ 2.0)
 *           tick -6932  => ~1:2
 *         With equal-decimal mock tokens, tick 0 keeps test math trivial.
 */
contract MockUniswapV3Pool {

    int24 public avgTick;

    function setAvgTick(int24 _tick) external {
        avgTick = _tick;
    }

    function observe(uint32[] calldata secondsAgos)
        external view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);

        // Cumulative at time (now - secondsAgo) = -avgTick * secondsAgo,
        // so cumulative[now] - cumulative[now - window] = avgTick * window.
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            tickCumulatives[i] = int56(avgTick) * -int56(uint56(secondsAgos[i]));
        }
    }
}

contract MockUniswapV3Factory {

    mapping(address => mapping(address => mapping(uint24 => address))) public pools;

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        pools[tokenA][tokenB][fee] = pool;
        pools[tokenB][tokenA][fee] = pool; // both orderings, as the real factory does
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return pools[tokenA][tokenB][fee];
    }
}
