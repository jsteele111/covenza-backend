/**
 * Creates the heartbeat bot's own key and writes it straight into .env, so the
 * private key is never printed. Only the address is shown, for funding.
 *
 * The key holds no protocol powers: anyone may call heartbeat(). Losing it
 * loses only the gas money in it, which is why it is kept separate from the
 * deployer, the Safes and every other role.
 *
 * Refuses to run if .env already has HEARTBEAT_PRIVATE_KEY, so an existing
 * (possibly funded) key is never overwritten.
 *
 * Usage:
 *   node scripts/generate-heartbeat-key.js
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const envPath = path.join(__dirname, "..", ".env");
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

if (/^\s*HEARTBEAT_PRIVATE_KEY\s*=/m.test(existing)) {
  const pk = existing.match(/^\s*HEARTBEAT_PRIVATE_KEY\s*=\s*(\S+)/m)[1];
  console.log("HEARTBEAT_PRIVATE_KEY is already in .env. Not replacing it.");
  console.log(`Its address: ${new ethers.Wallet(pk).address}`);
  process.exit(0);
}

const wallet = ethers.Wallet.createRandom();
const eol = existing.includes("\r\n") ? "\r\n" : "\n";
const prefix = existing.length && !existing.endsWith("\n") ? eol : "";
fs.appendFileSync(envPath,
  `${prefix}${eol}# Heartbeat bot (item 16): gas money only, no protocol powers${eol}` +
  `HEARTBEAT_PRIVATE_KEY=${wallet.privateKey}${eol}`);

console.log("New heartbeat key written to .env (the private key is not shown).");
console.log(`\nAddress to fund: ${wallet.address}`);
console.log("\nTestnet: send it a little faucet ETH. Mainnet: about 0.01 ETH.");
