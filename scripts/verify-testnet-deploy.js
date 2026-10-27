/**
 * Independent check of a testnet deployment: reads every contract straight
 * from the chain and compares it with what the deploy scripts are meant to
 * have produced. Read-only; sends nothing.
 *
 * It trusts only two things: the addresses in deployed-addresses.json and
 * uniswap-testnet.json. Everything else — wiring, settings, approvals,
 * eligibility — is read back from the contracts, so a deploy that printed
 * "done" but left something unset shows up here as FAIL.
 *
 *   npx hardhat run scripts/verify-testnet-deploy.js --network robinhoodTestnet
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const EXPECT = {
  timelockDelay: 3600,
  twapWindow: 60, twapToleranceBps: 300, swapBackGracePeriod: 90,
  bountyRatePerHourBps: 3000, bountyCapBps: 200,
  drawCapBps: 1000, maxDrawShareBps: 500,
  requiredBorrowerClaims: 7, requiredLenderClaims: 2,
  tiers: { tUSDG: 0, tWETH: 0, tAAPL: 1 },
  tierConfig: {
    0: [6000, 1000, 30 * 86400, 7000, 100],
    1: [10000, 2000, 7 * 86400, 5000, 250],
    2: [20000, 4000, 86400, 2500, 100],
  },
  poolFee: 3000,
  insuranceSeed: 2000,
};

let pass = 0, fail = 0;
function check(label, ok, detail = "") {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function main() {
  const { ethers } = hre;
  const network = hre.network.name;
  const [me] = await ethers.getSigners();
  const D = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"))[network];
  const U = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "uniswap-testnet.json"), "utf8"));
  const tokens = { ...U.tokens };
  const block = await ethers.provider.getBlock("latest");
  console.log(`Network ${network} (chain ${(await ethers.provider.getNetwork()).chainId}), block ${block.number}, ${new Date(block.timestamp * 1000).toISOString()}\nChecking as ${me.address}\n`);

  // --- Code exists ---------------------------------------------------------
  for (const [label, addr] of [
    ["KYCRegistry", D.kycRegistry], ["AssetRegistry", D.assetRegistry], ["InsurancePool", D.insurancePool],
    ["VaultFactory", D.vaultFactory], ["VaultLens", D.vaultLens], ["Vault implementation", D.vaultImplementation],
    ["UniswapTwap library", D.uniswapTwapLibrary], ["Uniswap factory", U.uniswapFactory], ["SwapRouter02", U.swapRouter],
    ...Object.entries(tokens).map(([s, a]) => [s, a]),
  ]) {
    check(`code at ${label}`, (await ethers.provider.getCode(addr)).length > 2, addr);
  }

  const kyc = await ethers.getContractAt("KYCRegistry", D.kycRegistry);
  const reg = await ethers.getContractAt("AssetRegistry", D.assetRegistry);
  const pool = await ethers.getContractAt("InsurancePool", D.insurancePool);
  const fac = await ethers.getContractAt("VaultFactory", D.vaultFactory);

  // --- Wiring --------------------------------------------------------------
  console.log("");
  check("factory → KYC registry", eq(await fac.kycRegistry(), D.kycRegistry));
  check("factory → asset registry", eq(await fac.assetRegistry(), D.assetRegistry));
  check("factory → insurance pool", eq(await fac.insurancePool(), D.insurancePool));
  check("factory → vault implementation", eq(await fac.vaultImplementation(), D.vaultImplementation));
  check("factory → treasury", eq(await fac.treasury(), D.treasury), await fac.treasury());
  check("insurance pool → factory", eq(await pool.vaultFactory(), D.vaultFactory));
  check("registry → Uniswap factory", eq(await reg.uniswapFactory(), U.uniswapFactory));
  check("registry → swap router", eq(await reg.swapRouter(), U.swapRouter));

  // --- Control -------------------------------------------------------------
  console.log("");
  for (const [label, c, fn] of [["KYC registry", kyc, "operator"], ["asset registry", reg, "operator"], ["insurance pool", pool, "operator"], ["factory", fac, "owner"]]) {
    const who = await c[fn]();
    check(`${label} ${fn}`, eq(who, me.address), who);
    check(`${label} timelock ${EXPECT.timelockDelay}s`, Number(await c.timelockDelay()) === EXPECT.timelockDelay, `${await c.timelockDelay()}s`);
  }

  // --- Settings ------------------------------------------------------------
  console.log("");
  for (const k of ["twapWindow", "twapToleranceBps", "swapBackGracePeriod", "bountyRatePerHourBps", "bountyCapBps"]) {
    const v = Number(await reg[k]());
    check(`registry ${k} = ${EXPECT[k]}`, v === EXPECT[k], String(v));
  }
  for (const k of ["drawCapBps", "maxDrawShareBps"]) {
    const v = Number(await pool[k]());
    check(`insurance ${k} = ${EXPECT[k]}`, v === EXPECT[k], String(v));
  }
  for (const k of ["requiredBorrowerClaims", "requiredLenderClaims"]) {
    const v = Number(await fac[k]());
    check(`factory ${k} = ${EXPECT[k]}`, v === EXPECT[k], String(v));
  }
  for (const [tier, want] of Object.entries(EXPECT.tierConfig)) {
    const c = await reg.tierConfig(Number(tier));
    const got = [c[0], c[1], c[2], c[3], c[4]].map(Number);
    check(`tier ${tier} config`, got.every((v, i) => v === want[i]), got.join(", "));
  }

  // --- Assets and pools ----------------------------------------------------
  console.log("");
  const POOL_ABI = ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)", "function liquidity() view returns (uint128)"];
  const FAC_ABI = ["function getPool(address,address,uint24) view returns (address)"];
  const uniF = new ethers.Contract(U.uniswapFactory, FAC_ABI, me);
  for (const [s, a] of Object.entries(tokens)) {
    check(`${s} whitelisted`, await reg.isWhitelisted(a));
    if (EXPECT.tiers[s] !== undefined) {
      const t = Number(await reg.tierOf(a));
      check(`${s} tier ${EXPECT.tiers[s]}`, t === EXPECT.tiers[s], String(t));
    }
    if (s === "tUSDG") continue;
    const fee = Number(await reg.poolFeeTier(tokens.tUSDG, a));
    check(`tUSDG/${s} approved pool at ${EXPECT.poolFee}`, fee === EXPECT.poolFee, fee ? String(fee) : "none");
    const p = await uniF.getPool(tokens.tUSDG, a, EXPECT.poolFee);
    if (p !== ethers.ZeroAddress) {
      const pc = new ethers.Contract(p, POOL_ABI, me);
      const s0 = await pc.slot0();
      check(`tUSDG/${s} pool keeps > ${EXPECT.twapWindow} history slots`, Number(s0[3]) > EXPECT.twapWindow, `${s0[3]} slots, ${p}`);
      console.log(`      liquidity ${await pc.liquidity()}`);
    }
  }

  // --- Insurance and eligibility --------------------------------------------
  console.log("");
  const reserve = await pool.reserveOf(tokens.tUSDG);
  check(`insurance reserve ≥ ${EXPECT.insuranceSeed} tUSDG`, reserve >= ethers.parseEther(String(EXPECT.insuranceSeed)), ethers.formatEther(reserve));
  const attesters = await kyc.allAttesters();
  check("deployer is a recognised attester", attesters.some((a) => eq(a, me.address)) && (await kyc.attesters(me.address))[0]);
  for (const [label, who, claims] of [["deployer can lend", me.address, EXPECT.requiredLenderClaims], ["borrower can borrow", D.verifiedBorrower, EXPECT.requiredBorrowerClaims]]) {
    const ok = await kyc.isEligible(who, claims);
    const v = await kyc.verificationOf(who);
    check(label, ok, `${who}, claims ${v.claims}, until ${v.validUntil > 0n ? new Date(Number(v.validUntil) * 1000).toISOString().slice(0, 10) : "-"}`);
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
