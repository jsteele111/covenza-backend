require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");

const KYC_REGISTRY_ADDRESS = "0x5B6C57cA408dD1bbE9cbdeB0cbb6e923E01a584D";
const TOKEN_ID = 3;

const ABI = ["function tokenURI(uint256) view returns (string)"];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);
  const registry = new ethers.Contract(KYC_REGISTRY_ADDRESS, ABI, provider);

  const uri = await registry.tokenURI(TOKEN_ID);
  console.log("Raw tokenURI (first 100 chars):", uri.slice(0, 100));

  if (!uri.startsWith("data:application/json;base64,")) {
    console.log("UNEXPECTED FORMAT — does not start with data:application/json;base64,");
    return;
  }

  const jsonBase64 = uri.replace("data:application/json;base64,", "");
  const jsonString = Buffer.from(jsonBase64, "base64").toString("utf8");
  console.log("\nDecoded JSON metadata:\n", jsonString);

  const metadata = JSON.parse(jsonString);
  const imageUri = metadata.image;

  if (!imageUri || !imageUri.startsWith("data:image/svg+xml;base64,")) {
    console.log("\nNo valid embedded SVG image found in metadata.");
    return;
  }

  const svgBase64 = imageUri.replace("data:image/svg+xml;base64,", "");
  const svgString = Buffer.from(svgBase64, "base64").toString("utf8");
  console.log("\nDecoded SVG:\n", svgString);

  fs.writeFileSync("badge-check.svg", svgString);
  console.log("\nSaved to badge-check.svg — open this file in a browser to view it.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});