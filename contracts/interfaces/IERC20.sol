// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC20 interface shared across the Covenza protocol
///         contracts — declared once here to avoid duplicate-identifier
///         collisions between contracts that import each other.
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);

    /// @dev Added for mandate fillability. A lender's capital stays in their
    ///      own wallet until a fill, so what can actually be drawn is
    ///      min(allowance, balance) — and an allowance can be revoked for
    ///      free at any moment, which is precisely why it has to be read
    ///      rather than assumed.
    function allowance(address owner, address spender) external view returns (uint256);
}
