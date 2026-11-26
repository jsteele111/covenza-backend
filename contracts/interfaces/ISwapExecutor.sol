// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice How a trade is carried out. `target == address(0)` means the
 *         pair's fallback pool, which needs no outside service. Any other
 *         target must be on the executor's approved-aggregator list, and
 *         `data` is the call the aggregator's own service built for exactly
 *         this trade.
 */
struct Route {
    address target;
    bytes   data;
}

/**
 * @title ISwapExecutor  (NOT AUDITED)
 * @notice Carries out one trade for a vault and keeps nothing.
 *
 * @dev    The caller sends exactly `amountIn` of `tokenIn` to the executor
 *         first, then calls execute(). The executor approves only that
 *         amount, runs the route, clears the approval, and sends back to the
 *         caller everything it received plus any `tokenIn` left unsold.
 *
 *         REQUIRED OF ANY IMPLEMENTATION (design review, 26 Nov 2026):
 *           - only targets on its approved list, and only the functions
 *             approved for each target (decision 3); the fallback pool
 *             otherwise;
 *           - exact approval to the aggregator, reset to zero after the call,
 *             never a standing or Permit2-style allowance;
 *           - account by balance change, never by its whole balance, and
 *             hold nothing between calls;
 *           - locked against re-entry;
 *           - never pass an aggregator's revert data back to the caller.
 *
 *         The executor enforces no price floor. The vault measures what
 *         arrived and what was spent, and applies its own floor — the same
 *         rule as the audited Vault (item 17, M-03): a vault never trusts a
 *         figure the trading venue reports.
 */
interface ISwapExecutor {
    function execute(address tokenIn, address tokenOut, uint256 amountIn, Route calldata route) external;

    /// @notice Whether the pair has a fallback pool, which needs no outside
    ///         service. RoutedVault proves exits through it where it exists,
    ///         and holds a party's settlement route to at least its result.
    function hasFallback(address tokenA, address tokenB) external view returns (bool);
}
