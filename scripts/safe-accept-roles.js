/**
 * Executes the acceptance side of the handover, from inside each Safe.
 *
 * This is the step that actually moves control. Everything before it was
 * reversible; after this the deploying EOA governs nothing.
 *
 * WHY IT IS THE POINT: a multisig that cannot reach its signing threshold is
 * indistinguishable from a working one right up until you need it. Making the
 * recipient execute a real transaction to claim the role turns the handover
 * into its own rehearsal — if the Safe cannot do this, it could not have
 * governed the protocol either, and finding out now costs nothing.
 *
 * SIGNATURES: Safe accepts a "pre-validated" signature when the caller is
 * itself an owner — encoded as the owner's address in r, zero in s, and v=1,
 * meaning "the sender vouches for this" rather than carrying an ECDSA
 * signature. That is what lets a 1-of-1 Safe be driven from a script. A real
 * multi-signer Safe would collect signatures off-chain instead, through the
 * Safe UI; this script would then only work for the final execution.
 *
 * Usage:
 *   npx hardhat run scripts/safe-accept-roles.js --network robinhoodTestnet
 *   DRY_RUN=1 npx hardhat run scripts/safe-accept-roles.js --network ...
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const DRY_RUN = process.env.DRY_RUN === "1";

const SAFE_ABI = [
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

function preValidatedSignature(owner) {
  const { ethers } = hre;
  return ethers.concat([
    ethers.zeroPadValue(owner, 32),          // r = the vouching owner
    ethers.zeroPadValue("0x00", 32),         // s = unused
    "0x01",                                  // v = 1 -> pre-validated
  ]);
}

async function main() {
  const { ethers } = hre;
  const [signer] = await ethers.getSigners();

  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  )[hre.network.name];

  if (!d.operatorSafe || !d.ownerSafe) {
    throw new Error("No Safe addresses recorded. Run scripts/create-safes.js first.");
  }

  const jobs = [
    ["AssetRegistry", "AssetRegistry", d.assetRegistry, "acceptOperator",  "operator", d.operatorSafe],
    ["KYCRegistry",   "KYCRegistry",   d.kycRegistry,   "acceptOperator",  "operator", d.operatorSafe],
    ["InsurancePool", "InsurancePool", d.insurancePool, "acceptOperator",  "operator", d.operatorSafe],
    ["VaultFactory",  "VaultFactory",  d.vaultFactory,  "acceptOwnership", "owner",    d.ownerSafe],
  ];

  console.log("=".repeat(70));
  console.log("Accepting roles from inside the Safes");
  console.log("=".repeat(70));
  console.log(`Executing as  ${signer.address}\n`);

  // Refuse to start unless every Safe can actually be driven by this key.
  for (const [label, , , , , safeAddr] of jobs) {
    const safe = new ethers.Contract(safeAddr, SAFE_ABI, signer);
    const owners = await safe.getOwners();
    const threshold = await safe.getThreshold();
    const isOwner = owners.some((o) => o.toLowerCase() === signer.address.toLowerCase());

    if (!isOwner) {
      throw new Error(`${label}: ${signer.address} is not an owner of Safe ${safeAddr}.`);
    }
    if (Number(threshold) !== 1) {
      throw new Error(
        `${label}: Safe ${safeAddr} has threshold ${threshold}. A pre-validated\n` +
        `signature only satisfies a threshold of 1 — collect signatures through\n` +
        `the Safe UI instead.`
      );
    }
  }

  // Nominations must already be in place, or acceptance reverts and the
  // failure looks like a Safe problem rather than a missing prior step.
  console.log("Checking nominations are outstanding:");
  for (const [label, artifact, addr, , getter, safeAddr] of jobs) {
    const c = await ethers.getContractAt(artifact, addr);
    const pendingGetter = getter === "owner" ? "pendingOwner" : "pendingOperator";
    const pending = await c[pendingGetter]();
    if (pending.toLowerCase() !== safeAddr.toLowerCase()) {
      throw new Error(
        `${label}: ${pendingGetter} is ${pending}, expected ${safeAddr}.\n` +
        `Run scripts/transfer-control.js first.`
      );
    }
    console.log(`  ${label.padEnd(15)} nominated -> ${safeAddr}`);
  }

  if (DRY_RUN) {
    console.log("\nDRY_RUN=1 — checks passed, nothing sent.");
    return;
  }

  console.log("\nExecuting:\n");
  for (const [label, artifact, addr, fn, getter, safeAddr] of jobs) {
    const target = await ethers.getContractAt(artifact, addr);
    const data = target.interface.encodeFunctionData(fn, []);

    const safe = new ethers.Contract(safeAddr, SAFE_ABI, signer);
    const tx = await safe.execTransaction(
      addr, 0, data, 0, 0, 0, 0,
      ethers.ZeroAddress, ethers.ZeroAddress,
      preValidatedSignature(signer.address)
    );
    await tx.wait();

    // Safe's execTransaction does NOT revert when the inner call fails — it
    // returns false and emits ExecutionFailure. Checking the resulting state
    // is the only honest confirmation.
    const held = await target[getter]();
    if (held.toLowerCase() !== safeAddr.toLowerCase()) {
      throw new Error(
        `${label}: ${getter} is still ${held}. The Safe transaction executed but ` +
        `the inner call did not take effect.`
      );
    }
    console.log(`  ${label.padEnd(15)} ${getter} -> ${safeAddr}`);
  }

  console.log("\n" + "-".repeat(70));
  console.log("Confirming the old key holds nothing:\n");
  for (const [label, artifact, addr, , getter] of jobs) {
    const c = await ethers.getContractAt(artifact, addr);
    const held = await c[getter]();
    const stillOurs = held.toLowerCase() === signer.address.toLowerCase();
    console.log(`  ${label.padEnd(15)} ${getter} = ${held}  ${stillOurs ? "<-- STILL THE OLD KEY" : "ok"}`);
    if (stillOurs) process.exitCode = 1;
  }

  console.log(`
Handover complete. The deploying key now governs nothing.

Operator actions — listing assets, setting tiers, recognising attesters,
administering the pool — must now go through ${d.operatorSafe}.
Repointing the factory goes through ${d.ownerSafe}.

Scripts that assume the deployer is the operator WILL now fail. That is the
change working, not a regression.`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
