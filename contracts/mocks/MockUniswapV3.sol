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

    /**
     * @notice How far back this pool can actually be observed, in seconds.
     *
     * @dev    Defaults to unlimited, so every pre-existing test behaves
     *         exactly as before. Set it to simulate a pool whose observation
     *         cardinality cannot serve the requested window:
     *           0    => cardinality 1 — only the current observation exists,
     *                   so ANY non-zero window reverts (a brand-new pool, or
     *                   one nobody has paid to expand)
     *           600  => ten minutes of history; a 1800s TWAP window reverts
     *
     *         Without this knob the suite is structurally blind to an entire
     *         bug class: the old mock synthesised tick cumulatives for any
     *         window and never reverted, so a pool that real Uniswap could
     *         not quote looked perfectly healthy in tests.
     */
    uint32 public maxWindow = type(uint32).max;

    function setAvgTick(int24 _tick) external {
        avgTick = _tick;
    }

    function setMaxWindow(uint32 _maxWindow) external {
        maxWindow = _maxWindow;
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
            // Real Uniswap V3 reverts with "OLD" when asked for an
            // observation older than the pool retains.
            require(secondsAgos[i] <= maxWindow, "OLD");
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
