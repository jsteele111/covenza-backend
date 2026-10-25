/**
 * Moves a LOCAL Hardhat node's clock forward, for testing deadlines, grace
 * periods, in-kind windows and timelocks from the interface.
 *
 *   $env:HOURS=26; npx hardhat run scripts/local-time-travel.js --network localhost
 *
 * HOURS may be fractional (0.5 = 30 minutes). Mines one block at the new time,
 * so the interface — which reads time from the latest block — sees it at once.
 */
const hre = require("hardhat");

async function main() {
  const net = await hre.ethers.provider.getNetwork();
  if (net.chainId !== 31337n) throw new Error("Local Hardhat node only.");
  const hours = Number(process.env.HOURS || 0);
  if (!(hours > 0)) throw new Error("Set HOURS, e.g.  $env:HOURS=26");
  const before = (await hre.ethers.provider.getBlock("latest")).timestamp;
  await hre.network.provider.send("evm_increaseTime", [Math.round(hours * 3600)]);
  await hre.network.provider.send("evm_mine", []);
  const after = (await hre.ethers.provider.getBlock("latest")).timestamp;
  console.log(`Chain time ${new Date(before * 1000).toISOString()} -> ${new Date(after * 1000).toISOString()}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
