// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Vault.sol";
import "./KYCRegistry.sol";
import "./AssetRegistry.sol";
import "./InsurancePool.sol";
import "./interfaces/IERC20.sol";

/**
 * @title VaultFactory
 * @notice Deploys per-borrower Vault contracts — Version 2.0, multi-asset.
 *
 *         Origination flow (single transaction):
 *           1. KYC gate: borrower must be verified in the KYCRegistry.
 *           2. Asset gate: the loan asset must be currently whitelisted
 *              in the AssetRegistry.
 *           3. Vault is deployed.
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
    uint256 public insuranceSkimRateBps = 2000;

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
        uint256 feeRateBps,
        uint256 insuranceSkim,
        uint256 deadline
    );

    event InsuranceSkimRateUpdated(uint256 previousBps, uint256 newBps);
    event RegistriesUpdated(address kycRegistry, address assetRegistry, address insurancePool);

    // --- Constructor ---

    constructor(address _kycRegistry, address _assetRegistry, address _insurancePool) {
        require(_kycRegistry != address(0),   "Invalid KYC registry address");
        require(_assetRegistry != address(0), "Invalid asset registry address");
        require(_insurancePool != address(0), "Invalid insurance pool address");

        kycRegistry   = KYCRegistry(_kycRegistry);
        assetRegistry = AssetRegistry(_assetRegistry);
        insurancePool = InsurancePool(_insurancePool);
        owner         = msg.sender;
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
     * @param _feeRateBps    Fixed fee rate in basis points.
     * @param _duration      Loan duration (days, or seconds if _useSeconds).
     * @param _useSeconds    True for testnet short durations.
     * @param _depositAmount Required deposit, in the same asset.
     */
    function deployVault(
        address _asset,
        address _borrower,
        uint256 _principal,
        uint256 _feeRateBps,
        uint256 _duration,
        bool    _useSeconds,
        uint256 _depositAmount
    ) external returns (address) {

        // --- Gates ---
        require(kycRegistry.isVerified(_borrower),     "Borrower is not KYC verified");
        require(assetRegistry.isWhitelisted(_asset),   "Loan asset is not whitelisted");

        // --- Basic validation ---
        require(_principal > 0,     "Principal must be greater than zero");
        require(_feeRateBps > 0,    "Fee rate must be greater than zero");
        require(_duration > 0,      "Duration must be greater than zero");
        require(_depositAmount > 0, "Deposit must be greater than zero");

        // --- Deploy vault ---
        Vault vault = new Vault(
            _asset,
            msg.sender,
            _borrower,
            _principal,
            _feeRateBps,
            _duration,
            _useSeconds,
            _depositAmount,
            address(assetRegistry),
            address(insurancePool)
        );
        address vaultAddress = address(vault);

        // --- Fund vault with principal (pulled from the lender) ---
        require(
            IERC20(_asset).transferFrom(msg.sender, vaultAddress, _principal),
            "Principal transfer failed"
        );

        // --- Insurance skim: pull from lender, fund the pool ---
        uint256 skim = quoteInsuranceSkim(_principal, _feeRateBps);
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
            _principal, _depositAmount, _feeRateBps, skim, vault.deadline()
        );

        return vaultAddress;
    }

    // --- Quoting ---

    /// @notice The insurance skim for a given principal and fee rate —
    ///         the extra amount (beyond principal) the lender must approve.
    function quoteInsuranceSkim(uint256 _principal, uint256 _feeRateBps)
        public view returns (uint256)
    {
        uint256 fee = (_principal * _feeRateBps) / 10000;
        return (fee * insuranceSkimRateBps) / 10000;
    }

    // --- Admin functions ---

    function setInsuranceSkimRateBps(uint256 _newBps) external onlyOwner {
        require(_newBps <= 10000, "Skim rate cannot exceed 100% of fee");
        uint256 previous = insuranceSkimRateBps;
        insuranceSkimRateBps = _newBps;
        emit InsuranceSkimRateUpdated(previous, _newBps);
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
