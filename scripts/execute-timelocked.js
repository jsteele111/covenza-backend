/**
 * Executes admin calls announced by scripts/lib/timelock.js once their delay
 * has passed. Safe to run repeatedly: it reports what is still waiting,
 * executes what is ready, and flags what has lapsed.
 *
 * Usage:
 *   npx hardhat run scripts/execute-timelocked.js --network robinhoodTestnet
 *   LIST_ONLY=1 npx hardhat run scripts/execute-timelocked.js --network robinhoodTestnet
 *
 * A lapsed approval (more than 14 days past its delay) cannot be executed; the
 * call must be announced again, by re-running the script that queued it.
 */

const hre = require("hardhat");
const { readPending, clearPending, fmt } = require("./lib/timelock");

const TIMELOCK_ABI = [
  "function isExecutable(bytes32) view returns (bool)",
  "function queuedAt(bytes32) view returns (uint256)",
  "function timeUntilExecutable(bytes32) view returns (uint256)",
  "function executionDeadline(bytes32) view returns (uint256)",
];

async function main() {
  const { ethers } = hre;
  const network = hre.network.name;
  const [signer] = await ethers.getSigners();
  const pending = readPending()[network] || [];

  console.log(`Pending timelocked actions on ${network}: ${pending.length}`);
  if (pending.length === 0) return;

  const now = BigInt(Math.floor(Date.now() / 1000));

  for (const p of pending) {
    const c = new ethers.Contract(p.target, TIMELOCK_ABI, signer);
    const queuedAt = await c.queuedAt(p.id);

    if (queuedAt === 0n) {
      console.log(`\n- ${p.label}: no longer queued (executed or cancelled elsewhere). Removing.`);
      clearPending(network, p.id);
      continue;
    }
    if ((await c.executionDeadline(p.id)) < now) {
      console.log(`\n- ${p.label}: LAPSED. Announce it again by re-running the script that queued it.`);
      continue;
    }
    if (!(await c.isExecutable(p.id))) {
      console.log(`\n- ${p.label}: waiting, ${fmt(await c.timeUntilExecutable(p.id))} to go.`);
      continue;
    }
    if (process.env.LIST_ONLY === "1") {
      console.log(`\n- ${p.label}: READY.`);
      continue;
    }

    console.log(`\n- ${p.label}: executing...`);
    const tx = await signer.sendTransaction({ to: p.target, data: p.data });
    await tx.wait();
    console.log(`  done (${tx.hash})`);
    clearPending(network, p.id);
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
