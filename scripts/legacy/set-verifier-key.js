// Run from the lending-poc backend root:
//   npx hardhat run scripts/set-verifier-key.js --network arbitrumSepolia
//
// Rotates the KYCRegistry's verifier signing key on-chain. Must be run
// with the operator wallet as the Hardhat signer (per your hardhat.config.js
// network setup) — the contract enforces onlyOperator on setVerifierKey().

const hre = require("hardhat");

const KYC_REGISTRY_ADDRESS = "0x5B6C57cA408dD1bbE9cbdeB0cbb6e923E01a584D";
const NEW_VERIFIER_KEY = "0x077F82e525bCe142eFF37c59FAaee2Ec5F66645B";

async function main() {
  const [operator] = await hre.ethers.getSigners();

  console.log("Network:", hre.network.name);
  console.log("Caller:", operator.address);
  console.log("Registry:", KYC_REGISTRY_ADDRESS);
  console.log("New verifier key:", NEW_VERIFIER_KEY);

  const registry = await hre.ethers.getContractAt("KYCRegistry", KYC_REGISTRY_ADDRESS);

  const currentOperator = await registry.operator();
  const currentVerifierKey = await registry.verifierKey();

  console.log("\nOn-chain operator:", currentOperator);
  console.log("Current verifier key:", currentVerifierKey);

  if (currentOperator.toLowerCase() !== operator.address.toLowerCase()) {
    console.log("\n❌ Caller is NOT the on-chain operator. Aborting — check your Hardhat network config's account.");
    return;
  }

  const tx = await registry.setVerifierKey(NEW_VERIFIER_KEY);
  console.log("\nTransaction sent, waiting for confirmation...");
  const receipt = await tx.wait();

  const updatedVerifierKey = await registry.verifierKey();

  console.log("\n✅ Verifier key rotation confirmed!");
  console.log("   Transaction hash:", receipt.hash);
  console.log("   View on explorer: https://sepolia.arbiscan.io/tx/" + receipt.hash);
  console.log("   New on-chain verifierKey:", updatedVerifierKey);
  console.log("   Matches expected:", updatedVerifierKey.toLowerCase() === NEW_VERIFIER_KEY.toLowerCase());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});