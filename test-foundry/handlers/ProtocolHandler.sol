// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Vault} from "../../contracts/Vault.sol";
import {VaultFactory} from "../../contracts/VaultFactory.sol";
import {AssetRegistry} from "../../contracts/AssetRegistry.sol";
import {InsurancePool} from "../../contracts/InsurancePool.sol";
import {MockERC20} from "../../contracts/mocks/MockERC20.sol";
import {MockFreezableToken} from "../../contracts/mocks/MockFreezableToken.sol";
import {MockSwapRouter} from "../../contracts/mocks/MockSwapRouter.sol";
import {MockUniswapV3Pool} from "../../contracts/mocks/MockUniswapV3.sol";

/**
 * @title ProtocolHandler
 * @notice The actions the invariant fuzzer may take, in any order, with any
 *         arguments: originate (directly or through a mandate), pay or skip
 *         the deposit, swap in and out, move the price, manipulate spot, freeze
 *         the held token, donate tokens to a vault, let time pass, settle,
 *         settle in kind, cancel, and claim in-kind entitlements.
 *
 * @dev    Each action bounds its inputs to something the protocol could
 *         plausibly see, then calls through try/catch: a refusal is a valid
 *         outcome, never a test failure. What the handler records are GHOST
 *         variables, the fuzzer's own bookkeeping, which the invariants compare
 *         against what the contracts say.
 *
 *         One loan pair: WETH is lent, USDX (freezable) is the asset bought.
 */
