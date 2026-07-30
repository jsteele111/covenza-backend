// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AssetRegistry.sol";
import "./InsurancePool.sol";
import "./interfaces/IERC20.sol";
import "./libraries/UniswapTwap.sol";

/**
 * @title Vault
 * @notice Per-borrower lending vault — Version 2.1, multi-asset.
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
 *         Once the lender is whole, the surviving residual is distributed
 *         in order: keeper bounty --> protocol fee --> borrower.
 *
 *         PROTOCOL FEE (v2.1): an ADD-ON charged to the borrower, taken
 *         from the residual at settlement. The lender's payout is entirely
 *         unaffected by it — their advertised yield is what they receive.
 *         Because the fee comes only from what survives after the lender
 *         is made whole, a loss automatically yields zero protocol fee:
 *         the protocol earns only when the lender does. Fee terms are
 *         SNAPSHOTTED at origination and never re-read, so they cannot be
 *         changed beneath a live loan.
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

/**
 * @dev The second yield venue is the ERC-4626 STANDARD rather than a named
 *      protocol. Aave is not deployed on every chain Covenza targets; binding
 *      to a specific lending market would mean re-integrating per chain. Any
 *      compliant vault — MetaMorpho, Yearn, others — works through this one
 *      interface.
 *
 *      Unlike Aave's aToken, which rebases 1:1 with the underlying, 4626
 *      shares appreciate against it. Hence convertToAssets() wherever a
 *      position's VALUE is needed rather than its share count.
 */
interface IERC4626 {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

/**
 * @dev This is **SwapRouter02**, not the original SwapRouter.
 *
 *      The two differ by exactly one field: v1's ExactInputSingleParams
 *      carries a `deadline`, SwapRouter02's does not (it moved deadline
 *      handling into multicall). Because the parameter is a struct, that one
 *      field changes the tuple signature and therefore the FUNCTION SELECTOR:
 *
 *        v1  exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
 *        02  exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
 *
 *      So calling one with the other's struct does not misprice — it finds no
 *      matching function and reverts. Every swap, permanently.
 *
 *      Robinhood Chain deployed SwapRouter02 (0xcaf681a6…5cb2) and no v1
 *      router, so SwapRouter02 is what this must target. Uniswap's own
 *      deployment docs warn that addresses and versions no longer track
 *      across chains; this is that warning biting.
 *
 *      Dropping `deadline` costs nothing here: the vault passed
 *      block.timestamp, which is a no-op deadline that can never expire
 *      within the transaction evaluating it.
 */
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @notice Protocol fee terms, snapshotted into each vault at origination.
 * @dev    Passed as a struct rather than four separate constructor
 *         arguments to keep the constructor's stack frame within EVM limits.
 *
 *         SNAPSHOTTING IS THE POINT. A vault must never read the factory's
 *         current fee rate at settlement time — that would let the operator
 *         raise the rate after a loan is live and retroactively take a
 *         larger cut. Terms are fixed at the moment both parties commit.
 */
/**
 * @notice The loan's terms, passed to initialize() as one memory struct.
 *
 * @dev Same reason FeeConfig exists, one step further. Eleven separate
 *      arguments fitted inside a constructor's frame, but initialize() is an
 *      EXTERNAL call — the caller must hold every argument live on the stack
 *      while making it, and VaultFactory.deployVault already has eight
 *      parameters plus locals of its own. That combination overflowed.
 *
 *      A memory struct costs the caller a single stack slot: a pointer. So
 *      what were eleven live values become two.
 */
struct LoanTerms {
    address asset;
    address lender;
    address borrower;
    uint256 principal;
    uint256 aprBps;
    uint256 duration;
    bool    useSeconds;      // treat duration as seconds rather than days
    uint256 depositAmount;
    address registry;
    address insurancePool;
}

struct FeeConfig {
    address treasury;             // protocol fee recipient
    address referrer;             // integrator that sourced this loan; address(0) if none
    uint256 protocolFeeRateBps;   // protocol fee, in bps of the loan's fee
    uint256 referrerShareBps;     // referrer's share of the protocol fee, in bps
    uint256 minimumFeeBps;        // floor on the interest charge, in bps of principal
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
    /**
     * @notice Interest rate, ANNUALISED, in basis points. 300 = 3% per year.
     *
     * @dev    Renamed from feeRateBps in the move to annualised interest. The
     *         old name described a flat charge applied regardless of duration,
     *         which meant a 7-day loan and a 365-day loan at "3%" cost the
     *         borrower the same amount — not how credit works anywhere.
     *
     *         Kept as a rename rather than an alias precisely because the
     *         semantics changed. A feeRateBps() that returned an APR would be
     *         actively misleading to anything still reading it.
     */
    uint256 public aprBps;

