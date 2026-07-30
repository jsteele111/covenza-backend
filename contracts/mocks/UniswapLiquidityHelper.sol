// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IERC20.sol";

interface IUniswapV3PoolActions {
    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount,
        bytes calldata data
    ) external returns (uint256 amount0, uint256 amount1);

    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;

    function token0() external view returns (address);
    function token1() external view returns (address);
    function tickSpacing() external view returns (int24);

    function slot0() external view returns (
        uint160 sqrtPriceX96, int24 tick, uint16 observationIndex,
        uint16 observationCardinality, uint16 observationCardinalityNext,
        uint8 feeProtocol, bool unlocked
    );
}

/**
 * @title UniswapLiquidityHelper
 * @notice Provides liquidity directly to a REAL Uniswap V3 pool, for test-
 *         network setup only.
 *
 * @dev    Why this exists: Uniswap's own NonfungiblePositionManager is the
 *         normal way to add liquidity, but deploying it drags in NFTDescriptor
 *         and NonfungibleTokenPositionDescriptor with library linking — a lot
 *         of moving parts for a testnet pool. Pool.mint() is the primitive
 *         underneath, and it only requires the caller to implement one
 *         callback.
 *
 *         The deliberate simplification is that this does NOT compute the
 *         liquidity for a desired token amount (Uniswap's LiquidityAmounts
 *         math). It works the other way round: the caller names a liquidity
 *         figure L, the pool works out what that costs, and the callback pays
 *         whatever is demanded from this contract's own balance. So the setup
 *         script funds this contract generously and picks L by feel. That is
 *         fine for a testnet pool and would not be fine for anything else.
 *
 *         Positions are full-range, so liquidity is active at every price and
 *         a test can move the pool wherever it likes without falling out of
 *         range.
 */
contract UniswapLiquidityHelper {

    /// @dev Widest range Uniswap V3 permits, before tick-spacing alignment.
    int24 private constant MIN_TICK = -887272;
    int24 private constant MAX_TICK =  887272;

    /// @notice Mints a full-range position of `liquidity` into `pool`.
    ///         Fund this contract with both tokens first.
    function addFullRangeLiquidity(address pool, uint128 liquidity)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        int24 spacing = IUniswapV3PoolActions(pool).tickSpacing();

        // Ticks must be multiples of the pool's spacing, and must sit INSIDE
        // the permitted range after rounding — hence rounding toward zero.
        int24 tickLower = (MIN_TICK / spacing) * spacing;
        int24 tickUpper = (MAX_TICK / spacing) * spacing;

        (amount0, amount1) = IUniswapV3PoolActions(pool).mint(
            address(this), tickLower, tickUpper, liquidity, abi.encode(pool)
        );
    }

    /**
     * @notice Called back by the pool during mint() to collect what the
     *         position costs.
     *
     * @dev    Verifying msg.sender is the pool we asked for matters: without
     *         it, anyone could call this and drain the contract by claiming
     *         tokens are owed. The encoded pool address from addFullRange-
     *         Liquidity is what makes that check possible.
     */
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external {
        address expectedPool = abi.decode(data, (address));
        require(msg.sender == expectedPool, "Callback from unexpected pool");

        if (amount0Owed > 0) {
            require(
                IERC20(IUniswapV3PoolActions(msg.sender).token0()).transfer(msg.sender, amount0Owed),
                "token0 transfer failed"
            );
        }
        if (amount1Owed > 0) {
            require(
                IERC20(IUniswapV3PoolActions(msg.sender).token1()).transfer(msg.sender, amount1Owed),
                "token1 transfer failed"
            );
        }
    }

    /// @notice Convenience passthrough — a fresh pool has cardinality 1 and
    ///         cannot serve any TWAP until this is raised AND enough blocks
    ///         with activity have written observations into the ring buffer.
    function warmUpOracle(address pool, uint16 cardinality) external {
        IUniswapV3PoolActions(pool).increaseObservationCardinalityNext(cardinality);
    }

    /// @notice Reports oracle readiness, so a script can poll rather than guess.
    function oracleStatus(address pool)
        external view
        returns (uint16 cardinality, uint16 cardinalityNext, int24 tick)
    {
        (, int24 t, , uint16 c, uint16 cNext, , ) = IUniswapV3PoolActions(pool).slot0();
        return (c, cNext, t);
    }
}
