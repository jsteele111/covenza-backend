// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolSetup} from "./ProtocolSetup.sol";

/**
 * @notice Proves the invariant handler can actually reach the rarer paths, so
 *         a passing invariant run means those paths were exercised, not
 *         merely never visited. Runs the handler's actions in a fixed order.
 */
contract HandlerPaths is ProtocolSetup {
    function test_handlerReachesInKindSettlementAndClaim() public {
        h.originate(0, 0, 10 ether, 2 ether, 1 days, true);
        h.swap(0, 3 ether);
        h.toggleFreeze(0);                                   // issuer freezes the bought token
        h.warpToInKindWindow(0); h.botHour();                // silence extends grace once (72h cap)
        h.warpToInKindWindow(0); h.botHour();                // then the window opens after recovery
        h.settleInKind(0, 0);
        assertEq(h.calls("settleInKind.ok"), 1, "in-kind settlement not reached");
        h.toggleFreeze(1);                                   // freeze lifts
        h.claimInKind(0, true);
        assertEq(h.calls("claimInKind.ok"), 1, "in-kind claim not reached");
    }
}
