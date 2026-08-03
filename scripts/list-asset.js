/**
 * Whitelists an ALREADY-DEPLOYED token on the current asset registry.
 *
 * Exists because deploy-stock-token-testnet.js does the whole job — deploy a
 * token, open a pool, seed it, warm the oracle, list it — which is right the
 * first time and wrong after a registry redeploy. Re-running it would mint a
 * second tAAPL against a second pool, orphaning the one whose oracle is warm
 * and whose price history the existing loans were priced against.
 *
 * Usage:
 *   SYMBOL=tAAPL TIER=1 GRACE_HOURS=72 npx hardhat run scripts/list-asset.js --network robinhoodTestnet
 *   ASSET=0x… TIER=1 GRACE_HOURS=72 npx hardhat run scripts/list-asset.js --network robinhoodTestnet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const SYMBOL      = process.env.SYMBOL || "";
const ASSET_ENV   = process.env.ASSET || "";
const TIER        = Number(process.env.TIER || 1);
const GRACE_HOURS = Number(process.env.GRACE_HOURS || 0);

async function main() {
  const { ethers } = hre;
  const [operator] = await ethers.getSigners();

  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  )[hre.network.name];
  const uni = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "uniswap-testnet.json"), "utf8")
  );

  const asset = ASSET_ENV || uni.tokens[SYMBOL];
  if (!asset) throw new Error(`No address for ${SYMBOL || "(unset)"} — pass ASSET or a known SYMBOL.`);
  if ((await ethers.provider.getCode(asset)) === "0x") {
    throw new Error(`No code at ${asset}. Nothing to list.`);
  }

  const registry = await ethers.getContractAt("AssetRegistry", d.assetRegistry);
  const op = await registry.operator();
  if (op.toLowerCase() !== operator.address.toLowerCase()) {
    throw new Error(`Caller is not the registry operator (${op}).`);
  }

  console.log(`Registry ${d.assetRegistry}`);
  console.log(`Listing  ${SYMBOL || asset} at ${asset}`);
  console.log(`Tier     ${TIER}, grace extension ${GRACE_HOURS}h`);

  if (await registry.isWhitelisted(asset)) {
    console.log("\nAlready whitelisted — setting tier only.");
  } else {
    await (await registry.addAssetWithVenue(
      asset,
      ethers.ZeroAddress,   // no Aave on this chain
      0,                    // YieldVenue.None
      ethers.ZeroAddress,
      GRACE_HOURS * 3600
    )).wait();
    console.log("\nWhitelisted.");
  }

  await (await registry.setTier(asset, TIER)).wait();
  console.log(`Tier set to ${TIER}.`);

  // The tier history seeded here is what a vault's risk mandate is measured
  // against. Worth showing: a freshly listed asset has one entry, so no live
  // loan can be surprised by a tier it never agreed to.
  //
  // Tolerated rather than assumed: a registry deployed before tier history
  // existed has no such function, and reverting on a REPORTING line after the
  // listing already succeeded makes a completed job look failed.
  try {
    console.log(`Tier history entries: ${await registry.tierHistoryLength(asset)}`);
  } catch {
    console.log("Tier history: unavailable — this registry predates it.");
  }

  for (const days of [7, 30]) {
    const bps = await registry.minimumDepositBpsForTier(TIER, days * 86400);
    console.log(`  deposit floor at ${String(days).padStart(2)}d: ${Number(bps) / 100}%`);
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