    uint256 public originatedAt;   // when the clock started
    uint256 public term;           // loan length in seconds; deadline = originatedAt + term
    uint256 public deadline;
    bool    public isSettled;

    uint256 private _requiredDeposit;

    // --- Protocol fee terms (snapshotted at origination, never re-read) ---

    address public treasury;
    address public referrer;
    uint256 public protocolFeeRateBps;
    uint256 public referrerShareBps;
    uint256 public minimumFeeBps;

    // --- Yield venue (snapshotted at first supply, never re-read) ---
    //
    // Same reasoning as the fee terms above. An operator repointing an
    // asset's venue mid-loan must not be able to strand a position: the
    // vault settles against the venue it actually supplied to, not whatever
    // the registry says today. Zero kind means the vault has never supplied.

    uint8   public yieldVenueKind;      // 0 None, 1 Aave, 2 ERC4626 — mirrors AssetRegistry.YieldVenue
    address public yieldVenue;          // Aave pool, or the ERC-4626 vault
    address public yieldPositionToken;  // aToken, or the ERC-4626 vault (its own share token)

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
    uint256 public settledProtocolFee;     // paid to treasury at settlement
    uint256 public settledReferrerFee;     // paid to referrer at settlement

    // --- Events ---

    event VaultInitialised(address indexed lender, address indexed borrower, address indexed asset,
        uint256 principal, uint256 requiredDeposit, uint256 aprBps, uint256 deadline);
    event DepositReceived(address indexed borrower, uint256 amount);
    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, bool isSwapBack);
    event AaveSupplied(uint256 amount, uint256 timestamp);
    event AaveWithdrawn(uint256 amount, uint256 timestamp);
    event YieldSupplied(uint8 indexed venue, uint256 amount, uint256 timestamp);
    event YieldWithdrawn(uint8 indexed venue, uint256 amount, uint256 timestamp);
    event ForcedSwapBack(address indexed heldAsset, uint256 amountIn, uint256 amountOut);
    event Settled(address indexed triggeredBy, bool early, uint256 totalReturned, uint256 insuranceDraw,
        uint256 lenderPayout, uint256 borrowerPayout, uint256 fee, uint256 bounty, uint256 timestamp);
    event ProtocolFeePaid(address indexed treasury, address indexed referrer,
        uint256 treasuryAmount, uint256 referrerAmount);

    // --- Constructor ---

    /**
     * @dev Locks this contract against initialisation.
     *
     *      Vaults are now minimal proxies (EIP-1167) cloned from a single
     *      deployed implementation, because VaultFactory previously embedded
     *      Vault's entire creation bytecode and had grown to 25,106 bytes
     *      against the 24,576-byte EIP-170 limit — undeployable. Cloning makes
     *      factory size constant no matter how large Vault becomes.
     *
     *      Clones do not run constructors, so every clone starts with
     *      factory == address(0) and can be initialised exactly once. This
     *      implementation gets a non-zero factory, so initialize() reverts on
     *      it. Seizing the implementation could not affect existing clones
     *      (their storage is their own) but leaving it open serves no purpose.
     */
    constructor() {
        factory = address(this);
    }

