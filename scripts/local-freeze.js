/**
 * Freezes or unfreezes the local tAAPL test token, as a tokenised equity's
 * issuer can. A vault holding frozen tAAPL cannot sell it, so settle() is
 * refused and in-kind settlement becomes the way out; a payout of frozen
 * tAAPL is recorded in owed() and claimed after unfreezing.
 *
 *   $env:FROZEN="true";  npx hardhat run scripts/local-freeze.js --network localhost
 *   $env:FROZEN="false"; npx hardhat run scripts/local-freeze.js --network localhost
 *
 * Local Hardhat node only; reads tAAPL from deployed-addresses.json.
 */
const hre = require("hardhat");
const addresses = require("../deployed-addresses.json");

async function main() {
  const net = await hre.ethers.provider.getNetwork();
  if (net.chainId !== 31337n) throw new Error("Local Hardhat node only.");
  const frozen = String(process.env.FROZEN).toLowerCase() === "true";
  const token = await hre.ethers.getContractAt("MockFreezableToken", addresses.localhost.tokens.tAAPL);
  await (await token.setFrozen(frozen)).wait();
  console.log(`tAAPL is now ${(await token.frozen()) ? "FROZEN" : "transferable"}.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
