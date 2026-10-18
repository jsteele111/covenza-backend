/**
 * Heartbeat bot for sequencer-outage detection (MAINNET-READINESS item 16).
 *
 * Calls AssetRegistry.heartbeat() every 5 minutes. A gap of more than
 * outageGapThreshold (30 minutes) between heartbeats is recorded on chain as
 * an outage, which extends settlement grace and holds keepers back for the
 * recovery period. Contracts cannot wake themselves, so something off chain
 * has to keep the record current; settle() also heartbeats first, so a
 * stopped bot inconveniences settlement but cannot put funds at risk.
 *
 * Plain Node, not a Hardhat script, so it can run for weeks under pm2.
 *
 * Environment (.env):
 *   HEARTBEAT_PRIVATE_KEY   its own key, holding only gas money (required)
 *   HEARTBEAT_NETWORK       robinhoodTestnet (default) | robinhoodMainnet | localhost
 *   HEARTBEAT_REGISTRY      AssetRegistry address; default from deployed-addresses.json
 *   ROBINHOOD_TESTNET_RPC_URL / ROBINHOOD_MAINNET_RPC_URL   as in hardhat.config.js
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID                     alerts (optional)
 *   HEARTBEAT_INTERVAL_SECONDS   default 300
 *   HEARTBEAT_LOW_BALANCE_ETH    default 0.002
 *
 * Usage:
 *   node scripts/heartbeat-bot.js               run forever (pm2 does this)
 *   node scripts/heartbeat-bot.js --once        one heartbeat, then exit
 *   node scripts/heartbeat-bot.js --test-alert  send a Telegram test message, then exit
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const NETWORKS = {
  robinhoodTestnet: { chainId: 46630n, rpc: process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com" },
  robinhoodMainnet: { chainId: 4663n,  rpc: process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com" },
  localhost:        { chainId: 31337n, rpc: "http://127.0.0.1:8545" },
};

const NETWORK      = process.env.HEARTBEAT_NETWORK || "robinhoodTestnet";
const INTERVAL_S   = Number(process.env.HEARTBEAT_INTERVAL_SECONDS || 300);
// Skip the transaction if a heartbeat (ours, or the one settle() makes) landed
// this recently. Saves gas without ever letting the gap approach 30 minutes.
const SKIP_IF_WITHIN_S = Math.floor(INTERVAL_S * 0.8);
const LOW_BALANCE  = ethers.parseEther(process.env.HEARTBEAT_LOW_BALANCE_ETH || "0.002");
const ALERT_AFTER_FAILURES = 3;              // ~15 minutes: half the outage threshold
const TX_TIMEOUT_MS = 120_000;
const BALANCE_CHECK_EVERY = 12;              // cycles: hourly at 5 minutes
const LOW_BALANCE_REPEAT_MS = 24 * 3600_000; // remind at most daily

const TELEGRAM_API = process.env.TELEGRAM_API_BASE || "https://api.telegram.org"; // overridable for tests

const REGISTRY_ABI = [
  "function heartbeat()",
  "function lastHeartbeat() view returns (uint256)",
  "function outageGapThreshold() view returns (uint256)",
  "event OutageRecorded(uint256 start, uint256 end)",
];

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function alert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { log("[alert, Telegram not configured]", text); return; }
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `Covenza heartbeat (${NETWORK})\n${text}` }),
    });
    if (!res.ok) { log(`[alert failed: Telegram HTTP ${res.status}]`, text); }
  } catch (e) {
    // An alert that cannot be delivered must never stop the heartbeats.
    log("[alert failed]", e.message, "|", text);
  }
}

function registryAddress() {
  if (process.env.HEARTBEAT_REGISTRY) return process.env.HEARTBEAT_REGISTRY;
  const p = path.join(__dirname, "..", "deployed-addresses.json");
  const all = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  const addr = all[NETWORK] && all[NETWORK].assetRegistry;
  if (!addr) throw new Error(`No assetRegistry for ${NETWORK} in deployed-addresses.json; set HEARTBEAT_REGISTRY.`);
  return addr;
}

async function setup() {
  const net = NETWORKS[NETWORK];
  if (!net) throw new Error(`Unknown HEARTBEAT_NETWORK "${NETWORK}".`);
  if (!process.env.HEARTBEAT_PRIVATE_KEY) {
    throw new Error("HEARTBEAT_PRIVATE_KEY is not set. Run: npx hardhat run scripts/generate-heartbeat-key.js");
  }
  const provider = new ethers.JsonRpcProvider(net.rpc);
  const { chainId } = await provider.getNetwork();
  if (chainId !== net.chainId) throw new Error(`RPC is chain ${chainId}, expected ${net.chainId} for ${NETWORK}.`);

  const wallet = new ethers.Wallet(process.env.HEARTBEAT_PRIVATE_KEY, provider);
  const registry = new ethers.Contract(registryAddress(), REGISTRY_ABI, wallet);
  if ((await provider.getCode(await registry.getAddress())).length <= 2) {
    throw new Error(`No contract at ${await registry.getAddress()} on ${NETWORK}.`);
  }
  return { provider, wallet, registry };
}

/** One cycle. Returns "sent" | "skipped"; throws on failure. */
async function beat({ registry }) {
  // Wall-clock time, not the latest block's: an Arbitrum-style chain makes no
  // blocks while idle, so a stale block time would make the last heartbeat
  // look recent and the bot would skip exactly when it is needed.
  const last = await registry.lastHeartbeat();
  const age = Math.floor(Date.now() / 1000) - Number(last);
  if (age < SKIP_IF_WITHIN_S) {
    log(`skip: last heartbeat ${age}s ago`);
    return "skipped";
  }

  const tx = await registry.heartbeat();
  const receipt = await tx.wait(1, TX_TIMEOUT_MS);
  if (!receipt || receipt.status !== 1) throw new Error(`heartbeat ${tx.hash} failed`);

  const outages = receipt.logs
    .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
    .filter((e) => e && e.name === "OutageRecorded");
  for (const o of outages) {
    const mins = Math.round(Number(o.args.end - o.args.start) / 60);
    const msg = `Outage recorded on chain: ${mins} min with no heartbeat (block time ${o.args.start} to ${o.args.end}).`;
    log(msg);
    await alert(msg);
  }
  log(`sent: ${tx.hash} gas ${receipt.gasUsed} (gap was ${age}s)`);
  return "sent";
}