    /**
     * @notice Sets up a freshly cloned vault. Callable exactly once, by the
     *         factory, in the same transaction as the clone.
     *
     * @dev Replaces the former constructor. The factory transfers `_principal`
     *      of `_asset` to this vault within the same transaction — the vault
     *      trusts the factory for funding, the factory is the only authorised
     *      initialiser, and its code guarantees the transfer.
     *
     *      The `factory == address(0)` guard is both the re-initialisation
     *      check and the storage it would otherwise need: an initialised vault
     *      always has a factory, so no separate flag is required.
     */
    function initialize(
        LoanTerms memory _terms,
        FeeConfig memory _feeConfig
    ) external {
        require(factory == address(0),               "Already initialised");
        require(_terms.asset != address(0),          "Invalid asset address");
        require(_terms.lender != address(0),         "Invalid lender address");
        require(_terms.borrower != address(0),       "Invalid borrower address");
        require(_terms.principal > 0,                "Principal must be greater than zero");
        require(_terms.aprBps > 0,                   "APR must be greater than zero");
        require(_terms.duration > 0,                 "Duration must be greater than zero");
        require(_terms.depositAmount > 0,            "Deposit must be greater than zero");
        require(_terms.registry != address(0),       "Invalid registry address");
        require(_terms.insurancePool != address(0),  "Invalid insurance pool address");

        factory          = msg.sender;
        asset            = _terms.asset;
        lender           = _terms.lender;
        borrower         = _terms.borrower;
        principal        = _terms.principal;
        aprBps           = _terms.aprBps;
        _requiredDeposit = _terms.depositAmount;

        // Term is stored explicitly rather than derived from deadline, because
        // pro-rata accrual needs both the start and the length, and deriving
        // one from the other at settlement would mean trusting block.timestamp
        // arithmetic done twice.
        originatedAt     = block.timestamp;
        term             = _terms.useSeconds ? _terms.duration : _terms.duration * 1 days;
        deadline         = originatedAt + term;
        registry         = AssetRegistry(_terms.registry);
        insurancePool    = InsurancePool(_terms.insurancePool);

        // Fee terms are snapshotted, not referenced. No require() here: a
        // zero treasury or zero rate simply means no protocol fee is taken,
        // which is a valid configuration.
        treasury           = _feeConfig.treasury;
        referrer           = _feeConfig.referrer;
        protocolFeeRateBps = _feeConfig.protocolFeeRateBps;
        referrerShareBps   = _feeConfig.referrerShareBps;
        minimumFeeBps      = _feeConfig.minimumFeeBps;

        emit VaultInitialised(
            _terms.lender, _terms.borrower, _terms.asset,
            _terms.principal, _terms.depositAmount, _terms.aprBps, deadline
        );
    }

    // --- Deposit ---

    // --- Interest ---

    uint256 private constant YEAR = 365 days;

    /// @notice Interest owed if the loan runs its full term. This is the
    ///         figure the lender is quoted, and the basis for the insurance
    ///         skim taken at origination.
    function fullTermFee() public view returns (uint256) {
        return (principal * aprBps * term) / (10000 * YEAR);
    }

    /**
     * @notice Interest owed as of now — pro-rata on time actually elapsed,
     *         floored, and never more than the full term's worth.
     *
     * @dev    Three properties, each deliberate:
     *
     *         PRO-RATA, because an annualised rate that charged a full year on
     *         a one-week loan would make early settlement so punitive nobody
     *         would ever use it.
     *
     *         FLOORED at minimumFeeBps of principal, because pure pro-rata
     *         lets a borrower originate and settle in the same block having
     *         paid essentially nothing for the capital they briefly held.
     *
     *         CAPPED at fullTermFee, so the floor can never charge more than
     *         running the loan to term would have. Without that cap a short
     *         loan's floor could exceed its own maximum interest, which is
     *         incoherent — and it means the floor simply doesn't bite on very
     *         short loans, where there is little to game anyway.
     */
    function accruedFee() public view returns (uint256) {
        uint256 full = fullTermFee();

        uint256 elapsed = block.timestamp - originatedAt;
        if (elapsed >= term) { return full; }

        uint256 pro = (principal * aprBps * elapsed) / (10000 * YEAR);

        uint256 floor = (principal * minimumFeeBps) / 10000;
        if (floor > full) { floor = full; }

        return pro > floor ? pro : floor;
    }

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

    // --- Whitelisted action 1: yield venue supply/withdraw (loan asset only) ---

    /**
     * @notice Supplies loan-asset funds to this asset's configured yield
     *         venue — Aave V3 or any ERC-4626 vault.
     *
     * @dev    The venue is snapshotted on the first supply and locked for the
     *         life of the vault. A borrower who wants to move venues must
     *         fully withdraw and settle; the alternative is a vault holding
     *         positions in two places with only one recorded, which is how
     *         funds get stranded.
     */
    function supplyToYield(uint256 amount) public onlyActiveBorrower {
        require(amount > 0, "Amount must be greater than zero");

        (AssetRegistry.YieldVenue venue, address venueAddr) = registry.venueOf(asset);
        require(venue != AssetRegistry.YieldVenue.None, "Asset has no yield venue");

        if (yieldVenueKind == 0) {
            yieldVenueKind = uint8(venue);
            if (venue == AssetRegistry.YieldVenue.Aave) {
                yieldVenue         = registry.aavePool();
                yieldPositionToken = registry.aTokenOf(asset);
                require(yieldPositionToken != address(0), "Asset has no Aave support");
            } else {
                yieldVenue         = venueAddr;
                yieldPositionToken = venueAddr;   // a 4626 vault IS its own share token
            }
        } else {
            require(yieldVenueKind == uint8(venue), "Yield venue changed mid-loan");
        }

        _enforceDepositInvariant(amount);

        require(IERC20(asset).approve(yieldVenue, amount), "Yield approval failed");
        if (yieldVenueKind == 1) {
            IAavePool(yieldVenue).supply(asset, amount, address(this), 0);
            emit AaveSupplied(amount, block.timestamp);
        } else {
            IERC4626(yieldVenue).deposit(amount, address(this));
        }

        emit YieldSupplied(yieldVenueKind, amount, block.timestamp);
    }

