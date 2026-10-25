/**
 * Read-only snapshot of the LOCAL deployment, straight from the chain — for
 * checking what the interface reports against what the contracts hold.
 * Sends no transactions.
 *
 *   npx hardhat run scripts/local-inspect.js --network localhost
 *
 * Prints: chain time; eligibility of the test accounts; balances and
 * allowances; every mandate; every vault with its terms, state and outcome;
 * insurance reserves.
 */
const hre = require("hardhat");
const A = require("../deployed-addresses.json").localhost;

const fmt = (v) => hre.ethers.formatUnits(v, 18);
const SEVERITY = ["no loss", "borrower-only loss", "lender-impacted loss", "settled in kind"];
const TIER = ["Blue chip", "Standard", "Speculative"];

async function main() {
  const { ethers } = hre;
  if ((await ethers.provider.getNetwork()).chainId !== 31337n) throw new Error("Local Hardhat node only.");

  const kyc = await ethers.getContractAt("KYCRegistry", A.kycRegistry);
  const factory = await ethers.getContractAt("VaultFactory", A.vaultFactory);
  const pool = await ethers.getContractAt("InsurancePool", A.insurancePool);
  const tokens = Object.fromEntries(await Promise.all(
    Object.entries(A.tokens).map(async ([s, a]) => [s, await ethers.getContractAt("MockERC20", a)])
  ));
  const sym = (addr) => Object.keys(A.tokens).find((s) => A.tokens[s].toLowerCase() === addr.toLowerCase()) || addr;

  const block = await ethers.provider.getBlock("latest");
  console.log(`Chain time ${new Date(block.timestamp * 1000).toISOString()}  (block ${block.number})\n`);

  const reqB = await factory.requiredBorrowerClaims();
  const reqL = await factory.requiredLenderClaims();
  console.log(`Required claims: borrower ${reqB}, lender ${reqL}`);
  for (const [role, addr] of Object.entries(A.accounts)) {
    if (role === "attester") continue;
    const v = await kyc.verificationOf(addr);
    const bal = await tokens.tUSDG.balanceOf(addr);
    const allow = await tokens.tUSDG.allowance(addr, A.vaultFactory);
    console.log(
      `  ${role.padEnd(9)} claims ${v.claims}  validUntil ${v.validUntil > 0n ? new Date(Number(v.validUntil) * 1000).toISOString().slice(0, 10) : "-"}` +
      `  canBorrow ${await kyc.isEligible(addr, reqB)}  canLend ${reqL === 0n ? true : await kyc.isEligible(addr, reqL)}` +
      `  tUSDG ${fmt(bal)}  allowance→factory ${fmt(allow)}`
    );
  }

  const n = Number(await factory.totalMandates());
  console.log(`\nMandates: ${n}`);
  for (let i = 0; i < n; i++) {
    const m = await factory.mandate(i);
    console.log(
      `  #${i} lender ${m.lender.slice(0, 8)}… ${sym(m.asset)}  per loan ${fmt(m.minPrincipal)}–${fmt(m.maxPrincipal)}` +
      `  capacity ${fmt(m.totalCapacity)} filled ${fmt(m.filled)}  term ${Number(m.minTermSeconds) / 86400}–${Number(m.maxTermSeconds) / 86400}d` +
      `  ${TIER[Number(m.maxTier)]}  live ${await factory.isMandateLive(i)}  fillable ${fmt(await factory.quoteMandateFillable(i))}`
    );
  }

  const vaults = [];
  const totalVaults = Number(await factory.totalVaults());
  for (let i = 0; i < totalVaults; i++) vaults.push(await factory.allVaults(i));
  console.log(`\nVaults: ${vaults.length}`);
  for (const addr of vaults) {
    const v = await ethers.getContractAt("Vault", addr);
    const asset = await v.asset();
    const settled = await v.isSettled();
    const line = [
      `  ${addr}  ${sym(asset)}  principal ${fmt(await v.principal())}  deposit ${fmt(await v.deposit())}`,
      `    apr ${Number(await v.aprBps()) / 100}%  deadline ${new Date(Number(await v.deadline()) * 1000).toISOString()}`,
      `    balance ${fmt(await tokens[sym(asset)].balanceOf(addr))}  held assets ${await v.heldAssetCount()}  settled ${settled}`,
    ];
    for (let i = 0; i < Number(await v.heldAssetCount()); i++) {
      const h = await v.heldAssets(i);
      line.push(`    holds ${sym(h)}: recorded ${fmt(await v.heldAmount(h))}  fee tier ${await v.swapFeeTierOf(h)}`);
    }
    if (settled) {
      line.push(
        `    outcome: ${SEVERITY[Number(await v.lossSeverity())]}${(await v.settledInKind()) ? " (in kind)" : ""}` +
        `  returned ${fmt(await v.settledTotalReturned())}  lender ${fmt(await v.settledLenderPayout())}` +
        `  borrower ${fmt(await v.settledBorrowerPayout())}  insurance ${fmt(await v.settledInsuranceDraw())}` +
        `  bounty ${fmt(await v.settledBounty())}`
      );
      for (const [role, who] of [["lender", await v.lender()], ["borrower", await v.borrower()]]) {
        for (const [s, a] of Object.entries(A.tokens)) {
          const o = await v.owed(a, who);
          if (o > 0n) line.push(`    owed to ${role}: ${fmt(o)} ${s}`);
        }
      }
    }
    console.log(line.join("\n"));
  }

  console.log("\nInsurance reserves:");
  for (const [s, a] of Object.entries(A.tokens)) console.log(`  ${s} ${fmt(await pool.reserveOf(a))}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
