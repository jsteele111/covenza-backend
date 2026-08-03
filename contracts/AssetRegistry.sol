// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AssetRegistry
 * @notice Protocol-level, operator-controlled asset whitelist for the
 *         Covenza lending protocol — replaces the single hardcoded Aave
 *         constant that previously lived inside Vault.sol.
 *
 *         This closes the NFR-6 gap ("whitelist configurable without
 *         redeploying in-flight vaults"): vaults read this registry LIVE
 *         at the moment of each action, so an operator whitelist change
 *         takes effect immediately across every vault, past and present,
 *         with no redeployment.
 *
 *         Per asset, the registry stores:
 *           - whether it is currently whitelisted (loans may be originated
 *             in it; borrowers may swap INTO it), and
 *           - its Aave V3 aToken address (needed by vaults to check their
 *             own Aave position balance at settlement).
 *
 *         It also stores the protocol-wide external contract addresses
 *         (Aave V3 Pool, Uniswap V3 SwapRouter, Uniswap V3 Factory, WETH),
 *         giving every vault one place to read integration config from.
 *
 *         IMPORTANT SAFETY RULE (enforced in Vault, documented here):
 *         removing an asset from the whitelist blocks NEW exposure to it
 *         (no new loans in it, no new swaps into it) — but swaps BACK from
 *         it to a vault's loan asset are always permitted regardless of
 *         whitelist status. A whitelist removal must never strand a
 *         borrower who is already holding the removed asset mid-loan.
 */
contract AssetRegistry {

    // --- State variables ---

    address public operator;

    // Protocol-wide integration addresses (set once at deployment, but
    // operator-updatable in case of e.g. a router migration).
    address public aavePool;         // Aave V3 Pool (uniform entry for all assets)
    address public swapRouter;       // Uniswap V3 SwapRouter
    address public uniswapFactory;   // Uniswap V3 Factory (for TWAP pool lookups)
    address public weth;             // canonical WETH for this network

    // --- Settlement configuration (protocol-wide, operator-configurable) ---
    // Launch values below are placeholders pending empirical calibration
    // (Build-Readiness Spec section 6) — deliberately settable post-deploy.

    uint32  public twapWindow          = 1800;  // 30 min TWAP window for forced swap-back pricing
    uint256 public twapToleranceBps    = 200;   // swap output must be within 2% of TWAP-implied value
    uint256 public swapBackGracePeriod = 36 hours; // post-expiry window where only lender/borrower may settle a foreign-asset vault
    uint256 public bountyRatePerHourBps = 2;    // keeper bounty accrual: bps of principal per hour past grace end
    uint256 public bountyCapBps        = 100;   // keeper bounty ceiling: 1% of principal

    /**
     * @notice How dangerous an asset is to be HOLDING when settlement forces a
     *         swap back out of it.
     *
     * @dev    The tier drives four things, and the reason it drives four rather
     *         than one is worth recording.
     *
     *         Modelling a 30-day loan against WETH at 64% annualised
     *         volatility: with a 20% deposit the lender is untouched until the
     *         asset falls 19%, which is only 1.15 standard deviations away — not
     *         a tail event. One loan in eight reaches the lender, and expected
     *         loss works out at 10.6% ANNUALISED. No plausible interest rate
     *         covers that.
     *
     *         Raising the deposit to 30% cuts expected loss to 1.8%. A ten-point
     *         change in deposit moved the risk by a factor of six, which no
     *         interest rate achieves. Hence: deposits are the control, rates are
     *         the compensation.
     *
     *         The same arithmetic at 200% volatility gives an expected loss of
     *         113% of principal per year at a 20% deposit, and only becomes
     *         sane around a 75% deposit — which is 1.33x leverage, at which
     *         point the borrower should simply buy the asset. So above roughly
     *         100% volatility, meaningful leverage is not lendable at any price.
     *         That is a LISTING decision, not a pricing one, and it is what
     *         this enum exists to express.
     */
    enum RiskTier { BlueChip, Standard, Speculative }

    /**
     * @notice Per-tier risk parameters.
     *
     * @dev    maxTermSeconds matters more than it looks. Risk scales with the
     *         SQUARE ROOT of time, so the same asset can be uninsurable over 30
     *         days and perfectly viable over 7 — measured: a 200%-volatility
     *         asset at a 50% deposit gives 1.8% expected loss over a week and
     *         37% over a month. Term limits belong beside deposit floors, not
     *         as an afterthought.
     */
    struct TierConfig {
        uint256 assumedVolBps;       // annualised sigma; 6000 = 60%
        uint256 minDepositBps;       // absolute floor, bps of principal
        uint256 maxTermSeconds;      // longest permitted loan against this tier
        uint256 maxExposureBps;      // most of principal that may sit in one such asset
        uint256 insurancePremiumBps; // annualised, bps of principal
    }

    mapping(RiskTier => TierConfig) public tierConfig;

    /**
     * @notice Every tier an asset has been assigned, with effect dates.
     *
     * @dev    Exists because a live loan's risk mandate has to mean what it
     *         meant when it was written. Vault.swap compared a LIVE tier
     *         against a ceiling snapshotted at origination, which is safe in
     *         one direction and not the other: re-tagging an asset as riskier
     *         excludes it from vaults that previously allowed it, but
     *         re-tagging it as SAFER admits it to vaults that previously
     *         excluded it — with no lender consent, against a deposit sized
     *         for a different volatility.
     *
     *         History rather than a single previous value because an asset can
     *         be re-tagged more than once during a loan, and only the worst it
     *         has been should count.
     */
    struct TierChange {
        uint64  at;
        RiskTier tier;
    }

    mapping(address => TierChange[]) private _tierHistory;

    /**
     * @notice Coefficient in the volatility deposit floor, in bps. 18000 = 1.8.
     *
     * @dev    Calibrated so a 30-day loan at 64% volatility requires ~33%
     *         deposit (the model says 30% suffices, so this errs conservative),
     *         and a 7-day loan at 200% volatility requires ~50% (which the model
     *         agrees with exactly).
     *
     *         Erring high is correct for a floor. It is also correct given that
     *         the model assumes lognormal returns while crypto has fatter tails,
     *         so every computed expected loss is UNDERSTATED — the error runs in
     *         the unsafe direction.
     */
    uint256 public depositCoeffBps = 18000;

    /**
     * @notice How far a swap's execution may fall below the TWAP before it is
     *         refused, in bps. Zero disables the check.
     *
     * @dev    Bounds position size by pool depth without needing to reason
     *         about liquidity directly — execution versus TWAP measures impact
     *         exactly.
     *
     *         Sized against twapToleranceBps, because a round trip pays impact
     *         twice and fees twice. At a 300bps settlement tolerance and 30bps
     *         of fees each way, entry impact above roughly 120bps makes the
     *         return leg unaffordable. 100 leaves margin.
     *
     *         Set separately rather than folded into setSettlementConfig, whose
     *         five-value atomic signature is relied on by existing deployments.
     */
    uint256 public maxEntryImpactBps = 100;

    uint256 private constant YEAR = 365 days;

    /**
     * @notice Where idle loan-asset funds may be parked to earn yield.
     *
     * @dev    Deliberately an interface standard rather than a named protocol.
     *         Aave is not deployed on every chain Covenza targets, and binding
     *         to one lending market would mean re-integrating for each new
     *         venue. ERC4626 covers MetaMorpho, Yearn, and anything else that
     *         implements the standard, on any chain, with one code path.
     *
     *         None is a first-class option, not a failure state: an asset with
     *         no yield venue is still perfectly usable for lending and swaps.
     */
    enum YieldVenue { None, Aave, ERC4626 }

    struct AssetConfig {
        bool       whitelisted;
        address    aToken;       // Aave V3 aToken for this asset (address(0) = no Aave support)
        YieldVenue venue;
        address    venueAddress; // ERC-4626 vault address; unused for Aave (which uses aavePool)
        RiskTier   tier;
        // Per-asset EXTENSION to the global swap-back grace, in seconds.
        // Only ever lengthens it — see gracePeriodOf(). Exists for assets that
        // are not continuously tradeable: tokenised equities trade 24/5, so a
        // vault holding one whose deadline falls on a Friday cannot be forced
        // out until markets reopen, and thin weekend liquidity is exactly when
        // a forced swap-back would breach the TWAP tolerance and revert.
        uint256    gracePeriod;
    }

    mapping(address => AssetConfig) public assetConfig;

    /// @notice Enumerable list of every asset ever added (whitelisted or
    ///         since removed) — removal flips the flag but keeps the entry,
    ///         so historical vaults can still look up aToken addresses.
    address[] public allAssets;
    mapping(address => bool) private _everAdded;

    // --- Events ---

    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event AssetAdded(address indexed asset, address indexed aToken);
    event AssetRemoved(address indexed asset);
    event VenueUpdated(address indexed asset, YieldVenue venue, address venueAddress);
    event GracePeriodUpdated(address indexed asset, uint256 gracePeriod);
    event TierUpdated(address indexed asset, RiskTier tier);
    event TierConfigUpdated(RiskTier indexed tier, uint256 assumedVolBps, uint256 minDepositBps,
        uint256 maxTermSeconds, uint256 maxExposureBps, uint256 insurancePremiumBps);
    event DepositCoeffUpdated(uint256 previousBps, uint256 newBps);
    event IntegrationAddressesUpdated(
        address aavePool,
        address swapRouter,
        address uniswapFactory,
        address weth
    );

    event SettlementConfigUpdated(
        uint32  twapWindow,
        uint256 twapToleranceBps,
        uint256 swapBackGracePeriod,
        uint256 bountyRatePerHourBps,
        uint256 bountyCapBps
    );

    // --- Constructor ---

    constructor(
        address _operator,
        address _aavePool,
        address _swapRouter,
        address _uniswapFactory,
        address _weth
    ) {
        require(_operator != address(0),       "Invalid operator address");
        require(_aavePool != address(0),       "Invalid Aave pool address");
        require(_swapRouter != address(0),     "Invalid swap router address");
        require(_uniswapFactory != address(0), "Invalid Uniswap factory address");
        require(_weth != address(0),           "Invalid WETH address");

        operator       = _operator;
        aavePool       = _aavePool;
        swapRouter     = _swapRouter;
        uniswapFactory = _uniswapFactory;
        weth           = _weth;

        emit OperatorUpdated(address(0), _operator);
        emit IntegrationAddressesUpdated(_aavePool, _swapRouter, _uniswapFactory, _weth);

        // Launch defaults. Volatilities are placeholders until measured on
        // chain (see the deferred observe()-derived sigma work); everything
        // else follows from them via the model in the RiskTier comment.
        _setTierConfig(RiskTier.BlueChip,    6000, 1000, 365 days, 10000, 100);
        _setTierConfig(RiskTier.Standard,   10000, 2000,  90 days,  5000, 250);
        _setTierConfig(RiskTier.Speculative, 20000, 4000,   7 days,  2500, 600);
    }

    // --- Modifiers ---

    modifier onlyOperator() {
        require(msg.sender == operator, "Caller is not the operator");
        _;
    }

    // --- Operator functions ---

    function transferOperator(address _newOperator) external onlyOperator {
        require(_newOperator != address(0), "Invalid operator address");
        address previous = operator;
        operator = _newOperator;
        emit OperatorUpdated(previous, _newOperator);
    }

    /**
     * @notice Whitelists an asset for loan origination and swap-into use.
     * @param _asset  The ERC20 asset to whitelist.
     * @param _aToken The asset's Aave V3 aToken, or address(0) if this
     *                asset should not support Aave supply (swap-only).
     */
    function addAsset(address _asset, address _aToken) external onlyOperator {
        // An aToken implies the Aave venue; its absence implies no venue.
        // Preserved as the shorthand for the common case — addAssetWithVenue
        // is the general form.
        _addAsset(
            _asset,
            _aToken,
            _aToken == address(0) ? YieldVenue.None : YieldVenue.Aave,
            address(0),
            0
        );
    }

    /**
     * @notice Whitelists an asset, specifying its yield venue and any grace
     *         period extension explicitly.
     * @param _asset        The ERC20 asset to whitelist.
     * @param _aToken       Aave aToken, or address(0). Required when the venue
     *                      is Aave — the vault reads its position through it.
     * @param _venue        None, Aave, or ERC4626.
     * @param _venueAddress The ERC-4626 vault. Must be address(0) for other venues.
     * @param _gracePeriod  Seconds to extend the global swap-back grace by, for
     *                      this asset. Zero for continuously tradeable assets.
     */
    function addAssetWithVenue(
        address    _asset,
        address    _aToken,
        YieldVenue _venue,
        address    _venueAddress,
        uint256    _gracePeriod
    ) external onlyOperator {
        _addAsset(_asset, _aToken, _venue, _venueAddress, _gracePeriod);
    }

    function _addAsset(
        address    _asset,
        address    _aToken,
        YieldVenue _venue,
        address    _venueAddress,
        uint256    _gracePeriod
    ) internal {
        require(_asset != address(0), "Invalid asset address");
        require(!assetConfig[_asset].whitelisted, "Asset already whitelisted");
        _validateVenue(_venue, _aToken, _venueAddress);

        // Preserve any tier already assigned. Re-adding a previously removed
        // asset overwrites the whole struct, and silently resetting a
        // Speculative asset to BlueChip would quietly widen every mandate that
        // referenced it.
        RiskTier existingTier = assetConfig[_asset].tier;

        assetConfig[_asset] = AssetConfig({
            whitelisted:  true,
            aToken:       _aToken,
            venue:        _venue,
            venueAddress: _venueAddress,
            tier:         existingTier,
            gracePeriod:  _gracePeriod
        });

        if (!_everAdded[_asset]) {
            _everAdded[_asset] = true;
            allAssets.push(_asset);
        }

        // Seeds history at listing so a vault opened before any re-tag has
        // something to compare against, rather than falling through to the
        // empty-history case that trusts the current tier.
        _recordTier(_asset, existingTier);

        emit AssetAdded(_asset, _aToken);
        emit VenueUpdated(_asset, _venue, _venueAddress);
        if (_gracePeriod > 0) { emit GracePeriodUpdated(_asset, _gracePeriod); }
    }

    function _validateVenue(YieldVenue _venue, address _aToken, address _venueAddress) internal pure {
        if (_venue == YieldVenue.Aave) {
            require(_aToken != address(0),       "Aave venue requires an aToken");
            require(_venueAddress == address(0), "Aave venue takes no venue address");
        } else if (_venue == YieldVenue.ERC4626) {
            require(_venueAddress != address(0), "ERC4626 venue requires a vault address");
        } else {
            require(_venueAddress == address(0), "No venue takes no venue address");
        }
    }

    /**
     * @notice Repoints an asset's yield venue.
     *
     * @dev    SAFETY: vaults snapshot their venue at first supply and settle
     *         against that snapshot, so changing this cannot strand an
     *         in-flight position. It takes effect for vaults that have not yet
     *         supplied. Same reasoning as the fee terms being snapshotted at
     *         origination — live loans are never repriced underneath.
     */
    function setVenue(
        address    _asset,
        YieldVenue _venue,
        address    _venueAddress
    ) external onlyOperator {
        require(_everAdded[_asset], "Unknown asset");
        _validateVenue(_venue, assetConfig[_asset].aToken, _venueAddress);

        assetConfig[_asset].venue        = _venue;
        assetConfig[_asset].venueAddress = _venueAddress;

        emit VenueUpdated(_asset, _venue, _venueAddress);
    }

    /**
     * @notice Tags an asset with its risk tier.
     *
     * @dev    Separate from addAsset rather than a parameter of it, so adding
     *         the tier system does not change existing call sites. Assets
     *         default to BlueChip (enum zero) and must be tagged deliberately.
     *
     *         That default is permissive, which is a considered trade: the
     *         whitelist is already operator-curated, so nothing reaches this
     *         function without a deliberate listing decision. An untagged asset
     *         being maximally CONSTRAINED would instead mean every existing
     *         deployment silently stopped working.
     */
    function setTier(address _asset, RiskTier _tier) external onlyOperator {
        require(_everAdded[_asset], "Unknown asset");
        assetConfig[_asset].tier = _tier;
        _recordTier(_asset, _tier);
        emit TierUpdated(_asset, _tier);
    }

    /// @dev Appends to the tier history. Called wherever `tier` is written, so
    ///      history and current state cannot drift apart.
    function _recordTier(address _asset, RiskTier _tier) internal {
        TierChange[] storage h = _tierHistory[_asset];
        if (h.length > 0 && h[h.length - 1].tier == _tier) { return; }
        h.push(TierChange({ at: uint64(block.timestamp), tier: _tier }));
    }

    /**
     * @notice The riskiest tier `_asset` has held at any point from `_since`
     *         until now.
     *
     * @dev    This is what a vault must check, not the current tier. Requiring
     *         `highestTierSince(asset, originatedAt) <= maxTier` refuses an
     *         asset that was too risky when the loan was written even if it
     *         has since been re-tagged safer, and refuses one that has since
     *         been re-tagged riskier. An asset that never moved is unaffected.
     *
     *         Walks backwards and stops at the first entry that predates
     *         `_since` — that entry is the tier in force at the time, and
     *         nothing before it is relevant. Cost is proportional to the number
     *         of re-tags during the loan, which should be zero.
     *
     *         Assets whitelisted before tier history existed have an empty
     *         array; their current tier is the only truth available and is
     *         returned unchanged.
     */
    function highestTierSince(address _asset, uint256 _since)
        external view returns (RiskTier)
    {
        TierChange[] storage h = _tierHistory[_asset];
        if (h.length == 0) { return assetConfig[_asset].tier; }

        RiskTier worst = h[h.length - 1].tier;
        for (uint256 i = h.length; i > 0; i--) {
            TierChange storage c = h[i - 1];
            if (uint8(c.tier) > uint8(worst)) { worst = c.tier; }
            if (c.at <= _since) { break; }
        }
        return worst;
    }

    /// @notice How many times this asset has been re-tagged. Surfaced so an
    ///         operator can see that changing a tier is not a free action —
    ///         it constrains every loan already open against it.
    function tierHistoryLength(address _asset) external view returns (uint256) {
        return _tierHistory[_asset].length;
    }

    /// @notice Updates a tier's risk parameters. Applies to NEW loans only —
    ///         vaults snapshot what they need at origination.
    function setTierConfig(
        RiskTier _tier,
        uint256 _assumedVolBps,
        uint256 _minDepositBps,
        uint256 _maxTermSeconds,
        uint256 _maxExposureBps,
        uint256 _insurancePremiumBps
    ) external onlyOperator {
        _setTierConfig(_tier, _assumedVolBps, _minDepositBps, _maxTermSeconds,
                       _maxExposureBps, _insurancePremiumBps);
    }

    function _setTierConfig(
        RiskTier _tier,
        uint256 _assumedVolBps,
        uint256 _minDepositBps,
        uint256 _maxTermSeconds,
        uint256 _maxExposureBps,
        uint256 _insurancePremiumBps
    ) internal {
        require(_minDepositBps  <= 10000, "Deposit floor above 100%");
        require(_maxExposureBps <= 10000, "Exposure cap above 100%");
        require(_maxTermSeconds > 0,      "Max term must be nonzero");

        tierConfig[_tier] = TierConfig({
            assumedVolBps:       _assumedVolBps,
            minDepositBps:       _minDepositBps,
            maxTermSeconds:      _maxTermSeconds,
            maxExposureBps:      _maxExposureBps,
            insurancePremiumBps: _insurancePremiumBps
        });

        emit TierConfigUpdated(_tier, _assumedVolBps, _minDepositBps,
                               _maxTermSeconds, _maxExposureBps, _insurancePremiumBps);
    }

    /// @notice Updates the entry impact ceiling. Zero disables the check.
    function setMaxEntryImpactBps(uint256 _newBps) external onlyOperator {
        require(_newBps <= 1000, "Entry impact cap too loose");
        maxEntryImpactBps = _newBps;
    }

    /// @notice Updates the volatility coefficient in the deposit floor.
    function setDepositCoeffBps(uint256 _newBps) external onlyOperator {
        require(_newBps > 0 && _newBps <= 50000, "Coefficient out of range");
        uint256 previous = depositCoeffBps;
        depositCoeffBps = _newBps;
        emit DepositCoeffUpdated(previous, _newBps);
    }

    /// @notice Sets how much this asset extends the global swap-back grace by.
    function setGracePeriod(address _asset, uint256 _gracePeriod) external onlyOperator {
        require(_everAdded[_asset], "Unknown asset");
        require(_gracePeriod <= 14 days, "Grace extension too long");

        assetConfig[_asset].gracePeriod = _gracePeriod;
        emit GracePeriodUpdated(_asset, _gracePeriod);
    }

    /**
     * @notice Removes an asset from the whitelist. Blocks new loans in it
     *         and new swaps into it. Does NOT affect existing holdings —
     *         swap-back from a removed asset is always permitted (enforced
     *         vault-side), and its stored aToken address remains readable
     *         so in-flight vaults can still settle correctly.
     */
    function removeAsset(address _asset) external onlyOperator {
        require(assetConfig[_asset].whitelisted, "Asset is not whitelisted");
        assetConfig[_asset].whitelisted = false;
        emit AssetRemoved(_asset);
    }

    /// @notice Updates protocol-wide integration addresses (e.g. a router
    ///         migration). All four must be supplied — no partial updates.
    function setIntegrationAddresses(
        address _aavePool,
        address _swapRouter,
        address _uniswapFactory,
        address _weth
    ) external onlyOperator {
        require(_aavePool != address(0),       "Invalid Aave pool address");
        require(_swapRouter != address(0),     "Invalid swap router address");
        require(_uniswapFactory != address(0), "Invalid Uniswap factory address");
        require(_weth != address(0),           "Invalid WETH address");

        aavePool       = _aavePool;
        swapRouter     = _swapRouter;
        uniswapFactory = _uniswapFactory;
        weth           = _weth;

        emit IntegrationAddressesUpdated(_aavePool, _swapRouter, _uniswapFactory, _weth);
    }

    /**
     * @notice Updates the protocol-wide settlement configuration. All five
     *         values are set together — no partial updates, so every change
     *         is a deliberate, complete statement of settlement policy.
     * @param _twapWindow           TWAP averaging window in seconds (e.g. 1800 = 30 min).
     * @param _twapToleranceBps     Max deviation of swap output from TWAP-implied
     *                              value, in bps (e.g. 200 = 2%).
     * @param _swapBackGracePeriod  Post-expiry window (seconds) where only the
     *                              lender or borrower may settle a vault still
     *                              holding foreign assets.
     * @param _bountyRatePerHourBps Keeper bounty accrual rate: bps of principal
     *                              per hour past the grace period's end.
     * @param _bountyCapBps         Keeper bounty ceiling, in bps of principal.
     */
    function setSettlementConfig(
        uint32  _twapWindow,
        uint256 _twapToleranceBps,
        uint256 _swapBackGracePeriod,
        uint256 _bountyRatePerHourBps,
        uint256 _bountyCapBps
    ) external onlyOperator {
        require(_twapWindow >= 60,                    "TWAP window too short");
        require(_twapToleranceBps > 0 && _twapToleranceBps <= 1000, "Tolerance must be 1-1000 bps");
        require(_bountyCapBps <= 1000,                "Bounty cap must be <= 1000 bps");

        twapWindow           = _twapWindow;
        twapToleranceBps     = _twapToleranceBps;
        swapBackGracePeriod  = _swapBackGracePeriod;
        bountyRatePerHourBps = _bountyRatePerHourBps;
        bountyCapBps         = _bountyCapBps;

        emit SettlementConfigUpdated(_twapWindow, _twapToleranceBps, _swapBackGracePeriod, _bountyRatePerHourBps, _bountyCapBps);
    }

    // --- View functions ---

    /// @notice True if the asset is currently whitelisted.
    function isWhitelisted(address _asset) external view returns (bool) {
        return assetConfig[_asset].whitelisted;
    }

    /// @notice The Aave aToken for an asset (address(0) if none configured).
    ///         Readable even after whitelist removal, so in-flight vaults
    ///         holding a removed asset can still settle.
    function aTokenOf(address _asset) external view returns (address) {
        return assetConfig[_asset].aToken;
    }

    /// @notice The asset's yield venue and, for ERC-4626, its vault address.
    ///         Readable after whitelist removal, like aTokenOf, so in-flight
    ///         vaults can still settle.
    function venueOf(address _asset) external view returns (YieldVenue, address) {
        AssetConfig storage c = assetConfig[_asset];
        return (c.venue, c.venueAddress);
    }

    /**
     * @notice The effective swap-back grace for a vault HOLDING this asset.
     *
     * @dev    Returns the global default extended by the asset's own period —
     *         never less. Per-asset configuration can only ever lengthen the
     *         window, which is the only direction that makes sense: the reason
     *         an asset needs special handling is that it is HARDER to exit,
     *         not easier. This also means a zero value is unambiguous ("no
     *         extension") rather than overloaded to mean "inherit".
     *
     *         Note it is the HELD asset that governs, not the loan asset. The
     *         constraint being managed is the tradability of whatever the
     *         vault must force its way out of.
     */
    function gracePeriodOf(address _asset) external view returns (uint256) {
        return swapBackGracePeriod + assetConfig[_asset].gracePeriod;
    }

    /// @notice The asset's risk tier. Readable after whitelist removal, like
    ///         aTokenOf, so in-flight vaults can still settle.
    function tierOf(address _asset) external view returns (RiskTier) {
        return assetConfig[_asset].tier;
    }

    /**
     * @notice Minimum deposit for a loan of this term against this asset, in
     *         bps of principal.
     *
     *         minDeposit = max( tierFloor,  coeff × sigma × sqrt(term / year) )
     *
     * @dev    The square root is the whole point. Risk scales with sqrt(T), not
     *         T, because price movement compounds as a random walk — so a term
     *         four times longer carries only twice the volatility.
     *
     *         Worked, for a 30-day loan against a 60%-volatility asset:
     *           sqrt(30/365)               = 0.2867
     *           1.8 × 0.60 × 0.2867        = 0.3096  ->  3096 bps
     *         Against the same asset over 7 days:
     *           1.8 × 0.60 × 0.1385        = 0.1496  ->  1496 bps
     *
     *         Fixed-point handling: sqrt(term/YEAR) is computed as
     *         sqrt(term × 1e36 / YEAR), which yields the root scaled by 1e18
     *         and keeps full precision through the multiply.
     */
    function minimumDepositBpsForTier(RiskTier _tier, uint256 _termSeconds)
        public view returns (uint256)
    {
        TierConfig storage cfg = tierConfig[_tier];

        uint256 sqrtTermScaled = _sqrt((_termSeconds * 1e36) / YEAR);
        uint256 volFloor =
            (depositCoeffBps * cfg.assumedVolBps * sqrtTermScaled) / (10000 * 1e18);

        if (volFloor > 10000) { volFloor = 10000; }
        return volFloor > cfg.minDepositBps ? volFloor : cfg.minDepositBps;
    }

    /**
     * @notice The same figure for a specific asset, for display.
     *
     * @dev    NOT what governs origination. At origination the borrower has not
     *         chosen what to hold — only the ceiling they are permitted — so
     *         the binding floor comes from the vault's maxTier, not from the
     *         loan's denomination. A USDG loan that permits Speculative
     *         exposure carries Speculative risk.
     *
     *         This overload answers "what would holding THIS asset require",
     *         which is a useful thing to show a borrower and the wrong thing to
     *         enforce.
     */
    function minimumDepositBps(address _asset, uint256 _termSeconds)
        external view returns (uint256)
    {
        return minimumDepositBpsForTier(assetConfig[_asset].tier, _termSeconds);
    }

    /// @notice Longest loan permitted for a given risk ceiling.
    function maxTermForTier(RiskTier _tier) external view returns (uint256) {
        return tierConfig[_tier].maxTermSeconds;
    }

    /// @notice Longest loan permitted against this asset.
    function maxTermFor(address _asset) external view returns (uint256) {
        return tierConfig[assetConfig[_asset].tier].maxTermSeconds;
    }

    /// @notice Most of a loan's principal that may sit in this one asset.
    function maxExposureBpsFor(address _asset) external view returns (uint256) {
        return tierConfig[assetConfig[_asset].tier].maxExposureBps;
    }

    /// @notice Annualised insurance premium for holding this asset, in bps of
    ///         principal. Charged to the borrower, priced on the full term.
    function insurancePremiumBpsFor(address _asset) external view returns (uint256) {
        return tierConfig[assetConfig[_asset].tier].insurancePremiumBps;
    }

    /// @notice The same figure keyed to a risk ceiling. This is what a vault
    ///         charges, since the premium insures what the borrower MAY hold
    ///         rather than what the loan is denominated in.
    function insurancePremiumBpsForTier(RiskTier _tier) external view returns (uint256) {
        return tierConfig[_tier].insurancePremiumBps;
    }

    /// @dev Babylonian square root. Vendored rather than imported so the
    ///      registry keeps no external dependency for four lines of arithmetic.
    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    /// @notice Total number of assets ever added (including removed ones).
    function totalAssets() external view returns (uint256) {
        return allAssets.length;
    }

    /// @notice Returns only the currently-whitelisted assets.
    function getWhitelistedAssets() external view returns (address[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < allAssets.length; i++) {
            if (assetConfig[allAssets[i]].whitelisted) { count++; }
        }
        address[] memory result = new address[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < allAssets.length; i++) {
            if (assetConfig[allAssets[i]].whitelisted) {
                result[j] = allAssets[i];
                j++;
            }
        }
        return result;
    }
}