    /// @notice Withdraws a borrower-chosen amount of the UNDERLYING asset
    ///         back from the yield venue mid-term.
    function withdrawFromYield(uint256 amount) public onlyActiveBorrower {
        require(amount > 0,        "Amount must be greater than zero");
        require(yieldVenueKind > 0, "No yield position");

        if (yieldVenueKind == 1) {
            IAavePool(yieldVenue).withdraw(asset, amount, address(this));
            emit AaveWithdrawn(amount, block.timestamp);
        } else {
            IERC4626(yieldVenue).withdraw(amount, address(this), address(this));
        }

        emit YieldWithdrawn(yieldVenueKind, amount, block.timestamp);
    }

    /// @notice Deprecated aliases, kept so existing integrations and the
    ///         published ABI keep working. Aave is now one venue among
    ///         several rather than the only one.
    function supplyToAave(uint256 amount) external { supplyToYield(amount); }
    function withdrawFromAave(uint256 amount) external { withdrawFromYield(amount); }

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

        // Refuse entry into a position we could not force an exit from.
        // _forcedSwapBackAll() quotes (tokenOut -> asset) at this same fee
        // tier; if that quote is unobtainable, settlement would revert and the
        // vault would be permanently stuck. Checked in the same direction the
        // forced swap-back will use, so the two cannot disagree.
        require(
            UniswapTwap.canQuote(
                registry.uniswapFactory(),
                tokenOut,
                asset,
                poolFee,
                registry.twapWindow()
            ),
            "No TWAP history for this pair and fee tier"
        );

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
            uint256 graceEnd = deadline + _effectiveGracePeriod();
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
        _withdrawAllFromYield();
        _distribute(early, bounty);
    }

    /// @dev Settlement phase 2: computes the waterfall, stores the outcome,
    ///      and pays out. Separated from settle() to keep each function's
    ///      stack frame within EVM limits — and it reads better in an audit.
    ///
    ///      Order against the residual: keeper bounty -> protocol fee ->
    ///      borrower. The bounty ranks ahead of the protocol's own take on
    ///      purpose: the three-tier settlement model depends on that
    ///      incentive being reliable, and it must never be squeezed by
    ///      protocol revenue.
    function _distribute(bool early, uint256 bounty) internal {
        uint256 totalReturned = IERC20(asset).balanceOf(address(this));
        // Interest as of settlement, not the full term's worth. A borrower who
        // closes on day 30 of a 365-day loan owes 30 days of interest.
        uint256 fee          = accruedFee();
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

        uint256 available    = totalReturned + insuranceDraw;
        uint256 lenderPayout = available >= lenderTarget ? lenderTarget : available;
        uint256 residual     = available > lenderTarget ? available - lenderTarget : 0;

        // 1. Keeper bounty, capped at whatever residual exists.
        if (bounty > residual) { bounty = residual; }
        residual -= bounty;

        // 2. Protocol fee. An ADD-ON charged to the borrower: the lender's
        //    payout above is already final and is not reduced by it. Taken
        //    only from what survives after the lender is whole and the
        //    keeper is paid, so in any loss scenario residual is zero and
        //    the protocol earns nothing. Block-scoped to keep the stack
        //    frame small.
        {
            uint256 protocolFee = 0;
            uint256 referrerFee = 0;

            if (residual > 0 && protocolFeeRateBps > 0 && treasury != address(0)) {
                protocolFee = (fee * protocolFeeRateBps) / 10000;
                if (protocolFee > residual) { protocolFee = residual; }
                residual -= protocolFee;

                if (referrer != address(0) && referrerShareBps > 0) {
                    referrerFee = (protocolFee * referrerShareBps) / 10000;
                    protocolFee -= referrerFee;
                }
            }

            settledProtocolFee = protocolFee;
            settledReferrerFee = referrerFee;
        }

        settledTotalReturned  = totalReturned;
        settledInsuranceDraw  = insuranceDraw;
        settledLenderPayout   = lenderPayout;
        settledBorrowerPayout = residual;
        settledFee            = fee;
        settledBounty         = bounty;

        require(IERC20(asset).transfer(lender, lenderPayout), "Failed to pay lender");
        if (bounty > 0) {
            require(IERC20(asset).transfer(msg.sender, bounty), "Failed to pay bounty");
        }
        if (settledProtocolFee > 0) {
            require(IERC20(asset).transfer(treasury, settledProtocolFee), "Failed to pay treasury");
        }
        if (settledReferrerFee > 0) {
            require(IERC20(asset).transfer(referrer, settledReferrerFee), "Failed to pay referrer");
        }
        if (settledBorrowerPayout > 0) {
            require(IERC20(asset).transfer(borrower, settledBorrowerPayout), "Failed to pay borrower");
        }

        emit Settled(msg.sender, early, settledTotalReturned, settledInsuranceDraw,
            settledLenderPayout, settledBorrowerPayout, settledFee, settledBounty, block.timestamp);

        if (settledProtocolFee > 0 || settledReferrerFee > 0) {
            emit ProtocolFeePaid(treasury, referrer, settledProtocolFee, settledReferrerFee);
        }
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
                        recipient: address(this),
                        amountIn: bal, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
                    })
                );
                emit ForcedSwapBack(held, bal, out);
            }
            isHeld[held] = false;
            heldAssets.pop();
        }
    }

    /// @dev Withdraws the vault's full yield position, if any, from whichever
    ///      venue it actually supplied to. Reads the SNAPSHOT rather than the
    ///      registry, so a venue repointed mid-loan cannot strand funds.
    ///      Hardened: balance must genuinely decrease (the v1 stuck-funds fix,
    ///      kept, and it applies to both venues).
    function _withdrawAllFromYield() internal {
        if (yieldVenueKind == 0) { return; }
        if (yieldPositionToken == address(0) || yieldPositionToken.code.length == 0) { return; }

        uint256 before = IERC20(yieldPositionToken).balanceOf(address(this));
        if (before == 0) { return; }

        if (yieldVenueKind == 1) {
            // aToken rebases 1:1, so `before` is both the share count and the value.
            IAavePool(yieldVenue).withdraw(asset, type(uint256).max, address(this));
            emit AaveWithdrawn(before, block.timestamp);
        } else {
            // `before` is a SHARE count here; redeem burns all of them and
            // returns however much underlying they are now worth.
            IERC4626(yieldVenue).redeem(before, address(this), address(this));
        }

        require(
            IERC20(yieldPositionToken).balanceOf(address(this)) < before,
            "Yield withdrawal did not reduce balance"
        );
        emit YieldWithdrawn(yieldVenueKind, before, block.timestamp);
    }

    /**
     * @dev The swap-back grace this vault is actually entitled to.
     *
     *      Driven by what the vault HOLDS, not what it owes. The grace exists
     *      to give the parties a window before keepers may force a swap-back
     *      at a bad price, so the binding constraint is the tradability of the
     *      asset being exited — and where several are held, the least
     *      tradeable of them governs.
     *
     *      Registry values already include the global default, so the max is
     *      never below it. A vault holding only continuously-traded crypto is
     *      therefore never delayed by a rule that exists for equities.
     */
    function _effectiveGracePeriod() internal view returns (uint256) {
        uint256 g = registry.swapBackGracePeriod();
        for (uint256 i = 0; i < heldAssets.length; i++) {
            uint256 assetGrace = registry.gracePeriodOf(heldAssets[i]);
            if (assetGrace > g) { g = assetGrace; }
        }
        return g;
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

    /// @notice The vault's yield position valued in the UNDERLYING loan asset.
    ///         Aave's aToken rebases 1:1 so its balance is already the value;
    ///         ERC-4626 shares must be converted, since their whole point is
    ///         to appreciate against the underlying.
    function yieldPositionValue() external view returns (uint256) {
        if (yieldVenueKind == 0 || yieldPositionToken == address(0)) { return 0; }

        uint256 bal = IERC20(yieldPositionToken).balanceOf(address(this));
        if (bal == 0) { return 0; }

        return yieldVenueKind == 1 ? bal : IERC4626(yieldVenue).convertToAssets(bal);
    }

    /// @notice The grace period this vault would get if it settled now, in
    ///         seconds — surfaced so the UI can show a borrower holding a
    ///         24/5 asset why their window is longer.
    function effectiveGracePeriod() external view returns (uint256) {
        return _effectiveGracePeriod();
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
