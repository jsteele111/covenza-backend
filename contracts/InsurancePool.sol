// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IERC20.sol";

/**
 * @title InsurancePool
 * @notice Protocol-level, per-asset insurance reserves for the Covenza
 *         lending protocol. Sits between the borrower's deposit and the
 *         lender's principal in the settlement waterfall:
 *
 *             deposit absorbs loss first
 *             --> insurance pool covers remaining shortfall (capped)
 *             --> only a true tail event reaches the lender's principal.
 *
 *         Design decisions (per the Build-Readiness Spec):
 *         - SEPARATE RESERVES PER ASSET. No cross-asset conversion at draw
 *           time — an asset's shortfall draws only from that asset's own
 *           reserve. Converting between assets at the moment of a draw
 *           would require pricing that conversion, reintroducing exactly
 *           the oracle dependency the protocol is designed to avoid.
 *         - FUNDED AT ORIGINATION. A defined percentage of each loan's fee
 *           is skimmed into the relevant asset's reserve when the loan is
 *           created (routed here by the VaultFactory).
 *         - DRAW CAP AS % OF LOAN PRINCIPAL. Not a flat amount (doesn't
 *           scale with loan size) and not a % of the pool's own balance
 *           (the cap would silently shrink exactly when the pool is most
 *           depleted). Enforced here, on every draw.
 *         - NO REHYPOTHECATION. Idle reserves sit in this contract as
 *           plain ERC20 balances. They are never lent, staked, or supplied
 *           anywhere — deliberately zero additional integration surface
 *           before audit.
 *         - OPERATOR-ONLY ADMINISTRATION. Same trust pattern as
 *           KYCRegistry: a single operator address governs configuration
 *           and any withdrawal outside of automatic settlement draws.
 *
 *         Only vaults registered by the authorised VaultFactory may draw.
 *         Vault code is trusted by construction — vaults are only ever
 *         deployed by the factory, which registers them here at creation.
 */

