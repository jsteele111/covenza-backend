// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AssetRegistry.sol";
import "./InsurancePool.sol";
import "./interfaces/IERC20.sol";
import "./libraries/UniswapTwap.sol";

/**
 * @title Vault
 * @notice Per-borrower lending vault — Version 2.0, multi-asset.
 *
 *         Loans are natively denominated in any whitelisted ERC20 asset
 *         (WETH, WBTC, USDC, USDT, ...). The vault is ERC20-native
 *         throughout: principal arrives as an ERC20 transfer from the
 *         factory, the deposit is paid in the same asset, and settlement
 *         pays out in the same asset. Native ETH never enters this
 *         contract — ETH loans are WETH loans, wrapped at the edges.
 *
 *         DEPOSIT SEGREGATION INVARIANT (replaces v1's investedAmount cap):
 *         the vault's loan-asset balance may never drop below `deposit`
 *         as a result of any borrower action. Every borrower-triggered
 *         outflow of the loan asset (Aave supply, swap out) checks that
 *         the post-action balance remains >= deposit. One rule, enforced
 *         uniformly across all action types.
 *
 *         SETTLEMENT WATERFALL: deposit absorbs loss first (by
 *         construction of the payout math) --> insurance pool covers
 *         remaining shortfall (capped, post-deadline settlements only)
 *         --> only a true tail event reaches the lender's principal.
 *
 *         FORCED SWAP-BACK: if the borrower holds non-loan assets at
 *         settlement, they are swapped back to the loan asset first,
 *         TWAP-bounded (reverts if execution deviates beyond tolerance
 *         from the Uniswap V3 time-weighted average price — settlement
 *         happens in the loan asset or not at all). Three-tier access:
 *           T1 before deadline           - borrower only (early close)
 *           T2 deadline -> grace end     - lender or borrower, no bounty
 *           T3 after grace period        - anyone; time-increasing bounty
 *                                          paid from the borrower residual
 *         If no foreign assets are held, post-deadline settlement is
 *         open to anyone immediately (unchanged from v1).
 */

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract Vault {

    // --- Protocol references ---

    AssetRegistry public registry;
    InsurancePool public insurancePool;
    address       public factory;

    // --- Loan terms ---

    address public asset;           // the loan's denomination (whitelisted ERC20)
    address public lender;
    address public borrower;
    uint256 public principal;
    uint256 public deposit;         // amount actually paid (0 until payDeposit)
    uint256 public feeRateBps;
    uint256 public deadline;
    bool    public isSettled;

    uint256 private _requiredDeposit;

    // --- Foreign asset tracking (assets swapped into, not yet swapped back) ---

    address[] public heldAssets;
    mapping(address => bool)   public isHeld;
    mapping(address => uint24) public swapFeeTierOf;  // pool fee tier used when swapping in; reused for swap-back TWAP lookup

    // --- Settlement outcome (readable post-settlement) ---

    uint256 public settledTotalReturned;   // vault's own funds at settlement, BEFORE any insurance draw
    uint256 public settledInsuranceDraw;   // amount actually received from the insurance pool
    uint256 public settledLenderPayout;
    uint256 public settledBorrowerPayout;
    uint256 public settledFee;
    uint256 public settledBounty;

    // --- Events ---

    event VaultInitialised(address indexed lender, address indexed borrower, address indexed asset,
        uint256 principal, uint256 requiredDeposit, uint256 feeRateBps, uint256 deadline);
    event DepositReceived(address indexed borrower, uint256 amount);
    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, bool isSwapBack);
    event AaveSupplied(uint256 amount, uint256 timestamp);
    event AaveWithdrawn(uint256 amount, uint256 timestamp);
    event ForcedSwapBack(address indexed heldAsset, uint256 amountIn, uint256 amountOut);
    event Settled(address indexed triggeredBy, bool early, uint256 totalReturned, uint256 insuranceDraw,
        uint256 lenderPayout, uint256 borrowerPayout, uint256 fee, uint256 bounty, uint256 timestamp);

    // --- Constructor ---

    /**
     * @dev Deployed exclusively by VaultFactory, which transfers `_principal`
     *      of `_asset` to this vault within the same transaction. The vault
     *      trusts the factory for funding — the factory is the only
     *      authorised deployer, and its code guarantees the transfer.
     */
    constructor(
        address _asset,
        address _lender,
        address _borrower,
        uint256 _principal,
        uint256 _feeRateBps,
        uint256 _duration,
        bool    _useSeconds,
        uint256 _depositAmount,
        address _registry,
        address _insurancePool
    ) {
        require(_asset != address(0),         "Invalid asset address");
        require(_lender != address(0),        "Invalid lender address");
        require(_borrower != address(0),      "Invalid borrower address");
        require(_principal > 0,               "Principal must be greater than zero");
        require(_feeRateBps > 0,              "Fee rate must be greater than zero");
        require(_duration > 0,                "Duration must be greater than zero");
        require(_depositAmount > 0,           "Deposit must be greater than zero");
        require(_registry != address(0),      "Invalid registry address");
        require(_insurancePool != address(0), "Invalid insurance pool address");

        factory          = msg.sender;
        asset            = _asset;
        lender           = _lender;
        borrower         = _borrower;
        principal        = _principal;
        feeRateBps       = _feeRateBps;
        _requiredDeposit = _depositAmount;
        deadline         = _useSeconds ? block.timestamp + _duration
                                       : block.timestamp + (_duration * 1 days);
        registry         = AssetRegistry(_registry);
        insurancePool    = InsurancePool(_insurancePool);

        emit VaultInitialised(_lender, _borrower, _asset, _principal, _depositAmount, _feeRateBps, deadline);
    }

    // --- Deposit ---

    function requiredDeposit() external view returns (uint256) { return _requiredDeposit; }
    function depositPaid()     public  view returns (bool)     { return deposit >= _requiredDeposit; }

    /// @notice Borrower pays the required deposit (in the loan asset).
    ///         Borrower must approve this vault for the amount first.
    function payDeposit() external {
        require(msg.sender == borrower,      "Only borrower can pay deposit");
        require(deposit == 0,                "Deposit already paid");
        require(!isSettled,                  "Loan already settled");
        require(block.timestamp <= deadline, "Deadline has passed");

        deposit = _requiredDeposit;
        bool ok = IERC20(asset).transferFrom(borrower, address(this), _requiredDeposit);
        require(ok, "Deposit transfer failed");

        emit DepositReceived(borrower, _requiredDeposit);
    }

    // --- Deposit segregation invariant ---

    /// @dev Reverts if removing `amount` of the loan asset would leave the
    ///      vault holding less than the deposit. THE core safety rule.
    function _enforceDepositInvariant(uint256 amount) internal view {
        require(
            IERC20(asset).balanceOf(address(this)) >= amount + deposit,
            "Action would touch the deposit - deposit is not investable"
        );
    }

    modifier onlyActiveBorrower() {
        require(msg.sender == borrower,      "Only borrower can execute");
        require(depositPaid(),               "Deposit not yet paid");
        require(!isSettled,                  "Loan already settled");
        require(block.timestamp <= deadline, "Loan deadline has passed");
        _;
    }

    // --- Whitelisted action 1: Aave V3 supply/withdraw (loan asset only) ---

    /// @notice Supplies loan-asset funds to Aave V3 to earn yield.
    function supplyToAave(uint256 amount) external onlyActiveBorrower {
        require(amount > 0, "Amount must be greater than zero");
        require(registry.aTokenOf(asset) != address(0), "Asset has no Aave support");
        _enforceDepositInvariant(amount);

        address pool = registry.aavePool();
        require(IERC20(asset).approve(pool, amount), "Aave approval failed");
        IAavePool(pool).supply(asset, amount, address(this), 0);

        emit AaveSupplied(amount, block.timestamp);
    }

    /// @notice Withdraws a borrower-chosen amount back from Aave mid-term.
    function withdrawFromAave(uint256 amount) external onlyActiveBorrower {
        require(amount > 0, "Amount must be greater than zero");
        IAavePool(registry.aavePool()).withdraw(asset, amount, address(this));
        emit AaveWithdrawn(amount, block.timestamp);
    }

    // --- Whitelisted action 2: Uniswap V3 directional swaps ---

    /**
     * @notice Swaps the loan asset into a whitelisted foreign asset
     *         (directional exposure). The destination must be currently
     *         whitelisted, and the deposit invariant is enforced. For the
     *         reverse direction use swapBack() — always permitted, even if
     *         the held asset has since been removed from the whitelist.
     *         Swaps between two non-loan assets are not supported directly —
     *         route through the loan asset in two swaps.
     * @param tokenOut     Destination asset (must be whitelisted, != loan asset).
     * @param amountIn     Amount of the loan asset to swap.
     * @param minAmountOut Borrower-supplied slippage floor, enforced on-chain.
     * @param poolFee      Uniswap V3 fee tier (500 / 3000 / 10000).
     */
    function swap(
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint24  poolFee
    ) external onlyActiveBorrower {
        require(amountIn > 0,                       "Amount must be greater than zero");
        require(minAmountOut > 0,                   "minAmountOut must be greater than zero");
        require(tokenOut != asset,                  "Use swapBack() for the loan asset");
        require(registry.isWhitelisted(tokenOut),   "Destination asset not whitelisted");
        _enforceDepositInvariant(amountIn);

        uint256 amountOut = _executeSwap(asset, tokenOut, amountIn, minAmountOut, poolFee);
        _trackHeldAsset(tokenOut, poolFee);

        emit SwapExecuted(asset, tokenOut, amountIn, amountOut, false);
    }

    /// @notice Explicit swap-back entry point: converts `heldAsset` back to
    ///         the loan asset. Always permitted while the loan is active.
    function swapBack(
        address heldAsset,
        uint256 amountIn,
        uint256 minAmountOut
    ) external onlyActiveBorrower {
        require(isHeld[heldAsset], "Not a held asset");
        require(amountIn > 0,      "Amount must be greater than zero");
        require(minAmountOut > 0,  "minAmountOut must be greater than zero");

        uint256 amountOut = _executeSwap(heldAsset, asset, amountIn, minAmountOut, swapFeeTierOf[heldAsset]);
        _untrackIfEmptied(heldAsset);

        emit SwapExecuted(heldAsset, asset, amountIn, amountOut, true);
    }

    function _executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint24  poolFee
    ) internal returns (uint256 amountOut) {
        address router = registry.swapRouter();
        require(IERC20(tokenIn).approve(router, amountIn), "Swap approval failed");

        amountOut = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:  tokenIn,
                tokenOut: tokenOut,
                fee:      poolFee,
                recipient: address(this),
                deadline:  block.timestamp,
                amountIn:  amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _trackHeldAsset(address _asset, uint24 poolFee) internal {
        if (!isHeld[_asset]) {
            isHeld[_asset] = true;
            heldAssets.push(_asset);
        }
        swapFeeTierOf[_asset] = poolFee;
    }

    function _untrackIfEmptied(address _asset) internal {
        if (IERC20(_asset).balanceOf(address(this)) == 0 && isHeld[_asset]) {
            isHeld[_asset] = false;
            for (uint256 i = 0; i < heldAssets.length; i++) {
                if (heldAssets[i] == _asset) {
                    heldAssets[i] = heldAssets[heldAssets.length - 1];
                    heldAssets.pop();
                    break;
                }
            }
        }
    }

    function heldAssetCount() external view returns (uint256) { return heldAssets.length; }

    // --- Settlement ---

    /**
     * @notice Settles the loan. Early (borrower-only, before deadline) or
     *         post-deadline. Forced swap-back of any held foreign assets
     *         happens first, TWAP-bounded. See contract header for the
     *         three-tier access model and bounty rules.
     */
    function settle() external {
        require(!isSettled, "Loan already settled");

        bool early = block.timestamp <= deadline;
        uint256 bounty = 0;

        if (early) {
            require(msg.sender == borrower, "Only borrower can close early");
            require(depositPaid(),          "Deposit not yet paid");
        } else if (heldAssets.length > 0) {
            uint256 graceEnd = deadline + registry.swapBackGracePeriod();
            if (block.timestamp <= graceEnd) {
                require(msg.sender == lender || msg.sender == borrower,
                    "Grace period: only lender or borrower may settle");
            } else if (msg.sender != lender && msg.sender != borrower) {
                bounty = _accruedBounty(graceEnd);
            }
        }
        // No foreign assets + past deadline: open to anyone immediately, no bounty (v1 behaviour).

        isSettled = true; // before external calls — reentrancy guard

        _forcedSwapBackAll();
        _withdrawAllFromAave();
        _distribute(early, bounty);
    }

    /// @dev Settlement phase 2: computes the waterfall, stores the outcome,
    ///      and pays out. Separated from settle() to keep each function's
    ///      stack frame within EVM limits — and it reads better in an audit.
    function _distribute(bool early, uint256 bounty) internal {
        uint256 totalReturned = IERC20(asset).balanceOf(address(this));
        uint256 fee          = (principal * feeRateBps) / 10000;
        uint256 lenderTarget = principal + fee;

        if (early) {
            require(totalReturned >= lenderTarget, "Cannot close early at a loss beyond deposit");
        }

        // Insurance pool draw — post-deadline settlements only. Early close
        // must make the lender whole from the vault's own funds; a borrower
        // voluntarily realising a loss cannot tap the shared pool at will.
        uint256 insuranceDraw = 0;
        if (!early && totalReturned < lenderTarget) {
            insuranceDraw = insurancePool.draw(asset, lenderTarget - totalReturned, principal);
        }

        uint256 available        = totalReturned + insuranceDraw;
        uint256 lenderPayout     = available >= lenderTarget ? lenderTarget : available;
        uint256 borrowerResidual = available > lenderTarget ? available - lenderTarget : 0;

        if (bounty > borrowerResidual) { bounty = borrowerResidual; }

        settledTotalReturned  = totalReturned;
        settledInsuranceDraw  = insuranceDraw;
        settledLenderPayout   = lenderPayout;
        settledBorrowerPayout = borrowerResidual - bounty;
        settledFee            = fee;
        settledBounty         = bounty;

        require(IERC20(asset).transfer(lender, lenderPayout), "Failed to pay lender");
        if (settledBorrowerPayout > 0) {
            require(IERC20(asset).transfer(borrower, settledBorrowerPayout), "Failed to pay borrower");
        }
        if (bounty > 0) {
            require(IERC20(asset).transfer(msg.sender, bounty), "Failed to pay bounty");
        }

        emit Settled(msg.sender, early, settledTotalReturned, settledInsuranceDraw,
            settledLenderPayout, settledBorrowerPayout, settledFee, settledBounty, block.timestamp);
    }

    /// @dev Swaps every held foreign asset back to the loan asset,
    ///      TWAP-bounded: output must be within the registry's tolerance of
    ///      the TWAP-implied value, or the whole settlement reverts.
    ///      Settlement happens in the loan asset, or not at all.
    function _forcedSwapBackAll() internal {
        address router = registry.swapRouter();
        uint32 twapWindow = registry.twapWindow();
        uint256 tolBps = registry.twapToleranceBps();

        while (heldAssets.length > 0) {
            address held = heldAssets[heldAssets.length - 1];
            uint256 bal = IERC20(held).balanceOf(address(this));
            if (bal > 0) {
                uint24 feeTier = swapFeeTierOf[held];
                uint256 twapQuote = UniswapTwap.quote(
                    registry.uniswapFactory(), held, asset, feeTier, bal, twapWindow
                );
                uint256 minOut = (twapQuote * (10000 - tolBps)) / 10000;

                require(IERC20(held).approve(router, bal), "Swap-back approval failed");
                uint256 out = ISwapRouter(router).exactInputSingle(
                    ISwapRouter.ExactInputSingleParams({
                        tokenIn: held, tokenOut: asset, fee: feeTier,
                        recipient: address(this), deadline: block.timestamp,
                        amountIn: bal, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
                    })
                );
                emit ForcedSwapBack(held, bal, out);
            }
            isHeld[held] = false;
            heldAssets.pop();
        }
    }

    /// @dev Withdraws the vault's full Aave position, if any. Hardened:
    ///      balance must genuinely decrease (the v1 stuck-funds fix, kept).
    function _withdrawAllFromAave() internal {
        address aToken = registry.aTokenOf(asset);
        if (aToken == address(0) || aToken.code.length == 0) { return; }

        uint256 before = IERC20(aToken).balanceOf(address(this));
        if (before == 0) { return; }

        IAavePool(registry.aavePool()).withdraw(asset, type(uint256).max, address(this));

        require(IERC20(aToken).balanceOf(address(this)) < before, "Aave withdrawal did not reduce balance");
        emit AaveWithdrawn(before, block.timestamp);
    }

    /// @dev Time-increasing keeper bounty: linear accrual from grace end,
    ///      rate and cap read from the registry (operator-configurable;
    ///      launch values to be calibrated empirically per the spec).
    function _accruedBounty(uint256 graceEnd) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - graceEnd;
        uint256 ratePerHourBps = registry.bountyRatePerHourBps();
        uint256 capBps = registry.bountyCapBps();
        uint256 accruedBps = (elapsed * ratePerHourBps) / 1 hours;
        if (accruedBps > capBps) { accruedBps = capBps; }
        return (principal * accruedBps) / 10000;
    }

    // --- Views ---

    function vaultBalance() external view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    function isExpired() external view returns (bool) {
        return block.timestamp > deadline && !isSettled;
    }

    /// 0 = no loss (or unsettled); 1 = borrower-only; 2 = lender-impacted.
    /// Severity reflects the vault's OWN performance (pre-insurance-draw):
    /// a pool draw that makes the lender whole still records severity 1+,
    /// because the loss genuinely occurred — the pool absorbed it.
    function lossSeverity() external view returns (uint8) {
        if (!isSettled) return 0;
        if (settledLenderPayout < principal + settledFee) return 2;
        if (settledTotalReturned < principal + deposit) return 1;
        return 0;
    }
}
