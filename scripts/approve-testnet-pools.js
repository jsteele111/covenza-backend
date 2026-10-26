/**
 * Approves the testnet pools once the settlement config is in force.
 *
 * Why this is a separate step: with a real timelock, deploy-robinhood-testnet.js
 * only ANNOUNCES the settlement config, so the registry keeps its default
 * 1800-second TWAP window until execute-timelocked.js runs an hour later. The
 * pools keep 64 history slots, which clears a 60-second window but not 1800,
 * so setPoolFeeTier refuses them (audit KRAIT-004) and both deploy scripts skip
 * the approval. Run this after the config has been executed.
 *
 * Naming a pair's FIRST pool is instant; nothing here waits on the timelock.
 * Safe to re-run: pairs already approved are left alone.
 *
 *   npx hardhat run scripts/approve-testnet-pools.js --network robinhoodTestnet
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { checkPoolHistory } = require("./lib/pool-history");

async function main() {
  const { ethers } = hre;
  const network = hre.network.name;
  const [signer] = await ethers.getSigners();
  const deployed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"))[network];
  if (!deployed) throw new Error(`No ${network} entry in deployed-addresses.json.`);
  const uni = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "uniswap-testnet.json"), "utf8"));
  const registry = await ethers.getContractAt("AssetRegistry", deployed.assetRegistry);

  const window = Number(await registry.twapWindow());
  console.log(`Registry ${deployed.assetRegistry}, TWAP window ${window}s`);
  if (window > 64) {
    console.log("The settlement config has not been executed yet — run execute-timelocked.js first.");
    return;
  }

  for (const p of uni.pools) {
    let a = p.token0, b = p.token1;
    if (!a || !b) {
      const [x, y] = (p.pair || "").split("/");
      a = uni.tokens[x]; b = uni.tokens[y];
    }
    const label = p.pair || "tUSDG/tWETH";
    if (!a || !b) { console.log(`  ${label}: cannot tell its tokens — skipped`); continue; }
    if (!(await registry.isWhitelisted(a)) || !(await registry.isWhitelisted(b))) {
      console.log(`  ${label}: a token is not listed — skipped`); continue;
    }
    if (Number(await registry.poolFeeTier(a, b)) !== 0) {
      console.log(`  ${label}: already approved at ${await registry.poolFeeTier(a, b)}`); continue;
    }
    const history = await checkPoolHistory(registry, a, b, p.fee, signer);
    if (!history.ok) { console.log(`  ${label}: NOT approved — ${history.reason}`); continue; }
    await (await registry.setPoolFeeTier(a, b, p.fee)).wait();
    console.log(`  ${label}: approved at fee ${p.fee} (${history.cardinality} history slots)`);
  }
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
