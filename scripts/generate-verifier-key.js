const { ethers } = require("ethers");

// One-off script: generates a fresh keypair for the KYC verifier signing key.
// Run once, save the output somewhere safe, then delete or ignore this script's output from your terminal history.

const wallet = ethers.Wallet.createRandom();

console.log("\n=== New Verifier Keypair ===\n");
console.log("Address (public — this goes into the KYCRegistry constructor):");
console.log(wallet.address);
console.log("\nPrivate Key (secret — this goes in your .env file, never share or commit it):");
console.log(wallet.privateKey);
console.log("\n=============================\n");