// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AssetRegistry.sol";
import "./InsurancePool.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/IPriceRouter.sol";
import "./interfaces/ISwapExecutor.sol";
import "./libraries/SafeTransfer.sol";
import {LoanTerms, FeeConfig} from "./Vault.sol";

/**
 * @title RoutedVault  (NOT AUDITED: new code outside the Zealynx audit scope)
 * @notice The audited Vault's loan, kept line for line, with trading and
 *         pricing handed to two contracts fixed into this template:
 *
 *           - PRICE_ROUTER gives the reference price every check uses
 *             (Chainlink, Uniswap average, Curve, Pendle — per token).
 *           - SWAP_EXECUTOR carries out trades through approved DEX
 *             aggregators, or through the pair's fallback pool.
 *
 *         Design: "Swap Executor and Price Module Design Note v2"
 *         (25 November 2026). The audited Vault.sol is not changed; this is a
 *         separate template for separate deployments.
 *
 *         WHAT IS UNCHANGED from the audited Vault: origination, the deposit
 *         and premium, the deposit invariant, tiers and exposure budget
 *         (M-07), the loss budget (M-04), measured amounts (item 17), partial
 *         fills (M-03), the three-tier settlement access, the waterfall,
 *         fees, deferred payouts (M-1, Q8), in-kind settlement (item 14,
 *         M-2, I-02, Q3B, KRAIT-005, M-02) and cancellation.
 *
 *         WHAT CHANGES:
 *           - Every price comes from PRICE_ROUTER, not from one pool.
 *           - swap() and swapBack() take a Route. Every listed token must
 *             have a fallback pool, and the full-exit check (M-02) is always
 *             simulated through it. Purchases are held to the token's size cap.
 *           - settle() takes routes, which only the lender and borrower may
 *             use (decision 3); everyone else sells through the fallback pool.
 *           - Entry points are locked against re-entry, because an outside
 *             aggregator runs in the middle of a trade.
 *
 *         READING THE COMMENTS: the explanations below are kept from the
 *         audited Vault, findings and all. Where they say "the TWAP" or
 *         "the pool", read "the reference price from PRICE_ROUTER" and "the
 *         route" — the rule they explain is the same.
 *
 *         The two addresses are IMMUTABLE: they live in this template's code,
 *         so every clone shares them and nothing can repoint them. A new
 *         router or executor means a new template and a new factory.
 */
