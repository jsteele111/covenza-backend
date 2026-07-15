require("dotenv").config();
const express = require("express");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const PORT = process.env.MOCK_VERIFIER_PORT || 4000;
const NETWORK = process.env.MOCK_VERIFIER_NETWORK || "localhost";

const VERIFIER_PRIVATE_KEY = process.env.VERIFIER_PRIVATE_KEY;
if (!VERIFIER_PRIVATE_KEY) {
  throw new Error("VERIFIER_PRIVATE_KEY is missing from your .env file.");
}

// --- Load the deployed KYCRegistry address for the target network ---
const addressesPath = path.join(__dirname, "..", "deployed-addresses.json");
const allAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
const networkAddresses = allAddresses[NETWORK];
if (!networkAddresses) {
  throw new Error(`No deployed addresses found for network "${NETWORK}" in deployed-addresses.json`);
}
const REGISTRY_ADDRESS = networkAddresses.kycRegistry;

// --- Load the contract ABI from Hardhat's compiled artifacts ---
const artifactPath = path.join(__dirname, "..", "artifacts", "contracts", "KYCRegistry.sol", "KYCRegistry.json");
const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

// --- Provider: supports both localhost and Arbitrum Sepolia ---
const RPC_URLS = {
  localhost: "http://127.0.0.1:8545",
  arbitrumSepolia: process.env.ARBITRUM_SEPOLIA_RPC_URL,
};

const RPC_URL = RPC_URLS[NETWORK];
if (!RPC_URL) {
  throw new Error(
    `No RPC URL configured for network "${NETWORK}". ` +
    `Supported networks: ${Object.keys(RPC_URLS).join(", ")}.`
  );
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const registry = new ethers.Contract(REGISTRY_ADDRESS, abi, provider);
const verifierWallet = new ethers.Wallet(VERIFIER_PRIVATE_KEY);

const app = express();
app.use(express.json());

// Allow the front-end (running on a different port) to call this server
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (req, res) => {
  res.json({ status: "ok", network: NETWORK, registry: REGISTRY_ADDRESS });
});

app.post("/verify", async (req, res) => {
  try {
    const { borrowerAddress } = req.body;

    if (!borrowerAddress || !ethers.isAddress(borrowerAddress)) {
      return res.status(400).json({ error: "A valid borrowerAddress is required." });
    }

    const alreadyVerified = await registry.isVerified(borrowerAddress);
    if (alreadyVerified) {
      return res.status(409).json({ error: "This address is already verified." });
    }

    const nonce = await registry.nonces(borrowerAddress);
    const expiry = Math.floor(Date.now() / 1000) + 60 * 60; // valid for 1 hour

    const structHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address"],
      [borrowerAddress, expiry, nonce, REGISTRY_ADDRESS]
    );
    const signature = await verifierWallet.signMessage(ethers.getBytes(structHash));

    console.log(`Issued attestation for ${borrowerAddress} (nonce ${nonce})`);

    res.json({
      borrowerAddress,
      expiry,
      nonce: nonce.toString(),
      signature,
      registryAddress: REGISTRY_ADDRESS
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal error generating attestation." });
  }
});

app.listen(PORT, () => {
  console.log(`Mock KYC verifier service running at http://localhost:${PORT}`);
  console.log(`Network:  ${NETWORK}`);
  console.log(`Registry: ${REGISTRY_ADDRESS}`);
});