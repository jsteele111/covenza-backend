/**
 * Creates the two Safes that will hold Covenza's admin roles.
 *
 * WHY TWO: the operator curates — whitelists assets, sets tiers, recognises
 * identity providers, administers the pool. The owner can repoint the factory
 * at entirely different registries. Different powers, different blast radii;
 * one key holding both means a single compromise takes the protocol rather
 * than a slice of it.
 *
 * WHY 1-of-1, FOR NOW: a Safe's address does not change when its owners do.
 * So these can be created today with a single owner, take the roles, and gain
 * real co-signers later through the Safe itself — without Covenza ever being
 * touched again. That deliberately separates "prove the handover mechanism
 * works" from "assemble the signers", because the second is a people problem
 * and should not block the first.
 *
 * Be clear about what this does NOT yet buy: a 1-of-1 Safe offers roughly the
 * same protection against key compromise as the EOA it replaces. The gain is
 * structural — a contract that can gain signers — not immediate.
 *
 * Talks to Safe's canonical contracts directly rather than through the SDK.
 * One less dependency, and the initializer is worth seeing in full since it is
 * what fixes the owner set.
 *
 * Usage:
 *   npx hardhat run scripts/create-safes.js --network robinhoodTestnet
 *   OWNERS=0xA,0xB,0xC THRESHOLD=2 npx hardhat run scripts/create-safes.js --network ...
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Canonical Safe 1.4.1 deployments — identical on every chain that has them.
const PROXY_FACTORY    = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2          = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const FALLBACK_HANDLER = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";

const FACTORY_ABI = [
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
];
const SAFE_ABI = [
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();

  const owners = (process.env.OWNERS || deployer.address)
    .split(",").map((s) => s.trim()).filter(Boolean);
  const threshold = Number(process.env.THRESHOLD || 1);

  for (const o of owners) {
    if (!ethers.isAddress(o)) throw new Error(`Not an address: ${o}`);
  }
  if (threshold < 1 || threshold > owners.length) {
    throw new Error(`Threshold ${threshold} impossible with ${owners.length} owner(s).`);
  }

  console.log("=".repeat(70));
  console.log("Creating Safes");
  console.log("=".repeat(70));
  console.log(`Deployer   ${deployer.address}`);
  console.log(`Owners     ${owners.join(", ")}`);
  console.log(`Threshold  ${threshold} of ${owners.length}`);
  if (owners.length === 1) {
    console.log("\nNOTE: single-owner Safes. Structurally better than an EOA — signers");
    console.log("can be added later without moving the roles again — but NOT yet");
    console.log("better protection against a compromised key. Add co-signers before");
    console.log("this stack sees real money.");
  }

  // A missing fallback handler is survivable (it only affects EIP-1271
  // signature verification and token callbacks), but silently passing
  // address(0) would leave a Safe that cannot verify signatures later.
  if ((await ethers.provider.getCode(FALLBACK_HANDLER)) === "0x") {
    throw new Error(
      `CompatibilityFallbackHandler absent at ${FALLBACK_HANDLER}.\n` +
      `Safe's core is deployed here but its handler is not — creating a Safe\n` +
      `without one is possible but leaves it unable to verify EIP-1271\n` +
      `signatures. Investigate before proceeding.`
    );
  }

  const factory = new ethers.Contract(PROXY_FACTORY, FACTORY_ABI, deployer);
  const safeIface = new ethers.Interface(SAFE_ABI);

  const initializer = safeIface.encodeFunctionData("setup", [
    owners,
    threshold,
    ethers.ZeroAddress,   // no delegatecall on setup
    "0x",                 // no setup data
    FALLBACK_HANDLER,
    ethers.ZeroAddress,   // no payment token
    0,                    // no payment
    ethers.ZeroAddress,   // no payment receiver
  ]);

  const created = {};
  const base = BigInt(Math.floor(Date.now() / 1000));

  for (const [label, key, offset] of [
    ["Operator Safe", "operatorSafe", 0n],
    ["Owner Safe",    "ownerSafe",    1n],
  ]) {
    const saltNonce = base + offset;

    // Predicted first, so a failure surfaces before spending gas and so the
    // address can be checked against what actually gets deployed.
    const predicted = await factory.createProxyWithNonce.staticCall(
      SAFE_L2, initializer, saltNonce
    );

    const tx = await factory.createProxyWithNonce(SAFE_L2, initializer, saltNonce);
    await tx.wait();

    if ((await ethers.provider.getCode(predicted)) === "0x") {
      throw new Error(`${label}: nothing deployed at the predicted address ${predicted}.`);
    }

    const safe = new ethers.Contract(predicted, SAFE_ABI, ethers.provider);
    const gotOwners = await safe.getOwners();
    const gotThreshold = await safe.getThreshold();

    if (Number(gotThreshold) !== threshold || gotOwners.length !== owners.length) {
      throw new Error(
        `${label}: deployed with ${gotOwners.length} owner(s) at threshold ` +
        `${gotThreshold}, expected ${owners.length} at ${threshold}.`
      );
    }

    console.log(`\n${label}  ${predicted}`);
    console.log(`  owners     ${gotOwners.join(", ")}`);
    console.log(`  threshold  ${gotThreshold}`);
    created[key] = predicted;
  }

  const file = path.join(__dirname, "..", "deployed-addresses.json");
  const all = JSON.parse(fs.readFileSync(file, "utf8"));
  all[hre.network.name] = { ...all[hre.network.name], ...created };
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n");

  console.log(`\ndeployed-addresses.json updated (${hre.network.name})`);
  console.log(`
Next, nominate them — this does NOT hand anything over yet:

  $env:OPERATOR_SAFE="${created.operatorSafe}"
  $env:OWNER_SAFE="${created.ownerSafe}"
  npx hardhat run scripts/transfer-control.js --network ${hre.network.name}`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
