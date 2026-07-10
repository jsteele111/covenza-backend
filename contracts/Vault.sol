// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Vault
 * @notice Per-borrower lending vault for the low-collateral lending protocol.
 *         Version 0.9 — adds a receive() function so the vault can accept
 *         plain ETH transfers with no calldata, required for Aave's WETH
 *         Gateway to send withdrawn funds back to the vault.
 *
 * @dev Vault holds two distinct pools of ETH:
 *      1. principal   — the lender's funds, locked for the loan duration.
 *      2. deposit     — the borrower's upfront risk buffer, held separately.
 *
 *      On repayment:  principal + deposit → borrower, repayment → lender.
 *      On default:    deposit covers shortfall only. Excess deposit returned
 *                     to borrower. Residual loss borne by lender / insurance pool.
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
    uint256 public repaymentDue;
    uint256 public deadline;
    bool    public isSettled;

    // --- Internal storage for required deposit ---
    uint256 private _requiredDeposit;

    // --- Events ---

    event VaultInitialised(
        address indexed lender,
        address indexed borrower,
        uint256 principal,
        uint256 requiredDeposit,
        uint256 repaymentDue,
        uint256 deadline
    );

    event DepositReceived(
        address indexed borrower,
        uint256 amount
    );

    event LoanRepaid(
        address indexed borrower,
        uint256 amountRepaid,
        uint256 depositReturned,
        uint256 timestamp
    );

    event LoanDefaulted(
        address indexed triggeredBy,
        uint256 principalSwept,
        uint256 depositApplied,
        uint256 depositReturned,
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
     * @param _repaymentDue   Total repayment amount (principal + fee).
     * @param _duration       Duration in seconds (if _useSeconds=true) or days.
     * @param _useSeconds     True for testnet/PoC short durations, false for production.
     * @param _depositAmount  Required deposit amount the borrower must pay.
     */
    constructor(
        address _lender,
        address _borrower,
        uint256 _repaymentDue,
        uint256 _duration,
        bool    _useSeconds,
        uint256 _depositAmount
    ) payable {
        require(_lender != address(0),      "Invalid lender address");
        require(_borrower != address(0),    "Invalid borrower address");
        require(msg.value > 0,              "Principal must be greater than zero");
        require(_repaymentDue >= msg.value, "Repayment must be >= principal");
        require(_duration > 0,             "Duration must be greater than zero");
        require(_depositAmount > 0,         "Deposit must be greater than zero");

        lender            = _lender;
        borrower          = _borrower;
        principal         = msg.value;
        repaymentDue      = _repaymentDue;
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
            _repaymentDue,
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
     *         WETH Gateway, earning yield on idle capital while the loan is active.
     *         This is the only external call the vault will ever make on the
     *         borrower's behalf — calls to any other address are rejected.
     * @param amount The amount of ETH to supply to Aave.
     */
    function supplyToAave(uint256 amount) external {
        require(msg.sender == borrower,      "Only borrower can execute");
        require(deposit >= _requiredDeposit, "Deposit not yet paid");
        require(!isSettled,                  "Loan already settled");
        require(block.timestamp <= deadline, "Loan deadline has passed");
        require(amount > 0,                  "Amount must be greater than zero");
        require(amount <= address(this).balance, "Insufficient vault balance");

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
     *      as plain ETH. Called automatically at the start of repay() and
     *      settleDefault(), so the vault's ability to close out a loan never
     *      depends on the borrower proactively withdrawing first.
     *
     *      Two-step process required by Aave's WETH Gateway:
     *      1. Approve the Gateway to pull the vault's aWETH.
     *      2. Call withdrawETH, which burns the aWETH, unwraps to ETH,
     *         and sends it to `to` (the vault itself, via receive()).
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

        uint256 aWethBalance = IERC20(AAVE_WETH_A_TOKEN).balanceOf(address(this));
        if (aWethBalance == 0) {
            return;
        }

        bool approveSuccess = IERC20(AAVE_WETH_A_TOKEN).approve(AAVE_WETH_GATEWAY, aWethBalance);
        require(approveSuccess, "aWETH approval failed");

        (bool withdrawSuccess, ) = AAVE_WETH_GATEWAY.call(
            abi.encodeWithSignature(
                "withdrawETH(address,uint256,address)",
                address(0),
                aWethBalance,
                address(this)
            )
        );
        require(withdrawSuccess, "Aave withdrawal failed");

        emit AaveWithdrawn(aWethBalance, block.timestamp);
    }

    // --- Core logic ---

    /**
     * @notice Borrower repays the loan in full before the deadline.
     *         Automatically withdraws any Aave-supplied funds first.
     *         On success: repayment goes to lender, principal + deposit
     *         returned to borrower.
     */
    function repay() external payable {
        require(msg.sender == borrower,      "Only borrower can repay");
        require(!isSettled,                  "Loan already settled");
        require(deposit >= _requiredDeposit, "Deposit not yet paid");
        require(block.timestamp <= deadline, "Loan deadline has passed");
        require(msg.value == repaymentDue,   "Must repay exact amount owed");

        _withdrawFromAaveIfNeeded();

        isSettled = true;

        uint256 depositToReturn = deposit;
        deposit = 0;

        // Return deposit to borrower
        (bool depositSent, ) = borrower.call{value: depositToReturn}("");
        require(depositSent, "Failed to return deposit to borrower");

        // Return principal to borrower
        (bool principalSent, ) = borrower.call{value: principal}("");
        require(principalSent, "Failed to return principal to borrower");

        // Send repayment to lender
        (bool repaymentSent, ) = lender.call{value: msg.value}("");
        require(repaymentSent, "Failed to send repayment to lender");

        emit LoanRepaid(borrower, msg.value, depositToReturn, block.timestamp);
    }

    /**
     * @notice Settles a defaulted loan. Callable by anyone after the deadline.
     *         Automatically withdraws any Aave-supplied funds first.
     *
     *         Deposit covers shortfall only:
     *         - Lender receives up to repaymentDue.
     *         - Excess deposit returned to borrower.
     *         - Residual loss (vault+deposit < repaymentDue) borne by lender
     *           and covered by insurance pool at protocol level (FR-12).
     */
    function settleDefault() external {
        require(!isSettled,                 "Loan already settled");
        require(block.timestamp > deadline, "Deadline has not yet passed");

        _withdrawFromAaveIfNeeded();

        isSettled = true;

        uint256 totalAvailable  = address(this).balance;
        uint256 depositApplied  = 0;
        uint256 depositReturned = 0;

        if (totalAvailable >= repaymentDue) {
            // Vault covers full repayment — return excess to borrower
            depositReturned = totalAvailable - repaymentDue;
            depositApplied  = deposit > depositReturned
                              ? deposit - depositReturned
                              : 0;

            (bool lenderSent, ) = lender.call{value: repaymentDue}("");
            require(lenderSent, "Failed to send to lender");

            if (depositReturned > 0) {
                (bool borrowerSent, ) = borrower.call{value: depositReturned}("");
                require(borrowerSent, "Failed to return excess deposit to borrower");
            }
        } else {
            // Vault insufficient — deposit partially or fully consumed
            depositApplied  = deposit;
            depositReturned = 0;

            (bool lenderSent, ) = lender.call{value: totalAvailable}("");
            require(lenderSent, "Failed to send to lender");
        }

        emit LoanDefaulted(
            msg.sender,
            principal,
            depositApplied,
            depositReturned,
            block.timestamp
        );
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
}