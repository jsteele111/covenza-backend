/**
 * Tops the insurance pool's tUSDG reserve up to the testnet seed (2,000 by
 * default), once the pool has been wired to the factory.
 *
 * Why this exists: since audit M-05 the FIRST factory wiring waits on the
 * timelock, and the pool refuses all funding until it is wired. With
 * TIMELOCK_DELAY=3600, deploy-robinhood-testnet.js therefore cannot seed the
 * pool itself; run this after scripts/execute-timelocked.js.
 *
 * Idempotent: it funds only the shortfall, and does nothing if the reserve
 * is already at the seed. Refuses if the pool is not wired yet.
 *
 * Usage:
 *   npx hardhat run scripts/seed-insurance-testnet.js --network robinhoodTestnet
 *   SEED=5000 npx hardhat run scripts/seed-insurance-testnet.js --network robinhoodTestnet
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const { ethers } = hre;
  const network = hre.network.name;
  const [deployer] = await ethers.getSigners();

  const all = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"));
  const D = all[network];
  if (!D || !D.insurancePool || !D.vaultFactory) {
    throw new Error(`No ${network} deployment in deployed-addresses.json.`);
  }
  let usdg = D.tokens && D.tokens.tUSDG;
  if (!usdg) {
    const U = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "uniswap-testnet.json"), "utf8"));
    usdg = U.tokens.tUSDG;
  }

  const pool = await ethers.getContractAt("InsurancePool", D.insurancePool, deployer);
  const token = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
    usdg, deployer
  );

  const wired = await pool.vaultFactory();
  console.log(`Network         ${network}`);
  console.log(`Insurance pool  ${D.insurancePool}`);
  console.log(`Wired factory   ${wired}`);
  if (wired.toLowerCase() !== D.vaultFactory.toLowerCase()) {
    throw new Error(
      `The pool is not wired to this deployment's factory (${D.vaultFactory}) yet.\n` +
      `Run scripts/execute-timelocked.js once the delay has passed, then this script.`
    );
  }

  const target = ethers.parseEther(process.env.SEED || "2000");
  const reserve = await pool.reserveOf(usdg);
  console.log(`Reserve now     ${ethers.formatEther(reserve)} tUSDG (target ${ethers.formatEther(target)})`);
  if (reserve >= target) {
    console.log("Already at or above the target — nothing to do.");
    return;
  }

  const shortfall = target - reserve;
  const balance = await token.balanceOf(deployer.address);
  if (balance < shortfall) {
    throw new Error(`Deployer holds ${ethers.formatEther(balance)} tUSDG; ${ethers.formatEther(shortfall)} is needed.`);
  }

  await (await token.approve(D.insurancePool, shortfall)).wait();
  await (await pool.fund(usdg, shortfall)).wait();
  console.log(`Funded ${ethers.formatEther(shortfall)} tUSDG.`);
  console.log(`Reserve now     ${ethers.formatEther(await pool.reserveOf(usdg))} tUSDG`);
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
