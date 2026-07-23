// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IERC20.sol";

/**
 * @title MockAToken
 * @notice Minimal aToken stand-in, mint/burn restricted to its pool.
 *         LOCAL TESTING ONLY.
 */
contract MockAToken {
    string public name;
    string public symbol;
    address public immutable pool;

    mapping(address => uint256) public balanceOf;

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
        pool = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == pool, "Only pool");
        balanceOf[to] += amount;
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == pool, "Only pool");
        require(balanceOf[from] >= amount, "Insufficient aToken balance");
        balanceOf[from] -= amount;
    }
}

/**
 * @title MockAavePool
 * @notice Simulates Aave V3's Pool for LOCAL TESTING ONLY. Mirrors the
 *         two functions Vault actually calls — supply() and withdraw() —
 *         with real token movement and 1:1 aToken accounting, so the
 *         vault's hardened "balance must genuinely decrease" check runs
 *         against real state changes, not stubs.
 *
 *         Yield is simulated explicitly via simulateYield(): mints extra
 *         aTokens to a holder. Tests must separately mint the matching
 *         underlying to this pool so the withdrawal can actually pay out.
 */
contract MockAavePool {

    mapping(address => MockAToken) public aTokens;

    /// @notice Creates (once) and returns the aToken for an asset.
    function configureAsset(address asset) external returns (address) {
        if (address(aTokens[asset]) == address(0)) {
            aTokens[asset] = new MockAToken("Mock aToken", "maTKN");
        }
        return address(aTokens[asset]);
    }

    function aTokenOf(address asset) external view returns (address) {
        return address(aTokens[asset]);
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(address(aTokens[asset]) != address(0), "Asset not configured");
        require(IERC20(asset).transferFrom(msg.sender, address(this), amount), "Supply transfer failed");
        aTokens[asset].mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        MockAToken aToken = aTokens[asset];
        require(address(aToken) != address(0), "Asset not configured");

        uint256 balance = aToken.balanceOf(msg.sender);
        if (amount == type(uint256).max) { amount = balance; }
        require(amount <= balance, "Amount exceeds aToken balance");

        aToken.burn(msg.sender, amount);
        require(IERC20(asset).transfer(to, amount), "Withdraw transfer failed");
        return amount;
    }

    /// @notice Test helper: simulates accrued yield by minting extra
    ///         aTokens. Mint matching underlying to this pool separately.
    function simulateYield(address asset, address holder, uint256 amount) external {
        aTokens[asset].mint(holder, amount);
    }
}
