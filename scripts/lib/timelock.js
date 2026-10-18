/**
 * Timelocked admin calls from scripts: send now when there is no delay,
 * otherwise announce now and execute later.
 *
 * WHY THIS EXISTS. Every risk-increasing setter in the protocol checks
 * `_consumeIfDelayed(keccak256(msg.data))`: with a non-zero timelock it reverts
 * unless that exact call was announced with `queueAction(id)` at least
 * `timelockDelay` earlier, and executed within 14 days after that. Testnet runs
 * with a zero delay, so scripts that call setters directly work there and
 * revert everywhere else. This helper makes the same script correct on both.
 *
 * Contracts with a generic `queueAction(bytes32)`: AssetRegistry,
 * InsurancePool, KYCRegistry (operator) and VaultFactory (owner). Actions with
 * their own queue functions (setVaultFactory, addAttester, rotateAttester,
 * setRegistries, adminWithdraw) are handled by their own scripts.
 *
 * MULTISIG. Once control has been handed to a Safe, the signer running the
 * script is no longer the operator or owner and cannot queue or execute. The
 * helper then prints the exact transaction to propose through the Safe instead
 * of sending a doomed one.
 *
 * PENDING RECORD. Each queued call is written to pending-timelock.json, keyed
 * by network, so scripts/execute-timelocked.js can execute it after the delay
 * without anyone reconstructing the calldata by hand.
 */

const fs = require("fs");
const path = require("path");

const PENDING_PATH = path.join(__dirname, "..", "..", "pending-timelock.json");

function readPending() {
  return fs.existsSync(PENDING_PATH) ? JSON.parse(fs.readFileSync(PENDING_PATH, "utf8")) : {};
}

function writePending(all) {
  fs.writeFileSync(PENDING_PATH, JSON.stringify(all, null, 2));
}

/** The address allowed to queue on `contract`: its owner (VaultFactory) or operator. */
async function roleHolder(contract) {
  try { return await contract.owner(); } catch { return await contract.operator(); }
}

function fmt(seconds) {
  const s = Number(seconds);
  if (s >= 86400) return `${(s / 86400).toFixed(1)} days`;
  if (s >= 3600)  return `${(s / 3600).toFixed(1)} hours`;
  return `${s}s`;
}

/**
 * Calls `contract[method](...args)` if it can take effect now, queues it if it
 * must wait, or prints the Safe transactions if the signer lacks the role.
 *
 * @param {import("ethers").Contract} contract  connected to the signer
 * @param {string} method
 * @param {any[]}  args
 * @param {object} [opts]
 * @param {string} [opts.label]    human description, printed and recorded
 * @param {string} [opts.network]  hre.network.name, for the pending record
 * @returns {Promise<"executed"|"queued"|"waiting"|"safe">}
 */
async function sendOrQueue(contract, method, args, opts = {}) {
  const { ethers } = require("hardhat");
  const label = opts.label || method;
  const network = opts.network || "unknown";
  const target = await contract.getAddress();
  const data = contract.interface.encodeFunctionData(method, args);
  const id = ethers.keccak256(data);
  const delay = await contract.timelockDelay();
  const signer = await contract.runner.getAddress();
  const holder = await roleHolder(contract);

  // The setter itself decides whether a given call waits (e.g. tightening is
  // instant). A static call tells us without guessing: if it would succeed
  // now, just send it.
  let instant = delay === 0n;
  if (!instant && signer.toLowerCase() === holder.toLowerCase()) {
    try {
      await contract[method].staticCall(...args);
      instant = true;
    } catch (e) {
      // Only the timelock's own refusals mean "queue it". Anything else is a
      // bad call, and announcing a bad call would waste the delay.
      const msg = String(e.shortMessage || e.message);
      if (!/not queued|not elapsed|approval expired/.test(msg)) { throw e; }
    }
  }

  if (signer.toLowerCase() !== holder.toLowerCase()) {
    const queueData = contract.interface.encodeFunctionData("queueAction", [id]);
    console.log(`\n  ${label}: the signer is not the role holder (${holder}).`);
    console.log("  Propose these through the Safe:");
    if (delay > 0n) {
      console.log(`    1. now:            to ${target}`);
      console.log(`                       data ${queueData}`);
      console.log(`    2. after ${fmt(delay)}: to ${target}`);
    } else {
      console.log(`    1.                 to ${target}`);
    }
    console.log(`                       data ${data}`);
    return "safe";
  }

  if (instant) {
    const announced = delay > 0n && (await contract.isExecutable(id));
    await (await contract[method](...args)).wait();
    console.log(`  ${label}${announced ? " (announced earlier, now executed)" : ""}`);
    if (announced) { clearPending(network, id); }
    return "executed";
  }

  const queuedAt = await contract.queuedAt(id);
  const expired = queuedAt !== 0n && (await contract.executionDeadline(id)) < BigInt(Math.floor(Date.now() / 1000));
  if (queuedAt !== 0n && !expired) {
    console.log(`  ${label}: already announced, executable in ${fmt(await contract.timeUntilExecutable(id))}`);
    return "waiting";
  }

  await (await contract.queueAction(id)).wait();
  const all = readPending();
  all[network] = (all[network] || []).filter((p) => p.id !== id);
  all[network].push({
    label, target, method, args: args.map(String), data, id,
    executableAt: new Date((Math.floor(Date.now() / 1000) + Number(delay)) * 1000).toISOString(),
    queuedBy: signer,
  });
  writePending(all);
  console.log(`  ${label}: ANNOUNCED. Executable in ${fmt(delay)}, then within 14 days.`);
  console.log("    Run scripts/execute-timelocked.js after the delay.");
  return "queued";
}

function clearPending(network, id) {
  const all = readPending();
  if (!all[network]) return;
  all[network] = all[network].filter((p) => p.id !== id);
  writePending(all);
}

module.exports = { sendOrQueue, readPending, writePending, clearPending, PENDING_PATH, fmt };
