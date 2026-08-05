// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./Timelocked.sol";
import "./OperatorControlled.sol";

/**
 * @title KYCRegistry
 * @notice Maintains a registry of wallet addresses that have passed identity
 *         verification (KYC/AML/sanctions screening) elsewhere.
 *
 *         Covenza performs no check itself. It records that a recognised third
 *         party did, and stores only a wallet address, a timestamp, and which
 *         attester admitted it. No name, no document, no jurisdiction.
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
 *         REMOVED 5 August 2026: a soulbound-styled ERC-721 badge, minted on
 *         verification with on-chain SVG artwork.
 *
 *         It governed nothing. isVerified() was always the source of truth,
 *         every gate read that, and the badge was deliberately not burned on
 *         revocation — so a revoked wallet kept a token asserting it had been
 *         verified. It also described itself as non-transferable while the
 *         transfer functions were never overridden, which made it a saleable
 *         object claiming to be proof of identity screening.
 *
 *         The badge predated this design. It made sense when Covenza performed
 *         verification itself, so a token Covenza minted represented something
 *         Covenza knew. Under the attester model the meaningful record is
 *         attestedBy plus a timestamp, both already stored and both readable by
 *         anyone. The badge duplicated a status it did not control.
 *
 *         Removing it dropped ERC721, Base64 and Strings, roughly halving this
 *         contract — bytecode an auditor would otherwise have to read for a
 *         feature the protocol never consulted.
 */