contract InsurancePool {

    // --- State variables ---

    address public operator;        // governs configuration and admin withdrawal
    address public vaultFactory;    // the only address allowed to register vaults

    /// @notice Reserve balance held per asset. This is the source of truth
    ///         for coverage — always read this, not the raw token balance
    ///         (tokens accidentally sent directly to this contract without
    ///         going through fund() are not counted as reserves).
    mapping(address => uint256) public reserveOf;

    /// @notice Vaults registered by the factory and permitted to draw.
    mapping(address => bool) public isRegisteredVault;

    /// @notice Maximum draw per settlement, expressed in basis points of
    ///         the loan's principal (e.g. 1000 = 10% of principal).
    uint256 public drawCapBps;

    // --- Events ---

    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event VaultFactoryUpdated(address indexed previousFactory, address indexed newFactory);
    event DrawCapUpdated(uint256 previousBps, uint256 newBps);
    event VaultRegistered(address indexed vault);
    event Funded(address indexed asset, address indexed from, uint256 amount);
    event Drawn(address indexed asset, address indexed vault, uint256 requested, uint256 paid);
    event AdminWithdrawal(address indexed asset, address indexed to, uint256 amount);

    // --- Constructor ---

    /**
     * @param _operator   Address authorised to configure the pool and perform
     *                    administrative withdrawals. In production, a multisig.
     * @param _drawCapBps Initial per-settlement draw cap in basis points of
     *                    loan principal. NOTE: deliberately configurable —
     *                    the launch value should be calibrated against the
     *                    VaR deposit-sizing data once it exists, not chosen
     *                    arbitrarily (see Build-Readiness Spec section 6).
     */
    constructor(address _operator, uint256 _drawCapBps) {
        require(_operator != address(0), "Invalid operator address");
        require(_drawCapBps > 0 && _drawCapBps <= 10000, "Draw cap must be 1-10000 bps");
        operator   = _operator;
        drawCapBps = _drawCapBps;
        emit OperatorUpdated(address(0), _operator);
        emit DrawCapUpdated(0, _drawCapBps);
    }

    // --- Modifiers ---

    modifier onlyOperator() {
        require(msg.sender == operator, "Caller is not the operator");
        _;
    }

    // --- Configuration (operator-only) ---

    /// @notice Transfers the operator role. Mirrors KYCRegistry's pattern.
    function transferOperator(address _newOperator) external onlyOperator {
        require(_newOperator != address(0), "Invalid operator address");
        address previous = operator;
        operator = _newOperator;
        emit OperatorUpdated(previous, _newOperator);
    }

    /**
     * @notice Sets the VaultFactory allowed to register vaults. Must be set
     *         once after deployment (factory and pool reference each other,
     *         so one must be deployed first and wired to the other).
     */
    function setVaultFactory(address _factory) external onlyOperator {
        require(_factory != address(0), "Invalid factory address");
        address previous = vaultFactory;
        vaultFactory = _factory;
        emit VaultFactoryUpdated(previous, _factory);
    }

    /// @notice Updates the per-settlement draw cap (bps of loan principal).
    function setDrawCapBps(uint256 _newBps) external onlyOperator {
        require(_newBps > 0 && _newBps <= 10000, "Draw cap must be 1-10000 bps");
        uint256 previous = drawCapBps;
        drawCapBps = _newBps;
        emit DrawCapUpdated(previous, _newBps);
    }

    // --- Vault registration (factory-only) ---

    /// @notice Registers a newly deployed vault as permitted to draw.
    ///         Called by the VaultFactory at vault creation.
    function registerVault(address _vault) external {
        require(msg.sender == vaultFactory, "Only factory can register vaults");
        require(_vault != address(0), "Invalid vault address");
        isRegisteredVault[_vault] = true;
        emit VaultRegistered(_vault);
    }

    // --- Funding ---

    /**
     * @notice Adds funds to an asset's reserve. Caller must have approved
     *         this contract for `amount` of `asset` first. Called by the
     *         VaultFactory at origination (the fee skim), but deliberately
     *         permissionless — anyone may top up a reserve voluntarily.
     * @param asset  The ERC20 asset being contributed.
     * @param amount The amount to contribute.
     */
    function fund(address asset, uint256 amount) external {
        require(asset != address(0), "Invalid asset");
        require(amount > 0, "Amount must be greater than zero");

        bool ok = IERC20(asset).transferFrom(msg.sender, address(this), amount);
        require(ok, "Funding transfer failed");

        reserveOf[asset] += amount;
        emit Funded(asset, msg.sender, amount);
    }

    // --- Drawing (registered vaults only) ---

    /**
     * @notice Draws from an asset's reserve to cover a settlement shortfall.
     *         Called by a registered vault during settle(), after the
     *         borrower's deposit has been fully consumed by a loss.
     *
     *         The amount actually paid is the smallest of:
     *           1. the requested shortfall,
     *           2. the draw cap (drawCapBps of the loan's principal),
     *           3. the asset's current reserve balance.
     *
     *         Never reverts for lack of funds — pays what it can and reports
     *         the actual amount, so settlement always completes. The pool
     *         reduces the probability and size of lender-impacted losses;
     *         it does not and cannot eliminate them (see UI disclosure
     *         requirements in the Build-Readiness Spec).
     *
     * @param asset     The loan's denomination asset.
     * @param shortfall The uncovered loss remaining after the deposit.
     * @param principal The loan's principal (basis for the draw cap).
     * @return paid     The amount actually transferred to the vault.
     */
    function draw(
        address asset,
        uint256 shortfall,
        uint256 principal
    ) external returns (uint256 paid) {
        require(isRegisteredVault[msg.sender], "Only registered vaults can draw");
        require(asset != address(0), "Invalid asset");
        require(shortfall > 0, "Shortfall must be greater than zero");

        uint256 cap = (principal * drawCapBps) / 10000;

        paid = shortfall;
        if (paid > cap)               { paid = cap; }
        if (paid > reserveOf[asset])  { paid = reserveOf[asset]; }

        if (paid > 0) {
            reserveOf[asset] -= paid;
            bool ok = IERC20(asset).transfer(msg.sender, paid);
            require(ok, "Draw transfer failed");
        }

        emit Drawn(asset, msg.sender, shortfall, paid);
    }

    // --- Administrative withdrawal (operator-only) ---

    /**
     * @notice Withdraws reserves outside of automatic settlement draws —
     *         e.g. if a reserve has grown large relative to outstanding
     *         risk. Operator-only, per the agreed governance model.
     */
    function adminWithdraw(address asset, address to, uint256 amount) external onlyOperator {
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be greater than zero");
        require(amount <= reserveOf[asset], "Amount exceeds reserve");

        reserveOf[asset] -= amount;
        bool ok = IERC20(asset).transfer(to, amount);
        require(ok, "Withdrawal transfer failed");

        emit AdminWithdrawal(asset, to, amount);
    }
}
