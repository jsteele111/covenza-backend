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
const BORROWER_ADDRESS = "0xC3b3e55fC85cC4C2638a64b4Ef29f44A760F9729";
const EXPIRY = 1784190742;
const SIGNATURE = "0x9ed5e4d179ae6364ba74b85aab9898b7bbaaf30b2c0b2ac2aa02a231ba65be8a6578a2010bfd0ef1cae711d57dcff8176b2531e88697dfca6588d922480fa0bc1b";

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