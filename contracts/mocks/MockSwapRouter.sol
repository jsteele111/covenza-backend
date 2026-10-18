// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IERC20.sol";

/**
 * @title MockSwapRouter
 * @notice Simulates Uniswap V3's SwapRouter for LOCAL TESTING ONLY.
 *         Implements exactInputSingle() with configurable pair rates so
 *         tests can simulate price movement — including genuine losses:
 *         swap in at one rate, drop the rate, swap back for less.
 *
 *         Rates are directional: setRate(tokenIn, tokenOut, num, den)
 *         means amountOut = amountIn * num / den for that direction only.
 *         Tests configure both directions explicitly — an asymmetric pair
 *         of rates is exactly how a price move between swap-in and
 *         swap-back is expressed.
 *
 *         Enforces amountOutMinimum with Uniswap's own revert message,
 *         so slippage-protection tests exercise the real failure path.
 *         The router must be funded with output-token inventory by the
 *         test (MockERC20.mint straight to this address).
 */
contract MockSwapRouter {

    // Mirrors **SwapRouter02**, which is what Robinhood Chain deployed — no
    // `deadline` field. See the ISwapRouter comment in Vault.sol: the missing
    // field changes the function selector, so a mock shaped like v1 would
    // pass tests while mainnet reverted on every swap.
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct Rate { uint256 num; uint256 den; }

    mapping(address => mapping(address => Rate)) public rates;

    event RateSet(address indexed tokenIn, address indexed tokenOut, uint256 num, uint256 den);

    // Optional DEPTH per direction: input beyond `depth` fills at one tenth of
    // the rate, so one large sale does worse than the same amount in small
    // ones. Zero (the default) means unlimited, preserving earlier behaviour.
    mapping(address => mapping(address => uint256)) public depth;

    // Optional UNDERPAYMENT, in bps of the computed output (default 10000 =
    // pays in full). The router still REPORTS the full amount and checks its
    // own minimum against it, modelling a router or token that says one
    // thing and delivers another.
    uint256 public payoutBps = 10000;

    function setDepth(address tokenIn, address tokenOut, uint256 _depth) external {
        depth[tokenIn][tokenOut] = _depth;
    }

    function setPayoutBps(uint256 _bps) external {
        payoutBps = _bps;
    }

    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 den) external {
        require(den > 0, "Zero denominator");
        rates[tokenIn][tokenOut] = Rate(num, den);
        emit RateSet(tokenIn, tokenOut, num, den);
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut)
    {
        Rate memory r = rates[params.tokenIn][params.tokenOut];
        require(r.den > 0, "No rate configured for pair");

        uint256 d = depth[params.tokenIn][params.tokenOut];
        if (d == 0 || params.amountIn <= d) {
            amountOut = (params.amountIn * r.num) / r.den;
        } else {
            amountOut = (d * r.num) / r.den + ((params.amountIn - d) * r.num) / (r.den * 10);
        }
        require(amountOut >= params.amountOutMinimum, "Too little received");

        require(
            IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn),
            "Router pull failed"
        );
        require(
            IERC20(params.tokenOut).transfer(params.recipient, (amountOut * payoutBps) / 10000),
            "Router payout failed - fund the router with output tokens"
        );
    }
}
