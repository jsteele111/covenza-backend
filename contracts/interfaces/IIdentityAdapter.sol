// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IIdentityAdapter
 * @notice The one question the lending protocol asks about identity: is this
 *         wallet eligible, right now, for these claims?
 *
 * @dev    VaultFactory depends on this interface, not on any one
 *         implementation. KYCRegistry answers it today from third-party
 *         attestations. A zero-knowledge adapter can answer the same question
 *         later, and is swapped in through the factory's timelocked
 *         setRegistries, with no change to the lending contracts.
 *
 *         "Right now" is the point: eligibility must be checked at the moment
 *         of use (origination, mandate fill), never cached by the caller,
 *         because attestations expire.
 */
interface IIdentityAdapter {
    function isEligible(address wallet, uint256 requiredClaims) external view returns (bool);
}

/// @notice Claim flags an attestation may carry. Bits, so a requirement is a
///         mask and a wallet is eligible when it holds every bit asked for.
///         They describe what a provider checked, never who anyone is.
library IdentityClaims {
    uint256 internal constant KYC_PASSED            = 1 << 0; // identity verified
    uint256 internal constant SANCTIONS_CLEAR       = 1 << 1; // screened against sanctions lists
    uint256 internal constant JURISDICTION_ELIGIBLE = 1 << 2; // resident where the protocol serves
    uint256 internal constant ALL                   = KYC_PASSED | SANCTIONS_CLEAR | JURISDICTION_ELIGIBLE;
}
