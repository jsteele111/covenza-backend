// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Vault.sol";
import "./KYCRegistry.sol";

/**
 * @title VaultFactory
 * @notice Deploys per-borrower Vault contracts, gated behind KYC verification.
 *
 *         No vault can be deployed unless:
 *         (1) the borrower address is marked as verified in the KYCRegistry, AND
 *         (2) the lender sends the principal as msg.value.
 *
 *         This contract is the single entry point for loan origination.
 *         Direct Vault deployment (bypassing this factory) would skip the
 *         KYC check — in production the factory address would be the only
 *         authorised deployer, enforced at the protocol governance level.
 */
contract VaultFactory {

    // --- State variables ---

    KYCRegistry public registry;   // KYC registry contract
    address     public owner;      // protocol owner (can update registry)

    // --- Vault tracking ---

    /// @notice All vaults deployed by this factory.
    address[] public allVaults;

    /// @notice Vaults deployed for a specific borrower address.
    mapping(address => address[]) public vaultsByBorrower;

    /// @notice Vaults deployed by a specific lender address.
    mapping(address => address[]) public vaultsByLender;

    // --- Events ---

    event VaultDeployed(
        address indexed vault,
        address indexed lender,
        address indexed borrower,
        uint256 principal,
        uint256 depositRequired,
        uint256 deadline
    );

    event RegistryUpdated(
        address indexed previousRegistry,
        address indexed newRegistry
    );

    // --- Constructor ---

    /**
     * @param _registry Address of the deployed KYCRegistry contract.
     */
    constructor(address _registry) {
        require(_registry != address(0), "Invalid registry address");
        registry = KYCRegistry(_registry);
        owner    = msg.sender;
    }

    // --- Modifiers ---

    modifier onlyOwner() {
        require(msg.sender == owner, "Caller is not the owner");
        _;
    }

    // --- Core function ---

    /**
     * @notice Deploys a new Vault for a verified borrower.
     *         Lender sends principal as msg.value.
     *
     * @param _borrower      Borrower's wallet address — must be KYC verified.
     * @param _repaymentDue  Total repayment amount (principal + fee).
     * @param _duration      Loan duration (in days if _useSeconds=false).
     * @param _useSeconds    True for testnet short durations, false for production.
     * @param _depositAmount Required deposit the borrower must pay to activate.
     */
    function deployVault(
        address _borrower,
        uint256 _repaymentDue,
        uint256 _duration,
        bool    _useSeconds,
        uint256 _depositAmount
    ) external payable returns (address) {

        // --- KYC gate ---
        require(
            registry.isVerified(_borrower),
            "Borrower is not KYC verified"
        );

        // --- Basic validation ---
        require(msg.value > 0,              "Principal must be greater than zero");
        require(_repaymentDue >= msg.value, "Repayment must be >= principal");
        require(_duration > 0,              "Duration must be greater than zero");
        require(_depositAmount > 0,         "Deposit must be greater than zero");

        // --- Deploy vault ---
        Vault vault = new Vault{value: msg.value}(
            msg.sender,
            _borrower,
            _repaymentDue,
            _duration,
            _useSeconds,
            _depositAmount
        );

        address vaultAddress = address(vault);

        // --- Record vault ---
        allVaults.push(vaultAddress);
        vaultsByBorrower[_borrower].push(vaultAddress);
        vaultsByLender[msg.sender].push(vaultAddress);

        emit VaultDeployed(
            vaultAddress,
            msg.sender,
            _borrower,
            msg.value,
            _depositAmount,
            vault.deadline()
        );

        return vaultAddress;
    }

    // --- Admin functions ---

    /**
     * @notice Updates the KYC registry address.
     *         Allows the registry to be upgraded without redeploying
     *         the factory.
     */
    function updateRegistry(address _newRegistry) external onlyOwner {
        require(_newRegistry != address(0), "Invalid registry address");
        address previous = address(registry);
        registry = KYCRegistry(_newRegistry);
        emit RegistryUpdated(previous, _newRegistry);
    }

    // --- View functions ---

    /// @notice Returns total number of vaults deployed by this factory.
    function totalVaults() external view returns (uint256) {
        return allVaults.length;
    }

    /// @notice Returns all vault addresses deployed for a borrower.
    function getVaultsByBorrower(address _borrower)
        external view returns (address[] memory)
    {
        return vaultsByBorrower[_borrower];
    }

    /// @notice Returns all vault addresses deployed by a lender.
    function getVaultsByLender(address _lender)
        external view returns (address[] memory)
    {
        return vaultsByLender[_lender];
    }
}
