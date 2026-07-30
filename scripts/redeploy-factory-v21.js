// Redeploys ONLY the VaultFactory, for the v2.1 protocol fee upgrade.
//
// Usage:
//   npx hardhat run scripts/redeploy-factory-v21.js --network hardhat          (dry run)
//   npx hardhat run scripts/redeploy-factory-v21.js --network arbitrumSepolia
//
// WHY FACTORY-ONLY: the v2.1 change touches Vault.sol and VaultFactory.sol
// and nothing else. KYCRegistry, AssetRegistry and InsurancePool are
// byte-identical to what is already deployed, so redeploying them would
// throw away live state for no reason — the borrower's KYC verification,
// the whitelisted assets and settlement config, and most importantly the
// insurance pool's accumulated reserve. Vault.sol is not deployed directly;
// its bytecode is embedded in the factory, so a new factory is sufficient
// to put the new vault logic in service.
//
// WHAT CARRIES OVER
//   KYCRegistry    - unchanged. Verified borrowers stay verified.
//   AssetRegistry  - unchanged. Whitelist and settlement config intact.
//   InsurancePool  - unchanged, INCLUDING its per-asset reserves.
//   Mock tokens    - unchanged.
//
// WHAT DOES NOT
//   Vault history. The UI scopes vault lookups to the current factory, so
//   vaults deployed by the previous factory will not appear in the lender
//   view or the dashboard's counts. They remain fully functional on-chain
//   and settleable — see the note on draw rights below.
//
// IMPORTANT — OLD VAULTS KEEP THEIR INSURANCE DRAW RIGHTS.
// Rewiring InsurancePool.setVaultFactory only changes who may REGISTER new
// vaults. Already-registered vaults stay in isRegisteredVault and can still
// draw at settlement. Nothing is stranded by this upgrade.

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Set TREASURY_ADDRESS in .env. Falls back to the deployer with a warning.
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || "";

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const addressesPath = path.join(__dirname, "..", "deployed-addresses.json");
  if (!fs.existsSync(addressesPath)) {
    throw new Error("deployed-addresses.json not found.");
  }
  const allAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const existing = allAddresses[hre.network.name];
  if (!existing) {
    throw new Error(`No deployment recorded for network "${hre.network.name}".`);
  }

  // --- Validate the three contracts we intend to reuse ---
  const required = ["kycRegistry", "assetRegistry", "insurancePool"];
  for (const key of required) {
    if (!existing[key]) {
      throw new Error(
        `deployed-addresses.json has no "${key}" for ${hre.network.name}. ` +
        `Run deploy-v2-infrastructure.js first — this script only replaces the factory.`
      );
    }
    const code = await hre.ethers.provider.getCode(existing[key]);
    if (code === "0x") {
      throw new Error(`No contract code at ${key} (${existing[key]}) — refusing to build on it.`);
    }
  }

  const treasury = TREASURY_ADDRESS || deployer.address;

  console.log("Redeploying VaultFactory for the v2.1 protocol fee upgrade");
  console.log("Network:            ", hre.network.name);
  console.log("Deployer / operator:", deployer.address);
  console.log();
  console.log("Reusing (unchanged):");
  console.log("  KYCRegistry:      ", existing.kycRegistry);
  console.log("  AssetRegistry:    ", existing.assetRegistry);
  console.log("  InsurancePool:    ", existing.insurancePool);
  console.log();
  console.log("Superseding:");
  console.log("  VaultFactory:     ", existing.vaultFactory || "(none recorded)");
  console.log();

  if (!TREASURY_ADDRESS) {
    console.log("⚠️  TREASURY_ADDRESS is not set in .env — defaulting the protocol");
    console.log("   fee treasury to the deployer address. Set it before any");
    console.log("   deployment you intend to collect fees from.");
    console.log();
  }

  // --- Confirm we are the pool's operator before we start ---
  const pool = await hre.ethers.getContractAt("InsurancePool", existing.insurancePool);
  const poolOperator = await pool.operator();
  if (poolOperator.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Deployer is not the InsurancePool operator (${poolOperator}). ` +
      `setVaultFactory would revert, leaving the new factory unable to register vaults.`
    );
  }

  const reserveBefore = {};
  const registry = await hre.ethers.getContractAt("AssetRegistry", existing.assetRegistry);
  const whitelisted = await registry.getWhitelistedAssets();
  for (const asset of whitelisted) {
    reserveBefore[asset] = await pool.reserveOf(asset);
  }

  // --- Deploy the new factory ---
  // UniswapTwap is a deployed library now, not inlined — VaultFactory
  // embeds Vault, which delegatecalls into it, so the address must be
  // linked at deploy time.
  const twapLib = await (await hre.ethers.getContractFactory("UniswapTwap", deployer)).deploy();
  await twapLib.waitForDeployment();
  const factory = await (await hre.ethers.getContractFactory("VaultFactory", {
    signer: deployer,
    libraries: { UniswapTwap: await twapLib.getAddress() },
  })).deploy(
    existing.kycRegistry,
    existing.assetRegistry,
    existing.insurancePool,
    treasury
  );
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  console.log("✅ New VaultFactory deployed:", factoryAddress);
  console.log("   Treasury:          ", treasury);
  console.log("   Protocol fee rate: ", (await factory.protocolFeeRateBps()).toString(),
              "bps of each loan's fee (add-on, charged to borrower)");
  console.log("   Referrer share:    ", (await factory.referrerShareBps()).toString(), "bps of the protocol fee");

  // --- Rewire the insurance pool ---
  await (await pool.setVaultFactory(factoryAddress)).wait();
  console.log("✅ InsurancePool rewired to the new factory.");
  console.log("   (Vaults registered by the previous factory keep their draw rights.)");

  // --- Confirm reserves survived ---
  console.log("\nInsurance reserves after upgrade (should be unchanged):");
  for (const asset of whitelisted) {
    const after = await pool.reserveOf(asset);
    const symbol = await (await hre.ethers.getContractAt("MockERC20", asset)).symbol();
    const ok = after === reserveBefore[asset] ? "✓" : "✗ CHANGED";
    console.log(`   ${symbol.padEnd(6)} ${after.toString().padStart(12)}  ${ok}`);
  }

  // --- Persist ---
  const updated = {
    ...existing,
    vaultFactory: factoryAddress,
    treasury: treasury,
    previousVaultFactory: existing.vaultFactory,
    factoryUpgradedAt: new Date().toISOString(),
    factoryVersion: "v2.1 — protocol fee",
  };
  allAddresses[hre.network.name] = updated;
  fs.writeFileSync(addressesPath, JSON.stringify(allAddresses, null, 2));
  console.log("\n📄 deployed-addresses.json updated.");

  console.log("\n" + "─".repeat(60));
  console.log("Verify:\n");
  console.log(`npx hardhat verify --network ${hre.network.name} ${factoryAddress} ${existing.kycRegistry} ${existing.assetRegistry} ${existing.insurancePool} ${treasury}`);

  console.log("\nNext steps:");
  console.log("  1. npx hardhat run scripts/lifecycle-proof.js --network " + hre.network.name);
  console.log("     (repopulates vault history and proves the fee on-chain)");
  console.log("  2. Update the frontend's contracts.js vaultFactory address to:");
  console.log("     " + factoryAddress);
  console.log("  3. Update the frontend ABI for the 8-argument deployVault.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});