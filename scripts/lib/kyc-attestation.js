/**
 * Builds an EIP-712 KYC attestation in the format KYCRegistry v2 verifies
 * (#7, 18 October 2026). Shared by the mock verifier script and server so
 * the format lives in one place.
 *
 * The domain binds the signature to this chain and this registry, so it
 * cannot be replayed elsewhere; the nonce binds it to the wallet's current
 * state, so it cannot be replayed here.
 */
const { ethers } = require("ethers");

const CLAIMS = { KYC_PASSED: 1, SANCTIONS_CLEAR: 2, JURISDICTION_ELIGIBLE: 4, ALL: 7 };

const TYPES = {
  Attestation: [
    { name: "wallet", type: "address" },
    { name: "claims", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

/**
 * @param {ethers.Signer} signer     the attester's signing wallet
 * @param {ethers.Contract} registry KYCRegistry (needs nonces(), getAddress())
 * @param {string} wallet            the wallet being attested
 * @param {object} [opts]
 * @param {number} [opts.claims]       IdentityClaims bits (default ALL)
 * @param {number} [opts.validForSecs] attestation validity (default 180 days, max 365)
 * @param {number} [opts.deadlineSecs] submission window (default 1 hour)
 */
async function buildAttestation(signer, registry, wallet, opts = {}) {
  const provider = registry.runner.provider ?? registry.runner;
  const now = (await provider.getBlock("latest")).timestamp;
  const claims = opts.claims ?? CLAIMS.ALL;
  const validUntil = now + (opts.validForSecs ?? 180 * 86400);
  const deadline = now + (opts.deadlineSecs ?? 3600);
  const nonce = await registry.nonces(wallet);
  const domain = {
    name: "Covenza KYC",
    version: "2",
    chainId: (await provider.getNetwork()).chainId,
    verifyingContract: await registry.getAddress(),
  };
  const signature = await signer.signTypedData(domain, TYPES, { wallet, claims, validUntil, deadline, nonce });
  return { wallet, claims, validUntil, deadline, nonce: nonce.toString(), signature };
}

module.exports = { buildAttestation, CLAIMS, TYPES };
