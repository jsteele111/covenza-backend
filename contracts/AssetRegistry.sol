// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./OperatorControlled.sol";
import "./Timelocked.sol";
import "./libraries/UniswapTwap.sol"; // IUniswapV3Factory, for pool-existence checks

/**
 * @title AssetRegistry
 * @notice Protocol-level, operator-controlled asset whitelist and
 *         settlement configuration for the Covenza lending protocol.
 *
 *         This closes the NFR-6 gap ("whitelist configurable without
 *         redeploying in-flight vaults"): vaults read this registry LIVE
 *         at the moment of each action, so an operator whitelist change
 *         takes effect immediately across every vault, past and present,
 *         with no redeployment.
 *
 *         Per asset, the registry stores:
 *           - whether it is currently whitelisted (loans may be originated
 *             in it; borrowers may swap INTO it),
 *           - its risk tier (with history), and
 *           - any extension to the swap-back grace period.
 *
 *         It also stores the Uniswap V3 SwapRouter and Factory, giving every
 *         vault one place to read integration config from. These are
 *         immutable: fixed at deployment, never repointable.
 *
 *         IMPORTANT SAFETY RULE (enforced in Vault, documented here):
 *         removing an asset from the whitelist blocks NEW exposure to it
 *         (no new loans in it, no new swaps into it) — but swaps BACK from
 *         it to a vault's loan asset are always permitted regardless of
 *         whitelist status. A whitelist removal must never strand a
 *         borrower who is already holding the removed asset mid-loan.
 *
 *         LISTING RULE (MAINNET-READINESS item 15): never list a
 *         fee-on-transfer or rebasing token. Every amount the protocol
 *         records (principal, deposit, held amounts, reserves) assumes a
 *         transfer delivers exactly what was sent and that balances do not
 *         change by themselves. Tokens that return no data from transfer
 *         (USDT-style) ARE supported, via SafeTransfer. A tokenised equity
 *         whose issuer can pause or freeze transfers may be listed, but see
 *         item 14 for what that does to settlement.
 */
