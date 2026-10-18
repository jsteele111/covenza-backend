const { ethers } = require("ethers");

// One-off script: generates a fresh keypair for a KYC ATTESTER signing key
// (the key the mock verifier signs EIP-712 attestations with on testnet).
// Recognise it on the registry with manage-attesters.js. Run once, save the
// output somewhere safe, then clear it from your terminal history.

const wallet = ethers.Wallet.createRandom();

console.log("\n=== New Verifier Keypair ===\n");
console.log("Address (public — the KYCRegistry constructor's first attester, or add it with manage-attesters.js):");
console.log(wallet.address);
console.log("\nPrivate Key (secret — this goes in your .env file, never share or commit it):");
console.log(wallet.privateKey);
console.log("\n=============================\n");