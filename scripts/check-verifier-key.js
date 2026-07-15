require("dotenv").config();
const { ethers } = require("ethers");

const KYC_REGISTRY_ADDRESS = "0x5B6C57cA408dD1bbE9cbdeB0cbb6e923E01a584D";
const EXPECTED_VERIFIER_KEY = "0x00a5Bc38649a654f11a6a68033ae1B6c2c203cC8";

const ABI = [
  "function verifierKey() view returns (address)",
  "function operator() view returns (address)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);
  const registry = new ethers.Contract(KYC_REGISTRY_ADDRESS, ABI, provider);

  const onChainVerifierKey = await registry.verifierKey();
  const onChainOperator = await registry.operator();

  console.log("On-chain verifierKey:", onChainVerifierKey);
  console.log("Expected verifierKey:", EXPECTED_VERIFIER_KEY);
  console.log("Match:", onChainVerifierKey.toLowerCase() === EXPECTED_VERIFIER_KEY.toLowerCase());
  console.log("On-chain operator:", onChainOperator);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});