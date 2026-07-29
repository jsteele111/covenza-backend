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

        assetConfig[_asset] = AssetConfig({
            whitelisted:  true,
            aToken:       _aToken,
            venue:        _venue,
            venueAddress: _venueAddress,
            gracePeriod:  _gracePeriod
        });

        if (!_everAdded[_asset]) {
            _everAdded[_asset] = true;
            allAssets.push(_asset);
        }

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
