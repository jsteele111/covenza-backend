// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockERC20.sol";

/**
 * @title MockBlacklistToken
 * @notice A USDC-style stablecoin whose issuer can blacklist individual
 *         addresses: a blacklisted address can neither send nor receive.
 *         LOCAL TESTING ONLY.
 * @dev    Used for audit finding M-1: one recipient the token will not pay
 *         must not be able to block a settlement for everyone else. Can also
 *         reject zero-value transfers, as some tokens do (audit L-5).
 */
contract MockBlacklistToken is MockERC20 {
    mapping(address => bool) public blacklisted;
    bool public rejectZero;

    constructor() MockERC20("Mock USDC", "USDC", 6) {}

    function setBlacklisted(address account, bool value) external {
        blacklisted[account] = value;
    }

    function setRejectZero(bool value) external {
        rejectZero = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!rejectZero || value > 0, "Zero transfer");
        require(!blacklisted[from] && !blacklisted[to], "Blacklisted");
        super._update(from, to, value);
    }
}
