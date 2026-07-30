/**
 * Reports deployed bytecode size for every compiled contract against the
 * 24,576-byte EIP-170 limit.
 *
 * Worth having as a standing check rather than a one-off: `hardhat compile`
 * does not enforce the limit, so an oversized contract compiles cleanly and
 * then fails at deployment — which surfaced here as 66 simultaneous test
 * failures all reporting "code too large" from a fixture, with nothing in the
 * output pointing at the actual cause.
 *
 * VaultFactory is the one to watch. It embeds Vault's full creation bytecode,
 * so every byte added to Vault lands in the factory too.
 *
 * Usage:
 *   npx hardhat run scripts/check-sizes.js
 */

const fs = require("fs");
const path = require("path");

const LIMIT = 24576;
const WARN_AT = 0.9;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) out.push(p);
  }
  return out;
}

async function main() {
  const artifactsDir = path.join(__dirname, "..", "artifacts", "contracts");
  if (!fs.existsSync(artifactsDir)) {
    throw new Error("No artifacts — run `npx hardhat compile` first.");
  }

  const rows = [];
  for (const file of walk(artifactsDir)) {
    let a;
    try { a = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (!a.contractName || !a.deployedBytecode || a.deployedBytecode.length <= 2) continue;
    rows.push({
      name: a.contractName,
      deployed: (a.deployedBytecode.length - 2) / 2,
      creation: (a.bytecode.length - 2) / 2,
    });
  }

  rows.sort((a, b) => b.deployed - a.deployed);

  console.log(`\n${"contract".padEnd(26)}${"deployed".padStart(10)}${"creation".padStart(10)}${"headroom".padStart(11)}`);
  console.log("-".repeat(57));

  let over = 0;
  for (const r of rows) {
    const headroom = LIMIT - r.deployed;
    let flag = "";
    if (r.deployed > LIMIT) { flag = "  OVER LIMIT"; over++; }
    else if (r.deployed > LIMIT * WARN_AT) { flag = "  tight"; }
    console.log(
      r.name.padEnd(26) +
      String(r.deployed).padStart(10) +
      String(r.creation).padStart(10) +
      String(headroom).padStart(11) +
      flag
    );
  }

  console.log("-".repeat(57));
  console.log(`Limit ${LIMIT} bytes (EIP-170).`);

  if (over > 0) {
    console.log(`\n${over} contract(s) over the limit — deployment WILL revert.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
