// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Timelocked
 * @notice A two-step delay for administrative actions that increase risk.
 *
 * @dev    WHY THIS EXISTS: the protocol's admin powers were instant and
 *         unbounded. One key could empty the insurance pool, repoint the
 *         factory at a hostile registry, or recognise an identity provider
 *         that admits anyone — between blocks, with no warning. Each is
 *         defensible as an operational need; none is defensible as an
 *         operation nobody can see coming.
 *
 *         THE ASYMMETRY IS THE POINT. Only actions that INCREASE risk are
 *         delayed. Removing an attester, funding the pool, tightening a cap —
 *         all stay instant. A timelock on revocation would make the timelock
 *         itself the vulnerability: a compromised provider key would remain
 *         live for the length of the delay precisely when speed matters most.
 *
 *         THE ID BINDS THE ARGUMENTS. Queuing is over a hash of the exact
 *         call, so approving "withdraw 100 to the treasury" does not authorise
 *         "withdraw everything to an attacker". Changing any argument means
 *         queuing again and waiting again.
 *
 *         THE DELAY IS IMMUTABLE. If the operator could shorten it, the
 *         timelock would be advisory: shorten to zero, act, restore. Making it
 *         unchangeable costs the ability to tune it after deployment, which is
 *         the right trade — a delay that can be removed by the party it
 *         constrains is decoration.
 */
abstract contract Timelocked {

    /// @notice Seconds that must elapse between queueing and executing.
    uint256 public immutable timelockDelay;

    /// @notice When each pending action was queued. Zero means not queued.
    mapping(bytes32 => uint256) public queuedAt;

    event ActionQueued(bytes32 indexed id, uint256 executableAt);
    event ActionCancelled(bytes32 indexed id);
    event ActionExecuted(bytes32 indexed id);

    constructor(uint256 _timelockDelay) {
        timelockDelay = _timelockDelay;
    }

    /// @notice Whether a queued action has matured and may be executed.
    ///         Public so anyone watching can see what is pending and when it
    ///         lands — a delay nobody can observe protects nobody.
    function isExecutable(bytes32 _id) public view returns (bool) {
        uint256 q = queuedAt[_id];
        return q != 0 && block.timestamp >= q + timelockDelay;
    }

    /// @notice Seconds remaining before a queued action matures, or zero if it
    ///         is already executable or was never queued.
    function timeUntilExecutable(bytes32 _id) external view returns (uint256) {
        uint256 q = queuedAt[_id];
        if (q == 0) { return 0; }
        uint256 ready = q + timelockDelay;
        return block.timestamp >= ready ? 0 : ready - block.timestamp;
    }

    function _queue(bytes32 _id) internal {
        require(queuedAt[_id] == 0, "Already queued");
        queuedAt[_id] = block.timestamp;
        emit ActionQueued(_id, block.timestamp + timelockDelay);
    }

    /// @dev Cancellation is deliberately NOT delayed — abandoning a pending
    ///      risk-increasing action reduces risk.
    function _cancel(bytes32 _id) internal {
        require(queuedAt[_id] != 0, "Not queued");
        delete queuedAt[_id];
        emit ActionCancelled(_id);
    }

    /// @dev Consumes the queue entry, so an approval cannot be replayed. A
    ///      second execution must queue and wait again.
    function _consume(bytes32 _id) internal {
        uint256 q = queuedAt[_id];
        require(q != 0, "Action was not queued");
        require(block.timestamp >= q + timelockDelay, "Timelock has not elapsed");
        delete queuedAt[_id];
        emit ActionExecuted(_id);
    }
}