async function checkBalance({ provider, wallet }, state) {
  const bal = await provider.getBalance(wallet.address);
  if (bal < LOW_BALANCE && Date.now() - state.lowBalanceAlertedAt > LOW_BALANCE_REPEAT_MS) {
    state.lowBalanceAlertedAt = Date.now();
    await alert(`Low balance: ${ethers.formatEther(bal)} ETH in ${wallet.address}. Top it up.`);
  }
  return bal;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--test-alert")) {
    await alert("Test message: alerts are working.");
    return;
  }

  const ctx = await setup();
  const threshold = await ctx.registry.outageGapThreshold();
  const bal = await ctx.provider.getBalance(ctx.wallet.address);
  log(`network ${NETWORK}, registry ${await ctx.registry.getAddress()}`);
  log(`bot ${ctx.wallet.address}, balance ${ethers.formatEther(bal)} ETH`);
  log(`interval ${INTERVAL_S}s, outage threshold ${threshold}s`);
  if (threshold === 0n) log("WARNING: outage detection is switched off on this registry; heartbeats record nothing.");

  if (args.includes("--once")) {
    await beat(ctx);
    return;
  }

  await alert(`Started. Bot ${ctx.wallet.address}, balance ${ethers.formatEther(bal)} ETH.`);

  const state = { failures: 0, cycle: 0, lowBalanceAlertedAt: 0, stopping: false };
  const stop = async (sig) => {
    if (state.stopping) return;
    state.stopping = true;
    log(`${sig}: stopping`);
    await alert(`Stopped (${sig}). Gaps over ${threshold}s will now be recorded as outages.`);
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  for (;;) {
    try {
      await beat(ctx);
      if (state.failures >= ALERT_AFTER_FAILURES) {
        await alert(`Recovered after ${state.failures} failed attempts.`);
      }
      state.failures = 0;
    } catch (e) {
      state.failures += 1;
      log(`FAILED (${state.failures} in a row): ${e.shortMessage || e.message}`);
      if (state.failures === ALERT_AFTER_FAILURES) {
        await alert(`${state.failures} heartbeats failed in a row. Last error: ${e.shortMessage || e.message}`);
      }
    }

    if (state.cycle % BALANCE_CHECK_EVERY === 0) {
      try { await checkBalance(ctx, state); } catch (e) { log("balance check failed:", e.message); }
    }
    state.cycle += 1;

    // After a failure, retry sooner (1 minute) rather than wait a full interval.
    const wait = state.failures > 0 ? Math.min(60, INTERVAL_S) : INTERVAL_S;
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

main().catch(async (e) => {
  log("FATAL:", e.shortMessage || e.message);
  await alert(`Bot exited: ${e.shortMessage || e.message}`);
  process.exitCode = 1;
});
