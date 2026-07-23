// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title UniswapTwap
 * @notice Minimal TWAP quote helper for Uniswap V3, used by Vault's forced
 *         swap-back at settlement: reads the pool's time-weighted average
 *         tick over a configured window and converts an input amount to the
 *         TWAP-implied output amount. The vault then requires the actual
 *         swap output to land within a tolerance band of this quote.
 *
 * @dev The tick/price math below (getSqrtRatioAtTick, mulDiv, getQuoteAtTick)
 *      is vendored unchanged from Uniswap's own audited v3-core / v3-periphery
 *      libraries (0.8-compatible branch) — deliberately NOT reimplemented.
 *      Do not modify these functions; they are bit-exact ports of code with
 *      years of production history securing billions in TVL.
 */

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniswapV3Pool {
    function observe(uint32[] calldata secondsAgos)
        external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

library UniswapTwap {

    /**
     * @notice Returns the TWAP-implied output of swapping `amountIn` of
     *         `tokenIn` for `tokenOut` through the given fee tier's pool,
     *         averaged over `window` seconds.
     */
    function quote(
        address factory,
        address tokenIn,
        address tokenOut,
        uint24  fee,
        uint256 amountIn,
        uint32  window
    ) internal view returns (uint256 amountOut) {
        require(window > 0, "TWAP window must be nonzero");

        address pool = IUniswapV3Factory(factory).getPool(tokenIn, tokenOut, fee);
        require(pool != address(0), "No pool for pair/fee");

        int24 avgTick = _consult(pool, window);
        amountOut = _getQuoteAtTick(avgTick, uint128(amountIn), tokenIn, tokenOut);
    }

    /// @dev Arithmetic mean tick over the window. Ported from Uniswap
    ///      v3-periphery OracleLibrary.consult.
    function _consult(address pool, uint32 secondsAgo) private view returns (int24 avgTick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives, ) = IUniswapV3Pool(pool).observe(secondsAgos);
        int56 delta = tickCumulatives[1] - tickCumulatives[0];

        avgTick = int24(delta / int56(uint56(secondsAgo)));
        // Round toward negative infinity
        if (delta < 0 && (delta % int56(uint56(secondsAgo)) != 0)) {
            avgTick--;
        }
    }

    /// @dev Ported from Uniswap v3-periphery OracleLibrary.getQuoteAtTick.
    function _getQuoteAtTick(
        int24 tick,
        uint128 baseAmount,
        address baseToken,
        address quoteToken
    ) private pure returns (uint256 quoteAmount) {
        uint160 sqrtRatioX96 = _getSqrtRatioAtTick(tick);

        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseToken < quoteToken
                ? _mulDiv(ratioX192, baseAmount, 1 << 192)
                : _mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = _mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? _mulDiv(ratioX128, baseAmount, 1 << 128)
                : _mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }

    /// @dev Ported from Uniswap v3-core TickMath.getSqrtRatioAtTick
    ///      (0.8-compatible branch). Bit-exact; do not modify.
    function _getSqrtRatioAtTick(int24 tick) private pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            require(absTick <= 887272, "T");

            uint256 ratio = absTick & 0x1 != 0
                ? 0xfffcb933bd6fad37aa2d162d1a594001
                : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            if (tick > 0) ratio = type(uint256).max / ratio;

            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }

    /// @dev Ported from Uniswap v3-core FullMath.mulDiv (0.8 branch).
    ///      Full-precision (a * b / d) without intermediate overflow.
    function _mulDiv(uint256 a, uint256 b, uint256 denominator) private pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            if (prod1 == 0) {
                require(denominator > 0);
                assembly { result := div(prod0, denominator) }
                return result;
            }

            require(denominator > prod1);

            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;

            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;

            result = prod0 * inv;
            return result;
        }
    }
}
