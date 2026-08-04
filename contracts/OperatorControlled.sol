// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title OperatorControlled
 * @notice Two-step transfer of the operator role.
 *
 * @dev    The role was previously handed over in one call: transferOperator
 *         set the new address and the old holder lost access in the same
 *         transaction. A mistyped address ended the protocol's ability to
 *         curate assets, recognise identity providers or administer the
 *         insurance pool — permanently, on a contract with no other admin
 *         path.
 *
 *         Nominate-then-accept fixes that, and does something more useful
 *         besides. The intended recipient is a multisig, and a multisig that
 *         cannot reach its signing threshold is indistinguishable from a lost
 *         key until the moment you need it. Requiring the nominee to call
 *         accept proves it can transact BEFORE anything depends on it.
 *
 *         The same reasoning produced VaultFactory's two-step ownership. This
 *         is the shared version, so the pattern cannot drift between the three
 *         contracts that use it.
 */
abstract contract OperatorControlled {

    address public operator;

    /// @notice Nominee for the operator role, pending their acceptance.
    ///         Holding a nomination confers nothing.
    address public pendingOperator;

    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event OperatorTransferStarted(address indexed from, address indexed to);

    constructor(address _operator) {
        require(_operator != address(0), "Invalid operator address");
        operator = _operator;
        emit OperatorUpdated(address(0), _operator);
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "Caller is not the operator");
        _;
    }

    /// @notice Nominates a new operator. Takes effect only once they accept,
    ///         so the current operator keeps control throughout.
    function transferOperator(address _newOperator) external onlyOperator {
        require(_newOperator != address(0), "Invalid operator address");
        pendingOperator = _newOperator;
        emit OperatorTransferStarted(operator, _newOperator);
    }

    /// @notice Withdraws a pending nomination. Instant — abandoning a transfer
    ///         that has not happened changes nothing.
    function cancelOperatorTransfer() external onlyOperator {
        emit OperatorTransferStarted(operator, address(0));
        pendingOperator = address(0);
    }

    /// @notice Called by the nominee to take the role.
    function acceptOperator() external {
        require(msg.sender == pendingOperator, "Caller is not the pending operator");
        address previous = operator;
        operator = pendingOperator;
        pendingOperator = address(0);
        emit OperatorUpdated(previous, operator);
    }
}
