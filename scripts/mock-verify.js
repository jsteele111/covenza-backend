const hre = require("hardhat");
const fs = require("fs");
const { buildAttestation, CLAIMS } = require("./lib/kyc-attestation");
const path = require("path");

async function main() {
  const borrowerAddress = process.env.BORROWER_ADDRESS;
  if (!borrowerAddress || !hre.ethers.isAddress(borrowerAddress)) {
    throw new Error(
      "Set BORROWER_ADDRESS as an environment variable before running this script."
    );
  }

  const verifierPrivateKey = process.env.VERIFIER_PRIVATE_KEY;
  if (!verifierPrivateKey) {
    throw new Error("VERIFIER_PRIVATE_KEY is missing from your .env file.");
  }

  // --- Load the deployed KYCRegistry address for the current network ---
  const addressesPath = path.join(__dirname, "..", "deployed-addresses.json");
  const allAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const networkAddresses = allAddresses[hre.network.name];
  if (!networkAddresses) {
    throw new Error(`No deployed addresses found for network "${hre.network.name}" in deployed-addresses.json`);
  }
  const registryAddress = networkAddresses.kycRegistry;

  const registry = await hre.ethers.getContractAt("KYCRegistry", registryAddress);

  // --- EIP-712 attestation in the KYCRegistry v2 format (#7) ---
  const verifierWallet = new hre.ethers.Wallet(verifierPrivateKey);
  const a = await buildAttestation(verifierWallet, registry, borrowerAddress, {
    claims: CLAIMS.ALL,
    validForSecs: 180 * 86400,
  });
  const { nonce, signature } = a;
  const expiry = a.deadline;

  console.log("\n=== Mock KYC Verification Attestation ===\n");
  console.log("Network:   ", hre.network.name);
  console.log("Registry:  ", registryAddress);
  console.log("Borrower:  ", borrowerAddress);
  console.log("Nonce:     ", nonce.toString());
  console.log("Claims:    ", a.claims, "(KYC, sanctions, jurisdiction)");
  console.log("Valid to:  ", a.validUntil, `(${new Date(a.validUntil * 1000).toISOString()})`);
  console.log("Submit by: ", expiry, `(${new Date(expiry * 1000).toISOString()})`);
  console.log("Call:       verifyWithSignature(borrower, claims, validUntil, deadline, signature)");
  console.log("Signature: ", signature);
  console.log("\n===========================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});