contract RoutedVault {

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

    /**
     * @notice Highest AssetRegistry.RiskTier this borrower may hold.
     *
     * @dev    Closes the gap between who sets terms and who chooses exposure.
     *         The lender fixes the deposit and APR at origination; the borrower
     *         picks what to swap into afterwards. Without a ceiling, a lender
     *         who priced for WETH can find themselves backing a memecoin
     *         position — a risk they had no opportunity to price.
     */
    uint8 public maxTier;

    /**
     * @notice Insurance premium, in the loan asset, payable by the BORROWER
     *         alongside their deposit.
     *
     * @dev    Moved from the lender for two reasons. Credit enhancement is
     *         borrower-funded almost everywhere it exists — mortgage insurance,
     *         guarantee fees, letters of credit — because the party seeking
     *         capital pays for whatever makes their credit acceptable. And it
     *         makes the lender's yield clean: previously a lender quoting 12%
     *         netted 9.6% after the skim, which is a hidden haircut on the
     *         headline figure and the worst possible friction to put on the
     *         scarce side of the market.
     *
     *         Priced on the FULL term plus the insured window (audit M-06) and
     *         snapshotted here, so a later change to tier pricing cannot
     *         reprice a live loan.
     */
    uint256 public insurancePremium;
    uint256 public deadline;
    /// @notice Audit M-06: the end of this loan's insurance cover, before any
    ///         outage extension. deadline + the registry's insuredWindow at
    ///         origination, so a later change cannot reach a live loan.
    ///         Recorded outages extend it by at most the registry's fixed
    ///         INSURED_OUTAGE_EXTENSION (72 hours), never by the adjustable
    ///         maxGraceExtension (M-06 fix review).
    uint256 public insuredUntil;
    bool    public isSettled;

    uint256 private _requiredDeposit;

    // --- Protocol fee terms (snapshotted at origination, never re-read) ---

    address public treasury;
    address public referrer;
    uint256 public protocolFeeRateBps;
    uint256 public referrerShareBps;
    uint256 public minimumFeeBps;

    // --- Foreign asset tracking (assets swapped into, not yet swapped back) ---

    address[] public heldAssets;
    mapping(address => bool)   public isHeld;
    mapping(address => uint256) public admittedToleranceBps; // audit M-02: tolerance the holding's full exit last passed at

    /// @notice How much of each held asset this vault BOUGHT, measured by
    ///         balance change. Swap-back and settlement sell this amount and
    ///         no more, so tokens sent to the vault directly are never pushed
    ///         into a forced exit. See _forcedSwapBackAll() and KRAIT-003.
    mapping(address => uint256) public heldAmount;

    // --- Settlement outcome (readable post-settlement) ---

    uint256 public settledTotalReturned;   // vault's own funds at settlement, BEFORE any insurance draw
    uint256 public settledInsuranceDraw;   // amount actually received from the insurance pool
    uint256 public settledInsuranceDeferred; // Q8: insurance owed to the lender but held by the pool (token refused the transfer)
    uint256 public settledLenderPayout;
    uint256 public settledBorrowerPayout;
    uint256 public settledFee;
    uint256 public settledBounty;
    uint256 public settledProtocolFee;     // paid to treasury at settlement
    uint256 public settledReferrerFee;     // paid to referrer at settlement

    // --- In-kind settlement (item 14) ---

    /// @notice How long after the grace period ends before the last-resort
    ///         in-kind settlement opens. Longer than the 72-hour outage cap and
    ///         any weekend grace, so it can never cut a normal path short.
    uint256 public constant IN_KIND_DELAY = 7 days;

    /// @notice True when the loan was closed by settleInKind().
    bool public settledInKind;

    /// @notice Lender-only period at the start of the in-kind window (M-2).
    ///         The split values unsold assets at the TWAP, and an asset that
    ///         cannot be sold usually sits in a thin pool whose TWAP is cheap to
    ///         move. Letting anyone trigger it let the borrower choose a pumped
    ///         moment. The lender, who bears the valuation, chooses first;
    ///         after this period anyone may, so an absent lender cannot hold
    ///         the borrower's share hostage.
    uint256 public constant IN_KIND_LENDER_PERIOD = 7 days;

    /// @notice Payouts that could not be delivered, by token and recipient:
    ///         a token that refused the transfer (a frozen equity, or a
    ///         blacklisted recipient of a regulated stablecoin). Claimable
    ///         with claim() once the token moves again. See _pay().
    mapping(address => mapping(address => uint256)) public owed;

    // --- Events ---

    event VaultInitialised(address indexed lender, address indexed borrower, address indexed asset,
        uint256 principal, uint256 requiredDeposit, uint256 aprBps, uint256 deadline);
    event DepositReceived(address indexed borrower, uint256 amount);
    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, bool isSwapBack);
    /// @notice Review R6: which route each trade used (address(0) = fallback pool), for monitoring.
    event RouteUsed(address indexed tokenIn, address indexed tokenOut, address indexed via);
    event InsurancePremiumPaid(address indexed borrower, uint256 amount);
    event Cancelled(address indexed lender, uint256 principalReturned, uint256 timestamp);
    event ForcedSwapBack(address indexed heldAsset, uint256 amountIn, uint256 amountOut);
    event Settled(address indexed triggeredBy, bool early, uint256 totalReturned, uint256 insuranceDraw,
        uint256 lenderPayout, uint256 borrowerPayout, uint256 fee, uint256 bounty, uint256 timestamp);
    event ProtocolFeePaid(address indexed treasury, address indexed referrer,
        uint256 treasuryAmount, uint256 referrerAmount);
    event InKindAllocated(address indexed token, uint256 toLender, uint256 toBorrower,
        uint256 twapValue, bool priced);
    event Claimed(address indexed token, address indexed to, uint256 amount);
    event PaymentDeferred(address indexed token, address indexed to, uint256 amount);

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
    /// @notice Reference prices for every check in this deployment.
    IPriceRouter  public immutable PRICE_ROUTER;
    /// @notice Carries out every trade in this deployment.
    ISwapExecutor public immutable SWAP_EXECUTOR;

    uint256 private _locked = 1;

    /// @dev An aggregator runs in the middle of swap(), swapBack(), settle()
    ///      and settleInKind(). None of them may be entered again until it
    ///      returns.
    modifier nonReentrant() {
        require(_locked == 1, "Re-entry");
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address _priceRouter, address _swapExecutor) {
        require(_priceRouter != address(0) && _priceRouter.code.length > 0,   "Invalid price router");
        require(_swapExecutor != address(0) && _swapExecutor.code.length > 0, "Invalid swap executor");
        PRICE_ROUTER  = IPriceRouter(_priceRouter);
        SWAP_EXECUTOR = ISwapExecutor(_swapExecutor);
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
        _locked          = 1;
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
        maxTier          = _terms.maxTier;

        // Keyed to the CEILING the lender granted, not the loan's own asset.
        // What is being insured is whatever the borrower is permitted to hold.
        // Audit M-06: insured for the term plus the window after it, and
        // priced on both.
        uint256 window = AssetRegistry(_terms.registry).insuredWindow();
        insuredUntil = deadline + window;
        insurancePremium =
            (principal
             * AssetRegistry(_terms.registry).insurancePremiumBpsForTier(
                   AssetRegistry.RiskTier(_terms.maxTier))
             * (term + window)) / (10000 * YEAR);

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

        // Deposit and insurance premium arrive together, but only the deposit
        // is recorded as `deposit` — the premium leaves immediately and must
        // never count toward the segregation invariant or the payout maths.
        deposit = _requiredDeposit;

        SafeTransfer.safeTransferFrom(asset, borrower, address(this), _requiredDeposit + insurancePremium);

        emit DepositReceived(borrower, _requiredDeposit);

        // Forwarded now, not at settlement. If the premium accrued to
        // settlement, a loan ending in a loss might never pay it — correlating
        // claim events with premium failures, which is the one property an
        // insurance fund cannot have.
        if (insurancePremium > 0) {
            SafeTransfer.safeApprove(asset, address(insurancePool), insurancePremium);
            insurancePool.fund(asset, insurancePremium);
            emit InsurancePremiumPaid(borrower, insurancePremium);
        }
    }

    /**
     * @notice Marks the deposit paid when the factory has already transferred
     *         it in. Used only by mandate fills.
     *
     * @dev Exists so a fill can be ATOMIC. In the mandate flow the borrower
     *      initiates, which reverses the usual risk: the lender's principal is
     *      committed the moment the vault exists, and a borrower who simply
     *      walks away would lock that capital until the deadline. A griefer
     *      could do that to every mandate on the book for the cost of gas.
     *
     *      So the factory moves both sides in one transaction and calls this.
     *      The balance check is what makes it safe to trust: the deposit cannot
     *      be credited unless the funds are demonstrably present, whatever the
     *      caller claims.
     */
    function creditDeposit() external {
        require(msg.sender == factory, "Only the factory may credit a deposit");
        require(deposit == 0,          "Deposit already paid");
        require(!isSettled,            "Loan already settled");
        require(
            IERC20(asset).balanceOf(address(this)) >= principal + _requiredDeposit,
            "Deposit has not been received"
        );

        deposit = _requiredDeposit;
        emit DepositReceived(borrower, _requiredDeposit);
    }

    /**
     * @notice Returns principal to the lender when the borrower never funded.
     *
     * @dev Without this, an unfunded vault could still be settled after its
     *      deadline: it holds only principal, the lender is owed principal plus
     *      interest, and the shortfall is covered by an INSURANCE DRAW. The
     *      shared pool would subsidise a loan that never started — trivial over
     *      a 150-second term, 3% of principal over a year, and paid for by
     *      every other lender who funded the pool.
     *
     *      Callable by anyone. There is no discretion here — the borrower did
     *      not turn up, and the money goes back where it came from.
     */
    function cancel() external {
        require(!isSettled,                  "Loan already settled");
        require(!depositPaid(),              "Deposit was paid - settle instead");
        require(block.timestamp > deadline,  "Deadline has not passed");

        isSettled = true;   // before the transfer — reentrancy guard

        uint256 balance = IERC20(asset).balanceOf(address(this));
        settledTotalReturned = balance;
        settledLenderPayout  = balance;

        _pay(asset, lender, balance);

        emit Cancelled(lender, balance, block.timestamp);
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

    // --- The borrower's one action: directional swaps, through a Route ---
    //
    // Yield venues (Aave, ERC-4626) were removed before audit: no venue
    // exists on Robinhood Chain and production refused to configure one, so
    // the code could only add attack surface. Idle principal sits in the
    // vault. A venue can be reintroduced, with its own review, when one exists.

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
     * @param buyRoute     How to buy: an approved aggregator's call, or
     *                     target 0 for the pair's fallback pool. Whatever the
     *                     route, the whole holding must then be sellable
     *                     through the fallback pool within tolerance (M-02),
     *                     simulated on the spot and undone.
     */
    function swap(
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        Route calldata buyRoute
    ) external onlyActiveBorrower nonReentrant {
        require(amountIn > 0,                       "Amount must be greater than zero");
        require(minAmountOut > 0,                   "minAmountOut must be greater than zero");
        require(tokenOut != asset,                  "Use swapBack() for the loan asset");
        require(registry.isWhitelisted(tokenOut),   "Destination asset not whitelisted");
        // Decision 1 (security review v2): every token must have a fallback
        // pool, so every exit can be proved and carried out on-chain without
        // relying on a route anyone chose.
        require(SWAP_EXECUTOR.hasFallback(tokenOut, asset), "No fallback pool for this asset");

        uint256 refOut = _refQuote(asset, tokenOut, amountIn);

        require(
            uint8(registry.highestTierSince(tokenOut, originatedAt)) <= maxTier,
            "Asset exceeds this vault's risk mandate"
        );

        _enforceDepositInvariant(amountIn);

        uint256 amountOut = _executeSwap(asset, tokenOut, amountIn, minAmountOut, buyRoute);
        _trackHeldAsset(tokenOut, amountOut);

        _enforceEntryImpact(refOut, amountOut);
        _enforceExposureCap(tokenOut);
        _enforceExitable(tokenOut);
        _enforceLossBudget();

        emit SwapExecuted(asset, tokenOut, amountIn, amountOut, false);
    }

    /**
     * @dev Refuses a position large enough to move the price against its own
     *      settlement.
     *
     *      Found on testnet, not in theory. settle() requires the forced
     *      swap-back to return at least the TWAP-implied value less tolerance.
     *      But twapQuote derives from the MARGINAL price while a swap executes
     *      at an AVERAGE price, worse by its own impact. So a borrower's
     *      swap-in moves the price, the TWAP converges on the new level, and
     *      swapping back returns roughly the original cost less two fees —
     *      beneath a bar that has since risen.
     *
     *      Measured: a 20-token position delivered 19.88 against 19.92
     *      required, and the vault could not be settled by anyone until the
     *      price moved. A borrower could do this to themselves accidentally.
     *
     *      Comparing execution against TWAP measures exactly the impact that
     *      causes it. The cap wants to be roughly half the settlement tolerance
     *      less the fee, since a round trip pays impact twice.
     */
    function _enforceEntryImpact(uint256 refOut, uint256 amountOut) internal view {
        uint256 maxImpactBps = registry.maxEntryImpactBps();
        if (maxImpactBps == 0) { return; }
        require(
            amountOut >= (refOut * (10000 - maxImpactBps)) / 10000,
            "Execution too far below the reference price"
        );
    }

    /**
     * @dev Caps how much of the principal may sit in any single asset.
     *
     *      Valued through the TWAP rather than counted as amount-swapped-in, so
     *      it measures the position the vault actually holds. A cumulative
     *      spend counter would turn the cap into a lifetime budget — a borrower
     *      who entered and fully exited could not re-enter, which is not what a
     *      concentration limit means.
     */
    function _enforceExposureCap(address tokenOut) internal view {
        uint256 value = _refQuote(tokenOut, asset, heldAmount[tokenOut]);

        require(value <= PRICE_ROUTER.maxPosition(tokenOut, asset), "Exceeds the size cap for this asset");

        uint256 capBps = registry.maxExposureBpsSince(tokenOut, originatedAt);
        if (capBps >= 10000) { return; }
        require(
            value <= (principal * capBps) / 10000,
            "Exceeds exposure cap for this asset"
        );
    }

    /**
     * @dev Audit M-04 (Zealynx). The deposit is a loan-wide budget for
     *      trading losses, not just a balance each purchase must leave alone.
     *
     *      _enforceDepositInvariant() and the per-trade checks bound every
     *      purchase and exit on its own, but nothing bounded their SUM. A
     *      borrower who owned the pool's liquidity could round-trip the
     *      principal through it dozens of times, every trade passing, until
     *      fees and impact paid into their own position had consumed the
     *      deposit and then the principal, the shortfall drawn from the
     *      shared insurance reserve.
     *
     *      So after every purchase the vault values itself conservatively:
     *      its loan-asset cash plus each holding at its exit floor (TWAP less
     *      tolerance; an unpriceable holding counts as nothing). Starting
     *      worth is principal plus deposit, so requiring the result to stay
     *      at or above the principal caps realised plus unrealised trading
     *      losses at the deposit. This is the same as tracking cost basis and
     *      realised profit per asset, and it carries across exits to zero
     *      and changes of asset without any extra record.
     *
     *      Purchases only. A sale at or above its floor cannot lower this
     *      figure, and blocking it would trap a borrower trying to cut a
     *      market loss; sales stay governed by the floor alone. Settlement,
     *      including in-kind, is untouched. Interest is not protected by this
     *      bound, and a later market move can still exceed the deposit.
     *
     *      Audit M-07 (Zealynx): the same pass enforces an exposure BUDGET
     *      across all holdings. _enforceExposureCap() checks only the asset
     *      just bought, so a Standard vault could hold two Standard assets at
     *      their 50% caps — twice the single exposure the deposit and premium
     *      were priced on. Each holding now uses value / (its cap x principal)
     *      of one shared budget, which may not exceed 100%. A vault can still
     *      fill its tier's cap in one asset; putting part of the budget into
     *      a safer asset (a higher cap) lets more of the principal be invested,
     *      never more risk. That holds while every safer tier's cap times its
     *      assumed volatility stays at or below the riskier tier's — a
     *      calibration rule for the operator. The cap read is the riskiest
     *      tier each asset has held since origination, as for the single-asset
     *      check. A holding that cannot be valued, or whose cap is zero, blocks
     *      purchases until it is sold or reprices; sales are never blocked.
     */
    function _enforceLossBudget() internal view {
        uint256 worth = IERC20(asset).balanceOf(address(this));
        uint256 used;   // exposure budget used, in principal units
        uint256 keepBps = 10000 - registry.twapToleranceBps();
        for (uint256 i = 0; i < heldAssets.length; i++) {
            address held = heldAssets[i];
            (bool priced, uint256 value) = _priceHeld(held);
            uint256 capBps = registry.maxExposureBpsSince(held, originatedAt);
            require(priced && (capBps > 0 || value == 0), "Holdings exceed exposure budget");
            if (capBps > 0) { used += (value * 10000 + capBps - 1) / capBps; }
            worth += (value * keepBps) / 10000;
        }
        require(used <= principal, "Holdings exceed exposure budget");
        require(worth >= principal, "Trading losses would exceed the deposit");
    }

    /// @dev Carries the simulated exit output out of simulateExit()'s revert.
    error ExitQuote(uint256 amountOut);

    /**
     * @dev Refuses a position the vault could not sell back in one go at
     *      settlement, measured on the WHOLE holding rather than the swap
     *      that just added to it.
     *
     *      _enforceEntryImpact() checks each purchase on its own. A position
     *      built from many small purchases passes every one of those checks
     *      and can still be too large to exit at once: the forced swap-back
     *      sells everything in one call, misses the TWAP floor, and settle()
     *      reverts for everyone (KRAIT-003, item 20).
     *
     *      So after each purchase the vault actually performs the exit it
     *      would face at settlement, through the same router and pool, then
     *      undoes it by reverting. This is the technique Uniswap's own Quoter
     *      uses; the revert discards every state change, and the only thing
     *      carried out is the output amount. The position is accepted only if
     *      that output clears the same floor settlement applies.
     *
     *      It cannot see the future: liquidity withdrawn after entry (for
     *      example by a borrower who was also the pool's main provider) can
     *      still leave a position unsellable later. Item 14 is the backstop.
     */
    function _enforceExitable(address held) internal {
        uint256 amount = heldAmount[held];
        uint256 tolerance = registry.twapToleranceBps();
        uint256 floorOut = _exitFloorAt(held, amount, tolerance);

        // Review R2 and decision 1: the exit is always proved through the
        // pair's fallback pool, for the exact holding. A route the borrower
        // built could pass through liquidity they control and withdraw later,
        // the KRAIT-003 pattern; the fallback pool cannot be chosen by anyone.
        require(_simulateExitOut(held, amount, Route(address(0), "")) >= floorOut,
            "Position too large to exit within tolerance");

        admittedToleranceBps[held] = tolerance;
    }

    /// @dev Output of a full exit of `amount` of `held`, performed and then
    ///      undone by simulateExit(). Any revert other than ExitQuote (the
    ///      pool could not take the trade at all) counts as an exit of zero.
    function _simulateExitOut(address held, uint256 amount, Route memory route) internal returns (uint256 simulatedOut) {
        try this.simulateExit(held, amount, route) {
            revert("Exit simulation did not revert");
        } catch (bytes memory reason) {
            if (reason.length == 36 && bytes4(reason) == ExitQuote.selector) {
                assembly { simulatedOut := mload(add(reason, 36)) }
            }
        }
    }

    /**
     * @notice Internal use only: performs a full exit of `amount` of `held`
     *         and reverts with the output, so nothing it does persists.
     * @dev    External only because try/catch needs an external call. Only
     *         this vault may call it, and it can never complete.
     */
    function simulateExit(address held, uint256 amount, Route calldata route) external {
        require(msg.sender == address(this), "Only the vault itself");
        // Review R1: an outside aggregator runs inside this call. If anything
        // below fails, its revert data must NOT reach _simulateExitOut, or a
        // contract the route calls could revert with a forged ExitQuote
        // carrying any number it likes and pass the full-exit check. Every
        // failure becomes ExitQuote(0); only the vault's own measurement
        // below can report a non-zero result.
        uint256 before = IERC20(asset).balanceOf(address(this));
        uint256 heldBefore = IERC20(held).balanceOf(address(this));
        SafeTransfer.safeTransfer(held, address(SWAP_EXECUTOR), amount);
        try SWAP_EXECUTOR.execute(held, asset, amount, route) {} catch { revert ExitQuote(0); }
        if (heldBefore - IERC20(held).balanceOf(address(this)) != amount) { revert ExitQuote(0); }
        revert ExitQuote(IERC20(asset).balanceOf(address(this)) - before);
    }

    /**
     * @notice Explicit swap-back entry point: converts `heldAsset` back to
     *         the loan asset. Always permitted while the loan is active.
     *
     * @dev    TWAP FLOOR. The exit is held to the same bound as the forced
     *         swap-back at settlement: output must be at least the TWAP-implied
     *         value less twapToleranceBps. The borrower may ask for MORE via
     *         minAmountOut; they can never accept less.
     *
     *         Without it this was the one price-unchecked path out of the
     *         vault. Entry was bounded by _enforceEntryImpact and settlement by
     *         the tolerance, but the voluntary exit relied on a minimum chosen
     *         by the borrower — the party it exists to constrain. A borrower
     *         could sell held assets at 1% of fair value into a pool they had
     *         moved (or into liquidity they provided) and keep the difference
     *         outside the vault: custody bypassed, lender loss down to the
     *         deposit plus the capped insurance draw.
     *
     *         Found by Krait (KRAIT-001, Critical) on 1 October 2026 with an
     *         executed proof of concept; see MAINNET-READINESS item 18.
     */
    function swapBack(
        address heldAsset,
        uint256 amountIn,
        uint256 minAmountOut,
        Route calldata route
    ) external onlyActiveBorrower nonReentrant {
        require(isHeld[heldAsset], "Not a held asset");
        require(amountIn > 0,      "Amount must be greater than zero");
        require(minAmountOut > 0,  "minAmountOut must be greater than zero");
        require(amountIn <= heldAmount[heldAsset], "Exceeds the amount this vault bought");

        uint256 amountOut = _executeSwap(heldAsset, asset, amountIn,
            _saleMinimum(heldAsset, amountIn, minAmountOut, route), route);
        heldAmount[heldAsset] -= amountIn;
        _untrackIfEmptied(heldAsset);

        emit SwapExecuted(heldAsset, asset, amountIn, amountOut, true);
    }

    function _executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        Route memory route
    ) internal returns (uint256 amountOut) {
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));
        uint256 spentBefore = IERC20(tokenIn).balanceOf(address(this));

        // Exactly amountIn goes to the executor; it returns the proceeds and
        // anything it did not spend. Everything below is measured here.
        SafeTransfer.safeTransfer(tokenIn, address(SWAP_EXECUTOR), amountIn);
        SWAP_EXECUTOR.execute(tokenIn, tokenOut, amountIn, route);
        emit RouteUsed(tokenIn, tokenOut, route.target);

        amountOut = IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
        require(amountOut >= minAmountOut, "Received less than minimum");
        require(spentBefore - IERC20(tokenIn).balanceOf(address(this)) == amountIn, "Swap did not spend the full amount");
    }

    /// @dev The tier is recorded once, at first entry, and never overwritten
    ///      while the position is open. Overwriting it on every swap was the
    ///      KRAIT-003 entry point: a dust swap re-pointed the whole exit.
    function _trackHeldAsset(address _asset, uint256 amount) internal {
        if (!isHeld[_asset]) {
            isHeld[_asset] = true;
            heldAssets.push(_asset);
        }
        heldAmount[_asset] += amount;
    }

    /// @dev Untracks on the vault's own record reaching zero, not on balance:
    ///      a token sent in from outside must not keep a position "open".
    function _untrackIfEmptied(address _asset) internal {
        if (heldAmount[_asset] == 0 && isHeld[_asset]) {
            isHeld[_asset] = false;
            delete admittedToleranceBps[_asset];
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
    function settle(address[] calldata tokens, Route[] calldata routes) external nonReentrant {
        require(!isSettled, "Loan already settled");

        // First, so that if this is the first transaction after a sequencer
        // outage, the outage is on record before any window below is read
        // (item 16). If this call then reverts, the record reverts with it;
        // a keeper held off by the recovery period must call heartbeat()
        // directly and wait.
        registry.heartbeat();

        bool early = block.timestamp <= deadline;
        uint256 bounty = 0;

        if (early) {
            require(msg.sender == borrower, "Only borrower can close early");
            require(depositPaid(),          "Deposit not yet paid");
        } else {
            // An unfunded vault must not reach _distribute(), where the lender's
            // interest shortfall would be met by an insurance draw. cancel()
            // returns the principal and draws nothing.
            require(depositPaid(), "Deposit was never paid - use cancel()");

            if (heldAssets.length > 0) {
                // Grace extended by any recorded outage that consumed it;
                // keepers additionally held off until the chain has recovered.
                (uint256 graceEnd, uint256 keeperFrom) =
                    registry.settlementWindow(deadline, deadline + _effectiveGracePeriod());
                bool party = msg.sender == lender || msg.sender == borrower;
                if (block.timestamp <= graceEnd) {
                    require(party, "Grace period: only lender or borrower may settle");
                } else if (!party) {
                    require(block.timestamp >= keeperFrom, "Chain recovering from an outage");
                    bounty = _accruedBounty(keeperFrom);
                }
            }
        }
        // No foreign assets + past deadline: open to anyone immediately, no bounty (v1 behaviour).

        // Decision 3: only the lender and borrower, who gain or lose from the
        // sale price, may choose routes. Everyone else sells through the
        // fallback pool, so a keeper cannot pick a route that pays exactly
        // the floor and keep the difference.
        require(tokens.length == routes.length, "One route per token");
        require(tokens.length == 0 || msg.sender == lender || msg.sender == borrower,
            "Only the parties may choose routes");

        isSettled = true; // before external calls — reentrancy guard

        _forcedSwapBackAll(tokens, routes);
        _distribute(early, bounty);
    }

    /**
     * @notice When the last-resort in-kind settlement opens: IN_KIND_DELAY
     *         after the grace period ends (including any outage extension),
     *         and never while the chain is still recovering from an outage.
     *
     * @dev    The seven days are counted from the grace end, not from the
     *         keeper start. The keeper start moves with the LATEST outage, and
     *         without a heartbeat bot a quiet chain records every silence over
     *         30 minutes as one, so counting from it pushed the window back a
     *         week every time anyone tried. Found by the invariant fuzzer.
     */
    function inKindFrom() public view returns (uint256) {
        (uint256 graceEnd, uint256 keeperFrom) =
            registry.settlementWindow(deadline, deadline + _effectiveGracePeriod());
        uint256 opens = graceEnd + IN_KIND_DELAY;
        return opens > keeperFrom ? opens : keeperFrom;
    }

    /**
     * @notice Last-resort settlement for a vault whose forced exit cannot
     *         complete — a held asset frozen by its issuer, or a pool too thin
     *         or too far from its TWAP to sell into. Opens at inKindFrom()
     *         (7 days after grace, and not during an outage's recovery period)
     *         for the lender alone, and to anyone IN_KIND_LENDER_PERIOD later.
     *         settle() remains available throughout; whichever succeeds first
     *         closes the loan.
     *
     * @dev    Item 14. Without it settle() reverts in full for as long as any
     *         one asset cannot be sold, and nothing bounds that: the lender
     *         receives nothing, not even the cash already in the vault. This
     *         turns the worst case into "the lender receives the asset".
     *
     *         1. Every held asset the vault CAN sell at the TWAP floor is sold,
     *            exactly as settle() would. Each attempt is isolated, so one
     *            refusing asset no longer blocks the rest.
     *         2. The cash pays the lender first, up to principal plus accrued
     *            interest. Any cash beyond that goes to the borrower.
     *         3. Each unsold asset goes to the lender up to what they are still
     *            owed, valued at the TWAP, and the rest to the borrower. Priced
     *            assets are allocated before unpriceable ones.
     *         4. An asset with no TWAP at all (its pool is gone) cannot be
     *            valued, so the lender receives all of it if anything is still
     *            owed, and the borrower receives it otherwise. It does not
     *            count against the claim, so while anything is owed EVERY
     *            unpriceable asset goes to the lender (Q3B).
     *
     *         NO INSURANCE on this path (M-2). The lender receives the asset
     *         instead of a claim. Drawing on a shortfall measured at the TWAP of
     *         a thin pool let whoever depressed that TWAP take the asset AND a
     *         payout, then watch the price recover.
     *
     *         No keeper bounty and no protocol fee: this is a rescue, and the
     *         lender has every reason to call it themselves.
     *
     *         Anything that cannot be delivered (a frozen held token, or a
     *         blacklisted recipient) is recorded in owed() and claimed later
     *         with claim(). Everything else goes out regardless.
     */
    function settleInKind() external nonReentrant {
        require(!isSettled, "Loan already settled");
        registry.heartbeat();
        require(depositPaid(), "Deposit was never paid - use cancel()");
        require(heldAssets.length > 0, "Nothing held - use settle()");
        uint256 opens = inKindFrom();
        require(block.timestamp >= opens, "In-kind settlement not yet open");
        require(msg.sender == lender || block.timestamp >= opens + IN_KIND_LENDER_PERIOD,
            "Lender-only period");

        isSettled = true; // before external calls — reentrancy guard
        settledInKind = true;

        // 1. Sell what can be sold. What cannot stays in heldAssets.
        for (uint256 i = heldAssets.length; i > 0; i--) {
            address held = heldAssets[i - 1];
            uint256 gasBefore = gasleft();
            try this.exitHeld(held) {
                heldAssets[i - 1] = heldAssets[heldAssets.length - 1];
                _dropLastHeld(held);
            } catch {
                // A sale that failed for lack of gas must not be read as an
                // asset that cannot be sold (63/64 rule; Solodit SOL-Heuristics-5).
                if (gasleft() <= gasBefore / 63) { revert("Out of gas"); }
                // Audit M-02: nor may a sale that failed only because the
                // tolerance was tightened after entry. The pool can still
                // take it, so this is a cash settlement waiting for the
                // setting to be restored, with its insurance waterfall.
                require(!_blockedOnlyByTightening(held), "Sale blocked only by a tightened tolerance - use settle()");
            }
        }


        // Audit KRAIT-005: if everything sold, this is an ordinary cash
        // settlement and must go through settle(), which draws insurance for
        // a loss and charges the protocol fee. Otherwise anyone could pick
        // this path to skip both.
        require(heldAssets.length > 0, "Everything sold - use settle()");

        uint256 cash = IERC20(asset).balanceOf(address(this));
        uint256 fee = accruedFee();
        uint256 stillOwed = principal + fee;

        // 2. Cash to the lender first, surplus cash to the borrower.
        uint256 lenderCash = cash < stillOwed ? cash : stillOwed;
        stillOwed -= lenderCash;

        settledTotalReturned  = cash;
        settledLenderPayout   = lenderCash;
        settledBorrowerPayout = cash - lenderCash;
        settledFee            = fee;

        _pay(asset, lender, lenderCash);
        _pay(asset, borrower, settledBorrowerPayout);

        // 3 and 4. Priced assets first, then unpriceable ones.
        stillOwed = _allocateInKind(stillOwed, true);
        _allocateInKind(stillOwed, false);

        emit Settled(msg.sender, false, cash, 0,
            lenderCash, settledBorrowerPayout, fee, 0, block.timestamp);
    }

    /**
     * @notice Internal use only: sells the whole of one held asset at the TWAP
     *         floor. External so settleInKind() can isolate each attempt.
     */
    function exitHeld(address held) external {
        require(msg.sender == address(this), "Only the vault itself");
        _sellHeld(held, _sellableAmount(held), Route(address(0), ""));
    }

    /// @dev Whether `held` can be valued at the TWAP and, if so, the value of
    ///      what settlement would hand over.
    function _priceHeld(address held) internal view returns (bool priced, uint256 value) {
        uint256 amount = _sellableAmount(held);
        if (amount == 0) { return (true, 0); }   // as the audited Vault: nothing left to value
        (priced, value) = PRICE_ROUTER.quote(held, asset, amount);
        if (!priced) { return (false, 0); }
    }

    /// @dev Hands over every remaining held asset that is (or, with
    ///      `pricedPass` false, is not) priceable, and forgets it. Returns what
    ///      the lender is still owed.
    function _allocateInKind(uint256 stillOwed, bool pricedPass) internal returns (uint256) {
        for (uint256 i = heldAssets.length; i > 0; i--) {
            address held = heldAssets[i - 1];
            (bool priced, uint256 value) = _priceHeld(held);
            if (priced != pricedPass) { continue; }

            uint256 amount = _sellableAmount(held);
            uint256 toLender;
            if (stillOwed > 0) {
                if (!priced || value <= stillOwed) {
                    toLender = amount;
                    // Q3B (Covenza policy, answering Zealynx's kickoff
                    // question): an unpriceable asset does NOT reduce what is
                    // still owed. It used to clear the claim, so the first
                    // unpriceable asset went to the lender and every later one
                    // to the borrower. The borrower took the risk that left
                    // the vault holding assets nobody can value, so while any
                    // claim remains the lender takes all of them.
                    if (priced) { stillOwed -= value; }
                } else {
                    // Audit I-02 (Zealynx): round the lender's share UP. The
                    // floor handed the borrower the unit that would have
                    // covered the lender's last fraction, then cleared the
                    // claim; with a coarse (e.g. zero-decimal) asset that left
                    // the lender a whole unit short of what it was owed. The
                    // lender is paid first, so it takes the fraction, and can
                    // end at most one unit's value above what it was owed.
                    // value > stillOwed here, so the result never exceeds amount.
                    toLender = (amount * stillOwed + value - 1) / value;
                    stillOwed = 0;
                }
            }

            _pay(held, lender, toLender);
            _pay(held, borrower, amount - toLender);
            emit InKindAllocated(held, toLender, amount - toLender, value, priced);

            heldAssets[i - 1] = heldAssets[heldAssets.length - 1];
            _dropLastHeld(held);
        }
        return stillOwed;
    }

    /**
     * @dev Every payout from this vault goes through here. Pays `amount`, or,
     *      if the token refuses (a frozen equity, or a recipient blacklisted
     *      by a regulated stablecoin), records it in owed() for the recipient
     *      to claim later. Zero amounts are skipped, so tokens that reject
     *      zero-value transfers cannot block settlement either.
     *
     *      M-1: settlement used to push every payout in one transaction, so
     *      ONE recipient the token would not pay reverted the whole settlement
     *      for everyone, permanently. A blacklisted borrower locked the
     *      lender's principal in the vault for good.
     */
    function _pay(address token, address to, uint256 amount) internal {
        if (amount == 0) { return; }
        if (!SafeTransfer.trySafeTransfer(token, to, amount)) {
            owed[token][to] += amount;
            emit PaymentDeferred(token, to, amount);
        }
    }

    /// @notice Collects a payout that could not be delivered at settlement.
    ///         Reverts while the token still refuses this recipient.
    function claim(address token) external nonReentrant {
        uint256 amount = owed[token][msg.sender];
        require(amount > 0, "Nothing owed");
        owed[token][msg.sender] = 0;
        SafeTransfer.safeTransfer(token, msg.sender, amount);
        emit Claimed(token, msg.sender, amount);
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
        //
        // PRINCIPAL ONLY. The pool covers a shortfall against principal, never
        // against interest. It used to insure principal + accrued interest,
        // and the interest is a number the LENDER chooses: APR is unbounded,
        // and nothing stops lender and borrower being the same wallet. One
        // KYC'd wallet could lend to itself for 60 seconds at an absurd APR,
        // settle, and collect drawCapBps of principal from the shared reserve
        // on every cycle — no market loss involved. Insuring only principal
        // takes the claim size out of the lender's hands entirely: a shortfall
        // against principal can only come from the vault actually losing
        // value. Found by Krait (KRAIT-002, High) on 1 October 2026; see
        // MAINNET-READINESS item 19.
        //
        // THE DEPOSIT IS FIRST-LOSS. It is part of totalReturned, so any loss
        // eats the borrower's deposit before the insurance pool pays anything:
        // the pool is drawn only once what the vault holds, deposit included,
        // has fallen below the principal. Order of payment, below:
        //   1. lender, up to principal + accrued interest (insurance included)
        //   2. keeper bounty   3. protocol fee   4. borrower, the residual.
        //
        // Q8: if the token refuses the insurance transfer, the pool holds it
        // for the lender (claimDeferredDraw) and the vault settles now with
        // its own cash. The lender's place in the order does not change.
        uint256 insuranceDraw = 0;
        // Audit M-06: and only within the insured window, extended by any
        // recorded outage that overlaps it (the same walk as grace), by at
        // most the fixed 72-hour INSURED_OUTAGE_EXTENSION, so no registry
        // change after origination can lengthen or shorten this loan's cover
        // (M-06 fix review). A later cash settlement still pays out the
        // vault's own funds.
        uint256 insuredEnd = registry.insuredCoverEnd(deadline, insuredUntil);
        if (!early && totalReturned < principal && block.timestamp <= insuredEnd) {
            uint256 deferred;
            (insuranceDraw, deferred) = insurancePool.draw(asset, principal - totalReturned, principal, lender);
            settledInsuranceDeferred = deferred;
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

        _pay(asset, lender, lenderPayout);
        _pay(asset, msg.sender, bounty);
        _pay(asset, treasury, settledProtocolFee);
        _pay(asset, referrer, settledReferrerFee);
        _pay(asset, borrower, settledBorrowerPayout);

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
    function _forcedSwapBackAll(address[] calldata tokens, Route[] calldata routes) internal {
        while (heldAssets.length > 0) {
            address held = heldAssets[heldAssets.length - 1];
            Route memory route;
            for (uint256 i = 0; i < tokens.length; i++) {
                if (tokens[i] == held) { route = routes[i]; break; }
            }
            _sellHeld(held, _sellableAmount(held), route);
            _dropLastHeld(held);
        }
    }

    /// @dev What settlement may sell of a held asset: what the vault BOUGHT,
    ///      not whatever it happens to hold. Selling the whole balance let
    ///      anyone stall settlement by sending the vault more of the asset
    ///      than the pool could absorb (KRAIT-003): the oversized sale missed
    ///      the floor and reverted. Tokens sent in directly stay untouched.
    ///      Capped at the balance, in case an issuer has clawed some back.
    function _sellableAmount(address held) internal view returns (uint256 amount) {
        amount = heldAmount[held];
        uint256 bal = IERC20(held).balanceOf(address(this));
        if (bal < amount) { amount = bal; }
    }

    /// @dev Sells `amount` of `held` back to the loan asset at no worse than
    ///      the TWAP floor, or reverts.
    function _sellHeld(address held, uint256 amount, Route memory route) internal {
        if (amount == 0) { return; }
        uint256 out = _executeSwap(held, asset, amount, _saleMinimum(held, amount, 0, route), route);
        emit ForcedSwapBack(held, amount, out);
    }

    /// @dev Forgets the LAST entry of heldAssets, which must be `held`.
    function _dropLastHeld(address held) internal {
        heldAmount[held] = 0;
        isHeld[held] = false;
        delete admittedToleranceBps[held];
        heldAssets.pop();
    }

    /// @dev The least the vault accepts for selling `amount` of `held`: the
    ///      TWAP-implied value less twapToleranceBps. One floor for every exit
    ///      path — voluntary swap-back, the exit simulation, and settlement.
    /// @dev The least a sale of `amount` of `held` may return: the floor
    ///      (reference price less tolerance, KRAIT-001), the caller's own
    ///      minimum if higher, and — review R4 — for any route other than the
    ///      fallback pool, at least what the fallback pool would pay, measured
    ///      in this transaction. Without that, whoever picks the route (the
    ///      borrower in swapBack, either party at settlement) could sell at
    ///      the floor through liquidity they own and keep up to the tolerance
    ///      at the other side's expense: the lender's recovery and the reserve
    ///      when a loan is underwater, the borrower's residual otherwise.
    function _saleMinimum(address held, uint256 amount, uint256 asked, Route memory route)
        internal returns (uint256 minOut)
    {
        minOut = _exitFloor(held, amount);
        if (asked > minOut) { minOut = asked; }
        if (route.target != address(0) && SWAP_EXECUTOR.hasFallback(held, asset)) {
            uint256 viaFallback = _simulateExitOut(held, amount, Route(address(0), ""));
            if (viaFallback > minOut) { minOut = viaFallback; }
        }
    }

    /// @dev The reference value of `amount` of `tokenIn` in `tokenOut`, or a
    ///      revert if the price cannot be read right now.
    function _refQuote(address tokenIn, address tokenOut, uint256 amount) internal view returns (uint256 out) {
        bool ok;
        (ok, out) = PRICE_ROUTER.quote(tokenIn, tokenOut, amount);
        require(ok, "Price unavailable");
    }

    function _exitFloor(address held, uint256 amount) internal view returns (uint256) {
        return _exitFloorAt(held, amount, registry.twapToleranceBps());
    }

    /// @dev _exitFloor() at a given tolerance.
    function _exitFloorAt(address held, uint256 amount, uint256 toleranceBps)
        internal view returns (uint256)
    {
        return (_refQuote(held, asset, amount) * (10000 - toleranceBps)) / 10000;
    }

    /**
     * @dev Audit M-02 (Zealynx). Whether a held asset whose sale just failed
     *      in settleInKind() could in fact be sold at the tolerance its whole
     *      position was admitted under, in its pinned pool.
     *
     *      Only a tolerance tightened since admission can make a sellable
     *      position fail; a tighter floor than the pool's own fee (1 bp
     *      against a 30 bp pool) fails every sale. Such a position is not
     *      "unsold" in the sense in-kind settlement exists for, and closing
     *      it in kind forgoes the insurance a cash settle() would draw.
     *
     *      False whenever the pool genuinely cannot price or take the sale:
     *      no TWAP, too thin over the window (M-01), or a simulated exit
     *      below the admitted floor. Those still close in kind.
     */
    function _blockedOnlyByTightening(address held) internal returns (bool) {
        uint256 admitted = admittedToleranceBps[held];
        if (registry.twapToleranceBps() >= admitted) { return false; }

        uint256 amount = _sellableAmount(held);
        if (amount == 0) { return false; }
        (bool ok, ) = PRICE_ROUTER.quote(held, asset, amount);
        if (!ok) { return false; }

        uint256 floorOut = _exitFloorAt(held, amount, admitted);
        uint256 gasBefore = gasleft();
        uint256 out = _simulateExitOut(held, amount, Route(address(0), ""));
        if (out == 0 && gasleft() <= gasBefore / 63) { revert("Out of gas"); }
        return out >= floorOut;
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

    // quoteSwapOut moved to VaultLens.quoteSwapOut(vault, ...) to make
    // room for item 14 under the contract size limit.



    /// @notice The grace period this vault would get if it settled now, in
    ///         seconds — surfaced so the UI can show a borrower holding a
    ///         24/5 asset why their window is longer.
    function effectiveGracePeriod() external view returns (uint256) {
        return _effectiveGracePeriod();
    }

    /// 0 = no loss (or unsettled); 1 = borrower-only; 2 = lender-impacted;
    /// 3 = settled in kind.
    /// Severity reflects the vault's OWN performance (pre-insurance-draw):
    /// a pool draw that makes the lender whole still records severity 1+,
    /// because the loss genuinely occurred — the pool absorbed it.
    /// An in-kind close hands over assets the vault could not sell, so its
    /// outcome cannot be measured in the loan asset: comparing cash alone
    /// would report a lender loss even when the assets made the lender whole
    /// (audit I-3). See the InKindAllocated events for what each side got.
    function lossSeverity() external view returns (uint8) {
        if (!isSettled) return 0;
        if (settledInKind) return 3;
        if (settledLenderPayout < principal + settledFee) return 2;
        if (settledTotalReturned < principal + deposit) return 1;
        return 0;
    }
}
