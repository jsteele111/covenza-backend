// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Vault
 * @notice Per-borrower lending vault for the low-collateral lending protocol.
 *         Version 1.0 — tranche-based settlement. Deposit is pure untouched
 *         collateral; principal is the only capital ever put to work via the
 *         whitelisted Aave action. Settlement is a single unified function
 *         that liquidates the vault's own position and pays lender + borrower
 *         directly from it — the borrower never needs to source external
 *         funds to close out a loan.
 *
 * @dev Vault holds two distinct pools of ETH:
 *      1. principal   — the lender's funds. Only this may ever be invested.
 *      2. deposit     — the borrower's upfront risk buffer. Never invested,
 *                       sits untouched until settlement.
 *
 *      At settlement (repay early, or default after deadline):
 *      - Vault liquidates any Aave position back to plain ETH.
 *      - totalReturned = whatever the vault now holds (deposit + principal
 *        + investment P&L).
 *      - fee = principal * feeRateBps / 10000, agreed at origination,
 *        charged in FULL regardless of when settlement happens (no proration
 *        for early close).
 *      - lender receives min(totalReturned, principal + fee).
 *      - borrower receives whatever's left over (could be less than deposit
 *        if there was a loss; could be more than deposit if there was a
 *        profit).
 *      - Deposit absorbs losses first, by construction of this math — no
 *        separate branching needed. Losses beyond deposit are borne by the
 *        lender in the interim, until an insurance pool exists (FR-12).
 */

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract Vault {

    // --- State variables ---

    address public lender;
    address public borrower;
    uint256 public principal;
    uint256 public deposit;
    uint256 public feeRateBps;      // fixed fee rate agreed at origination, e.g. 300 = 3%
    uint256 public deadline;
    bool    public isSettled;

    uint256 public investedAmount;  // cumulative amount of `principal` supplied to Aave

    // Settlement outcome, readable after settle() completes. Needed because
    // settle() fully drains the vault's balance — without these, the actual
    // payout amounts would only ever exist in the emitted Settled event,
    // unreadable by a front-end without scanning historical event logs.
    uint256 public settledTotalReturned;
    uint256 public settledLenderPayout;
    uint256 public settledBorrowerPayout;
    uint256 public settledFee;

    // --- Internal storage for required deposit ---
    uint256 private _requiredDeposit;

    // --- Events ---

    event VaultInitialised(
        address indexed lender,
        address indexed borrower,
        uint256 principal,
        uint256 requiredDeposit,
        uint256 feeRateBps,
        uint256 deadline
    );

    event DepositReceived(
        address indexed borrower,
        uint256 amount
    );

    event Settled(
        address indexed triggeredBy,
        bool    early,
        uint256 totalReturned,
        uint256 lenderPayout,
        uint256 borrowerPayout,
        uint256 fee,
        uint256 timestamp
    );

    // --- Whitelisted external protocol addresses (Arbitrum Sepolia testnet) ---
    address public constant AAVE_WETH_GATEWAY = 0x20040a64612555042335926d72B4E5F667a67fA1;
    address public constant AAVE_WETH_A_TOKEN = 0xf5f17EbE81E516Dc7cB38D61908EC252F150CE60;

    event WhitelistedActionExecuted(
        address indexed borrower,
        address indexed target,
        uint256 amount,
        uint256 timestamp
    );

    event AaveWithdrawn(
        uint256 amount,
        uint256 timestamp
    );

    // --- Constructor ---

    /**
     * @param _lender         The lender's wallet address (EOA or protocol address).
     * @param _borrower       Authorised borrower address.
     * @param _feeRateBps     Fixed fee rate in basis points (e.g. 300 = 3%),
     *                        applied to principal, charged in full regardless
     *                        of early or on-time settlement.
     * @param _duration       Duration in seconds (if _useSeconds=true) or days.
     * @param _useSeconds     True for testnet/PoC short durations, false for production.
     * @param _depositAmount  Required deposit amount the borrower must pay.
     */
    constructor(
        address _lender,
        address _borrower,
        uint256 _feeRateBps,
        uint256 _duration,
        bool    _useSeconds,
        uint256 _depositAmount
    ) payable {
        require(_lender != address(0),   "Invalid lender address");
        require(_borrower != address(0), "Invalid borrower address");
        require(msg.value > 0,           "Principal must be greater than zero");
        require(_feeRateBps > 0,         "Fee rate must be greater than zero");
        require(_duration > 0,           "Duration must be greater than zero");
        require(_depositAmount > 0,      "Deposit must be greater than zero");

        lender            = _lender;
        borrower          = _borrower;
        principal         = msg.value;
        feeRateBps        = _feeRateBps;
        deposit           = 0;
        _requiredDeposit  = _depositAmount;
        deadline          = _useSeconds
                            ? block.timestamp + _duration
                            : block.timestamp + (_duration * 1 days);
        isSettled         = false;

        emit VaultInitialised(
            lender,
            borrower,
            msg.value,
            _depositAmount,
            _feeRateBps,
            deadline
        );
    }

    /**
     * @notice Allows the vault to receive plain ETH transfers with no calldata —
     *         required for Aave's WETH Gateway to send withdrawn ETH back here.
     */
    receive() external payable {}

    // --- Deposit view functions ---

    /// @notice Returns the deposit amount required from the borrower.
    function requiredDeposit() external view returns (uint256) {
        return _requiredDeposit;
    }

    /// @notice Returns true once the borrower has paid the required deposit.
    function depositPaid() external view returns (bool) {
        return deposit >= _requiredDeposit;
    }

    // --- Deposit payment ---

    /**
     * @notice Borrower pays the required deposit to activate the vault.
     *         Must send exactly the required amount before the deadline.
     */
    function payDeposit() external payable {
        require(msg.sender == borrower,        "Only borrower can pay deposit");
        require(deposit == 0,                  "Deposit already paid");
        require(!isSettled,                    "Loan already settled");
        require(block.timestamp <= deadline,   "Deadline has passed");
        require(msg.value == _requiredDeposit, "Must send exact deposit amount");

        deposit = msg.value;

        emit DepositReceived(borrower, msg.value);
    }

    // --- Aave whitelist ---

    /**
     * @notice Allows the borrower to supply vault-held ETH to Aave V3 via the
     *         WETH Gateway, earning yield on idle capital while the loan is
     *         active. Only `principal` may ever be invested — deposit is pure
     *         collateral and is never at risk in the investment itself.
     *         Cumulative investment across multiple calls is capped at
     *         `principal` via `investedAmount`.
     * @param amount The amount of ETH to supply to Aave.
     */
    function supplyToAave(uint256 amount) external {
        require(msg.sender == borrower,      "Only borrower can execute");
        require(deposit >= _requiredDeposit, "Deposit not yet paid");
        require(!isSettled,                  "Loan already settled");
        require(block.timestamp <= deadline, "Loan deadline has passed");
        require(amount > 0,                  "Amount must be greater than zero");
        require(
            investedAmount + amount <= principal,
            "Cannot invest more than principal - deposit is not investable"
        );
        // Note: no separate "amount <= vault balance" check needed here.
        // Vault balance is always >= principal (deposit only ever adds to
        // it, never subtracts below principal), so the cap above is always
        // at least as strict — a redundant balance check would be
        // unreachable dead code.

        investedAmount += amount;

        (bool success, ) = AAVE_WETH_GATEWAY.call{value: amount}(
            abi.encodeWithSignature(
                "depositETH(address,address,uint16)",
                address(0),
                address(this),
                uint16(0)
            )
        );
        require(success, "Aave supply call failed");

        emit WhitelistedActionExecuted(msg.sender, AAVE_WETH_GATEWAY, amount, block.timestamp);
    }

    /**
     * @dev Internal helper: pulls any Aave-supplied funds back into the vault
     *      as plain ETH. Called automatically at the start of settle(), so
     *      the vault's ability to close out a loan never depends on the
     *      borrower proactively withdrawing first.
     *
     *      Two-step process required by Aave's WETH Gateway:
     *      1. Approve the Gateway to pull the vault's aWETH.
     *      2. Call withdrawETH, which burns the aWETH, unwraps to ETH,
     *         and sends it to `to` (the vault itself, via receive()).
     *
     *      Hardened check: after the withdrawal call, confirms the aWETH
     *      balance actually decreased — not just that the low-level call
     *      didn't revert. A call that reports success without genuinely
     *      executing (e.g. an unexpected fallback on the target) would
     *      otherwise let isSettled flip to true while funds remain
     *      permanently stuck in Aave, with no other code path able to
     *      retrieve them.
     *
     *      Explicitly checks for deployed code at the aToken address first.
     *      On networks where it doesn't exist (e.g. local test networks),
     *      this safely does nothing rather than attempting a call that would
     *      fail in a way ordinary try/catch cannot reliably intercept — so
     *      plain ETH-only vaults that never touched Aave are unaffected.
     */
    function _withdrawFromAaveIfNeeded() internal {
        if (AAVE_WETH_A_TOKEN.code.length == 0) {
            // No aToken contract deployed on this network — nothing to withdraw
            return;
        }

        uint256 aWethBalanceBefore = IERC20(AAVE_WETH_A_TOKEN).balanceOf(address(this));
        if (aWethBalanceBefore == 0) {
            return;
        }

        bool approveSuccess = IERC20(AAVE_WETH_A_TOKEN).approve(AAVE_WETH_GATEWAY, aWethBalanceBefore);
        require(approveSuccess, "aWETH approval failed");

        (bool withdrawSuccess, ) = AAVE_WETH_GATEWAY.call(
            abi.encodeWithSignature(
                "withdrawETH(address,uint256,address)",
                address(0),
                aWethBalanceBefore,
                address(this)
            )
        );
        require(withdrawSuccess, "Aave withdrawal failed");

        uint256 aWethBalanceAfter = IERC20(AAVE_WETH_A_TOKEN).balanceOf(address(this));
        require(
            aWethBalanceAfter < aWethBalanceBefore,
            "Aave withdrawal did not reduce balance"
        );

        emit AaveWithdrawn(aWethBalanceBefore - aWethBalanceAfter, block.timestamp);
    }

    // --- Core logic ---

    /**
     * @notice Settles the loan — either a voluntary early close (borrower-only,
     *         any time before the deadline) or a post-deadline close (callable
     *         by anyone, keeper-style, same as the old settleDefault()).
     *
     *         Automatically liquidates any Aave position first. Pays the lender
     *         principal + fee (fee is always the full-term amount, never
     *         prorated for early close), capped at whatever the vault actually
     *         holds. Borrower receives the remainder — which absorbs any
     *         investment loss first (via the deposit) before the lender's
     *         principal is ever touched.
     *
     *         Early close is only permitted if the lender would be made whole
     *         (totalReturned >= principal + fee) — a borrower cannot use early
     *         close to walk away from a locked-in loss.
     */
    function settle() external {
        require(!isSettled, "Loan already settled");

        bool early = block.timestamp <= deadline;

        if (early) {
            require(msg.sender == borrower,      "Only borrower can close early");
            require(deposit >= _requiredDeposit, "Deposit not yet paid");
        }

        isSettled = true; // set before any external calls — reentrancy guard

        _withdrawFromAaveIfNeeded();

        uint256 totalReturned = address(this).balance;
        uint256 fee = (principal * feeRateBps) / 10000;
        uint256 lenderTarget = principal + fee;

        uint256 lenderPayout   = totalReturned >= lenderTarget ? lenderTarget : totalReturned;
        uint256 borrowerPayout = totalReturned > lenderTarget ? totalReturned - lenderTarget : 0;

        if (early) {
            require(totalReturned >= lenderTarget, "Cannot close early at a loss beyond deposit");
        }

        settledTotalReturned  = totalReturned;
        settledLenderPayout   = lenderPayout;
        settledBorrowerPayout = borrowerPayout;
        settledFee            = fee;

        (bool lenderSent, ) = lender.call{value: lenderPayout}("");
        require(lenderSent, "Failed to pay lender");

        if (borrowerPayout > 0) {
            (bool borrowerSent, ) = borrower.call{value: borrowerPayout}("");
            require(borrowerSent, "Failed to pay borrower");
        }

        emit Settled(msg.sender, early, totalReturned, lenderPayout, borrowerPayout, fee, block.timestamp);
    }

    // --- View functions ---

    /// @notice Returns the ETH balance currently held in this vault.
    function vaultBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Returns true if the loan deadline has passed without settlement.
    function isExpired() external view returns (bool) {
        return block.timestamp > deadline && !isSettled;
    }

    /// @notice Returns a loss severity classification for the settlement
    ///         outcome, matching the off-chain classification used by
    ///         scripts/settle.js and scripts/check-loss-history.js. Kept
    ///         on-chain as the single canonical source of truth, so the
    ///         front-end never needs to reimplement this logic separately.
    ///         0 = not yet settled, or settled with no loss.
    ///         1 = borrower-only loss (deposit absorbed it, lender made whole).
    ///         2 = lender-impacted loss (deposit insufficient, lender
    ///             received less than principal + fee).
    function lossSeverity() external view returns (uint8) {
        if (!isSettled) return 0;
        uint256 lenderTarget = principal + settledFee;
        uint256 noLossBaseline = principal + deposit;
        if (settledLenderPayout < lenderTarget) return 2;
        if (settledTotalReturned < noLossBaseline) return 1;
        return 0;
    }
}
