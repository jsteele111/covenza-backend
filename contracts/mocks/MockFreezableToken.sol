// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockERC20.sol";

/**
 * @title MockFreezableToken
 * @notice A token whose issuer can halt every transfer, as a tokenised equity's
 *         issuer can. LOCAL TESTING ONLY.
 * @dev    Used to test item 14: a held asset that can be neither sold nor
 *         handed over. Minting still works while frozen, so a test can fund
 *         the router before or after.
 */
contract MockFreezableToken is MockERC20 {
    bool public frozen;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        MockERC20(name_, symbol_, decimals_) {}

    function setFrozen(bool _frozen) external {
        frozen = _frozen;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!frozen || from == address(0), "Token is frozen");
        super._update(from, to, value);
    }
}
