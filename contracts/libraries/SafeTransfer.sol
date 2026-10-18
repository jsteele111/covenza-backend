// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IERC20.sol";

/**
 * @title SafeTransfer
 * @notice Token transfers and approvals that work with tokens which return
 *         `true`, AND with tokens which return nothing at all.
 *
 * @dev    WHY (MAINNET-READINESS item 15). The protocol used
 *         `require(token.transfer(...))`, which decodes a bool from the
 *         reply. Some widely used tokens (USDT on Ethereum mainnet among them)
 *         return no data. Solidity cannot decode a bool from an empty reply,
 *         so the call reverted even though the token had moved the funds —
 *         and because the same transfer is retried on every attempt, a loan
 *         in such a token could never be settled.
 *
 *         The rule here is the one Uniswap's TransferHelper and OpenZeppelin's
 *         SafeERC20 apply:
 *           - the call itself must not revert;
 *           - if it returns data, that data must decode to `true`;
 *           - if it returns NO data, the target must be a contract (a call to
 *             an address with no code also "succeeds" with no data, and must
 *             not be mistaken for a transfer).
 *         Nothing is loosened: a token that reverts or returns `false` still
 *         fails.
 *
 *         Approvals use the "force" pattern: if setting the allowance
 *         directly fails, reset it to zero and set it again. Some tokens
 *         refuse to change one non-zero allowance into another.
 *
 *         OUT OF SCOPE BY DESIGN: fee-on-transfer and rebasing tokens. Their
 *         balances change in transit or by themselves, which every amount the
 *         protocol records assumes cannot happen. They are excluded by the
 *         listing rule in AssetRegistry, not handled here.
 */
library SafeTransfer {

    function safeTransfer(address token, address to, uint256 amount) internal {
        require(
            _succeeded(token, abi.encodeWithSelector(IERC20.transfer.selector, to, amount)),
            "Token transfer failed"
        );
    }

    /// @dev As safeTransfer, but reports failure instead of reverting. Used
    ///      only where a refusing token must not block everything else: the
    ///      in-kind settlement of an asset whose issuer has frozen it.
    function trySafeTransfer(address token, address to, uint256 amount) internal returns (bool) {
        return _succeeded(token, abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        require(
            _succeeded(token, abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)),
            "Token transfer failed"
        );
    }

    function safeApprove(address token, address spender, uint256 amount) internal {
        if (!_succeeded(token, abi.encodeWithSelector(IERC20.approve.selector, spender, amount))) {
            require(
                _succeeded(token, abi.encodeWithSelector(IERC20.approve.selector, spender, 0)) &&
                _succeeded(token, abi.encodeWithSelector(IERC20.approve.selector, spender, amount)),
                "Token approval failed"
            );
        }
    }

    /// @dev True when the call did not revert and either returned `true` or
    ///      returned nothing from an address that holds code.
    function _succeeded(address token, bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) { return false; }
        if (ret.length == 0) { return token.code.length > 0; }
        return ret.length >= 32 && abi.decode(ret, (bool));
    }
}