contract AssetRegistry is OperatorControlled, Timelocked {

    // --- State variables ---

    // Protocol-wide integration addresses. IMMUTABLE — fixed at deployment.
    //
    // They were previously operator-updatable, instantly, "in case of e.g. a
    // router migration". Vaults read swapRouter and uniswapFactory LIVE at
    // every swap and at settlement, and trust the router to enforce the
    // minimum output they pass it. A repointed router could therefore take a
    // vault's held assets during settlement, and a repointed factory could
    // serve the TWAP from a pool of the operator's choosing — against every
    // open loan at once, with no delay. Found in the 1 October 2026 pre-audit
    // review; the same class of power as setRegistries, which was already
    // timelocked, but with no timelock at all.
    //
    // Fixing them is stronger than delaying them, and costs little: a router
    // migration now means deploying a new AssetRegistry and moving the factory
    // to it through VaultFactory's timelocked setRegistries. Vaults hold their
    // own registry reference, so live loans keep the integrations they were
    // originated against and can never be repointed underneath.
    address public immutable swapRouter;     // Uniswap V3 SwapRouter02
    address public immutable uniswapFactory; // Uniswap V3 Factory (for TWAP pool lookups)

    // --- Settlement configuration (protocol-wide, operator-configurable) ---
    // Launch values below are placeholders pending empirical calibration
    // (Build-Readiness Spec section 6) — deliberately settable post-deploy.

    uint32  public twapWindow          = 1800;  // 30 min TWAP window for forced swap-back pricing
    uint256 public twapToleranceBps    = 200;   // swap output must be within 2% of TWAP-implied value
    uint256 public constant MAX_GRACE_EXTENSION = 14 days; // per-asset extension cap, at listing and on change
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

    struct AssetConfig {
        bool       whitelisted;
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

    /**
     * @notice The ONE Uniswap V3 fee tier a vault may trade each pair
     *         through. Zero means no approved pool: swaps in that pair are
     *         refused. Stored symmetrically, so (a, b) and (b, a) agree.
     *
     * @dev    WHY THE PROTOCOL CHOOSES THE POOL, NOT THE BORROWER. Every
     *         pair can exist at several fee tiers, and before this the
     *         borrower named the tier on each swap. That let them pick the
     *         pool their own settlement would be forced through. KRAIT-003
     *         (MAINNET-READINESS item 20): build a position in a deep pool,
     *         then a dust swap through a thin pool (possibly their own)
     *         re-pointed the whole exit at it, settlement missed the TWAP
     *         floor and reverted, and the borrower held a free option on a
     *         non-liquidating loan. Pinning the first tier a vault used would
     *         not fix it: the borrower could simply make the thin pool the
     *         first. Naming the pool here means a borrower who wants to stall
     *         settlement must dominate the liquidity of the protocol's chosen
     *         public pool, which is costly and visible.
     *
     *         Vaults record the tier at entry and keep it while the position
     *         is open, so changing this affects new positions only. Changing
     *         an existing choice waits on the timelock (item 12).
     */
    mapping(address => mapping(address => uint24)) private _poolFeeTier;

    // --- Sequencer outages (MAINNET-READINESS item 16) ---
    //
    // Robinhood Chain has a single sequencer. While it is down nothing can be
    // included, but the clock runs on, and block.timestamp jumps forward when
    // it returns. Settlement access is purely time-based, so an outage across
    // a vault's deadline and grace window silently consumed the parties'
    // protected window and let keepers force a sale, with a bounty already
    // accrued, the moment the chain came back.
    //
    // A contract cannot see a gap in block production directly, so the
    // registry keeps a heartbeat. Anyone may call heartbeat(); an off-chain
    // bot calls it every few minutes and every settle() calls it first. A gap
    // between heartbeats longer than outageGapThreshold is recorded as an
    // outage. Vaults then extend their grace by the outage time that fell in
    // it (capped at maxGraceExtension), keepers wait recoveryPeriod after any
    // outage ends, and the keeper bounty accrues only from the later of the
    // two. A missed heartbeat that was NOT an outage costs only time: the
    // parties get longer, keepers wait. The parties are never held back.

    struct Outage { uint64 start; uint64 end; }
    Outage[] internal _outages;

    uint256 public lastHeartbeat;
    uint256 public outageGapThreshold = 30 minutes; // zero disables detection
    uint256 public recoveryPeriod     = 1 hours;
    uint256 public maxGraceExtension  = 72 hours;

    /// @notice Enumerable list of every asset ever added (whitelisted or
    ///         since removed) — removal flips the flag but keeps the entry,
    ///         so its tier history and grace stay readable for open loans.
    address[] public allAssets;
    mapping(address => bool) private _everAdded;

    // --- Events ---

    event AssetAdded(address indexed asset);
    event AssetRemoved(address indexed asset);
    event GracePeriodUpdated(address indexed asset, uint256 gracePeriod);
    event PoolFeeTierUpdated(address indexed tokenA, address indexed tokenB, uint24 fee);
    event OutageRecorded(uint256 start, uint256 end);
    event OutageConfigUpdated(uint256 gapThreshold, uint256 recoveryPeriod, uint256 maxGraceExtension);
    event TierUpdated(address indexed asset, RiskTier tier);
    event TierConfigUpdated(RiskTier indexed tier, uint256 assumedVolBps, uint256 minDepositBps,
        uint256 maxTermSeconds, uint256 maxExposureBps, uint256 insurancePremiumBps);
    event DepositCoeffUpdated(uint256 previousBps, uint256 newBps);
    event MaxEntryImpactUpdated(uint256 previousBps, uint256 newBps);
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
        address _swapRouter,
        address _uniswapFactory,
        uint256 _timelockDelay
    ) OperatorControlled(_operator) Timelocked(_timelockDelay) {
        require(_swapRouter != address(0),     "Invalid swap router address");
        require(_uniswapFactory != address(0), "Invalid Uniswap factory address");

        swapRouter     = _swapRouter;
        uniswapFactory = _uniswapFactory;

        lastHeartbeat = block.timestamp;

        // Launch defaults. Volatilities are placeholders until measured on
        // chain (see the deferred observe()-derived sigma work); everything
        // else follows from them via the model in the RiskTier comment.
        _setTierConfig(RiskTier.BlueChip,    6000, 1000, 365 days, 10000, 100);
        _setTierConfig(RiskTier.Standard,   10000, 2000,  90 days,  5000, 250);
        _setTierConfig(RiskTier.Speculative, 20000, 4000,   7 days,  2500, 600);
    }

    // --- Operator functions ---

    /**
     * @notice Whitelists an asset for loan origination and swap-into use.
     *         A never-seen asset starts at Speculative; a re-listed one keeps
     *         the tier it had.
     * @param _asset        The ERC20 asset to whitelist.
     * @param _gracePeriod  Seconds to extend the global swap-back grace by, for
     *                      this asset. Zero for continuously tradeable assets.
     */
    function addAsset(address _asset, uint256 _gracePeriod) external onlyOperator {
        _addAsset(_asset, _gracePeriod);
        _recordTier(_asset, assetConfig[_asset].tier);
    }

    /**
     * @notice Whitelists an asset AND assigns its tier in one transaction.
     *
     * @dev    Listing then tagging in two transactions leaves the asset
     *         carrying the default tier in between. Observed on testnet:
     *         listing an equity produced two tier-history entries, the first
     *         of them a tier nobody intended. This is the path an operator
     *         should use; addAsset remains for leaving the tier at its default.
     */
    function addAssetWithTier(address _asset, uint256 _gracePeriod, RiskTier _tier) external onlyOperator {
        _addAsset(_asset, _gracePeriod);
        assetConfig[_asset].tier = _tier;

        // Recorded once, here, rather than inside _addAsset. Recording the
        // default first and the real tier on top left every listing carrying a
        // phantom Speculative entry it was never at — same block, so no loan
        // could read it, but the history is what a lender audits and it should
        // say what happened.
        _recordTier(_asset, _tier);
        emit TierUpdated(_asset, _tier);
    }

    function _addAsset(address _asset, uint256 _gracePeriod) internal {
        require(_asset != address(0), "Invalid asset address");
        require(!assetConfig[_asset].whitelisted, "Asset already whitelisted");
        require(_gracePeriod <= MAX_GRACE_EXTENSION, "Grace extension too long");

        // Re-listing a removed asset is not a fresh start: vaults may still
        // hold it (swap-back is always allowed), so its grace extension
        // reaches live loans. Without this, remove-then-re-add changed it
        // instantly, around the timelock on setGracePeriod. Re-listing on the
        // same terms stays instant.
        if (_everAdded[_asset] && _gracePeriod != assetConfig[_asset].gracePeriod) {
            _consumeIfDelayed(keccak256(msg.data));
        }

        // Preserve any tier already assigned. Re-adding a previously removed
        // asset overwrites the whole struct, and silently resetting a
        // Speculative asset to BlueChip would quietly widen every mandate that
        // referenced it.
        //
        // A NEVER-SEEN asset defaults to Speculative, not BlueChip. The enum's
        // zero value is BlueChip, which made "unassessed" and "safest" the
        // same state — so an asset nobody had evaluated was admitted to every
        // vault including the most conservative. Unknown should be the most
        // constrained position, and relaxing it should take a deliberate act.
        RiskTier existingTier = _everAdded[_asset]
            ? assetConfig[_asset].tier
            : RiskTier.Speculative;

        assetConfig[_asset] = AssetConfig({
            whitelisted:  true,
            tier:         existingTier,
            gracePeriod:  _gracePeriod
        });

        if (!_everAdded[_asset]) {
            _everAdded[_asset] = true;
            allAssets.push(_asset);
        }

        // History is seeded by the CALLER, not here, so that a listing which
        // assigns a tier writes one entry rather than two. Every public path
        // into this function must record — a listing with no history falls
        // through to the empty-history case, which trusts the current tier and
        // would let a re-tag widen a live loan.
        emit AssetAdded(_asset);
        if (_gracePeriod > 0) { emit GracePeriodUpdated(_asset, _gracePeriod); }
    }

    /**
     * @notice Tags an asset with its risk tier.
     *
     * @dev    An asset listed without a tier defaults to Speculative, the
     *         most constrained tier; relaxing it takes this deliberate call.
     *         (An earlier version of this comment said BlueChip. It was
     *         changed, see _addAsset.)
     *
     *         Instant in both directions. A loan checks the WORST tier an asset
     *         has held since origination, for both its risk ceiling and its
     *         exposure cap, so re-tagging an asset safer cannot loosen a loan
     *         that is already open, and re-tagging it riskier tightens it.
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
        public view returns (RiskTier)
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

    /**
     * @notice Updates a tier's risk parameters.
     * @dev    Most of these are read only at origination (deposit floor, term
     *         limit, premium), so changing them affects new loans only. The
     *         EXPOSURE CAP is different: open vaults read it on every swap.
     *         (This comment previously said "applies to NEW loans only", which
     *         was not true of the cap; MAINNET-READINESS item 12.) Raising a
     *         cap therefore waits on the timelock; lowering one is instant.
     */
    function setTierConfig(
        RiskTier _tier,
        uint256 _assumedVolBps,
        uint256 _minDepositBps,
        uint256 _maxTermSeconds,
        uint256 _maxExposureBps,
        uint256 _insurancePremiumBps
    ) external onlyOperator {
        if (_maxExposureBps > tierConfig[_tier].maxExposureBps) {
            _consumeIfDelayed(keccak256(msg.data));
        }
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
    /// @dev    Loosening (a higher ceiling, or zero, which switches the check
    ///         off) waits on the timelock: open vaults apply it to their next
    ///         swap. Tightening is instant.
    function setMaxEntryImpactBps(uint256 _newBps) external onlyOperator {
        require(_newBps <= 1000, "Entry impact cap too loose");
        if (_newBps == 0 || (maxEntryImpactBps != 0 && _newBps > maxEntryImpactBps)) {
            _consumeIfDelayed(keccak256(msg.data));
        }
        emit MaxEntryImpactUpdated(maxEntryImpactBps, _newBps);
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
    /// @dev    Timelocked in BOTH directions (item 12), like the global grace in
    ///         setSettlementConfig. The extension is read at settlement, not
    ///         snapshotted, because which assets a vault holds is only known at
    ///         expiry. So a change reaches every live loan holding the asset:
    ///         shortening it cuts the borrower's window to exit at a fair
    ///         price, and lengthening it holds keepers, and the lender's
    ///         recovery, off for longer. The delay gives both sides warning.
    function setGracePeriod(address _asset, uint256 _gracePeriod) external onlyOperator {
        require(_everAdded[_asset], "Unknown asset");
        require(_gracePeriod <= MAX_GRACE_EXTENSION, "Grace extension too long");
        _consumeIfDelayed(keccak256(msg.data));

        assetConfig[_asset].gracePeriod = _gracePeriod;
        emit GracePeriodUpdated(_asset, _gracePeriod);
    }

    /**
     * @notice Names the Uniswap V3 pool (by fee tier) vaults must use for a
     *         pair. Both assets must be whitelisted and the pool must exist.
     */
    function setPoolFeeTier(address _tokenA, address _tokenB, uint24 _fee) external onlyOperator {
        require(_tokenA != _tokenB, "Identical tokens");
        require(
            assetConfig[_tokenA].whitelisted && assetConfig[_tokenB].whitelisted,
            "Asset not whitelisted"
        );
        require(
            IUniswapV3Factory(uniswapFactory).getPool(_tokenA, _tokenB, _fee) != address(0),
            "No pool at this fee tier"
        );

        // Naming the first pool for a pair is instant: no position can exist
        // in a pair with no approved pool. Changing it waits.
        if (_poolFeeTier[_tokenA][_tokenB] != 0) { _consumeIfDelayed(keccak256(msg.data)); }

        _poolFeeTier[_tokenA][_tokenB] = _fee;
        _poolFeeTier[_tokenB][_tokenA] = _fee;
        emit PoolFeeTierUpdated(_tokenA, _tokenB, _fee);
    }

    /// @notice The approved fee tier for a pair, or zero if none.
    function poolFeeTier(address _tokenA, address _tokenB) external view returns (uint24) {
        return _poolFeeTier[_tokenA][_tokenB];
    }

    /**
     * @notice Removes an asset from the whitelist. Blocks new loans in it
     *         and new swaps into it. Does NOT affect existing holdings —
     *         swap-back from a removed asset is always permitted (enforced
     *         vault-side), and its tier history and grace extension stay
     *         readable so in-flight vaults still settle correctly.
     */
    function removeAsset(address _asset) external onlyOperator {
        require(assetConfig[_asset].whitelisted, "Asset is not whitelisted");
        assetConfig[_asset].whitelisted = false;
        emit AssetRemoved(_asset);
    }

    // setIntegrationAddresses() was removed on 1 October 2026. See the comment
    // on the integration addresses above for why, and for the migration path.

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
        // Upper limits (audit L-2). An unbounded window longer than any pool's
        // history makes every quote revert, which freezes every swap and every
        // forced exit at once; an unbounded grace postpones keepers for ever.
        require(_twapWindow <= 1 days,                "TWAP window too long");
        require(_swapBackGracePeriod <= 7 days,       "Grace period too long");
        require(_bountyRatePerHourBps <= 10000,       "Bounty rate too high");
        // The rule setOutageConfig enforces, checked from this side too: after
        // an outage the TWAP is stale for a full window, so keepers must be
        // held off at least that long. Without this, widening the window here
        // quietly broke it.
        require(outageGapThreshold == 0 || _twapWindow <= recoveryPeriod,
            "TWAP window longer than the outage recovery period");

        // Every one of these is read by open vaults at settlement, and every
        // direction hurts someone: a wider tolerance or longer grace costs
        // the lender, a higher bounty costs the borrower, a shorter window is
        // easier to manipulate. So all changes wait (item 12).
        _consumeIfDelayed(keccak256(msg.data));

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

    /// @notice The asset's risk tier. Readable after whitelist removal, so
    ///         in-flight vaults can still settle.
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

    /// @notice Longest loan permitted for a given risk ceiling.
    function maxTermForTier(RiskTier _tier) external view returns (uint256) {
        return tierConfig[_tier].maxTermSeconds;
    }

    /// @notice The exposure cap a loan written at `_since` must apply to
    ///         `_asset`: the cap of the riskiest tier the asset has held since
    ///         then. Krait observation: reading the CURRENT tier meant
    ///         re-tagging an asset safer loosened the cap on loans already open.
    function maxExposureBpsSince(address _asset, uint256 _since) external view returns (uint256) {
        return tierConfig[highestTierSince(_asset, _since)].maxExposureBps;
    }

    /**
     * @notice Records that the chain is live. Callable by anyone; costs only
     *         gas. If the previous heartbeat is older than the gap threshold,
     *         the silence between them is recorded as an outage.
     */
    function heartbeat() external {
        uint256 last = lastHeartbeat;
        if (outageGapThreshold != 0 && block.timestamp > last + outageGapThreshold) {
            _outages.push(Outage({ start: uint64(last), end: uint64(block.timestamp) }));
            emit OutageRecorded(last, block.timestamp);
        }
        lastHeartbeat = block.timestamp;
    }

    /**
     * @notice The settlement window a vault is actually entitled to, given the
     *         outages recorded so far.
     * @param  _deadline  The loan's deadline.
     * @param  _graceEnd  The grace end before any extension.
     * @return graceEnd   `_graceEnd` extended by the outage time that fell after
     *                    the deadline and within the (extended) window, capped
     *                    at maxGraceExtension.
     * @return keeperFrom The earliest moment a keeper may settle: the extended
     *                    grace end, or the end of the latest outage plus the
     *                    recovery period, whichever is later. The keeper bounty
     *                    accrues from here.
     *
     * @dev    Only outages that end after the deadline and start before
     *         `_graceEnd + maxGraceExtension` (the horizon) can extend the
     *         window. Outages are recorded in time order and never overlap, so
     *         these form one contiguous run: a binary search finds where the run
     *         ends, and the walk goes backwards from there, stopping at the first
     *         outage that ended on or before the deadline. Cost is logarithmic in
     *         the outages recorded after the horizon (audit L-4).
     */
    function settlementWindow(uint256 _deadline, uint256 _graceEnd)
        external view returns (uint256 graceEnd, uint256 keeperFrom)
    {
        uint256 ext;
        uint256 n = _outages.length;
        uint256 horizon = _graceEnd + maxGraceExtension;

        // First outage starting at or after the horizon (or n if none).
        uint256 lo = 0;
        uint256 hi = n;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_outages[mid].start < horizon) { lo = mid + 1; } else { hi = mid; }
        }
        for (uint256 i = lo; i > 0; i--) {
            Outage storage o = _outages[i - 1];
            if (o.end <= _deadline) { break; }
            ext += o.end - (o.start > _deadline ? o.start : _deadline);
        }
        if (ext > maxGraceExtension) { ext = maxGraceExtension; }
        graceEnd = _graceEnd + ext;

        keeperFrom = graceEnd;
        if (n > 0) {
            uint256 recovered = uint256(_outages[n - 1].end) + recoveryPeriod;
            if (recovered > keeperFrom) { keeperFrom = recovered; }
        }
    }

    /// @notice Number of outages recorded.
    function outageCount() external view returns (uint256) { return _outages.length; }

    /// @notice One recorded outage.
    function outageAt(uint256 _i) external view returns (uint256 start, uint256 end) {
        Outage storage o = _outages[_i];
        return (o.start, o.end);
    }

    /**
     * @notice Sets outage detection. A zero gap threshold disables it (all
     *         three must then be zero). Timelocked in every direction: each
     *         value moves time between the parties and the keepers on loans
     *         already open.
     * @dev    The recovery period may not be shorter than the TWAP window.
     *         During an outage nothing trades, so the TWAP is frozen at the
     *         pre-outage price; it needs a full window after restart before it
     *         reflects the market a forced sale will meet.
     */
    function setOutageConfig(uint256 _gapThreshold, uint256 _recoveryPeriod, uint256 _maxGraceExtension)
        external onlyOperator
    {
        if (_gapThreshold == 0) {
            require(_recoveryPeriod == 0 && _maxGraceExtension == 0, "Disable all three together");
        } else {
            require(_gapThreshold >= 5 minutes,       "Gap threshold too short");
            require(_recoveryPeriod >= twapWindow,    "Recovery shorter than the TWAP window");
            require(_recoveryPeriod <= 1 days,        "Recovery period too long");
            require(_maxGraceExtension <= 7 days,     "Extension cap too long");
        }
        _consumeIfDelayed(keccak256(msg.data));

        outageGapThreshold = _gapThreshold;
        recoveryPeriod     = _recoveryPeriod;
        maxGraceExtension  = _maxGraceExtension;
        emit OutageConfigUpdated(_gapThreshold, _recoveryPeriod, _maxGraceExtension);
    }

    /// @notice Announces a timelocked change. `_id` is keccak256 of the exact
    ///         calldata of the setter call that will follow, so the
    ///         announcement authorises those arguments and no others.
    function queueAction(bytes32 _id) external onlyOperator { _queue(_id); }

    /// @notice Abandons an announced change. Instant: it reduces risk.
    function cancelAction(bytes32 _id) external onlyOperator { _cancel(_id); }

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
