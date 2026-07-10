const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const vaultsPath = path.join(__dirname, "..", "deployed-vaults.json");
  const vaults = JSON.parse(fs.readFileSync(vaultsPath, "utf8"));
  const vaultsOnThisNetwork = vaults.filter(v => v.network === hre.network.name);
  const vaultAddress = vaultsOnThisNetwork[vaultsOnThisNetwork.length - 1].vaultAddress;

  const vault = await hre.ethers.getContractAt("Vault", vaultAddress);

  console.log("Checking if deployed vault has the whitelist code (AAVE_WETH_GATEWAY constant)...");
  try {
    const gateway = await vault.AAVE_WETH_GATEWAY();
    console.log("✅ Found it. Deployed gateway address:", gateway);
    console.log("   This vault DOES have the new whitelist code.");
  } catch (err) {
    console.log("❌ Call failed — this vault does NOT have AAVE_WETH_GATEWAY.");
    console.log("   This means it's running an OLDER version of Vault.sol,");
    console.log("   deployed before supplyToAave() was added.");
    console.log("   Error:", err.message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});