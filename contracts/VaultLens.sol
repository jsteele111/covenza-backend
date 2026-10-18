// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AssetRegistry.sol";
import "./libraries/UniswapTwap.sol";

/// @dev The parts of a Vault the lens reads.
interface IVaultView {
    function asset() external view returns (address);
    function registry() external view returns (AssetRegistry);
    function isHeld(address token) external view returns (bool);
    function swapFeeTierOf(address token) external view returns (uint24);
}

/**
 * @title VaultLens
 * @notice Read-only helpers for the interface. Holds no state, moves no funds,
 *         and nothing in the protocol calls it.
 *
 * @dev    Exists because Vault is close to the 24,576-byte contract size limit.
 *         quoteSwapOut used to live on Vault; it was moved here when item 14's
 *         in-kind settlement needed the room. It reads only the vault's public
 *         state and its registry's settings, so it gives exactly the answer
 *         the vault itself would.
 */
contract VaultLens {

    /**
     * @notice What a prospective swap out of `vault` is worth at the TWAP, and
     *         the least the vault will accept for it.
     *
     * @dev    The borrower's price reference for the swap form's minimum
     *         output. Without one, a borrower either guesses or enters a
     *         minimum too low to protect them, defeating the control.
     *
     *         Returns rather than reverts when the pair cannot be quoted. An
     *         unquotable pool is a real and expected state — a freshly created
     *         pool has no observation history — and a view that reverts is one
     *         the interface cannot distinguish from a network failure.
     *
     * @return quotable     whether the pool can serve the configured window
     * @return twapOut      output implied by the time-weighted average price
     * @return minimumOut   twapOut less the entry-impact allowance: the least
     *                      the vault accepts. A lower minimum does not widen
     *                      what is permitted; the vault refuses the swap.
     */
    function quoteSwapOut(address vault, address tokenOut, uint256 amountIn, uint24 poolFee)
        external view
        returns (bool quotable, uint256 twapOut, uint256 minimumOut)
    {
        if (amountIn == 0) return (false, 0, 0);

        AssetRegistry registry = IVaultView(vault).registry();
        address loanAsset = IVaultView(vault).asset();

        // Same pool rule as Vault.swap(): a quote for a pool the vault would
        // refuse is not a quote.
        if (poolFee == 0 || poolFee != _approvedFee(vault, registry, tokenOut, loanAsset)) return (false, 0, 0);

        address uniFactory = registry.uniswapFactory();
        uint32  window     = registry.twapWindow();
        uint256 maxImpactBps = registry.maxEntryImpactBps();

        // Checked in BOTH directions, matching swap(): the entry quote prices
        // the position, and the swap-back quote is what settlement will need.
        if (!UniswapTwap.canQuote(uniFactory, loanAsset, tokenOut, poolFee, window)) return (false, 0, 0);
        if (!UniswapTwap.canQuote(uniFactory, tokenOut, loanAsset, poolFee, window)) return (false, 0, 0);

        twapOut = UniswapTwap.quote(uniFactory, loanAsset, tokenOut, poolFee, amountIn, window);

        minimumOut = maxImpactBps == 0
            ? twapOut
            : (twapOut * (10000 - maxImpactBps)) / 10000;
        quotable = true;
    }

    function _approvedFee(address vault, AssetRegistry registry, address tokenOut, address loanAsset)
        internal view returns (uint24)
    {
        return IVaultView(vault).isHeld(tokenOut)
            ? IVaultView(vault).swapFeeTierOf(tokenOut)
            : registry.poolFeeTier(tokenOut, loanAsset);
    }
}
