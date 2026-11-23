/**
 * Runs one small matched-pair carry loan on a TEST network deployment, step by
 * step, for the Sepolia rehearsal (deployment plan v2, section 6). Refuses to
 * run on Ethereum mainnet: real loans are opened by real lenders through the
 * partner's app, never by this script.
 *
 * Uses the test tokens from setup-sepolia-carry-pool.js, which anyone can mint.
 * The lender is the first key in .env (DEVTEST_PRIVATE_KEY), the borrower the
 * second (BORROWER_PRIVATE_KEY). Both need a little Sepolia ETH for gas.
 *
 * Phases, in order (PHASE=…):
 *   fund-reserve  mint test WETH and fund the protection reserve (AMOUNT, default 50)
 *   grant         announce identity grants for the lender and borrower; with a
 *                 timelock they apply after the delay, via execute-timelocked.js
 *   open          open a loan (PRINCIPAL default 10 tWETH, TERM_SECONDS default 3600,
 *                 2% a year, the minimum deposit), pay the deposit, buy twstETH
 *   settle        after the deadline, the lender settles; prints who got what
 *
 * Usage:
 *   PHASE=fund-reserve npx hardhat run scripts/carry-demo-loan.js --network sepolia
 */

const fs = require("fs");
const path = require("path");
const { isProduction } = require("./lib/production-guards");
const { sendOrQueue } = require("./lib/timelock");

const DEFAULT_ADDRESSES_PATH = path.join(__dirname, "..", "deployed-addresses.json");
const APR_BPS = 200;

function contracts(ethers, d, signer) {
  return Promise.all([
    ethers.getContractAt("MockERC20", d.tokens.WETH, signer),
    ethers.getContractAt("KYCRegistry", d.kycRegistry, signer),
    ethers.getContractAt("InsurancePool", d.insurancePool, signer),
    ethers.getContractAt("VaultFactory", d.vaultFactory, signer),
  ]);
}

async function fundReserve({ ethers, d, lender, amount, log = console.log }) {
  const [weth, , reserve] = await contracts(ethers, d, lender);
  await (await weth.mint(lender.address, amount)).wait();
  await (await weth.approve(d.insurancePool, amount)).wait();
  await (await reserve.fund(d.tokens.WETH, amount)).wait();
  log(`Protection reserve now holds ${ethers.formatEther(await reserve.reserveOf(d.tokens.WETH))} tWETH`);
}

async function grant({ ethers, d, lender, borrower, network, log = console.log }) {
  const [, kyc] = await contracts(ethers, d, lender);
  for (const [who, w] of [["lender", lender], ["borrower", borrower]]) {
    if (await kyc.isEligible(w.address, 7)) { log(`${who} ${w.address}: already eligible`); continue; }
    await sendOrQueue(kyc, "verify", [w.address, 7, ethers.id(`rehearsal-${who}-${w.address}`)],
      { network, label: `identity grant, ${who} ${w.address} (30 days)` });
  }
}

async function open({ ethers, d, lender, borrower, principal, termSeconds, addressesPath, network, log = console.log }) {
  const [weth, , , factory] = await contracts(ethers, d, lender);
  const deposit = await factory.quoteMinimumDeposit(principal, 0, termSeconds, true);
  await (await weth.mint(lender.address, principal)).wait();
  await (await weth.approve(d.vaultFactory, principal)).wait();
  await (await factory.deployVaultWithTier(d.tokens.WETH, borrower.address, principal, APR_BPS, termSeconds, true, deposit, ethers.ZeroAddress, 0)).wait();
  const vaultAddr = await factory.allVaults((await factory.totalVaults()) - 1n);
  const vault = await ethers.getContractAt("Vault", vaultAddr, borrower);
  const premium = await vault.insurancePremium();
  const wethB = weth.connect(borrower);
  await (await wethB.mint(borrower.address, deposit + premium)).wait();
  await (await wethB.approve(vaultAddr, deposit + premium)).wait();
  await (await vault.payDeposit()).wait();
  await (await vault.swap(d.tokens.wstETH, principal, 1n, d.uniswap.fee)).wait();
  const deadline = await vault.deadline();
  log(`Vault ${vaultAddr}: ${ethers.formatEther(principal)} tWETH lent, deposit ${ethers.formatEther(deposit)}, ` +
      `premium ${ethers.formatEther(premium)}; holds ${ethers.formatEther(await vault.heldAmount(d.tokens.wstETH))} twstETH`);
  log(`Deadline ${new Date(Number(deadline) * 1000).toISOString()}`);

  const all = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  all[network].demoLoan = { vault: vaultAddr, deadline: Number(deadline), openedAt: new Date().toISOString() };
  fs.writeFileSync(addressesPath, JSON.stringify(all, null, 2));
  return vault;
}

async function settle({ ethers, d, lender, log = console.log }) {
  if (!d.demoLoan) throw new Error("No demo loan recorded. Run PHASE=open first.");
  const vault = await ethers.getContractAt("Vault", d.demoLoan.vault, lender);
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  if (now <= d.demoLoan.deadline) {
    throw new Error(`Too early: the deadline is ${new Date(d.demoLoan.deadline * 1000).toISOString()}.`);
  }
  await (await vault.settle()).wait();
  const f = ethers.formatEther;
  log(`Settled. Vault returned ${f(await vault.settledTotalReturned())} tWETH; ` +
      `lender ${f(await vault.settledLenderPayout())} (interest ${f(await vault.settledFee())}); ` +
      `borrower ${f(await vault.settledBorrowerPayout())}; reserve draw ${f(await vault.settledInsuranceDraw())}`);
}

async function main() {
  const hre = require("hardhat");
  const { ethers } = hre;
  const network = hre.network.name;
  if (isProduction(network)) throw new Error(`Refusing to run on ${network}: this script is for test networks only.`);
  const [lender, borrower] = await ethers.getSigners();
  if (!borrower) throw new Error("Needs two keys in .env: DEVTEST_PRIVATE_KEY (lender) and BORROWER_PRIVATE_KEY (borrower).");
  const addressesPath = DEFAULT_ADDRESSES_PATH;
  const d = JSON.parse(fs.readFileSync(addressesPath, "utf8"))[network];
  if (!d || d.product !== "matched-pair carry") throw new Error(`No carry deployment recorded for ${network}.`);
  const E = ethers.parseEther;

  switch (process.env.PHASE) {
    case "fund-reserve": return fundReserve({ ethers, d, lender, amount: E(process.env.AMOUNT || "50") });
    case "grant":        return grant({ ethers, d, lender, borrower, network });
    case "open":         return open({ ethers, d, lender, borrower, network, addressesPath,
                                       principal: E(process.env.PRINCIPAL || "10"),
                                       termSeconds: Number(process.env.TERM_SECONDS || 3600) });
    case "settle":       return settle({ ethers, d, lender });
    default: throw new Error("Set PHASE to fund-reserve, grant, open or settle.");
  }
}

module.exports = { fundReserve, grant, open, settle };

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
}
