// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";

import "./Vault.sol";
import "./KYCRegistry.sol";
import "./AssetRegistry.sol";
import "./InsurancePool.sol";
import "./interfaces/IERC20.sol";
import "./Timelocked.sol";

/**
 * @title VaultFactory
 * @notice Deploys per-borrower Vault contracts — Version 2.1, multi-asset.
 *
 *         Origination flow (single transaction):
 *           1. KYC gate: borrower must be verified in the KYCRegistry.
 *           2. Asset gate: the loan asset must be currently whitelisted
 *              in the AssetRegistry.
 *           3. Vault is deployed, snapshotting the current protocol fee
 *              terms so they can never change beneath a live loan.
 *           4. Principal is pulled from the lender (ERC20 transferFrom —
 *              the lender must approve this factory for principal + the
 *              insurance skim beforehand) and sent to the vault.
 *           5. The insurance skim — a configured fraction of the loan's
 *              fee — is pulled from the lender and paid into the
 *              InsurancePool's reserve for the loan asset. Economically
 *              this is a portion of the lender's fee income allocated to
 *              the shared pool (BRD FR-8): the lender fronts it at
 *              origination and earns it back through the full fee at
 *              settlement.
 *           6. The new vault is registered with the InsurancePool so it
 *              may draw on a post-deadline shortfall.
 *
 *         PROTOCOL FEE (v2.1): a configurable share of each loan's fee,
 *         charged as an ADD-ON to the borrower at settlement — the lender
 *         still receives their full fee, so a lender's advertised yield is
 *         unaffected by protocol revenue. Split between the treasury and an
 *         optional referrer, so that platforms integrating Covenza as a
 *         lending backend can earn a share of what they originate.
 *
 *         ETH loans are WETH loans: the UI wraps ETH before origination,
 *         and this factory only ever handles ERC20s.
 */
