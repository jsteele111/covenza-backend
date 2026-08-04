/**
 * Proves, on the live chain, that the deployed contracts really do hold the
 * two-step role transfer — and then puts everything back.
 *
 * WHY THIS EXISTS: the unit suite proves the SOURCE is right. It cannot prove
 * the deployment picked the source up. Twice today a contract change reached
 * git without reaching the chain, and both times the tests stayed green while
 * the live system behaved the old way. A redeploy that silently reused a stale
 * artifact would look exactly like a successful one.
 *
 * The check that matters is the dangerous one: nominating must NOT hand over
 * control. So this nominates a throwaway address, asserts the incumbent is
 * still in charge and the nominee still powerless, then cancels. If the
 * deployed code were the old one-step version, step two would have already
 * given the role away — which is why the probe target is an account we
 * control rather than an arbitrary address.
 *
 * Usage:
 *   npx hardhat run scripts/verify-two-step.js --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

function ok(label)      { console.log(`  PASS  ${label}`); }
function fail(label, e) { console.log(`  FAIL  ${label}\n        ${e}`); process.exitCode = 1; }

async function main() {
  const { ethers } = hre;
  const [operator, probe] = await ethers.getSigners();

  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  )[hre.network.name];

  const kyc      = await ethers.getContractAt("KYCRegistry", d.kycRegistry);
  const registry = await ethers.getContractAt("AssetRegistry", d.assetRegistry);
  const pool     = await ethers.getContractAt("InsurancePool", d.insurancePool);
  const factory  = await ethers.getContractAt("VaultFactory", d.vaultFactory);

  console.log("=".repeat(70));
  console.log("Two-step role transfer — live verification");
  console.log("=".repeat(70));
  console.log(`Incumbent  ${operator.address}`);
  console.log(`Probe      ${probe.address}\n`);

  // --- 1. The new surface exists at all -------------------------------------
  // A stale artifact would revert here: calls to a function the deployed
  // bytecode lacks return no data.
  console.log("Deployed contracts expose the pending-role view:");
  for (const [label, c, getter] of [
    ["AssetRegistry", registry, "pendingOperator"],
    ["KYCRegistry",   kyc,      "pendingOperator"],
    ["InsurancePool", pool,     "pendingOperator"],
    ["VaultFactory",  factory,  "pendingOwner"],
  ]) {
    try {
      const pending = await c[getter]();
      if (pending !== ethers.ZeroAddress) {
        throw new Error(`unexpected nomination outstanding: ${pending}`);
      }
      ok(`${label}.${getter}() reads clean`);
    } catch (e) {
      fail(`${label}.${getter}()`, e.shortMessage || e.message);
      console.log("\nAborting — the deployment does not carry this change.");
      return;
    }
  }

  // --- 2. Nominating does NOT transfer --------------------------------------
  console.log("\nNominating the probe on KYCRegistry:");
  await (await kyc.transferOperator(probe.address)).wait();

  try {
    const held = await kyc.operator();
    if (held.toLowerCase() !== operator.address.toLowerCase()) {
      throw new Error(`role already moved to ${held} — this is the OLD one-step code`);
    }
    ok("incumbent still holds the role after nomination");
  } catch (e) {
    fail("incumbent still holds the role after nomination", e.shortMessage || e.message);
  }

  try {
    const pending = await kyc.pendingOperator();
    if (pending.toLowerCase() !== probe.address.toLowerCase()) {
      throw new Error(`pendingOperator is ${pending}`);
    }
    ok("nomination recorded against the probe");
  } catch (e) {
    fail("nomination recorded against the probe", e.shortMessage || e.message);
  }

  // --- 3. A nominee who has not accepted has no powers ----------------------
  try {
    await kyc.connect(probe).verify.staticCall(operator.address);
    fail("nominee is powerless before accepting", "the call SUCCEEDED — it should revert");
  } catch (e) {
    const msg = e.shortMessage || e.message;
    if (msg.includes("Caller is not the operator")) {
      ok("nominee is powerless before accepting");
    } else {
      fail("nominee is powerless before accepting", `reverted, but for the wrong reason: ${msg}`);
    }
  }

  // --- 4. And it can be taken back ------------------------------------------
  console.log("\nCancelling:");
  await (await kyc.cancelOperatorTransfer()).wait();

  try {
    const pending = await kyc.pendingOperator();
    if (pending !== ethers.ZeroAddress) throw new Error(`still ${pending}`);
    ok("nomination cleared");
  } catch (e) {
    fail("nomination cleared", e.shortMessage || e.message);
  }

  try {
    const held = await kyc.operator();
    if (held.toLowerCase() !== operator.address.toLowerCase()) {
      throw new Error(`operator is now ${held}`);
    }
    ok("incumbent unchanged throughout");
  } catch (e) {
    fail("incumbent unchanged throughout", e.shortMessage || e.message);
  }

  console.log("\n" + "=".repeat(70));
  console.log(
    process.exitCode
      ? "FAILED — do not hand control to a multisig against this deployment."
      : "Verified. Handover to a multisig is safe to attempt against this stack."
  );
  console.log("=".repeat(70));
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
