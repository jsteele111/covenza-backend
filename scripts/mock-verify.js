const hre = require("hardhat");
const fs = require("fs");
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

  // --- Read the borrower's current nonce on-chain (must match what the contract checks) ---
  const nonce = await registry.nonces(borrowerAddress);

  // --- Attestation is valid for 1 hour from now ---
  const expiry = Math.floor(Date.now() / 1000) + 60 * 60;

  // --- Build the exact same hash the contract computes, then sign it ---
  const structHash = hre.ethers.solidityPackedKeccak256(
    ["address", "uint256", "uint256", "address"],
    [borrowerAddress, expiry, nonce, registryAddress]
  );

  const verifierWallet = new hre.ethers.Wallet(verifierPrivateKey);
  const signature = await verifierWallet.signMessage(hre.ethers.getBytes(structHash));

  console.log("\n=== Mock KYC Verification Attestation ===\n");
  console.log("Network:   ", hre.network.name);
  console.log("Registry:  ", registryAddress);
  console.log("Borrower:  ", borrowerAddress);
  console.log("Nonce:     ", nonce.toString());
  console.log("Expiry:    ", expiry, `(${new Date(expiry * 1000).toISOString()})`);
  console.log("Signature: ", signature);
  console.log("\n===========================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});