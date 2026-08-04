/**
 * Checks whether Safe's contracts exist on the connected chain.
 *
 * WHY: "hand control to a multisig" assumes a multisig can be created. Safe is
 * not a protocol that exists everywhere — it is a set of contracts someone has
 * to deploy per chain. Robinhood Chain is a new Orbit L2, and app.safe.global
 * only serves chains where these are present.
 *
 * Checking costs nothing and the alternative is discovering it after
 * committing to a handover plan built on a multisig that cannot be created.
 *
 * Addresses below are Safe's canonical deployments, identical across every
 * chain that has them (deployed via a deterministic deployer).
 *
 * Usage:
 *   npx hardhat run scripts/check-safe-support.js --network robinhoodTestnet
 */

const hre = require("hardhat");

const CANONICAL = [
  ["SafeProxyFactory 1.3.0", "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2"],
  ["Safe singleton 1.3.0",   "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552"],
  ["SafeL2 singleton 1.3.0", "0x3E5c63644E683549055b9Be8653de26E0B4CD36E"],
  ["MultiSend 1.3.0",        "0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761"],
  ["SafeProxyFactory 1.4.1", "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"],
  ["Safe singleton 1.4.1",   "0x41675C099F32341bf84BFc5382aF534df5C7461a"],
  ["SafeL2 singleton 1.4.1", "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"],
];

async function main() {
  const { ethers } = hre;
  const net = await ethers.provider.getNetwork();

  console.log("=".repeat(64));
  console.log(`Safe contract availability — ${hre.network.name} (chain ${net.chainId})`);
  console.log("=".repeat(64) + "\n");

  let found = 0;
  for (const [label, addr] of CANONICAL) {
    const code = await ethers.provider.getCode(addr);
    const present = code !== "0x";
    if (present) found++;
    console.log(`  ${present ? "present" : "ABSENT "}  ${label.padEnd(24)} ${addr}`);
  }

  console.log("");
  if (found === 0) {
    console.log("No Safe deployment on this chain.");
    console.log("");
    console.log("Handing control to a Safe is not possible here as things stand.");
    console.log("The realistic options:");
    console.log("");
    console.log("  1. Check whether Safe supports Robinhood Chain mainnet even");
    console.log("     though it does not support testnet — the handover that");
    console.log("     matters is the mainnet one, and testnet is where we");
    console.log("     rehearse it.");
    console.log("  2. Deploy Safe's contracts to this chain ourselves. They are");
    console.log("     public and audited, but self-hosting the UI is real work.");
    console.log("  3. Rehearse the two-step handover against an ordinary second");
    console.log("     EOA. It proves the mechanism — nominate, verify the");
    console.log("     incumbent still governs, accept from the other side — and");
    console.log("     leaves only the Safe itself unproven.");
  } else if (found < CANONICAL.length) {
    console.log(`Partial: ${found}/${CANONICAL.length} present. Some version is deployed.`);
    console.log("Confirm which version app.safe.global will offer before relying on it.");
  } else {
    console.log("Full Safe deployment present. Creating Safes here should work.");
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
