// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockERC20.sol";

interface IVaultPoke { function claim(address token) external; }

/// @notice TEST ONLY. An aggregator that can be honest or hostile.
///   mode 0 honest            pays amountIn * rate
///   mode 1 forge             reverts with a forged ExitQuote(huge)
///   mode 2 shortchange       pays only half
///   mode 3 reenter           calls back into the vault mid-trade
///   mode 4 partial           takes only half the input
contract MockAggregator {
    error ExitQuote(uint256 amountOut);
    uint8 public mode;
    uint256 public num = 1;
    uint256 public den = 1;
    address public vault;

    function setMode(uint8 m) external { mode = m; }
    function setRate(uint256 n, uint256 d) external { num = n; den = d; }
    function setVault(address v) external { vault = v; }

    function swap(address tokenIn, address tokenOut, uint256 amountIn) external {
        if (mode == 1) revert ExitQuote(type(uint128).max);
        if (mode == 3) IVaultPoke(vault).claim(tokenIn);
        uint256 take = mode == 4 ? amountIn / 2 : amountIn;
        MockERC20(tokenIn).transferFrom(msg.sender, address(this), take);
        uint256 out = take * num / den;
        if (mode == 2) out /= 2;
        MockERC20(tokenOut).transfer(msg.sender, out);
    }
}
