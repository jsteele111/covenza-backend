// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice TEST ONLY. Answers the two questions the deployment checks ask a
///         Safe (who its owners are, and how many must sign). Holds no logic.
contract MockSafe {
    address[] private _owners;
    uint256 private _threshold;
    constructor(address[] memory owners_, uint256 threshold_) { _owners = owners_; _threshold = threshold_; }
    function getOwners() external view returns (address[] memory) { return _owners; }
    function getThreshold() external view returns (uint256) { return _threshold; }
}
