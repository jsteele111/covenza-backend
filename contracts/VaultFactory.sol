// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";

import "./Vault.sol";
import "./KYCRegistry.sol";
import "./AssetRegistry.sol";
import "./InsurancePool.sol";
import "./interfaces/IERC20.sol";

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
contract VaultFactory {

    // --- State variables ---

    KYCRegistry   public kycRegistry;
    AssetRegistry public assetRegistry;
    InsurancePool public insurancePool;
    address       public owner;

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
        address _vaultImplementation
    ) {
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
        return _deployVault(
            _asset, _borrower, _principal, _aprBps, _duration, _useSeconds,
            _depositAmount, _referrer, uint8(AssetRegistry.RiskTier.Speculative)
        );
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
        return _deployVault(
            _asset, _borrower, _principal, _aprBps, _duration, _useSeconds,
            _depositAmount, _referrer, _maxTier
        );
    }

    function _deployVault(
        address _asset,
        address _borrower,
        uint256 _principal,
        uint256 _aprBps,
        uint256 _duration,
        bool    _useSeconds,
        uint256 _depositAmount,
        address _referrer,
        uint8   _maxTier
    ) internal returns (address) {

        // --- Gates ---
        require(kycRegistry.isVerified(_borrower),     "Borrower is not KYC verified");
        require(assetRegistry.isWhitelisted(_asset),   "Loan asset is not whitelisted");

        // --- Basic validation ---
        require(_principal > 0,     "Principal must be greater than zero");
        require(_aprBps > 0,        "APR must be greater than zero");
        require(_duration > 0,      "Duration must be greater than zero");
        require(_depositAmount > 0, "Deposit must be greater than zero");

        // --- Risk limits, keyed to the ceiling the lender granted ---
        //
        // Both bind on _maxTier rather than on the loan asset. At origination
        // the borrower has not chosen what to hold, only what they are allowed
        // to hold, and it is that permission the lender is underwriting.
        {
            AssetRegistry.RiskTier tier = AssetRegistry.RiskTier(_maxTier);
            uint256 termSeconds = _useSeconds ? _duration : _duration * 1 days;

            require(
                termSeconds <= assetRegistry.maxTermForTier(tier),
                "Term exceeds the maximum for this risk tier"
            );

            // Risk scales with sqrt(time), so the floor rises with term. A
            // 30-day loan against 60% volatility needs ~33%; the same asset
            // over 7 days needs ~15%.
            uint256 floorBps = assetRegistry.minimumDepositBpsForTier(tier, termSeconds);
            require(
                _depositAmount >= (_principal * floorBps) / 10000,
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
                asset:         _asset,
                lender:        msg.sender,
                borrower:      _borrower,
                principal:     _principal,
                aprBps:        _aprBps,
                duration:      _duration,
                useSeconds:    _useSeconds,
                depositAmount: _depositAmount,
                registry:      address(assetRegistry),
                insurancePool: address(insurancePool),
                maxTier:       _maxTier
            }),
            FeeConfig({
                treasury:           treasury,
                referrer:           _referrer,
                protocolFeeRateBps: protocolFeeRateBps,
                referrerShareBps:   referrerShareBps,
                minimumFeeBps:      minimumFeeBps
            })
        );

        // --- Fund vault with principal (pulled from the lender) ---
        require(
            IERC20(_asset).transferFrom(msg.sender, vaultAddress, _principal),
            "Principal transfer failed"
        );

        // --- Insurance skim: pull from lender, fund the pool ---
        uint256 skim = quoteInsuranceSkim(_principal, _aprBps, _duration, _useSeconds);
        if (skim > 0) {
            require(
                IERC20(_asset).transferFrom(msg.sender, address(this), skim),
                "Skim transfer failed"
            );
            require(IERC20(_asset).approve(address(insurancePool), skim), "Skim approval failed");
            insurancePool.fund(_asset, skim);
        }

        // --- Register vault with the pool (enables shortfall draws) ---
        insurancePool.registerVault(vaultAddress);

        // --- Record vault ---
        allVaults.push(vaultAddress);
        vaultsByBorrower[_borrower].push(vaultAddress);
        vaultsByLender[msg.sender].push(vaultAddress);

        emit VaultDeployed(
            vaultAddress, msg.sender, _borrower, _asset,
            _principal, _depositAmount, _aprBps, skim, Vault(vaultAddress).deadline()
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

    /// @notice Updates the minimum interest charge, capped at
    ///         MAX_MINIMUM_FEE_BPS. Applies to NEW vaults only.
    function setMinimumFeeBps(uint256 _newBps) external onlyOwner {
        require(_newBps <= MAX_MINIMUM_FEE_BPS, "Exceeds maximum minimum fee");
        uint256 previous = minimumFeeBps;
        minimumFeeBps = _newBps;
        emit MinimumFeeUpdated(previous, _newBps);
    }

    /// @notice Updates registry/pool references. All three set together.
    function setRegistries(
        address _kycRegistry,
        address _assetRegistry,
        address _insurancePool
    ) external onlyOwner {
        require(_kycRegistry != address(0),   "Invalid KYC registry address");
        require(_assetRegistry != address(0), "Invalid asset registry address");
        require(_insurancePool != address(0), "Invalid insurance pool address");
        kycRegistry   = KYCRegistry(_kycRegistry);
        assetRegistry = AssetRegistry(_assetRegistry);
        insurancePool = InsurancePool(_insurancePool);
        emit RegistriesUpdated(_kycRegistry, _assetRegistry, _insurancePool);
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
