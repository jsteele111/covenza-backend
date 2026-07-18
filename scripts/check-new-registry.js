require("dotenv").config();
const { ethers } = require("ethers");

const NEW_REGISTRY_ADDRESS = "0x842629E4C953De726946Db5886e50d4840F61FC4";
const EXPECTED_VERIFIER = "0x077F82e525bCe142eFF37c59FAaee2Ec5F66645B";
const BORROWER = "0x6369ffc9F3D8cdAB69Fa0e6C002ABE617A5D576D";

const ABI = [
  "function operator() view returns (address)",
  "function verifierKey() view returns (address)",
  "function isVerified(address) view returns (bool)",
  "function badgeIdOf(address) view returns (uint256)",
  "function tokenURI(uint256) view returns (string)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);
  const registry = new ethers.Contract(NEW_REGISTRY_ADDRESS, ABI, provider);

  const [operator, verifierKey, isVerified, badgeId] = await Promise.all([
    registry.operator(),
    registry.verifierKey(),
    registry.isVerified(BORROWER),
    registry.badgeIdOf(BORROWER),
  ]);

  console.log("Registry:", NEW_REGISTRY_ADDRESS);
  console.log("Operator:", operator);
  console.log("Verifier key:", verifierKey);
  console.log("Matches rotated key:", verifierKey.toLowerCase() === EXPECTED_VERIFIER.toLowerCase());
  console.log("Borrower isVerified:", isVerified);
  console.log("Borrower badgeId:", badgeId.toString());

  if (badgeId > 0n) {
    const uri = await registry.tokenURI(badgeId);
    console.log("\ntokenURI() first 100 chars:", uri.slice(0, 100));
    console.log("Starts with data:application/json;base64,:", uri.startsWith("data:application/json;base64,"));

    if (uri.startsWith("data:application/json;base64,")) {
      const json = Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString("utf8");
      const metadata = JSON.parse(json);
      console.log("\nDecoded metadata name:", metadata.name);
      console.log("Has image field:", Boolean(metadata.image));
      console.log("Image starts with:", metadata.image?.slice(0, 40));
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });