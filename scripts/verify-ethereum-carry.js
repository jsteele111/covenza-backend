/**
 * Verifies every contract deploy-ethereum-carry.js deployed, on Etherscan
 * (Sepolia or Ethereum mainnet), from the record in deployed-addresses.json.
 *
 * Verification publishes each contract's source next to its bytecode, so
 * anyone can check on Etherscan that what is deployed is exactly the audited
 * code, rather than trusting this repository's console output.
 *
 * Needs ETHERSCAN_API_KEY in .env (one free key covers every Etherscan chain).
 * Safe to re-run: contracts already verified are reported and skipped.
 *
 * Usage:
 *   npx hardhat run scripts/verify-ethereum-carry.js --network sepolia
 *   npx hardhat run scripts/verify-ethereum-carry.js --network mainnet
 */

const fs = require("fs");
const path = require("path");

const EXPLORERS = { 1: "https://etherscan.io", 11155111: "https://sepolia.etherscan.io" };

/** The constructor arguments deploy-ethereum-carry.js used, rebuilt from its record. */
function verificationPlan(d) {
  for (const k of ["deployer", "attester", "treasury", "timelockDelay", "drawCapBps", "uniswap"]) {
    if (d[k] === undefined) throw new Error(`The record has no "${k}". Was it written by deploy-ethereum-carry.js?`);
  }
  const lib = { UniswapTwap: d.uniswapTwapLibrary };
  return [
    { name: "KYCRegistry",   address: d.kycRegistry,   args: [d.deployer, d.attester, d.timelockDelay] },
    { name: "InsurancePool", address: d.insurancePool, args: [d.deployer, d.drawCapBps, d.timelockDelay] },
    { name: "AssetRegistry", address: d.assetRegistry, args: [d.deployer, d.uniswap.router, d.uniswap.factory, d.timelockDelay] },
    { name: "UniswapTwap",   address: d.uniswapTwapLibrary, args: [] },
    { name: "Vault",         address: d.vaultImplementation, args: [], libraries: lib },
    { name: "VaultLens",     address: d.vaultLens, args: [], libraries: lib },
    { name: "VaultFactory",  address: d.vaultFactory,
      args: [d.kycRegistry, d.assetRegistry, d.insurancePool, d.treasury, d.vaultImplementation, d.timelockDelay] },
  ];
}

async function main() {
  const hre = require("hardhat");
  const network = hre.network.name;
  if (!process.env.ETHERSCAN_API_KEY) throw new Error("ETHERSCAN_API_KEY is not set in .env.");
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"));
  const d = all[network];
  if (!d || d.product !== "matched-pair carry") throw new Error(`No carry deployment recorded for ${network}.`);
  const explorer = EXPLORERS[d.chainId] || "(explorer)";

  for (const c of verificationPlan(d)) {
    process.stdout.write(`${c.name.padEnd(14)} ${c.address} ... `);
    try {
      await hre.run("verify:verify", {
        address: c.address,
        constructorArguments: c.args,
        ...(c.libraries ? { libraries: c.libraries } : {}),
      });
      console.log("verified");
    } catch (e) {
      const msg = String(e.message || e);
      if (/already verified/i.test(msg)) console.log("already verified");
      else { console.log("FAILED"); console.log(`  ${msg.split("\n")[0]}`); process.exitCode = 1; }
    }
    console.log(`               ${explorer}/address/${c.address}#code`);
  }
}

module.exports = { verificationPlan };

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
}
