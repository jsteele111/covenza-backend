// Run from the lending-poc backend root:
//   npx hardhat run scripts/verify-with-new-key.js --network arbitrumSepolia
//
// Submits a signature obtained from the live production /verify endpoint
// directly on-chain via verifyWithSignature(). If this succeeds, it's
// definitive proof the signature was produced by the CURRENT on-chain
// verifierKey — since verifyWithSignature() checks the recovered signer
// against verifierKey() and reverts on any mismatch, including a
// signature from the old, now-rotated-out key.

const hre = require("hardhat");

const KYC_REGISTRY_ADDRESS = "0x5B6C57cA408dD1bbE9cbdeB0cbb6e923E01a584D";

// Paste the exact response fields from the /verify call here:
const BORROWER_ADDRESS = "0x0a08d83ABcca58dd151dC5c61202937925413D1F";
const EXPIRY = 1784191017;
const SIGNATURE = "0x3fd56d9984980b0170ee5555f66abe9572d4b9f40203516411b815a74fec5b2b7c1e34164ea6a7673362f401fa5f26c35a215f694cb743f75feb8d0e6af9a4841b";

async function main() {
  const [caller] = await hre.ethers.getSigners();

  console.log("Network:", hre.network.name);
  console.log("Caller:", caller.address);
  console.log("Borrower being verified:", BORROWER_ADDRESS);

  const registry = await hre.ethers.getContractAt("KYCRegistry", KYC_REGISTRY_ADDRESS);

  const currentVerifierKey = await registry.verifierKey();
  console.log("Current on-chain verifierKey:", currentVerifierKey);

  const tx = await registry.verifyWithSignature(BORROWER_ADDRESS, EXPIRY, SIGNATURE);
  console.log("\nTransaction sent, waiting for confirmation...");
  const receipt = await tx.wait();

  const isVerified = await registry.isVerified(BORROWER_ADDRESS);
  const badgeId = await registry.badgeIdOf(BORROWER_ADDRESS);

  console.log("\n✅ verifyWithSignature() succeeded!");
  console.log("   This proves the signature was produced by the CURRENT verifierKey,");
  console.log("   since a mismatched signer would have reverted with 'Invalid verifier signature'.");
  console.log("   Transaction hash:", receipt.hash);
  console.log("   View on explorer: https://sepolia.arbiscan.io/tx/" + receipt.hash);
  console.log("   isVerified:", isVerified);
  console.log("   badgeId:", badgeId.toString());
}

main().catch((error) => {
  console.error(error);
  console.log("\nIf this reverted with 'Invalid verifier signature', the signature was");
  console.log("NOT produced by the current on-chain verifierKey — meaning the deployed");
  console.log("Netlify Function is still signing with the OLD key.");
  process.exitCode = 1;
});