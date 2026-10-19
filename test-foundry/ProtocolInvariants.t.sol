// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Test.sol";
import {Vault} from "../contracts/Vault.sol";
import {VaultFactory} from "../contracts/VaultFactory.sol";
import {ProtocolSetup} from "./ProtocolSetup.sol";

/**
 * @title ProtocolInvariants
 * @notice Properties that must hold after ANY sequence of actions the handler
 *         can take. Foundry runs many random sequences (see foundry.toml) and
 *         checks every invariant_* function after every call. A failure prints
 *         the shortest sequence it could find that breaks the property.
 *
 * @dev    The stack and the handler come from ProtocolSetup.
 */
contract ProtocolInvariants is ProtocolSetup {
    // ------------------------------------------------------------------
    // While a loan is open
    // ------------------------------------------------------------------

    /// The deposit is never spent: an open, funded vault always holds at
    /// least the borrower's deposit in the loan asset.
    function invariant_openVaultHoldsDeposit() public view {
        for (uint256 i = 0; i < h.vaultCount(); i++) {
            Vault v = h.vaults(i);
            if (v.isSettled() || !v.depositPaid()) continue;
            assertGe(weth.balanceOf(address(v)), v.deposit(), "open vault below its deposit");
        }
    }

    /// The vault's record of what it bought is always backed by tokens it
    /// actually holds, and an asset is tracked exactly when it is held.
    function invariant_heldRecordIsBacked() public view {
        for (uint256 i = 0; i < h.vaultCount(); i++) {
            Vault v = h.vaults(i);
            uint256 held = v.heldAmount(address(usdx));
            assertLe(held, usdx.balanceOf(address(v)), "held record exceeds balance");
            assertEq(v.isHeld(address(usdx)), held > 0, "tracked flag disagrees with record");
            if (v.isSettled()) assertEq(held, 0, "settled vault still records a holding");
        }
    }

    // ------------------------------------------------------------------
    // At settlement
    // ------------------------------------------------------------------

    /// Every settlement distributes exactly what the vault had plus what the
    /// pool paid: nothing created, nothing left behind or lost.
    function invariant_settlementConserves() public view {
        for (uint256 i = 0; i < h.vaultCount(); i++) {
            Vault v = h.vaults(i);
            if (!v.isSettled() || v.depositPaid() == false) continue;   // cancelled vaults: see below
            uint256 out = v.settledLenderPayout() + v.settledBorrowerPayout() + v.settledBounty()
                        + v.settledProtocolFee() + v.settledReferrerFee();
            assertEq(out, v.settledTotalReturned() + v.settledInsuranceDraw(), "payouts != funds");
            assertEq(weth.balanceOf(address(v)), 0, "loan asset left in a settled vault");
        }
    }

    /// The lender never receives more than principal plus accrued interest,
    /// and an early close always pays them in full.
    function invariant_lenderPayoutBounded() public view {
        assertFalse(h.ghostEarlyCloseShort(), "early close paid the lender short");
        for (uint256 i = 0; i < h.vaultCount(); i++) {
            Vault v = h.vaults(i);
            if (!v.isSettled() || !v.depositPaid()) continue;
            assertLe(v.settledLenderPayout(), v.principal() + v.settledFee(), "lender overpaid");
        }
    }

    /// Whatever settleInKind could not transfer is still in the vault for its
    /// owners to claim.
    function invariant_inKindClaimsAreBacked() public view {
        for (uint256 i = 0; i < h.vaultCount(); i++) {
            Vault v = h.vaults(i);
            if (!v.settledInKind()) continue;
            uint256 owed = v.inKindOwed(address(usdx), v.lender()) + v.inKindOwed(address(usdx), v.borrower());
            assertGe(usdx.balanceOf(address(v)), owed, "in-kind claims exceed tokens held");
        }
    }

    // ------------------------------------------------------------------
    // Insurance pool
    // ------------------------------------------------------------------

    /// The pool's reserve equals funding plus premiums minus draws, and is
    /// always covered by tokens it actually holds.
    function invariant_reserveAccounting() public view {
        uint256 reserve = pool.reserveOf(address(weth));
        assertEq(reserve, h.ghostReserve(), "reserve drifted from its inflows and draws");
        assertLe(reserve, weth.balanceOf(address(pool)), "reserve exceeds pool balance");
    }

    /// No draw ever exceeded 10% of the loan's principal or 5% of what was
    /// left in the reserve (item 8).
    function invariant_drawsWithinBothCaps() public view {
        assertFalse(h.ghostDrawTooLarge(), "a draw broke the per-loan cap or the reserve share");
    }

    // ------------------------------------------------------------------
    // System-wide
    // ------------------------------------------------------------------

    /// Every WETH ever minted is somewhere we can account for. A shortfall
    /// would mean value left the system; an excess would mean it was created.
    function invariant_wethConserved() public view {
        uint256 sum = weth.balanceOf(address(router)) + weth.balanceOf(address(pool))
                    + weth.balanceOf(treasury) + weth.balanceOf(keeper) + weth.balanceOf(address(this));
        for (uint256 i = 0; i < lenders.length; i++) sum += weth.balanceOf(lenders[i]);
        for (uint256 i = 0; i < borrowers.length; i++) sum += weth.balanceOf(borrowers[i]);
        for (uint256 i = 0; i < h.vaultCount(); i++) sum += weth.balanceOf(address(h.vaults(i)));
        assertEq(sum, h.ghostWethMinted(), "WETH unaccounted for");
        assertEq(sum, weth.totalSupply(), "WETH supply mismatch");
    }

    /// A mandate never lends more than its total capacity (item 13).
    function invariant_mandateCapacity() public view {
        for (uint256 i = 0; i < h.mandateCount(); i++) {
            // Mandate is 18 static fields (totalCapacity is the 17th, filled the 18th), returned flat. Reading the two we need
            // directly avoids decoding the whole struct (stack too deep).
            (bool ok, bytes memory d) = address(factory).staticcall(
                abi.encodeCall(VaultFactory.mandate, (h.mandateIds(i))));
            assertTrue(ok, "mandate read failed");
            uint256 capacity; uint256 filled;
            assembly { capacity := mload(add(d, 544)) filled := mload(add(d, 576)) }
            assertLe(filled, capacity, "mandate lent beyond capacity");
        }
    }

    /// Printed once per run, so a reviewer can see the paths were exercised.
    function afterInvariant() external view {
        string[14] memory names = ["originate", "fillMandate", "swap.ok", "swapBack.ok",
            "movePrice", "manipulateSpot", "toggleFreeze", "donate", "warpToInKindWindow", "botHour",
            "settle.ok", "settleInKind.ok", "claimInKind.ok", "cancel.ok"];
        for (uint256 i = 0; i < names.length; i++) {
            console.log(names[i], h.calls(names[i]));
        }
        console.log("vaults", h.vaultCount());
    }
}
