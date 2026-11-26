// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/ISwapExecutor.sol";
import "./MockERC20.sol";

/// @notice TEST ONLY, and deliberately WORSE than the real executor must be:
///         it passes an aggregator's revert data straight back to the vault,
///         so the tests prove RoutedVault is safe even then. Fallback pool =
///         a fixed rate paid from this contract's own inventory.
contract MockSwapExecutor is ISwapExecutor {
    error ExitQuote(uint256 amountOut);
    /// When set, a fallback sale of this token reverts with a forged ExitQuote.
    mapping(address => bool) public forgeOnSell;
    function setForgeOnSell(address t, bool f) external { forgeOnSell[t] = f; }

    mapping(address => mapping(address => uint256)) public fbNum;
    mapping(address => mapping(address => uint256)) public fbDen;

    function setFallback(address a, address b, uint256 n, uint256 d) external {
        fbNum[a][b] = n; fbDen[a][b] = d; fbNum[b][a] = d; fbDen[b][a] = n;
    }
    function clearFallback(address a, address b) external {
        delete fbNum[a][b]; delete fbDen[a][b]; delete fbNum[b][a]; delete fbDen[b][a];
    }
    function hasFallback(address a, address b) external view returns (bool) { return fbDen[a][b] != 0; }

    function execute(address tokenIn, address tokenOut, uint256 amountIn, Route calldata route) external {
        if (route.target == address(0)) {
            if (forgeOnSell[tokenIn]) revert ExitQuote(type(uint128).max);
            require(fbDen[tokenIn][tokenOut] != 0, "No fallback pool");
            MockERC20(tokenOut).transfer(msg.sender, amountIn * fbNum[tokenIn][tokenOut] / fbDen[tokenIn][tokenOut]);
            return;
        }
        uint256 outBefore = MockERC20(tokenOut).balanceOf(address(this));
        uint256 inBefore = MockERC20(tokenIn).balanceOf(address(this)) - amountIn;
        MockERC20(tokenIn).approve(route.target, amountIn);
        (bool ok, bytes memory ret) = route.target.call(route.data);
        if (!ok) { assembly { revert(add(ret, 32), mload(ret)) } }   // bubbles: worst case
        MockERC20(tokenIn).approve(route.target, 0);
        MockERC20(tokenOut).transfer(msg.sender, MockERC20(tokenOut).balanceOf(address(this)) - outBefore);
        uint256 left = MockERC20(tokenIn).balanceOf(address(this)) - inBefore;
        if (left > 0) MockERC20(tokenIn).transfer(msg.sender, left);
    }
}
