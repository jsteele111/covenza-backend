// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IPriceRouter.sol";

/// @notice TEST ONLY. A price module the test sets by hand: a rate per
///         direction, a switch to make a token's price unreadable, and a size
///         cap per token. Zero is always worth zero, as IPriceRouter requires.
contract MockPriceRouter is IPriceRouter {
    mapping(address => mapping(address => uint256)) public num;
    mapping(address => mapping(address => uint256)) public den;
    mapping(address => bool) public unreadable;
    mapping(address => mapping(address => uint256)) public cap;
    mapping(address => mapping(address => bool)) public capSet;

    function setRate(address a, address b, uint256 n, uint256 d) external { num[a][b] = n; den[a][b] = d; num[b][a] = d; den[b][a] = n; }
    function setUnreadable(address t, bool u) external { unreadable[t] = u; }
    function setMaxPosition(address t, address loan, uint256 v) external { cap[t][loan] = v; capSet[t][loan] = true; }

    function quote(address a, address b, uint256 amount) external view returns (bool, uint256) {
        if (amount == 0) return (true, 0);
        if (unreadable[a] || unreadable[b] || den[a][b] == 0) return (false, 0);
        return (true, amount * num[a][b] / den[a][b]);
    }

    function maxPosition(address t, address loan) external view returns (uint256) {
        return capSet[t][loan] ? cap[t][loan] : type(uint256).max;
    }
}