contract KYCRegistry is Timelocked, OperatorControlled {
    using ECDSA for bytes32;

    // --- State variables ---

    /**
     * @notice Signing keys whose attestations this registry will accept.
     *
     * @dev    Replaces a single `verifierKey`. The change is not about
     *         convenience: with one key, Covenza necessarily ISSUED the
     *         attestation, which made it a participant in the KYC process and
     *         an obvious holder of whatever sat behind it. With a curated set,
     *         Covenza only RECOGNISES attestations that identity providers
     *         issued independently — it never performs a check, never sees a
     *         document, and never learns who anyone is.
     *
     *         Curating the set is the whole of the trust decision, and it is
     *         as consequential as whitelisting an asset: a recognised attester
     *         can admit anyone to the protocol.
     */
    struct Attester {
        bool    recognised;
        string  name;       // human-readable, for the operator UI and for audit
        // Where an unverified borrower should go to get checked. On chain
        // rather than in a frontend config because this string IS the product
        // of the listing decision — recognising a provider and telling people
        // where to find them are the same act, and splitting them means the
        // list and the links drift apart the first time one is added.
        string  url;
        uint256 addedAt;
    }

    mapping(address => Attester) public attesters;
    address[] private _attesterList;

    /// @notice Which attester's signature verified each wallet. Kept so that a
    ///         compromised or delisted attester's admissions can be found and
    ///         reviewed, rather than being indistinguishable from the rest.
    mapping(address => address) public attestedBy;

    mapping(address => bool)    public isVerified;    // verified status per address
    mapping(address => uint256) public verifiedAt;    // timestamp of verification
    mapping(address => uint256) public revokedAt;      // timestamp of revocation (0 if not revoked)
    mapping(address => uint256) public nonces;         // per-wallet nonce; bumped on revoke to invalidate old signatures

    // --- Events ---

    event AttesterAdded(address indexed key, string name, string url);
    event AttesterRemoved(address indexed key);

    event AddressVerified(
        address indexed wallet,
        uint256 timestamp,
        bool viaSignature
    );

    /// @dev Emitted alongside AddressVerified when the route was a signature,
    ///      naming the attester. Separate so the existing event keeps its shape.
    event AttestationAccepted(address indexed wallet, address indexed attester);

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
    constructor(address _operator, address _verifierKey, uint256 _timelockDelay)
        Timelocked(_timelockDelay)
        OperatorControlled(_operator)
    {
        require(_verifierKey != address(0), "Invalid verifier key address");

        // The constructor still takes a single key so existing deployment
        // scripts are unaffected; it is registered as the first recognised
        // attester rather than being privileged.
        _addAttester(_verifierKey, "Initial attester", "");
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
        require(attesters[signer].recognised, "Signature is not from a recognised attester");

        attestedBy[_wallet] = signer;
        _setVerified(_wallet, true);
        emit AttestationAccepted(_wallet, signer);
    }

    // --- Attester management ---

    /**
     * @notice Recognises an identity provider's signing key.
     *
     * @dev    SAFETY: this is the protocol's most consequential admin action.
     *         A recognised attester can admit any wallet, and the registry has
     *         no way to check that a real check happened — it verifies only
     *         that the signature came from a key on this list. Curation is the
     *         entire control.
     *
     *         Deliberately does NOT retroactively affect anyone: adding an
     *         attester admits nobody by itself, and removing one leaves
     *         existing verifications standing. Wallets a delisted attester
     *         admitted are findable through attestedBy and can be revoked
     *         individually. Mass revocation is not offered because it would be
     *         an unbounded loop, and because delisting a provider for a
     *         commercial reason is not the same as doubting every check they
     *         ever performed.
     */
    /**
     * @notice Announces a new identity provider. Recognised after
     *         `timelockDelay`.
     *
     * @dev    A recognised key can admit any wallet, and the registry cannot
     *         check that a real identity check happened behind the signature.
     *         Adding a provider is never urgent; doing it instantly and
     *         silently is how a hostile key gets added at 3am.
     */
    function queueAddAttester(
        address _key,
        string calldata _name,
        string calldata _url
    ) external onlyOperator {
        require(_key != address(0), "Invalid attester address");
        _queue(_attesterId(_key, _name, _url));
    }

    function cancelAddAttester(
        address _key,
        string calldata _name,
        string calldata _url
    ) external onlyOperator {
        _cancel(_attesterId(_key, _name, _url));
    }

    function addAttester(
        address _key,
        string calldata _name,
        string calldata _url
    ) external onlyOperator {
        _consume(_attesterId(_key, _name, _url));
        _addAttester(_key, _name, _url);
    }

    function _attesterId(address _key, string memory _name, string memory _url)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encode("addAttester", _key, _name, _url));
    }

    function removeAttester(address _key) external onlyOperator {
        require(attesters[_key].recognised, "Not a recognised attester");
        attesters[_key].recognised = false;
        emit AttesterRemoved(_key);
    }

    function _addAttester(address _key, string memory _name, string memory _url) internal {
        require(_key != address(0), "Invalid attester address");
        require(!attesters[_key].recognised, "Attester already recognised");

        if (attesters[_key].addedAt == 0) { _attesterList.push(_key); }
        attesters[_key] = Attester({
            recognised: true,
            name: _name,
            url: _url,
            addedAt: block.timestamp
        });
        emit AttesterAdded(_key, _name, _url);
    }

    /// @notice Every key ever recognised, including delisted ones. Callers
    ///         should read `attesters(key).recognised` for current status —
    ///         the list is history, not the whitelist.
    function allAttesters() external view returns (address[] memory) {
        return _attesterList;
    }

    function isRecognisedAttester(address _key) external view returns (bool) {
        return attesters[_key].recognised;
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
     * @notice Rotates the verifier signing key. Allows swapping in a real
     *         KYC provider's key later without any other contract changes.
     * @param _newVerifierKey The new verifier key address.
     */
    /**
     * @notice Rotates a single attester key: recognises the new one and
     *         delists the old.
     *
     * @dev    Kept because key rotation is a routine operational event and
     *         doing it as add-then-remove leaves a window in which both keys
     *         are live. The name carries across, since it is the same provider.
     */
    function rotateAttester(address _oldKey, address _newKey) external onlyOperator {
        require(attesters[_oldKey].recognised, "Not a recognised attester");
        string memory name = attesters[_oldKey].name;
        string memory url  = attesters[_oldKey].url;
        attesters[_oldKey].recognised = false;
        emit AttesterRemoved(_oldKey);
        _addAttester(_newKey, name, url);
    }

    // --- Internal ---

    function _setVerified(address _wallet, bool viaSignature) private {
        isVerified[_wallet] = true;
        verifiedAt[_wallet] = block.timestamp;
        revokedAt[_wallet]  = 0;

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

}
