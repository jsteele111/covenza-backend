// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockERC20.sol";

/**
 * @title MockSenderBlockToken
 * @notice A token whose issuer can stop chosen addresses from SENDING, while
 *         they can still receive and everyone else trades normally.
 *         LOCAL TESTING ONLY.
 * @dev    Used for audit L-06: the issuer blocks the insurance pool as a
 *         sender, so the pool's transfer to a vault is refused while the
 *         vault can still pay the lender. Minting is never blocked.
 */
contract MockSenderBlockToken is MockERC20 {
    mapping(address => bool) public senderBlocked;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        MockERC20(name_, symbol_, decimals_) {}

    function setSenderBlocked(address account, bool value) external {
        senderBlocked[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(from == address(0) || !senderBlocked[from], "Sender blocked");
        super._update(from, to, value);
    }
}