contract VaultFactory is Timelocked {

    // --- State variables ---

    KYCRegistry   public kycRegistry;
    AssetRegistry public assetRegistry;
    InsurancePool public insurancePool;
    address       public owner;

    /// @notice Nominee for ownership, pending their acceptance.
    ///
    /// @dev    Two-step, and the factory had no transfer at all before this:
    ///         `owner` was set in the constructor with no setter, so handing
    ///         the protocol to a multisig meant redeploying the factory. Found
    ///         while writing the script to do exactly that.
    ///
    ///         Two-step rather than one because the transfer is irreversible
    ///         and the recipient is usually a Safe. Requiring the nominee to
    ///         call accept proves it can transact BEFORE control depends on
    ///         it — a multisig that cannot reach its threshold is
    ///         indistinguishable from a lost key, and you find out at the
    ///         moment you need it.
    address       public pendingOwner;

    /// @notice Portion of each loan's fee skimmed into the insurance pool
    ///         at origination, in bps of the fee (e.g. 2000 = 20% of the
    ///         fee). Launch value is a placeholder pending VaR calibration
    ///         (Build-Readiness Spec section 6).
    /**
     * @dev Zero by default: the insurance pool is now funded by the BORROWER
     *      via a per-tier premium collected at payDeposit, and charging both
     *      sides would double-fund it.
     *
     *      The mechanism is retained rather than deleted, deliberately. The
     *      premium prices a risk nobody has loss data for yet, so if borrowers
     *      will not bear it — or will not bear all of it — this is a dial back
     *      toward lender funding that costs one transaction rather than a
     *      redeploy. Both can run together at any split.
     *
     *      Worth deleting once the premium has proven itself, since a disabled
     *      code path is audit surface that nothing exercises.
     */
    uint256 public insuranceSkimRateBps = 0;

    // --- Protocol fee configuration ---

    /// @notice Recipient of the protocol fee. Deliberately separate from
    ///         `owner` so that revenue and governance keys need not be the
    ///         same address.
    address public treasury;

    /// @notice Protocol fee, in bps of each loan's fee. 1000 = 10% of the
    ///         fee, which at a 3% loan fee works out to 0.30% of principal.
    uint256 public protocolFeeRateBps = 1000;

    /// @notice Referrer's share of the protocol fee, in bps. 3000 = 30% to
    ///         the referrer, leaving 70% to the treasury.
    uint256 public referrerShareBps = 3000;

    /// @notice Hard ceilings, enforced in the setters below. These exist so
    ///         that even a compromised owner key cannot set a confiscatory
    ///         rate — the worst case is bounded by the contract itself.
    uint256 public constant MAX_PROTOCOL_FEE_RATE_BPS = 2000;  // 20% of the loan fee
    uint256 public constant MAX_REFERRER_SHARE_BPS    = 5000;  // 50% of the protocol fee

    // --- Minimum interest charge ---

    /**
     * @notice Floor on the interest a borrower owes, in bps of principal.
     *
     * @dev    Exists because interest is now annualised and accrues pro-rata,
     *         which without a floor lets a borrower originate and settle in the
     *         same block having paid essentially nothing for capital they did
     *         genuinely hold.
     *
     *         The vault caps this at the loan's own full-term interest, so on
     *         very short loans it simply does not bite — there is little to
     *         extract from a loan whose entire term's interest is smaller than
     *         the floor anyway.
     */
    uint256 public minimumFeeBps = 10;  // 0.1% of principal

    uint256 public constant MAX_MINIMUM_FEE_BPS = 200;  // 2% of principal

    // --- Vault tracking ---

    address[] public allVaults;
    mapping(address => address[]) public vaultsByBorrower;
    mapping(address => address[]) public vaultsByLender;

    // --- Events ---

    event VaultDeployed(
        address indexed vault,
        address indexed lender,
        address indexed borrower,
        address asset,
        uint256 principal,
        uint256 depositRequired,
        uint256 aprBps,
        uint256 insuranceSkim,
        uint256 deadline
    );

    event InsuranceSkimRateUpdated(uint256 previousBps, uint256 newBps);
    event RegistriesUpdated(address kycRegistry, address assetRegistry, address insurancePool);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event ProtocolFeeRateUpdated(uint256 previousBps, uint256 newBps);
    event ReferrerShareUpdated(uint256 previousBps, uint256 newBps);
    event MinimumFeeUpdated(uint256 previousBps, uint256 newBps);

    // --- Constructor ---

    /**
     * @notice The Vault implementation every vault is cloned from.
     *
     * @dev Passed in rather than deployed here, and that is the entire point.
     *      `new Vault(...)` embedded Vault's full creation bytecode in this
     *      contract, which took the factory to 25,106 bytes against the
     *      24,576-byte EIP-170 limit — undeployable, and growing with every
     *      addition to Vault. Referencing the type to call initialize() costs
     *      nothing; constructing it cost kilobytes.
     *
     *      Fixed at construction. Making it mutable would let the owner
     *      repoint every future vault to arbitrary code, which is a much
     *      larger power than any other setter here grants.
     */
    address public immutable vaultImplementation;

    constructor(
        address _kycRegistry,
        address _assetRegistry,
        address _insurancePool,
        address _treasury,
        address _vaultImplementation,
        uint256 _timelockDelay
    ) Timelocked(_timelockDelay) {
        require(_kycRegistry != address(0),         "Invalid KYC registry address");
        require(_assetRegistry != address(0),       "Invalid asset registry address");
        require(_insurancePool != address(0),       "Invalid insurance pool address");
        require(_treasury != address(0),            "Invalid treasury address");
        require(_vaultImplementation != address(0), "Invalid vault implementation address");
        require(_vaultImplementation.code.length > 0, "Vault implementation has no code");

        kycRegistry         = KYCRegistry(_kycRegistry);
        assetRegistry       = AssetRegistry(_assetRegistry);
        insurancePool       = InsurancePool(_insurancePool);
        treasury            = _treasury;
        vaultImplementation = _vaultImplementation;
        owner               = msg.sender;
    }

    // --- Modifiers ---

    modifier onlyOwner() {
        require(msg.sender == owner, "Caller is not the owner");
        _;
    }

    // --- Ownership ---

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    /// @notice Nominates a new owner. Takes effect only once they accept.
    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "Invalid owner address");
        pendingOwner = _newOwner;
        emit OwnershipTransferStarted(owner, _newOwner);
    }

    /// @notice Withdraws a pending nomination. Not restricted to before any
    ///         deadline — a nomination that has not been accepted has changed
    ///         nothing, so cancelling it costs nothing.
    function cancelOwnershipTransfer() external onlyOwner {
        emit OwnershipTransferStarted(owner, address(0));
        pendingOwner = address(0);
    }

    /// @notice Called by the nominee to take ownership.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Caller is not the pending owner");
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    // --- Core function ---

    /**
     * @notice Deploys a new Vault for a verified borrower, denominated in
     *         any whitelisted asset. The lender must first approve this
     *         factory for `_principal` plus the insurance skim (see
     *         quoteInsuranceSkim() for the exact amount).
     *
     * @param _asset         The loan's denomination — must be whitelisted.
     * @param _borrower      Borrower's wallet address — must be KYC verified.
     * @param _principal     Loan principal, in the asset's own units.
     * @param _aprBps        ANNUALISED interest rate in basis points. 300 = 3%
     *                       per year, accrued pro-rata over the loan's term.
     * @param _duration      Loan duration (days, or seconds if _useSeconds).
     * @param _useSeconds    True for testnet short durations.
     * @param _depositAmount Required deposit, in the same asset.
     * @param _referrer      Integrator that sourced this loan, entitled to a
     *                       share of the protocol fee. Pass address(0) for
     *                       a direct origination with no referrer.
     */
    function deployVault(
        address _asset,
        address _borrower,
        uint256 _principal,
        uint256 _aprBps,
        uint256 _duration,
        bool    _useSeconds,
        uint256 _depositAmount,
        address _referrer
    ) external returns (address) {
        // Speculative is the most PERMISSIVE ceiling, which preserves existing
        // behaviour exactly: before tiers there was no ceiling at all. Callers
        // wanting the protection use deployVaultWithTier and say so.
        return _deployVault(OriginationParams({
            lender:        msg.sender,
            asset:         _asset,
            borrower:      _borrower,
            principal:     _principal,
            aprBps:        _aprBps,
            duration:      _duration,
            useSeconds:    _useSeconds,
            depositAmount: _depositAmount,
            referrer:      _referrer,
            maxTier:       uint8(AssetRegistry.RiskTier.Speculative)
        }));
    }

    /**
     * @notice Originates a loan with an explicit risk ceiling.
     *
     * @param _maxTier Highest AssetRegistry.RiskTier the borrower may swap
     *                 into. 0 = BlueChip only, 1 = up to Standard, 2 = any.
     *
     * @dev This is the form a lender should use. Without a ceiling, terms are
     *      priced at origination while exposure is chosen afterwards by someone
     *      else — a lender quoting for WETH can end up backing a memecoin.
     */
    function deployVaultWithTier(
        address _asset,
        address _borrower,
        uint256 _principal,
        uint256 _aprBps,
        uint256 _duration,
        bool    _useSeconds,
        uint256 _depositAmount,
        address _referrer,
        uint8   _maxTier
    ) external returns (address) {
        return _deployVault(OriginationParams({
            lender:        msg.sender,
            asset:         _asset,
            borrower:      _borrower,
            principal:     _principal,
            aprBps:        _aprBps,
            duration:      _duration,
            useSeconds:    _useSeconds,
            depositAmount: _depositAmount,
            referrer:      _referrer,
            maxTier:       _maxTier
        }));
    }

    /**
     * @dev Everything origination needs, as one struct.
     *
     *      The lender is explicit rather than taken from msg.sender, because a
     *      mandate fill is called by the BORROWER — the lender consented in
     *      advance by publishing the mandate and approving this factory. Ten
     *      separate parameters would also overflow the stack, which is the same
     *      reason LoanTerms and FeeConfig exist.
     */
    struct OriginationParams {
        address lender;
        address asset;
        address borrower;
        uint256 principal;
        uint256 aprBps;
        uint256 duration;
        bool    useSeconds;
        uint256 depositAmount;
        address referrer;
        uint8   maxTier;
    }

    function _deployVault(OriginationParams memory p) internal returns (address) {

        // --- Gates ---
        require(kycRegistry.isVerified(p.borrower),     "Borrower is not KYC verified");
        require(assetRegistry.isWhitelisted(p.asset),   "Loan asset is not whitelisted");

        // --- Basic validation ---
        require(p.principal > 0,     "Principal must be greater than zero");
        require(p.aprBps > 0,        "APR must be greater than zero");
        require(p.duration > 0,      "Duration must be greater than zero");
        require(p.depositAmount > 0, "Deposit must be greater than zero");

        // --- Risk limits, keyed to the ceiling the lender granted ---
        //
        // Both bind on p.maxTier rather than on the loan asset. At origination
        // the borrower has not chosen what to hold, only what they are allowed
        // to hold, and it is that permission the lender is underwriting.
        {
            AssetRegistry.RiskTier tier = AssetRegistry.RiskTier(p.maxTier);
            uint256 termSeconds = p.useSeconds ? p.duration : p.duration * 1 days;

            require(
                termSeconds <= assetRegistry.maxTermForTier(tier),
                "Term exceeds the maximum for this risk tier"
            );

            // Risk scales with sqrt(time), so the floor rises with term. A
            // 30-day loan against 60% volatility needs ~33%; the same asset
            // over 7 days needs ~15%.
            uint256 floorBps = assetRegistry.minimumDepositBpsForTier(tier, termSeconds);
            require(
                p.depositAmount >= (p.principal * floorBps) / 10000,
                "Deposit below the volatility floor for this tier and term"
            );
        }

        // --- Clone a vault, snapshotting current fee terms ---
        //
        // The snapshot matters: a vault must never re-read the factory's live
        // rate at settlement, or the owner could raise the rate after a loan is
        // originated and retroactively take a larger cut.
        //
        // Clone and initialise atomically. Initialisation MUST happen in this
        // same transaction — an uninitialised clone is claimable by whoever
        // calls initialize() first, and there is no window here for that.
        address vaultAddress = Clones.clone(vaultImplementation);
        Vault(vaultAddress).initialize(
            LoanTerms({
                asset:         p.asset,
                lender:        p.lender,
                borrower:      p.borrower,
                principal:     p.principal,
                aprBps:        p.aprBps,
                duration:      p.duration,
                useSeconds:    p.useSeconds,
                depositAmount: p.depositAmount,
                registry:      address(assetRegistry),
                insurancePool: address(insurancePool),
                maxTier:       p.maxTier
            }),
            FeeConfig({
                treasury:           treasury,
                referrer:           p.referrer,
                protocolFeeRateBps: protocolFeeRateBps,
                referrerShareBps:   referrerShareBps,
                minimumFeeBps:      minimumFeeBps
            })
        );

        // --- Fund vault with principal (pulled from the lender) ---
        require(
            IERC20(p.asset).transferFrom(p.lender, vaultAddress, p.principal),
            "Principal transfer failed"
        );

        // --- Insurance skim: pull from lender, fund the pool ---
        uint256 skim = quoteInsuranceSkim(p.principal, p.aprBps, p.duration, p.useSeconds);
        if (skim > 0) {
            require(
                IERC20(p.asset).transferFrom(p.lender, address(this), skim),
                "Skim transfer failed"
            );
            require(IERC20(p.asset).approve(address(insurancePool), skim), "Skim approval failed");
            insurancePool.fund(p.asset, skim);
        }

        // --- Register vault with the pool (enables shortfall draws) ---
        insurancePool.registerVault(vaultAddress);

        // --- Record vault ---
        allVaults.push(vaultAddress);
        vaultsByBorrower[p.borrower].push(vaultAddress);
        vaultsByLender[p.lender].push(vaultAddress);

        emit VaultDeployed(
            vaultAddress, p.lender, p.borrower, p.asset,
            p.principal, p.depositAmount, p.aprBps, skim, Vault(vaultAddress).deadline()
        );

        return vaultAddress;
    }

    // --- Quoting ---

    /**
     * @notice Smallest deposit that will be accepted for these terms, in the
     *         asset's own units. Quote this before originating.
     */
    function quoteMinimumDeposit(
        uint256 _principal,
        uint8   _maxTier,
        uint256 _duration,
        bool    _useSeconds
    ) public view returns (uint256) {
        uint256 termSeconds = _useSeconds ? _duration : _duration * 1 days;
        uint256 floorBps = assetRegistry.minimumDepositBpsForTier(
            AssetRegistry.RiskTier(_maxTier), termSeconds
        );
        return (_principal * floorBps) / 10000;
    }

    /**
     * @notice Interest for the FULL term at the given annualised rate.
     *
     * @dev    Duration is now part of the quote, which it was not when the fee
     *         was flat. Both the skim and the protocol fee are percentages of
     *         the interest, so both annualise for free once this does — no
     *         change to either mechanism was needed.
     */
    function quoteFullTermFee(
        uint256 _principal,
        uint256 _aprBps,
        uint256 _duration,
        bool    _useSeconds
    ) public pure returns (uint256) {
        uint256 term = _useSeconds ? _duration : _duration * 1 days;
        return (_principal * _aprBps * term) / (10000 * 365 days);
    }

    /**
     * @notice The insurance skim for the given terms — the extra amount
     *         beyond principal the lender must approve.
     *
     * @dev    Computed from the FULL-TERM interest, deliberately, even though
     *         the realised interest may be lower if the borrower closes early.
     *         The pool has to be funded for maximum exposure before any loss
     *         can occur; over-collecting slightly is the safe direction, and
     *         the excess stays in the reserve where it does useful work.
     */
    function quoteInsuranceSkim(
        uint256 _principal,
        uint256 _aprBps,
        uint256 _duration,
        bool    _useSeconds
    ) public view returns (uint256) {
        uint256 fee = quoteFullTermFee(_principal, _aprBps, _duration, _useSeconds);
        return (fee * insuranceSkimRateBps) / 10000;
    }

    /// @notice The protocol fee a borrower would pay at settlement for the
    ///         given terms, at the CURRENT rate. Charged as an add-on: the
    ///         lender still receives the full fee, so this does not reduce
    ///         lender yield. Returns zero if no treasury is configured.
    ///
    /// @dev    Indicative only. A vault snapshots the rate at origination,
    ///         so a vault created before a rate change keeps its original
    ///         terms — read the vault's own protocolFeeRateBps for a loan
    ///         that already exists.
    function quoteProtocolFee(
        uint256 _principal,
        uint256 _aprBps,
        uint256 _duration,
        bool    _useSeconds
    ) public view returns (uint256) {
        if (treasury == address(0) || protocolFeeRateBps == 0) return 0;
        uint256 fee = quoteFullTermFee(_principal, _aprBps, _duration, _useSeconds);
        return (fee * protocolFeeRateBps) / 10000;
    }

    // =====================================================================
    // Mandates
    // =====================================================================
    //
    // A lender publishes terms they will accept; a borrower fills them. Capital
    // stays in the lender's wallet until a fill, so nothing is locked up
    // waiting — which is the friction that otherwise kills the scarce side of
    // a two-sided market.
    //
    // WHY THIS LIVES IN THE FACTORY rather than a separate book contract: the
    // vault records msg.sender as its lender. A separate contract filling on a
    // lender's behalf would either become the lender of record — so settlement
    // pays the book instead of the lender — or need privileged authority to
    // originate against anyone's allowance. Keeping it here removes the
    // question entirely.
    //
    // THE PRICING IS A FORMULA, NOT A RANGE, and that is the central decision.
    // A mandate quoting "11-15% APR, 7-90 days, 15-40% deposit" is not a range
    // of acceptable terms; it is the lender's WORST terms with decoration
    // around them, because every borrower will take 11% at 90 days on a 15%
    // deposit. A formula prices every point on the surface, so the lender is
    // indifferent across it rather than exposed at one corner.

    struct Mandate {
        address lender;
        address asset;
        uint256 minPrincipal;
        uint256 maxPrincipal;
        uint256 minTermSeconds;
        uint256 maxTermSeconds;
        uint256 expiry;
        uint256 nonce;              // lender's nonce when published; cancel-all bumps it
        uint8   maxTier;            // risk ceiling granted to the borrower
        bool    cancelled;
        address permittedBorrower;  // address(0) = open to any verified borrower

        // --- pricing surface ---
        uint256 baseAprBps;                 // at the mandate's minimum term and deposit
        uint256 termPremiumBpsPerDay;       // added per day of term
        uint256 depositCreditBpsPerPoint;   // subtracted per whole % of deposit above the minimum
        uint256 minDepositBps;              // the mandate's own floor, on top of the tier's
        uint256 minAprBps;                  // the formula can never price below this
    }

    /// @dev Published as one struct: eleven-plus arguments would overflow the
    ///      stack for the same reason LoanTerms exists.
    struct MandateTerms {
        address asset;
        uint256 minPrincipal;
        uint256 maxPrincipal;
        uint256 minTermSeconds;
        uint256 maxTermSeconds;
        uint256 validForSeconds;
        uint8   maxTier;
        address permittedBorrower;
        uint256 baseAprBps;
        uint256 termPremiumBpsPerDay;
        uint256 depositCreditBpsPerPoint;
        uint256 minDepositBps;
        uint256 minAprBps;
    }

    Mandate[] internal _mandates;

    /// @notice Bumped by cancelAllMandates. Every mandate carries the nonce it
    ///         was published under, so raising it invalidates all of them at
    ///         once — one transaction when a lender needs to withdraw from the
    ///         market, rather than one per mandate.
    mapping(address => uint256) public lenderNonce;

    /**
     * @notice Longest a mandate may remain valid.
     *
     * @dev Expiry is mandatory, and this caps how far it can be pushed out.
     *      A standing offer is an option written to the market for free: it
     *      will be exercised precisely when it is worst for the lender —
     *      when rates have moved, when volatility spikes and non-liquidating
     *      leverage becomes most valuable. Expiry is what makes INACTION safe,
     *      which matters because a lender cannot watch the market continuously
     *      and an adversary only has to act once.
     */
    uint256 public maxMandateDuration = 7 days;

    event MandatePublished(uint256 indexed id, address indexed lender, address indexed asset,
        uint256 maxPrincipal, uint256 expiry, uint8 maxTier);
    event MandateCancelled(uint256 indexed id, address indexed lender);
    event MandateFilled(uint256 indexed id, address indexed lender, address indexed borrower,
        address vault, uint256 principal, uint256 aprBps);
    event AllMandatesCancelled(address indexed lender, uint256 newNonce);
    event MaxMandateDurationUpdated(uint256 previous, uint256 newValue);

    // --- Publishing ---

    function publishMandate(MandateTerms calldata t) external returns (uint256 id) {
        require(assetRegistry.isWhitelisted(t.asset),     "Loan asset is not whitelisted");
        require(t.minPrincipal > 0,                       "Minimum principal must be nonzero");
        require(t.maxPrincipal >= t.minPrincipal,         "Maximum below minimum principal");
        require(t.minTermSeconds > 0,                     "Minimum term must be nonzero");
        require(t.maxTermSeconds >= t.minTermSeconds,     "Maximum below minimum term");
        require(t.validForSeconds > 0,                    "Mandate must have a lifetime");
        require(t.validForSeconds <= maxMandateDuration,  "Mandate lifetime too long");
        require(t.baseAprBps > 0,                         "Base APR must be nonzero");
        require(t.minAprBps > 0,                          "Minimum APR must be nonzero");
        require(t.minAprBps <= t.baseAprBps,              "Minimum APR above base");
        require(t.minDepositBps <= 10000,                 "Deposit floor above 100%");
        require(
            t.maxTermSeconds <= assetRegistry.maxTermForTier(AssetRegistry.RiskTier(t.maxTier)),
            "Maximum term exceeds the tier's limit"
        );

        // Written field-by-field into storage rather than built as a memory
        // struct literal. Sixteen fields constructed at once overflows the
        // stack — the same limit that produced LoanTerms and FeeConfig — and
        // assigning through a storage pointer avoids the memory copy entirely.
        id = _mandates.length;
        _mandates.push();
        Mandate storage m = _mandates[id];

        m.lender                   = msg.sender;
        m.asset                    = t.asset;
        m.minPrincipal             = t.minPrincipal;
        m.maxPrincipal             = t.maxPrincipal;
        m.minTermSeconds           = t.minTermSeconds;
        m.maxTermSeconds           = t.maxTermSeconds;
        m.expiry                   = block.timestamp + t.validForSeconds;
        m.nonce                    = lenderNonce[msg.sender];
        m.maxTier                  = t.maxTier;
        m.permittedBorrower        = t.permittedBorrower;
        m.baseAprBps               = t.baseAprBps;
        m.termPremiumBpsPerDay     = t.termPremiumBpsPerDay;
        m.depositCreditBpsPerPoint = t.depositCreditBpsPerPoint;
        m.minDepositBps            = t.minDepositBps;
        m.minAprBps                = t.minAprBps;
        // cancelled defaults to false

        emit MandatePublished(id, msg.sender, t.asset, t.maxPrincipal, m.expiry, t.maxTier);
    }

    function cancelMandate(uint256 id) external {
        require(id < _mandates.length,             "No such mandate");
        require(_mandates[id].lender == msg.sender, "Not your mandate");
        _mandates[id].cancelled = true;
        emit MandateCancelled(id, msg.sender);
    }

    /// @notice Invalidates every mandate this lender has published, in one
    ///         transaction. The point is that withdrawing from the market
    ///         during a rate move must be cheap — if it is not, lenders leave
    ///         stale mandates standing rather than pay to remove them, and the
    ///         book fills with mispriced liquidity.
    function cancelAllMandates() external {
        lenderNonce[msg.sender] += 1;
        emit AllMandatesCancelled(msg.sender, lenderNonce[msg.sender]);
    }

    // --- Pricing and validity ---

    /// @notice True if this mandate could be filled at all right now. Does not
    ///         consider the lender's balance or allowance — see
    ///         quoteMandateFillable for that.
    function isMandateLive(uint256 id) public view returns (bool) {
        if (id >= _mandates.length) return false;
        Mandate storage m = _mandates[id];
        return !m.cancelled
            && block.timestamp <= m.expiry
            && m.nonce == lenderNonce[m.lender];
    }

    /**
     * @notice The APR this mandate charges for a given term and deposit.
     *
     *         apr = base
     *             + termPremiumPerDay x days
     *             - depositCredit x (deposit% - mandate minimum%)
     *
     *         floored at minAprBps.
     *
     * @dev Longer term costs more; a larger deposit costs less. Both are the
     *      borrower's choice, and both are priced — so there is no corner of
     *      the mandate that is cheap relative to the rest.
     */
    function quoteMandateApr(uint256 id, uint256 termSeconds, uint256 depositBps)
        public view returns (uint256)
    {
        Mandate storage m = _mandates[id];

        uint256 apr = m.baseAprBps + (m.termPremiumBpsPerDay * termSeconds) / 1 days;

        if (depositBps > m.minDepositBps) {
            uint256 credit = (m.depositCreditBpsPerPoint * (depositBps - m.minDepositBps)) / 100;
            apr = credit >= apr ? 0 : apr - credit;
        }

        return apr < m.minAprBps ? m.minAprBps : apr;
    }

    /// @notice How much of this mandate could actually be drawn right now —
    ///         the lesser of what the lender has approved, what they hold, and
    ///         what the mandate offers.
    ///
    /// @dev An allowance is not a commitment; it can be revoked at any moment
    ///      for free. A book that displays intended size rather than this
    ///      becomes a book of liquidity that cannot be taken.
    function quoteMandateFillable(uint256 id) public view returns (uint256) {
        if (!isMandateLive(id)) return 0;
        Mandate storage m = _mandates[id];

        uint256 allowance = IERC20(m.asset).allowance(m.lender, address(this));
        uint256 balance   = IERC20(m.asset).balanceOf(m.lender);

        uint256 available = allowance < balance ? allowance : balance;
        return available < m.maxPrincipal ? available : m.maxPrincipal;
    }

    function totalMandates() external view returns (uint256) {
        return _mandates.length;
    }

    // --- Filling ---

    /**
     * @notice Fills a mandate. Called by the BORROWER, who picks the size,
     *         term and deposit; the mandate's formula prices the result.
     *
     * @dev Everything happens here or nothing does. The lender's principal, the
     *      borrower's deposit and the insurance premium all move in this one
     *      transaction, and the vault is left fully funded rather than waiting
     *      on a second call that may never come.
     *
     *      That matters because the mandate flow reverses who initiates. In a
     *      direct origination the lender acts and the borrower funds afterwards
     *      — an unfunded vault is the borrower's problem, and cancel() returns
     *      the principal. Here the borrower acts, so a non-atomic fill would
     *      let anyone lock a lender's capital until the deadline for the price
     *      of gas, across every mandate on the book.
     */
    function fillMandate(
        uint256 id,
        uint256 principal,
        uint256 duration,
        bool    useSeconds,
        uint256 deposit
    ) external returns (address vaultAddress) {
        require(isMandateLive(id), "Mandate is not live");

        uint256 apr;
        address asset;
        address lender;

        // Scoped so the mandate pointer and the validation locals are dead
        // before origination, which needs the stack.
        {
            Mandate storage m = _mandates[id];
            asset  = m.asset;
            lender = m.lender;

            require(
                m.permittedBorrower == address(0) || m.permittedBorrower == msg.sender,
                "Not the permitted borrower for this mandate"
            );
            require(
                principal >= m.minPrincipal && principal <= m.maxPrincipal,
                "Principal outside the mandate's bounds"
            );

            uint256 termSeconds = useSeconds ? duration : duration * 1 days;
            require(
                termSeconds >= m.minTermSeconds && termSeconds <= m.maxTermSeconds,
                "Term outside the mandate's bounds"
            );

            uint256 depositBps = (deposit * 10000) / principal;
            require(depositBps >= m.minDepositBps, "Deposit below the mandate's minimum");

            apr = quoteMandateApr(id, termSeconds, depositBps);
        }

        vaultAddress = _deployVault(OriginationParams({
            lender:        lender,
            asset:         asset,
            borrower:      msg.sender,
            principal:     principal,
            aprBps:        apr,
            duration:      duration,
            useSeconds:    useSeconds,
            depositAmount: deposit,
            referrer:      address(0),
            maxTier:       _mandates[id].maxTier
        }));

        _fundBorrowerSide(vaultAddress, asset, deposit);

        emit MandateFilled(id, lender, msg.sender, vaultAddress, principal, apr);
    }

    /**
     * @dev Moves the borrower's money in. Split out because fillMandate's stack
     *      is already carrying the mandate's terms.
     *
     *      The premium is read FROM THE VAULT rather than recomputed here.
     *      Vault.initialize derives it from the registry, and a second
     *      implementation of the same formula in this contract would be a
     *      standing invitation for the two to disagree.
     */
    function _fundBorrowerSide(address vaultAddress, address asset, uint256 deposit) internal {
        require(
            IERC20(asset).transferFrom(msg.sender, vaultAddress, deposit),
            "Deposit transfer failed"
        );
        Vault(vaultAddress).creditDeposit();

        uint256 premium = Vault(vaultAddress).insurancePremium();
        if (premium > 0) {
            require(
                IERC20(asset).transferFrom(msg.sender, address(this), premium),
                "Premium transfer failed"
            );
            require(
                IERC20(asset).approve(address(insurancePool), premium),
                "Premium approval failed"
            );
            insurancePool.fund(asset, premium);
        }
    }

    /// @notice What a borrower must approve this factory for before filling —
    ///         deposit plus premium, in the loan asset.
    function quoteFillCost(uint256 id, uint256 principal, uint256 duration, bool useSeconds, uint256 deposit)
        external view returns (uint256 depositOwed, uint256 premiumOwed)
    {
        uint256 termSeconds = useSeconds ? duration : duration * 1 days;
        uint256 premiumBps = assetRegistry.insurancePremiumBpsForTier(
            AssetRegistry.RiskTier(_mandates[id].maxTier)
        );
        return (deposit, (principal * premiumBps * termSeconds) / (10000 * 365 days));
    }

    /**
     * @notice Reads a mandate.
     *
     * @dev The array is internal with this getter in front of it, rather than
     *      public, because Solidity's generated getter for a public array of a
     *      sixteen-field struct returns sixteen separate values — and pushing
     *      sixteen returns onto the stack overflows it. Returning a memory
     *      struct costs one pointer instead.
     *
     *      Same limit that produced LoanTerms and FeeConfig, reached from a
     *      different direction: there the problem was passing many arguments,
     *      here it is returning many values.
     */
    function mandate(uint256 id) external view returns (Mandate memory) {
        require(id < _mandates.length, "No such mandate");
        return _mandates[id];
    }

    // --- Admin functions ---

    function setInsuranceSkimRateBps(uint256 _newBps) external onlyOwner {
        require(_newBps <= 10000, "Skim rate cannot exceed 100% of fee");
        uint256 previous = insuranceSkimRateBps;
        insuranceSkimRateBps = _newBps;
        emit InsuranceSkimRateUpdated(previous, _newBps);
    }

    /// @notice Updates the protocol fee recipient. Applies to NEW vaults
    ///         only — existing vaults pay out to the treasury they were
    ///         created with.
    function setTreasury(address _newTreasury) external onlyOwner {
        require(_newTreasury != address(0), "Invalid treasury address");
        address previous = treasury;
        treasury = _newTreasury;
        emit TreasuryUpdated(previous, _newTreasury);
    }

    /// @notice Updates the protocol fee rate, capped at
    ///         MAX_PROTOCOL_FEE_RATE_BPS. Applies to NEW vaults only, so a
    ///         live loan's economics can never be altered underneath the
    ///         parties who agreed to them.
    function setProtocolFeeRateBps(uint256 _newBps) external onlyOwner {
        require(_newBps <= MAX_PROTOCOL_FEE_RATE_BPS, "Exceeds maximum protocol fee rate");
        uint256 previous = protocolFeeRateBps;
        protocolFeeRateBps = _newBps;
        emit ProtocolFeeRateUpdated(previous, _newBps);
    }

    /// @notice Updates the referrer's share of the protocol fee, capped at
    ///         MAX_REFERRER_SHARE_BPS. Applies to NEW vaults only.
    function setReferrerShareBps(uint256 _newBps) external onlyOwner {
        require(_newBps <= MAX_REFERRER_SHARE_BPS, "Exceeds maximum referrer share");
        uint256 previous = referrerShareBps;
        referrerShareBps = _newBps;
        emit ReferrerShareUpdated(previous, _newBps);
    }

    /// @notice Caps how long a mandate may stay valid. Shorter is safer: a
    ///         standing offer is an option written for free, and expiry is
    ///         what bounds how stale it can become.
    function setMaxMandateDuration(uint256 _seconds) external onlyOwner {
        require(_seconds > 0 && _seconds <= 30 days, "Duration out of range");
        uint256 previous = maxMandateDuration;
        maxMandateDuration = _seconds;
        emit MaxMandateDurationUpdated(previous, _seconds);
    }

    /// @notice Updates the minimum interest charge, capped at
    ///         MAX_MINIMUM_FEE_BPS. Applies to NEW vaults only.
    function setMinimumFeeBps(uint256 _newBps) external onlyOwner {
        require(_newBps <= MAX_MINIMUM_FEE_BPS, "Exceeds maximum minimum fee");
        uint256 previous = minimumFeeBps;
        minimumFeeBps = _newBps;
        emit MinimumFeeUpdated(previous, _newBps);
    }

    /**
     * @notice Announces a change of registry/pool references. All three are
     *         set together and the change becomes executable after
     *         `timelockDelay`.
     *
     * @dev    This call is how the KYC registry was migrated without
     *         redeploying the factory — a genuinely useful power, and the same
     *         one that points the protocol at a hostile asset registry able to
     *         whitelist a worthless token at Blue chip tier with no deposit
     *         floor. A planned migration tolerates a delay comfortably; an
     *         attack does not.
     */
    function queueSetRegistries(
        address _kycRegistry,
        address _assetRegistry,
        address _insurancePool
    ) external onlyOwner {
        _queue(_registriesId(_kycRegistry, _assetRegistry, _insurancePool));
    }

    function cancelSetRegistries(
        address _kycRegistry,
        address _assetRegistry,
        address _insurancePool
    ) external onlyOwner {
        _cancel(_registriesId(_kycRegistry, _assetRegistry, _insurancePool));
    }

    /// @notice Executes a registry change announced at least `timelockDelay`
    ///         ago. Existing vaults are unaffected either way — they hold
    ///         their own references and settle against them.
    function setRegistries(
        address _kycRegistry,
        address _assetRegistry,
        address _insurancePool
    ) external onlyOwner {
        require(_kycRegistry != address(0),   "Invalid KYC registry address");
        require(_assetRegistry != address(0), "Invalid asset registry address");
        require(_insurancePool != address(0), "Invalid insurance pool address");

        _consume(_registriesId(_kycRegistry, _assetRegistry, _insurancePool));

        kycRegistry   = KYCRegistry(_kycRegistry);
        assetRegistry = AssetRegistry(_assetRegistry);
        insurancePool = InsurancePool(_insurancePool);
        emit RegistriesUpdated(_kycRegistry, _assetRegistry, _insurancePool);
    }

    function _registriesId(address k, address a, address i) internal pure returns (bytes32) {
        return keccak256(abi.encode("setRegistries", k, a, i));
    }

    // --- View functions ---

    function totalVaults() external view returns (uint256) {
        return allVaults.length;
    }

    function getVaultsByBorrower(address _borrower) external view returns (address[] memory) {
        return vaultsByBorrower[_borrower];
    }

    function getVaultsByLender(address _lender) external view returns (address[] memory) {
        return vaultsByLender[_lender];
    }
}
