// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title KYCRegistry
 * @notice Maintains a registry of wallet addresses that have passed
 *         identity verification (KYC/AML/sanctions screening), and issues
 *         a non-transferable ("soulbound") ERC-721 badge to each verified
 *         wallet as visible, wallet-held proof of verification.
 *
 *         Two paths into the registry:
 *           1. verifyWithSignature() - the primary path. Permissionless;
 *              succeeds only if accompanied by a valid signature from
 *              `verifierKey`. In production, `verifierKey` is controlled
 *              by a real KYC provider's backend (e.g. Persona, Sumsub).
 *              For the PoC, it is controlled by a small mock verifier
 *              script that stands in for that provider.
 *           2. verify() - a manual operator override/fallback, kept for
 *              edge cases (e.g. FR-13-style manual reinstatement).
 *
 *         This contract is intentionally separate from the Vault contract
 *         so that the identity layer can be upgraded independently of the
 *         lending logic.
 *
 *         IMPORTANT: isVerified() is always the source of truth for current
 *         status. The badge token is NOT burned on revocation - it remains
 *         as a historical record that verification happened at some point.
 *         Never infer current status from badge ownership alone.
 */
contract KYCRegistry is ERC721 {
    using ECDSA for bytes32;

    // --- State variables ---

    address public operator;     // address authorised to verify/revoke wallets manually
    address public verifierKey;  // address whose signature attests to a successful KYC check

    mapping(address => bool)    public isVerified;    // verified status per address
    mapping(address => uint256) public verifiedAt;    // timestamp of verification
    mapping(address => uint256) public revokedAt;      // timestamp of revocation (0 if not revoked)
    mapping(address => uint256) public nonces;         // per-wallet nonce; bumped on revoke to invalidate old signatures

    mapping(address => uint256) private _badgeIdOf;    // borrower -> badge token id (0 = none issued)
    uint256 private _nextBadgeId = 1;

    // --- Events ---

    event OperatorUpdated(
        address indexed previousOperator,
        address indexed newOperator
    );

    event VerifierKeyUpdated(
        address indexed previousKey,
        address indexed newKey
    );

    event AddressVerified(
        address indexed wallet,
        uint256 timestamp,
        bool viaSignature
    );

    event AddressRevoked(
        address indexed wallet,
        uint256 timestamp
    );

    // --- Constructor ---

    /**
     * @param _operator The address authorised to verify and revoke wallets manually.
     *                  In production this would be a multisig.
     * @param _verifierKey The address whose signature is accepted as proof of
     *                      a successful off-chain KYC check. Should be a distinct
     *                      key from _operator - keep verification-signing and
     *                      registry-administration privileges separate.
     */
    constructor(address _operator, address _verifierKey) ERC721("Covenza KYC Badge", "CVKYC") {
        require(_operator != address(0), "Invalid operator address");
        require(_verifierKey != address(0), "Invalid verifier key address");
        operator = _operator;
        verifierKey = _verifierKey;
        emit OperatorUpdated(address(0), _operator);
        emit VerifierKeyUpdated(address(0), _verifierKey);
    }

    // --- Modifiers ---

    modifier onlyOperator() {
        require(msg.sender == operator, "Caller is not the operator");
        _;
    }

    // --- Primary verification path: signature-based ---

    /**
     * @notice Verifies a wallet using a signature from `verifierKey`, attesting
     *         that the wallet passed an off-chain KYC/AML/sanctions check.
     *         Permissionless - typically called by the borrower's own front-end
     *         after receiving a signed attestation from the (mock, for now)
     *         verifier service.
     * @param _wallet The address being verified.
     * @param _expiry Unix timestamp after which this signature is no longer valid.
     * @param _signature Signature over (wallet, expiry, current nonce, this contract)
     *                    produced by `verifierKey`.
     */
    function verifyWithSignature(
        address _wallet,
        uint256 _expiry,
        bytes calldata _signature
    ) external {
        require(_wallet != address(0), "Invalid wallet address");
        require(block.timestamp <= _expiry, "Signature expired");
        require(!isVerified[_wallet], "Address already verified");

        bytes32 structHash = keccak256(
            abi.encodePacked(_wallet, _expiry, nonces[_wallet], address(this))
        );
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(structHash);
        address signer = digest.recover(_signature);
        require(signer == verifierKey, "Invalid verifier signature");

        _setVerified(_wallet, true);
    }

    // --- Manual fallback path (operator-controlled, as before) ---

    /**
     * @notice Marks a wallet address as KYC verified. Manual operator override -
     *         kept for edge cases; the signature-based path above is primary.
     * @param _wallet The address that has passed identity verification.
     */
    function verify(address _wallet) external onlyOperator {
        require(_wallet != address(0), "Invalid wallet address");
        require(!isVerified[_wallet], "Address already verified");

        _setVerified(_wallet, false);
    }

    /**
     * @notice Revokes KYC verification for a wallet address.
     *         Used when a borrower defaults, fails re-screening,
     *         or appears on a sanctions list post-verification.
     *         Bumps the wallet's nonce, invalidating any previously-issued
     *         signature so it cannot be replayed to re-verify later.
     * @param _wallet The address to revoke.
     */
    function revoke(address _wallet) external onlyOperator {
        require(isVerified[_wallet], "Address is not verified");

        isVerified[_wallet] = false;
        revokedAt[_wallet]  = block.timestamp;
        nonces[_wallet]    += 1;

        emit AddressRevoked(_wallet, block.timestamp);
    }

    /**
     * @notice Transfers operator role to a new address.
     *         Allows the KYC operator key to be rotated without
     *         redeploying the registry.
     * @param _newOperator The new operator address.
     */
    function transferOperator(address _newOperator) external onlyOperator {
        require(_newOperator != address(0), "Invalid operator address");
        address previous = operator;
        operator = _newOperator;
        emit OperatorUpdated(previous, _newOperator);
    }

    /**
     * @notice Rotates the verifier signing key. Allows swapping in a real
     *         KYC provider's key later without any other contract changes.
     * @param _newVerifierKey The new verifier key address.
     */
    function setVerifierKey(address _newVerifierKey) external onlyOperator {
        require(_newVerifierKey != address(0), "Invalid verifier key");
        address previous = verifierKey;
        verifierKey = _newVerifierKey;
        emit VerifierKeyUpdated(previous, _newVerifierKey);
    }

    // --- Internal ---

    function _setVerified(address _wallet, bool viaSignature) private {
        isVerified[_wallet] = true;
        verifiedAt[_wallet] = block.timestamp;
        revokedAt[_wallet]  = 0;

        if (_badgeIdOf[_wallet] == 0) {
            uint256 badgeId = _nextBadgeId++;
            _badgeIdOf[_wallet] = badgeId;
            _safeMint(_wallet, badgeId);
        }

        emit AddressVerified(_wallet, block.timestamp, viaSignature);
    }

    // --- View functions ---

    /**
     * @notice Returns full verification status for a wallet.
     * @return verified   Whether the address is currently verified.
     * @return verifiedTs Timestamp of most recent verification (0 if never).
     * @return revokedTs  Timestamp of most recent revocation (0 if never revoked).
     */
    function statusOf(address _wallet) external view returns (
        bool verified,
        uint256 verifiedTs,
        uint256 revokedTs
    ) {
        return (
            isVerified[_wallet],
            verifiedAt[_wallet],
            revokedAt[_wallet]
        );
    }

    /**
     * @notice Returns the badge token id held by a wallet (0 if none issued yet).
     */
    function badgeIdOf(address _wallet) external view returns (uint256) {
        return _badgeIdOf[_wallet];
    }

    // --- Soulbound enforcement: block all transfers, allow only minting ---

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        require(from == address(0), "KYC badge is non-transferable");
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert("KYC badge is non-transferable");
    }

    function setApprovalForAll(address, bool) public pure override {
        revert("KYC badge is non-transferable");
    }
}