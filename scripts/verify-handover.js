/**
 * Proves the handover both ways: the old key is refused, and the Safe governs.
 *
 * Reading `operator()` and seeing the Safe's address is weaker evidence than
 * it looks. It confirms a variable was assigned; it does not confirm the
 * permission checks read that variable, that no other path bypasses them, or
 * that the Safe can in fact drive the contract. Those are three different
 * claims and only the last two matter.
 *
 * So this exercises a real operator action from both sides:
 *
 *   1. From the old deploying key — must be REFUSED.
 *   2. From the operator Safe — must SUCCEED.
 *
 * The action chosen is idempotent: setting tAAPL to the tier it already holds.
 * It proves authority without changing anything, so a failure part-way through
 * leaves no mess to clean up.
 *
 * Usage:
 *   npx hardhat run scripts/verify-handover.js --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const SAFE_ABI = [
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
];

function preValidatedSignature(owner) {
  const { ethers } = hre;
  return ethers.concat([
    ethers.zeroPadValue(owner, 32),
    ethers.zeroPadValue("0x00", 32),
    "0x01",
  ]);
}

function ok(l)       { console.log(`  PASS  ${l}`); }
function fail(l, e)  { console.log(`  FAIL  ${l}\n        ${e}`); process.exitCode = 1; }

async function main() {
  const { ethers } = hre;
  const [oldKey] = await ethers.getSigners();

  const root = path.join(__dirname, "..");
  const d = JSON.parse(fs.readFileSync(path.join(root, "deployed-addresses.json"), "utf8"))[hre.network.name];
  const uni = JSON.parse(fs.readFileSync(path.join(root, "uniswap-testnet.json"), "utf8"));

  const registry = await ethers.getContractAt("AssetRegistry", d.assetRegistry);
  const asset = uni.tokens.tAAPL;

  console.log("=".repeat(70));
  console.log("Handover verification");
  console.log("=".repeat(70));
  console.log(`Old key        ${oldKey.address}`);
  console.log(`Operator Safe  ${d.operatorSafe}\n`);

  const currentTier = await registry.tierOf(asset);
  console.log(`Probe action: setTier(tAAPL, ${currentTier}) — the tier it already holds.\n`);

  // --- 1. The old key must be refused --------------------------------------
  try {
    await registry.connect(oldKey).setTier.staticCall(asset, currentTier);
    fail("old key is refused", "the call SUCCEEDED — the old key can still govern");
  } catch (e) {
    const msg = e.shortMessage || e.message;
    if (msg.includes("Caller is not the operator")) {
      ok("old key is refused, with the operator check");
    } else {
      fail("old key is refused", `reverted for the wrong reason: ${msg}`);
    }
  }

  // --- 2. The Safe must be able to govern ----------------------------------
  const data = registry.interface.encodeFunctionData("setTier", [asset, currentTier]);
  const safe = new ethers.Contract(d.operatorSafe, SAFE_ABI, oldKey);

  try {
    const tx = await safe.execTransaction(
      d.assetRegistry, 0, data, 0, 0, 0, 0,
      ethers.ZeroAddress, ethers.ZeroAddress,
      preValidatedSignature(oldKey.address)
    );
    const receipt = await tx.wait();

    // Safe returns false and emits ExecutionFailure rather than reverting when
    // the inner call fails, so a mined transaction proves nothing on its own.
    const failed = receipt.logs.some((l) => {
      try { return safe.interface.parseLog(l)?.name === "ExecutionFailure"; }
      catch { return false; }
    });
    if (failed) throw new Error("Safe emitted ExecutionFailure — the inner call reverted");

    ok("operator Safe can perform an operator action");
  } catch (e) {
    fail("operator Safe can perform an operator action", e.shortMessage || e.message);
  }

  // --- 3. Nothing was disturbed --------------------------------------------
  try {
    const after = await registry.tierOf(asset);
    if (after !== currentTier) throw new Error(`tier moved ${currentTier} -> ${after}`);
    ok("probe was idempotent — tier unchanged");
  } catch (e) {
    fail("probe was idempotent", e.shortMessage || e.message);
  }

  try {
    const pending = await registry.pendingOperator();
    if (pending !== ethers.ZeroAddress) throw new Error(`pendingOperator is ${pending}`);
    ok("no nomination left outstanding");
  } catch (e) {
    fail("no nomination left outstanding", e.shortMessage || e.message);
  }

  console.log("\n" + "=".repeat(70));
  console.log(
    process.exitCode
      ? "FAILED — control is not where it should be. Investigate before relying on this."
      : "Control has genuinely moved. The old key is refused; the Safe governs."
  );
  console.log("=".repeat(70));
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
