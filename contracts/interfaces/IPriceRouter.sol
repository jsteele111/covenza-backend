// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IPriceRouter  (NOT AUDITED)
 * @notice The reference price RoutedVault checks every trade and valuation
 *         against. One implementation serves a whole deployment; each listed
 *         token has its own source (Chainlink, Uniswap average, Curve smoothed
 *         price, Pendle PT oracle), an optional cross-check, a largest gap, an
 *         oldest-price limit and a pause check.
 *
 * @dev    `ok == false` means the price cannot be read right now: the source
 *         is stale or paused, the two sources disagree, or (for a pool source)
 *         the pool's history or depth fails the audited KRAIT-004 and M-01
 *         checks. A vault treats that exactly as the audited Vault treats a
 *         pool it cannot quote: no new purchases, no sale that needs a
 *         minimum, and in-kind settlement after the existing delay.
 *
 *         REQUIRED OF ANY IMPLEMENTATION (security review, 26 Nov 2026):
 *           - `amount == 0` returns (true, 0); a non-zero amount whose
 *             result would round to zero returns ok = false (audit L-7);
 *           - Chainlink: answer above zero, updated within the token's
 *             maximum age, round complete, decimals applied, and a price at
 *             the feed's minimum or maximum bound refused;
 *           - Robinhood's Stock Token oracle pause respected, the multiplier
 *             used as given, and equity prices unreadable while their market
 *             is closed;
 *           - unreadable until the registry's outage recovery period passes;
 *           - the cross-check's largest gap enforced; a loan asset without a
 *             feed counts as $1 only while a deep-pool market check agrees;
 *           - a Uniswap source uses the audited UniswapTwap library unchanged,
 *             with the KRAIT-004 history and M-01 depth checks;
 *           - settings: first setting immediate, later changes timelocked in
 *             both directions, held by the operator Safe.
 */
interface IPriceRouter {
    /// @notice What `amount` of `tokenIn` is worth in `tokenOut` at the reference price.
    function quote(address tokenIn, address tokenOut, uint256 amount)
        external view returns (bool ok, uint256 amountOut);

    /// @notice The most one vault may hold of `token`, valued in `loanAsset`.
    ///         type(uint256).max when no cap is set (pool-priced pairs, whose
    ///         depth is checked by the full-exit simulation instead).
    function maxPosition(address token, address loanAsset) external view returns (uint256);
}
