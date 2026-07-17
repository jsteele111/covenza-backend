require("dotenv").config();
const { ethers } = require("ethers");

const NEW_FACTORY_ADDRESS = "0xAa7645d954f69BfEF8EF884fE96eff8a229FBD9f";
const EXPECTED_REGISTRY_ADDRESS = "0x5B6C57cA408dD1bbE9cbdeB0cbb6e923E01a584D";

const ABI = [
  "function registry() view returns (address)",
  "function owner() view returns (address)",
  "function totalVaults() view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);
  const factory = new ethers.Contract(NEW_FACTORY_ADDRESS, ABI, provider);

  const [registryAddress, owner, totalVaults] = await Promise.all([
    factory.registry(),
    factory.owner(),
    factory.totalVaults(),
  ]);

  console.log("New VaultFactory:", NEW_FACTORY_ADDRESS);
  console.log("Points at registry:", registryAddress);
  console.log("Expected registry: ", EXPECTED_REGISTRY_ADDRESS);
  console.log("Match:", registryAddress.toLowerCase() === EXPECTED_REGISTRY_ADDRESS.toLowerCase());
  console.log("Owner:", owner);
  console.log("Total vaults deployed so far:", totalVaults.toString());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});