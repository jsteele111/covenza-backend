// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolSetup} from "./ProtocolSetup.sol";
import {Vault} from "../contracts/Vault.sol";

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
        h.settleInKind(0, 1);                                // the lender, in the lender-only period
        assertEq(h.calls("settleInKind.ok"), 1, "in-kind settlement not reached");
        h.toggleFreeze(1);                                   // freeze lifts
        h.claim(0, true);
        assertEq(h.calls("claim.ok"), 1, "in-kind claim not reached");
    }

    /// Audit L-06's scenario: a cash-only vault (everything bought was sold
    /// back at a loss, so there is no in-kind route) settles while the issuer
    /// blocks the pool as a sender. The insurance is held for the lender, and
    /// the lender collects it once the block lifts.
    function test_handlerReachesDeferredDrawAndClaim() public {
        h.originate(0, 0, 10 ether, 2 ether, 1 days, true);
        h.swap(0, 10 ether);                                 // spend the principal on USDX
        h.movePrice(0);                                      // USDX halves
        h.swapBack(0, 10 ether);                             // sell it all: 7 WETH of cash, nothing held
        Vault v = h.vaults(0);
        assertEq(v.heldAmount(address(usdx)), 0, "vault should be cash-only");

        vm.warp(v.deadline() + 1);
        h.togglePoolBlock(0);                                // issuer blocks the pool as a sender
        h.settle(0, 0);                                      // the lender settles
        assertEq(h.calls("settle.ok"), 1, "settlement blocked by the refused draw");
        assertEq(h.calls("draw.deferred"), 1, "draw was not deferred");
        assertEq(weth.balanceOf(v.lender()), 7 ether, "lender not paid the vault's cash");
        assertEq(pool.deferredDrawOf(address(weth), v.lender()), 1 ether, "insurance not held for the lender");

        h.claimDeferredDraw(0);                              // still blocked: refused, claim kept
        assertEq(h.calls("claimDeferredDraw.ok"), 0, "claim paid while blocked");
        assertEq(pool.deferredDrawOf(address(weth), v.lender()), 1 ether, "claim lost while blocked");

        h.togglePoolBlock(1);                                // the block lifts
        h.claimDeferredDraw(0);
        assertEq(h.calls("claimDeferredDraw.ok"), 1, "deferred claim not reached");
        assertEq(weth.balanceOf(v.lender()), 8 ether, "lender not paid the held insurance");
    }
}
