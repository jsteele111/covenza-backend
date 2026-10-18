// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./Timelocked.sol";
import "./OperatorControlled.sol";
import "./interfaces/IIdentityAdapter.sol";

/**
 * @title KYCRegistry
 * @notice Records which wallets recognised identity providers have attested
 *         to, what each attestation covers, and until when. Answers
 *         IIdentityAdapter.isEligible for the lending protocol.
 *
 *         Covenza performs no check itself and stores no identity data: a
 *         wallet, the provider that attested it, a set of claim flags, and
 *         three timestamps. No name, no document, no jurisdiction.
 *
 * @dev    REDESIGNED 18 October 2026 (MAINNET-READINESS item 7 follow-up,
 *         the KYC adapter work agreed with the auditor). What changed and why:
 *
 *         1. ATTESTATIONS EXPIRE, AND EXPIRY IS CHECKED AT THE POINT OF USE.
 *            Previously a signature's expiry bounded only when it could be
 *            submitted; once admitted, a wallet stayed admitted for ever. Now
 *            every attestation carries `validUntil` (at most 365 days out),
 *            and isEligible() reads it at each origination and mandate fill.
 *
 *         2. SIGNATURES ARE BOUND TO THIS CHAIN AND THIS CONTRACT. Attestations
 *            are EIP-712 typed data whose domain includes the chain id and this
 *            registry's address, so a signature cannot be replayed on another
 *            chain or presented to another adapter. The per-wallet nonce stops
 *            replay here.
 *
 *         3. CLAIMS, NOT A YES/NO. An attestation states which checks the
 *            provider performed (IdentityClaims). The factory asks for the
 *            claims it needs; a provider that only screens sanctions can say
 *            so, and its wallets will not pass a requirement for full KYC.
 *
 *         4. THE OPERATOR CANNOT WALK AROUND THE ATTESTER TIMELOCK (Krait
 *            observation). rotateAttester now waits like addAttester. The
 *            manual verify() path survives for genuine exceptions, but every
 *            grant is announced and waits on the timelock, lasts 30 days, can
 *            be given to a wallet at most once a year, carries an on-chain
 *            reference to the operator's case record, is marked as manual, and
 *            at most five may be made in any 30 days.
 *
 *         Revocation remains instant in every case: it only ever reduces risk.
 *
 *         REMOVED 5 August 2026: a soulbound-styled ERC-721 badge minted on
 *         verification. It governed nothing and outlived revocation.
 */
