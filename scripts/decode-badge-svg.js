require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");

const NEW_REGISTRY_ADDRESS = "0x842629E4C953De726946Db5886e50d4840F61FC4";
const BADGE_ID = 1;

const ABI = ["function tokenURI(uint256) view returns (string)"];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);
  const registry = new ethers.Contract(NEW_REGISTRY_ADDRESS, ABI, provider);

  const uri = await registry.tokenURI(BADGE_ID);
  const json = Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString("utf8");
  const metadata = JSON.parse(json);

  const svgBase64 = metadata.image.replace("data:image/svg+xml;base64,", "");
  const svg = Buffer.from(svgBase64, "base64").toString("utf8");

  fs.writeFileSync("badge-artwork-check.svg", svg);
  console.log("Saved to badge-artwork-check.svg — open this file in a browser to view the actual badge.");
  console.log("\nRaw SVG:\n", svg);
}

main().catch((err) => { console.error(err); process.exit(1); });