const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
const borrowerAddress = "0x30f24BEb7873cd9C4Bd03486300B2666201747fe";
const expiry = 1783687718;
const signature = "0x2d01a42b471f89fbabb49fbf0a2c336dce1c526dd8168f7ccfd70a6d49795ff01378b711aa28e50d010f96517f6e0feec6cf48be1e3e41ebe566ad24c085f7ee1b";

  const addressesPath = path.join(__dirname, "..", "deployed-addresses.json");
  const allAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const registryAddress = allAddresses[hre.network.name].kycRegistry;

  const registry = await hre.ethers.getContractAt("KYCRegistry", registryAddress);

  console.log("Before:", await registry.isVerified(borrowerAddress));

  const tx = await registry.verifyWithSignature(borrowerAddress, expiry, signature);
  const receipt = await tx.wait();

  console.log("Transaction status:", receipt.status === 1 ? "success" : "FAILED");
  console.log("After: ", await registry.isVerified(borrowerAddress));

  const badgeId = await registry.badgeIdOf(borrowerAddress);
  console.log("Badge ID minted:", badgeId.toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});