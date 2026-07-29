// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IERC20.sol";

/**
 * @title MockERC4626
 * @notice Minimal ERC-4626 tokenised vault for LOCAL TESTING ONLY — enough
 *         surface for Vault's yield path (deposit / withdraw / redeem /
 *         convertToAssets) plus balanceOf, since a 4626 vault is its own
 *         share token.
 *
 *         The property that matters here and does NOT exist in the Aave mock:
 *         shares APPRECIATE against the underlying. Aave's aToken rebases 1:1,
 *         so a share count and a value are the same number. Here they diverge,
 *         which is exactly the arithmetic that can go wrong. Simulate yield by
 *         minting underlying straight to this contract — totalAssets() rises
 *         while totalSupply() stays fixed, so every share is worth more:
 *
 *             await usdx.mint(await vault4626.getAddress(), E("1"));
 *
 *         Deliberately NOT a full ERC-20: no transfer, no allowance. Vault
 *         only ever reads its own share balance, and leaving the rest out
 *         keeps the mock honest about what is actually exercised.
 */
contract MockERC4626 {

    IERC20 public immutable underlying;

    string public name     = "Mock ERC4626 Vault";
    string public symbol   = "m4626";
    uint8  public decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);

    constructor(address _underlying) {
        require(_underlying != address(0), "Invalid underlying");
        underlying = IERC20(_underlying);
    }

    function asset() external view returns (address) {
        return address(underlying);
    }

    /// @dev Yield appears here: anything transferred in raises the share price.
    function totalAssets() public view returns (uint256) {
        return underlying.balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply;
        uint256 held   = totalAssets();
        if (supply == 0 || held == 0) { return assets; }
        return (assets * supply) / held;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0) { return shares; }
        return (shares * totalAssets()) / supply;
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf[owner];
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        // Priced BEFORE the transfer lands, or the depositor would be diluted
        // by their own deposit.
        shares = convertToShares(assets);
        require(shares > 0, "Zero shares");

        require(underlying.transferFrom(msg.sender, address(this), assets), "Deposit transfer failed");

        totalSupply        += shares;
        balanceOf[receiver] += shares;

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /// @notice Withdraws an exact amount of the UNDERLYING, burning whatever
    ///         share count that currently costs.
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        shares = convertToShares(assets);
        require(balanceOf[owner] >= shares, "Insufficient shares");

        balanceOf[owner] -= shares;
        totalSupply      -= shares;

        require(underlying.transfer(receiver, assets), "Withdraw transfer failed");

        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    /// @notice Burns an exact share count, returning whatever underlying it
    ///         is now worth. This is the path settlement uses.
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(balanceOf[owner] >= shares, "Insufficient shares");
        assets = convertToAssets(shares);

        balanceOf[owner] -= shares;
        totalSupply      -= shares;

        require(underlying.transfer(receiver, assets), "Redeem transfer failed");

        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }
}
