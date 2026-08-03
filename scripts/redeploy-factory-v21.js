// Redeploys the VaultFactory, the Vault implementation and the TWAP library,
// reusing the KYC registry, asset registry and insurance pool in place.
//
// Usage:
//   npx hardhat run scripts/redeploy-factory-v21.js --network hardhat          (dry run)
//   npx hardhat run scripts/redeploy-factory-v21.js --network robinhoodTestnet
//
// Originally written for the v2.1 protocol fee upgrade; it is the general
// script for any change confined to Vault.sol and VaultFactory.sol. As of
// Phase 4 that includes risk tiers, the borrower-funded insurance premium,
// and the mandate system.
//
// WHY NOT A FULL REDEPLOY: KYCRegistry, AssetRegistry and InsurancePool hold
// live state that a redeploy would discard for nothing — the borrower's KYC
// verification, the whitelist and per-asset settlement config, and the
// insurance pool's accumulated reserve. Confirm they are current first with
// diagnose-chain.js, which probes each one's ABI generation; this script
// assumes they are and only replaces what sits above them.
//
// The Vault implementation is redeployed alongside the factory even though
// the factory does not embed it. Clones delegate to whatever implementation
// the factory was given, so leaving a stale one in place would produce a
// factory that knows about tiers and mandates originating vaults that do not.
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

// Timelock delay applied to risk-increasing admin actions: administrative
// withdrawal from the insurance pool, repointing the factory's registries, and
// recognising a new identity provider. Zero on testnet so flows can be
// exercised in one sitting; mainnet must pass a real delay. The value is
// IMMUTABLE once deployed — an operator able to shorten it could shorten it to
// zero, act, and restore.
const TIMELOCK_DELAY = Number(process.env.TIMELOCK_DELAY || 0);

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
  // Vaults are EIP-1167 clones of one implementation, so the factory no
  // longer embeds Vault bytecode and needs no library link. The
  // IMPLEMENTATION does — it delegatecalls UniswapTwap.
  const twapLib = await (await hre.ethers.getContractFactory("UniswapTwap", deployer)).deploy();
  await twapLib.waitForDeployment();
  const vaultImpl = await (await hre.ethers.getContractFactory("Vault", {
    signer: deployer,
    libraries: { UniswapTwap: await twapLib.getAddress() },
  })).deploy();
  await vaultImpl.waitForDeployment();
  const factory = await (await hre.ethers.getContractFactory("VaultFactory", deployer)).deploy(
    existing.kycRegistry,
    existing.assetRegistry,
    existing.insurancePool,
    treasury,
    await vaultImpl.getAddress(),  // clone source
    TIMELOCK_DELAY
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
  // The implementation and library addresses are recorded, not just the
  // factory. Without them a later diagnosis cannot tell which vault logic the
  // clones actually run, and clones carry no reference of their own that is
  // readable off-chain without knowing the EIP-1167 layout.
  const updated = {
    ...existing,
    vaultFactory: factoryAddress,
    vaultImplementation: await vaultImpl.getAddress(),
    uniswapTwapLib: await twapLib.getAddress(),
    treasury: treasury,
    previousVaultFactory: existing.vaultFactory,
    factoryUpgradedAt: new Date().toISOString(),
    factoryVersion: "phase 4 — risk tiers, borrower-funded premium, mandates",
  };
  allAddresses[hre.network.name] = updated;
  fs.writeFileSync(addressesPath, JSON.stringify(allAddresses, null, 2));
  console.log("\n📄 deployed-addresses.json updated.");

  console.log("\n" + "─".repeat(60));
  console.log("Verify:\n");
  console.log(`npx hardhat verify --network ${hre.network.name} ${factoryAddress} ${existing.kycRegistry} ${existing.assetRegistry} ${existing.insurancePool} ${treasury} ${await vaultImpl.getAddress()}`);

  console.log("\nNext steps:");
  console.log("  1. npx hardhat run scripts/diagnose-chain.js --network " + hre.network.name);
  console.log("     (confirms the new factory reports the mandate surface)");
  console.log("  2. In the FRONTEND repo, update src/config/contracts.js:");
  console.log("       vaultFactory:   " + factoryAddress);
  console.log("       vaultImpl:      " + (await vaultImpl.getAddress()));
  console.log("       uniswapTwapLib: " + (await twapLib.getAddress()));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});