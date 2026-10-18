// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IIdentityAdapter.sol";

/**
 * @title MockIdentityAdapter
 * @notice LOCAL TESTING ONLY. Stands in for a future adapter (for example a
 *         zero-knowledge one) to prove the factory depends only on the
 *         IIdentityAdapter interface, not on KYCRegistry.
 */
contract MockIdentityAdapter is IIdentityAdapter {
    mapping(address => uint256) public claimsOf;

    function set(address wallet, uint256 claims) external { claimsOf[wallet] = claims; }

    function isEligible(address wallet, uint256 requiredClaims) external view returns (bool) {
        return (claimsOf[wallet] & requiredClaims) == requiredClaims && claimsOf[wallet] != 0;
    }
}