contract ProtocolHandler is Test {
    VaultFactory public factory;
    AssetRegistry public registry;
    InsurancePool public pool;
    MockERC20 public weth;
    MockFreezableToken public usdx;
    MockSwapRouter public router;
    MockUniswapV3Pool public uniPool;

    address[] public lenders;
    address[] public borrowers;
    address public keeper;

    uint24 public constant FEE = 3000;
    uint256 public constant MAX_VAULTS = 24;

    // --- Ghost state ---
    Vault[] public vaults;
    mapping(address => bool) public settledEarly;
    uint256[] public mandateIds;

    uint256 public ghostReserve;        // what the pool's WETH reserve should be
    uint256 public ghostWethMinted;     // every WETH the handler has created
    bool public ghostDrawTooLarge;      // a draw broke the per-loan cap or the reserve share
    bool public ghostEarlyCloseShort;   // an early close paid the lender less than owed

    // Call counts, printed at the end of a run to show coverage.
    mapping(string => uint256) public calls;

    // USDX price in WETH, as (numerator, denominator) with the matching tick
    // magnitude for 1.0001^tick: 0.5, 0.8, 1, 1.2, 1.5.
    uint256[5] internal PNUM = [uint256(50), 80, 100, 120, 150];
    int24[5]   internal TICK = [int24(-6932), -2232, 0, 1823, 4055];

    /// @dev Grouped in one struct: thirteen separate constructor arguments
    ///      overflow the stack.
    struct Deps {
        VaultFactory factory; AssetRegistry registry; InsurancePool pool;
        MockERC20 weth; MockFreezableToken usdx; MockSwapRouter router; MockUniswapV3Pool uniPool;
        address keeper; uint256 initialReserve; uint256 wethAlreadyMinted;
    }

    constructor(Deps memory d, address[] memory _lenders, address[] memory _borrowers) {
        factory = d.factory; registry = d.registry; pool = d.pool;
        weth = d.weth; usdx = d.usdx; router = d.router; uniPool = d.uniPool;
        keeper = d.keeper;
        ghostReserve = d.initialReserve;
        ghostWethMinted = d.wethAlreadyMinted;
        lenders = _lenders; borrowers = _borrowers;
    }

    // ------------------------------------------------------------------
    // Origination
    // ------------------------------------------------------------------

    function originate(uint256 lSeed, uint256 bSeed, uint256 principalSeed, uint256 depSeed,
                       uint256 termSeed, bool payDeposit) external {
        if (vaults.length >= MAX_VAULTS) return;
        calls["originate"]++;
        address lender = lenders[lSeed % lenders.length];
        address borrower = borrowers[bSeed % borrowers.length];
        uint256 principal = bound(principalSeed, 1 ether, 50 ether);
        uint256 dep = bound(depSeed, principal / 20, principal / 2);
        uint256 term = bound(termSeed, 1 hours, 10 days);

        _mintWeth(lender, principal);
        vm.prank(lender);
        weth.approve(address(factory), principal);
        vm.prank(lender);
        try factory.deployVaultWithTier(address(weth), borrower, principal, 1200, term, true, dep, address(0), 0)
            returns (address v)
        {
            Vault vault = Vault(v);
            vaults.push(vault);
            if (payDeposit) {
                uint256 owed = dep + vault.insurancePremium();
                _mintWeth(borrower, owed);
                vm.prank(borrower);
                weth.approve(v, owed);
                vm.prank(borrower);
                try vault.payDeposit() { ghostReserve += vault.insurancePremium(); } catch {}
            }
        } catch {}
    }

    function publishMandate(uint256 lSeed, uint256 capSeed) external {
        calls["publishMandate"]++;
        address lender = lenders[lSeed % lenders.length];
        uint256 cap = bound(capSeed, 20 ether, 100 ether);
        VaultFactory.MandateTerms memory t = VaultFactory.MandateTerms({
            asset: address(weth),
            minPrincipal: 1 ether, maxPrincipal: 20 ether,
            minTermSeconds: 1 hours, maxTermSeconds: 14 days,
            validForSeconds: 7 days, maxTier: 0, permittedBorrower: address(0),
            baseAprBps: 1200, termPremiumBpsPerDay: 1, depositCreditBpsPerPoint: 1,
            minDepositBps: 1000, minAprBps: 500, totalCapacity: cap
        });
        _mintWeth(lender, cap);
        vm.prank(lender);
        weth.approve(address(factory), type(uint256).max);
        vm.prank(lender);
        try factory.publishMandate(t) returns (uint256 id) { mandateIds.push(id); } catch {}
    }

    function fillMandate(uint256 mSeed, uint256 bSeed, uint256 principalSeed, uint256 termSeed) external {
        if (mandateIds.length == 0 || vaults.length >= MAX_VAULTS) return;
        calls["fillMandate"]++;
        uint256 id = mandateIds[mSeed % mandateIds.length];
        address borrower = borrowers[bSeed % borrowers.length];
        uint256 principal = bound(principalSeed, 1 ether, 20 ether);
        uint256 term = bound(termSeed, 1 hours, 14 days);
        uint256 dep = principal / 5;   // 20%, above the mandate's 10% floor

        _mintWeth(borrower, dep + principal);   // generous: covers any premium
        vm.prank(borrower);
        weth.approve(address(factory), type(uint256).max);
        vm.prank(borrower);
        try factory.fillMandate(id, principal, term, true, dep) returns (address v) {
            vaults.push(Vault(v));
            ghostReserve += Vault(v).insurancePremium();
        } catch {}
    }

    // ------------------------------------------------------------------
    // Borrower trading
    // ------------------------------------------------------------------

    function swap(uint256 vSeed, uint256 amtSeed) external {
        Vault v = _vault(vSeed);
        if (address(v) == address(0)) return;
        calls["swap"]++;
        // Up to the WHOLE balance, deposit included: the fuzzer must try to
        // spend the deposit for the deposit invariant to mean anything.
        uint256 bal = weth.balanceOf(address(v));
        if (bal == 0) return;
        uint256 amt = bound(amtSeed, 1, bal);
        vm.prank(v.borrower());
        try v.swap(address(usdx), amt, 1, FEE) { calls["swap.ok"]++; } catch {}
    }

    function swapBack(uint256 vSeed, uint256 amtSeed) external {
        Vault v = _vault(vSeed);
        if (address(v) == address(0)) return;
        uint256 held = v.heldAmount(address(usdx));
        if (held == 0) return;
        calls["swapBack"]++;
        uint256 amt = bound(amtSeed, 1, held * 2);   // may try to sell more than was bought
        vm.prank(v.borrower());
        try v.swapBack(address(usdx), amt, 1) { calls["swapBack.ok"]++; } catch {}
    }

    // ------------------------------------------------------------------
    // The market
    // ------------------------------------------------------------------

    /// @dev Moves price fairly: TWAP and spot together.
    function movePrice(uint256 pSeed) external {
        calls["movePrice"]++;
        uint256 i = pSeed % 5;
        bool usdxIsToken0 = address(usdx) < address(weth);
        uniPool.setAvgTick(usdxIsToken0 ? TICK[i] : -TICK[i]);
        router.setRate(address(usdx), address(weth), PNUM[i], 100);
        router.setRate(address(weth), address(usdx), 100, PNUM[i]);
    }

    /// @dev Moves spot only, leaving the TWAP behind: a manipulated or thin pool.
    function manipulateSpot(uint256 pSeed) external {
        calls["manipulateSpot"]++;
        uint256 i = pSeed % 5;
        router.setRate(address(usdx), address(weth), PNUM[i], 100);
        router.setRate(address(weth), address(usdx), 100, PNUM[i]);
    }

    /// @dev Freezes the held token one time in four, otherwise lifts any
    ///      freeze, so the fuzzer spends most of its time on a live market.
    function toggleFreeze(uint256 seed) external {
        calls["toggleFreeze"]++;
        usdx.setFrozen(seed % 4 == 0);
    }

    /// @dev Sends tokens to an open vault from outside, as a griefer would.
    function donate(uint256 vSeed, uint256 amtSeed, bool inUsdx) external {
        Vault v = _vault(vSeed);
        if (address(v) == address(0) || v.isSettled()) return;
        calls["donate"]++;
        uint256 amt = bound(amtSeed, 1, 5 ether);
        if (inUsdx) {
            if (usdx.frozen()) return;
            usdx.mint(address(v), amt);
        } else {
            _mintWeth(address(v), amt);
        }
    }

    /// @dev The heartbeat bot. Sometimes it runs, sometimes it does not: both
    ///      a watched and an unwatched chain get exercised.
    function heartbeat() external {
        calls["heartbeat"]++;
        registry.heartbeat();
    }

    /// @dev An hour of the bot running: four heartbeats, twenty minutes apart.
    ///      Enough to clear an outage's recovery period.
    function botHour() external {
        calls["botHour"]++;
        for (uint256 i = 0; i < 4; i++) {
            registry.heartbeat();
            vm.warp(block.timestamp + 20 minutes);
        }
        registry.heartbeat();
    }

    /// @dev Jumps to the moment a vault still holding the bought asset may be
    ///      settled in kind. Without it that window is reached too rarely for
    ///      the fuzzer to exercise the path.
    function warpToInKindWindow(uint256 vSeed) external {
        Vault v = _holdingVault(vSeed);
        if (address(v) == address(0)) return;
        uint256 at = v.inKindFrom();
        if (at <= block.timestamp) return;
        calls["warpToInKindWindow"]++;
        vm.warp(at);
    }

    function warp(uint256 secondsSeed) external {
        calls["warp"]++;
        vm.warp(block.timestamp + bound(secondsSeed, 1 minutes, 6 hours));
    }

    /// @dev A long jump, far enough to open the in-kind window (grace plus
    ///      seven days) on loans that are already due.
    ///      Taken one time in two, so most loans still live long enough to trade.
    function warpLong(uint256 secondsSeed) external {
        if (secondsSeed % 2 != 0) return;
        calls["warpLong"]++;
        vm.warp(block.timestamp + bound(secondsSeed, 2 days, 10 days));
    }

    // ------------------------------------------------------------------
    // Closing
    // ------------------------------------------------------------------

    function settle(uint256 vSeed, uint256 callerSeed) external {
        Vault v = _unsettledVault(vSeed);
        if (address(v) == address(0)) return;
        calls["settle"]++;
        address caller = callerSeed % 3 == 0 ? v.lender() : callerSeed % 3 == 1 ? v.borrower() : keeper;
        bool early = block.timestamp <= v.deadline();
        uint256 reserveBefore = pool.reserveOf(address(weth));
        vm.prank(caller);
        try v.settle() {
            calls["settle.ok"]++;
            _afterClose(v, reserveBefore);
            if (early) {
                settledEarly[address(v)] = true;
                if (v.settledLenderPayout() < v.principal() + v.settledFee()) ghostEarlyCloseShort = true;
            }
        } catch {}
    }

    function settleInKind(uint256 vSeed, uint256 callerSeed) external {
        Vault v = _holdingVault(vSeed);
        if (address(v) == address(0)) return;
        calls["settleInKind"]++;
        address caller = callerSeed % 2 == 0 ? keeper : v.lender();
        uint256 reserveBefore = pool.reserveOf(address(weth));
        vm.prank(caller);
        try v.settleInKind() {
            calls["settleInKind.ok"]++;
            _afterClose(v, reserveBefore);
        } catch {}
    }

    function cancel(uint256 vSeed) external {
        Vault v = _unsettledVault(vSeed);
        if (address(v) == address(0)) return;
        calls["cancel"]++;
        try v.cancel() { calls["cancel.ok"]++; } catch {}
    }

    function claimInKind(uint256 vSeed, bool asLender) external {
        Vault v;
        uint256 n = vaults.length;
        for (uint256 k = 0; k < n; k++) {
            Vault c = vaults[(vSeed % n + k) % n];
            if (c.settledInKind()) { v = c; break; }
        }
        if (address(v) == address(0)) return;
        calls["claimInKind"]++;
        vm.prank(asLender ? v.lender() : v.borrower());
        try v.claimInKind(address(usdx)) { calls["claimInKind.ok"]++; } catch {}
    }

    // ------------------------------------------------------------------
    // Helpers and views for the invariants
    // ------------------------------------------------------------------

    function _afterClose(Vault v, uint256 reserveBefore) internal {
        uint256 draw = v.settledInsuranceDraw();
        ghostReserve -= draw;
        if (draw > (reserveBefore * pool.maxDrawShareBps()) / 10000 ||
            draw > (v.principal() * pool.drawCapBps()) / 10000) {
            ghostDrawTooLarge = true;
        }
    }

    function _mintWeth(address to, uint256 amt) internal {
        weth.mint(to, amt);
        ghostWethMinted += amt;
    }

    /// @dev An open vault with its deposit paid, starting the search at
    ///      `seed`, or none. Searching (rather than picking one at random and
    ///      giving up) keeps the trading actions busy once early loans close.
    function _vault(uint256 seed) internal view returns (Vault) {
        uint256 n = vaults.length;
        for (uint256 k = 0; k < n; k++) {
            Vault v = vaults[(seed % n + k) % n];
            if (!v.isSettled() && v.depositPaid() && block.timestamp <= v.deadline()) return v;
        }
        return Vault(address(0));
    }

    function _unsettledVault(uint256 seed) internal view returns (Vault) {
        uint256 n = vaults.length;
        for (uint256 k = 0; k < n; k++) {
            Vault v = vaults[(seed % n + k) % n];
            if (!v.isSettled()) return v;
        }
        return Vault(address(0));
    }

    /// @dev An unsettled vault still holding the bought asset: the only kind
    ///      settleInKind accepts.
    function _holdingVault(uint256 seed) internal view returns (Vault) {
        uint256 n = vaults.length;
        for (uint256 k = 0; k < n; k++) {
            Vault v = vaults[(seed % n + k) % n];
            if (!v.isSettled() && v.heldAmount(address(usdx)) > 0) return v;
        }
        return Vault(address(0));
    }

    function _anyVault(uint256 seed) internal view returns (Vault) {
        if (vaults.length == 0) return Vault(address(0));
        return vaults[seed % vaults.length];
    }

    function vaultCount() external view returns (uint256) { return vaults.length; }
    function mandateCount() external view returns (uint256) { return mandateIds.length; }
    function lenderCount() external view returns (uint256) { return lenders.length; }
    function borrowerCount() external view returns (uint256) { return borrowers.length; }
}