contract KYCRegistry is Timelocked, OperatorControlled, EIP712, IIdentityAdapter {

    // --- Limits ---

    /// @notice Longest validity a provider attestation may carry.
    uint256 public constant MAX_ATTESTATION_VALIDITY = 365 days;

    /// @notice Validity of a manual (operator) grant.
    uint256 public constant MANUAL_VALIDITY = 30 days;

    /// @notice A wallet may receive a manual grant at most once per this period.
    uint256 public constant MANUAL_COOLDOWN = 365 days;

    /// @notice At most MANUAL_RATE_LIMIT manual grants in any MANUAL_RATE_WINDOW.
    uint256 public constant MANUAL_RATE_LIMIT  = 5;
    uint256 public constant MANUAL_RATE_WINDOW = 30 days;

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address wallet,uint256 claims,uint256 validUntil,uint256 deadline,uint256 nonce)"
    );

    // --- Attesters ---

    struct Attester {
        bool    recognised;
        string  name;       // human-readable, for the operator UI and for audit
        string  url;        // where an unverified borrower should go to get checked
        uint256 addedAt;
    }

    mapping(address => Attester) public attesters;
    address[] private _attesterList;

    // --- Verifications ---

    struct Verification {
        address attester;    // provider key, or address(0) for a manual grant
        uint256 claims;      // IdentityClaims bits
        uint256 validUntil;  // eligibility ends after this moment
        bool    manual;      // granted by the operator, not a provider
        bytes32 caseRef;     // manual grants: hash of the operator's case record
    }

    mapping(address => Verification) internal _verification;

    mapping(address => bool)    public isVerified;  // admitted and not revoked; NOT expiry-aware — use isEligible
    mapping(address => uint256) public verifiedAt;
    mapping(address => uint256) public revokedAt;
    mapping(address => uint256) public nonces;      // bumped on every use and on revoke

    /// @notice Which attester admitted each wallet, address(0) if manual.
    mapping(address => address) public attestedBy;

    /// @notice When each wallet last received a manual grant.
    mapping(address => uint256) public lastManualGrantAt;

    /// @dev Ring of the last MANUAL_RATE_LIMIT manual grant times.
    uint256[5] private _manualGrantTimes;
    uint256 private _manualGrantIndex;

    // --- Events ---

    event AttesterAdded(address indexed key, string name, string url);
    event AttesterRemoved(address indexed key);
    event AddressVerified(address indexed wallet, uint256 timestamp, bool viaSignature);
    event AttestationAccepted(address indexed wallet, address indexed attester, uint256 claims, uint256 validUntil);
    event ManualGrant(address indexed wallet, uint256 claims, uint256 validUntil, bytes32 indexed caseRef);
    event AddressRevoked(address indexed wallet, uint256 timestamp);

    // --- Constructor ---

    /**
     * @param _operator      Administers attesters, manual grants and revocation.
     *                       In production, a multisig.
     * @param _verifierKey   The first recognised attester's signing key.
     * @param _timelockDelay Delay on risk-increasing actions.
     */
    constructor(address _operator, address _verifierKey, uint256 _timelockDelay)
        Timelocked(_timelockDelay)
        OperatorControlled(_operator)
        EIP712("Covenza KYC", "2")
    {
        require(_verifierKey != address(0), "Invalid verifier key address");
        _addAttester(_verifierKey, "Initial attester", "");
    }

    // --- The adapter question ---

    /// @inheritdoc IIdentityAdapter
    function isEligible(address _wallet, uint256 _requiredClaims) external view returns (bool) {
        if (!isVerified[_wallet]) { return false; }
        Verification storage v = _verification[_wallet];
        if (block.timestamp > v.validUntil) { return false; }
        return (v.claims & _requiredClaims) == _requiredClaims;
    }

    // --- Primary path: a provider's attestation ---

    /**
     * @notice Admits (or renews) a wallet on a recognised provider's
     *         attestation. Permissionless: usually submitted by the borrower's
     *         own interface with the signature the provider returned.
     * @param _wallet     The wallet attested.
     * @param _claims     IdentityClaims bits the provider checked.
     * @param _validUntil When the attestation stops counting.
     * @param _deadline   Last moment this signature may be submitted.
     * @param _signature  EIP-712 signature over Attestation(...) with the
     *                    wallet's current nonce.
     */
    function verifyWithSignature(
        address _wallet,
        uint256 _claims,
        uint256 _validUntil,
        uint256 _deadline,
        bytes calldata _signature
    ) external {
        require(_wallet != address(0), "Invalid wallet address");
        require(block.timestamp <= _deadline, "Signature expired");
        require(_validUntil > block.timestamp, "Attestation already expired");
        require(_validUntil <= block.timestamp + MAX_ATTESTATION_VALIDITY, "Validity beyond the 365-day cap");
        require(_claims != 0 && (_claims & ~IdentityClaims.ALL) == 0, "Unknown or empty claims");

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            ATTESTATION_TYPEHASH, _wallet, _claims, _validUntil, _deadline, nonces[_wallet]
        )));
        address signer = ECDSA.recover(digest, _signature);
        require(attesters[signer].recognised, "Signature is not from a recognised attester");

        nonces[_wallet] += 1;
        _record(_wallet, signer, _claims, _validUntil, false, bytes32(0));
        emit AttestationAccepted(_wallet, signer, _claims, _validUntil);
    }

    // --- Exception path: a manual grant ---

    /**
     * @notice Admits a wallet without a provider attestation, for a genuine
     *         exception the operator can document.
     *
     * @dev    Six safeguards, because this path bypasses the providers:
     *         1. Announced: waits on the timelock, bound to these exact
     *            arguments (queueAction(keccak256(calldata))).
     *         2. Lasts MANUAL_VALIDITY (30 days), then lapses.
     *         3. A wallet may receive one at most once per MANUAL_COOLDOWN, so
     *            grants cannot be chained; after that, a provider must attest.
     *         4. `_caseRef` is a hash of the operator's case record. No
     *            personal data on chain, but every grant points to a file.
     *         5. Recorded as manual (attester zero, `manual` set) and emitted
     *            as ManualGrant, distinct from provider admissions.
     *         6. At most MANUAL_RATE_LIMIT (5) in any MANUAL_RATE_WINDOW (30
     *            days), which bounds what a stolen operator key could do.
     */
    function verify(address _wallet, uint256 _claims, bytes32 _caseRef) external onlyOperator {
        require(_wallet != address(0), "Invalid wallet address");
        require(_claims != 0 && (_claims & ~IdentityClaims.ALL) == 0, "Unknown or empty claims");
        require(_caseRef != bytes32(0), "A case reference is required");
        uint256 last = lastManualGrantAt[_wallet];
        require(last == 0 || block.timestamp >= last + MANUAL_COOLDOWN, "Manual grant used within the last year");
        require(
            block.timestamp >= _manualGrantTimes[_manualGrantIndex] + MANUAL_RATE_WINDOW
                || _manualGrantTimes[_manualGrantIndex] == 0,
            "Manual grant rate limit reached"
        );
        _consumeIfDelayed(keccak256(msg.data));

        _manualGrantTimes[_manualGrantIndex] = block.timestamp;
        _manualGrantIndex = (_manualGrantIndex + 1) % MANUAL_RATE_LIMIT;
        lastManualGrantAt[_wallet] = block.timestamp;

        uint256 validUntil = block.timestamp + MANUAL_VALIDITY;
        _record(_wallet, address(0), _claims, validUntil, true, _caseRef);
        emit ManualGrant(_wallet, _claims, validUntil, _caseRef);
    }

    /**
     * @notice Revokes a wallet. Instant, and invalidates any signature already
     *         issued for it. Used on a sanctions hit, a failed re-screen, or a
     *         provider's notice.
     */
    function revoke(address _wallet) external onlyOperator {
        require(isVerified[_wallet], "Address is not verified");
        isVerified[_wallet] = false;
        revokedAt[_wallet]  = block.timestamp;
        nonces[_wallet]    += 1;
        emit AddressRevoked(_wallet, block.timestamp);
    }

    // --- Attester management ---

    /**
     * @notice Announces a new identity provider. Recognised after the delay.
     * @dev    A recognised key can admit any wallet, and the registry cannot
     *         check that a real check happened behind the signature. Adding a
     *         provider is never urgent.
     */
    function queueAddAttester(address _key, string calldata _name, string calldata _url) external onlyOperator {
        require(_key != address(0), "Invalid attester address");
        _queue(_attesterId(_key, _name, _url));
    }

    function cancelAddAttester(address _key, string calldata _name, string calldata _url) external onlyOperator {
        _cancel(_attesterId(_key, _name, _url));
    }

    function addAttester(address _key, string calldata _name, string calldata _url) external onlyOperator {
        _consume(_attesterId(_key, _name, _url));
        _addAttester(_key, _name, _url);
    }

    function _attesterId(address _key, string memory _name, string memory _url) internal pure returns (bytes32) {
        return keccak256(abi.encode("addAttester", _key, _name, _url));
    }

    /// @notice Delists a provider. Instant. Wallets it admitted keep their
    ///         verification until it expires (at most 365 days), and can be
    ///         found through attestedBy and revoked individually.
    function removeAttester(address _key) external onlyOperator {
        require(attesters[_key].recognised, "Not a recognised attester");
        attesters[_key].recognised = false;
        emit AttesterRemoved(_key);
    }

    /**
     * @notice Announces a key rotation for an existing provider.
     * @dev    Rotation recognises a new key, which is exactly what addAttester
     *         guards. It previously did so instantly, which made the attester
     *         timelock decorative (Krait observation). It now waits the same
     *         delay. Delisting a compromised key needs no rotation:
     *         removeAttester is instant.
     */
    function queueRotateAttester(address _oldKey, address _newKey) external onlyOperator {
        require(_newKey != address(0), "Invalid attester address");
        _queue(_rotateId(_oldKey, _newKey));
    }

    function cancelRotateAttester(address _oldKey, address _newKey) external onlyOperator {
        _cancel(_rotateId(_oldKey, _newKey));
    }

    function rotateAttester(address _oldKey, address _newKey) external onlyOperator {
        require(attesters[_oldKey].recognised, "Not a recognised attester");
        _consume(_rotateId(_oldKey, _newKey));
        string memory name = attesters[_oldKey].name;
        string memory url  = attesters[_oldKey].url;
        attesters[_oldKey].recognised = false;
        emit AttesterRemoved(_oldKey);
        _addAttester(_newKey, name, url);
    }

    function _rotateId(address _oldKey, address _newKey) internal pure returns (bytes32) {
        return keccak256(abi.encode("rotateAttester", _oldKey, _newKey));
    }

    /// @notice Announces a manual grant: `_id` is keccak256 of the exact
    ///         verify() calldata that will follow.
    function queueAction(bytes32 _id) external onlyOperator { _queue(_id); }

    /// @notice Abandons an announced manual grant. Instant.
    function cancelAction(bytes32 _id) external onlyOperator { _cancel(_id); }

    // --- Internal ---

    function _addAttester(address _key, string memory _name, string memory _url) internal {
        require(_key != address(0), "Invalid attester address");
        require(!attesters[_key].recognised, "Attester already recognised");
        if (attesters[_key].addedAt == 0) { _attesterList.push(_key); }
        attesters[_key] = Attester({ recognised: true, name: _name, url: _url, addedAt: block.timestamp });
        emit AttesterAdded(_key, _name, _url);
    }

    function _record(
        address _wallet,
        address _attester,
        uint256 _claims,
        uint256 _validUntil,
        bool    _manual,
        bytes32 _caseRef
    ) private {
        _verification[_wallet] = Verification({
            attester:   _attester,
            claims:     _claims,
            validUntil: _validUntil,
            manual:     _manual,
            caseRef:    _caseRef
        });
        attestedBy[_wallet] = _attester;
        isVerified[_wallet] = true;
        verifiedAt[_wallet] = block.timestamp;
        revokedAt[_wallet]  = 0;
        emit AddressVerified(_wallet, block.timestamp, !_manual);
    }

    // --- Views ---

    /// @notice The full verification record for a wallet.
    function verificationOf(address _wallet) external view returns (Verification memory) {
        return _verification[_wallet];
    }

    /// @notice Every key ever recognised, including delisted ones.
    function allAttesters() external view returns (address[] memory) {
        return _attesterList;
    }

    function isRecognisedAttester(address _key) external view returns (bool) {
        return attesters[_key].recognised;
    }

    /// @notice Summary status, kept for existing callers. `verified` ignores
    ///         expiry; isEligible is the answer that counts.
    function statusOf(address _wallet) external view returns (bool verified, uint256 verifiedTs, uint256 revokedTs) {
        return (isVerified[_wallet], verifiedAt[_wallet], revokedAt[_wallet]);
    }

    /// @notice The EIP-712 domain separator signers must use.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
