// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockERC20.sol";

/**
 * @title MockNoReturnToken
 * @notice LOCAL TESTING ONLY. Behaves like USDT on Ethereum mainnet:
 *         transfer, transferFrom and approve return NO data, and approve
 *         refuses to change one non-zero allowance into another.
 */
contract MockNoReturnToken {
    string public name = "No-Return USD";
    string public symbol = "NRUSD";
    uint8  public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        require(amount == 0 || allowance[msg.sender][spender] == 0, "reset allowance first");
        allowance[msg.sender][spender] = amount;
    }
}

/**
 * @title MockFalseToken
 * @notice LOCAL TESTING ONLY. A standard token that can be switched to
 *         return `false` from transfer without moving anything.
 */
contract MockFalseToken is MockERC20 {
    bool public failTransfers;

    constructor() MockERC20("False Token", "FALSE", 18) {}

    function setFailTransfers(bool _fail) external { failTransfers = _fail; }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (failTransfers) { return false; }
        return super.transfer(to, amount);
    }
}
