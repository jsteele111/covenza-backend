/**
 * Seeds a testnet deployment with demo activity, so the dashboard, the
 * borrow board and the loan pages show something real to an audience:
 *
 *   1. The LENDER publishes three mandates, one per risk tier, and approves
 *      the factory for their combined capacity.
 *   2. The BORROWER fills two of them — a Blue chip loan and a Standard loan —
 *      at the protocol's deposit floor plus a small margin.
 *   3. The borrower invests part of each loan (tWETH in the Blue chip loan,
 *      tAAPL in the Standard one), inside each loan's investment limit.
 *
 * Every transaction is an ordinary user action through the public contracts:
 * nothing here needs operator rights, and nothing changes a setting.
 *
 * Signers come from hardhat.config.js (the keys in .env), as for the deploy
 * scripts: by default the first is the lender and the second the borrower.
 * Both must be eligible — on a fresh testnet deploy, after
 * scripts/execute-timelocked.js has executed their manual grants.
 *
 * Usage (PowerShell, from the repository root):
 *   npx hardhat run scripts/seed-demo-testnet.js --network robinhoodTestnet
 *
 * Options (environment variables):
 *   MANDATES_ONLY=1   publish the three mandates and stop (mandates last at
 *                     most 7 days; run this before a later demo to refresh them)
 *   LENDER_INDEX / BORROWER_INDEX   which configured signers to use (0 / 1)
 *   BLUE_PRINCIPAL / STD_PRINCIPAL  loan sizes in tUSDG (2000 / 1000)
 *
 * Reads addresses from deployed-addresses.json for the network it runs on.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const DAY = 86400;
const TIER = { BLUE: 0, STANDARD: 1, SPECULATIVE: 2 };

// The mandates: deliberately varied so the board shows how a price surface
// differs by tier. Rates in bps a year; lifetimes at the 7-day protocol limit.
const MANDATES = [
  { label: "Blue chip, 1–30 days",   tier: TIER.BLUE,        minDays: 1, maxDays: 30, min: "100", max: "5000", cap: "20000", base: 800,  perDay: 2,  credit: 10, minDep: 1000, floor: 500 },
  { label: "Standard, 1–7 days",     tier: TIER.STANDARD,    minDays: 1, maxDays: 7,  min: "100", max: "3000", cap: "10000", base: 1200, perDay: 5,  credit: 15, minDep: 2000, floor: 800 },
  { label: "Speculative, 1 day",     tier: TIER.SPECULATIVE, minDays: 1, maxDays: 1,  min: "50",  max: "1000", cap: "3000",  base: 1800, perDay: 0,  credit: 20, minDep: 4000, floor: 1200 },
];

async function main() {
  const { ethers } = hre;
  const network = hre.network.name;
  const signers = await ethers.getSigners();
  const lender = signers[Number(process.env.LENDER_INDEX || 0)];
  const borrower = signers[Number(process.env.BORROWER_INDEX || 1)];
  if (!lender || !borrower) throw new Error("Need two configured signers (lender and borrower).");

  const all = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8"));
  const D = all[network];
  if (!D || !D.vaultFactory) throw new Error(`No ${network} deployment in deployed-addresses.json.`);
  let tokens = D.tokens;
  if (!tokens || !tokens.tUSDG) {
    tokens = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "uniswap-testnet.json"), "utf8")).tokens;
  }
  const usdgAddr = tokens.tUSDG;

  const factory = await ethers.getContractAt("VaultFactory", D.vaultFactory);
  const registry = await ethers.getContractAt("AssetRegistry", D.assetRegistry);
  const kyc = await ethers.getContractAt("KYCRegistry", D.kycRegistry);
  const lens = await ethers.getContractAt("VaultLens", D.vaultLens);
  const erc20 = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];
  const usdg = await ethers.getContractAt(erc20, usdgAddr);
  const E = (n) => ethers.parseEther(String(n));
  const F = (v) => Number(ethers.formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 4 });

  console.log("=".repeat(70));
  console.log(`Covenza demo seed — ${network}`);
  console.log("=".repeat(70));
  console.log(`Lender    ${lender.address}`);
  console.log(`Borrower  ${borrower.address}`);
  console.log(`Factory   ${D.vaultFactory}`);

  // --- Preconditions --------------------------------------------------------
  const lenderOk = await kyc.isEligible(lender.address, await factory.requiredLenderClaims());
  const borrowerOk = await kyc.isEligible(borrower.address, await factory.requiredBorrowerClaims());
  console.log(`Eligible  lender ${lenderOk ? "yes" : "NO"} · borrower ${borrowerOk ? "yes" : "NO"}`);
  if (!lenderOk || (!borrowerOk && !process.env.MANDATES_ONLY)) {
    throw new Error("Both wallets must be eligible. On a fresh deploy, run scripts/execute-timelocked.js first.");
  }
  for (const [sym, a] of [["tWETH", tokens.tWETH], ["tAAPL", tokens.tAAPL]]) {
    if (!a) continue;
    const fee = await registry.poolFeeTier(usdgAddr, a);
    console.log(`Pool      tUSDG/${sym}: ${fee ? `approved at ${Number(fee) / 10000}%` : "NOT APPROVED"}`);
  }

  // --- 1. Mandates ------------------------------------------------------------
  console.log("\n1. Mandates");
  const skim = await factory.insuranceSkimRateBps();
  const totalCap = MANDATES.reduce((s, m) => s + E(m.cap), 0n);
  const lenderBal = await usdg.balanceOf(lender.address);
  if (lenderBal < totalCap) {
    throw new Error(`Lender holds ${F(lenderBal)} tUSDG; the three mandates need ${F(totalCap)}.`);
  }
  // One allowance per asset, shared by all the lender's mandates: set it to
  // the combined capacity (approving sets the figure, it does not add to it).
  await (await usdg.connect(lender).approve(D.vaultFactory, totalCap)).wait();
  console.log(`  approved the factory for ${F(totalCap)} tUSDG (combined capacity)`);

  const ids = [];
  for (const m of MANDATES) {
    const maxTerm = await registry.maxTermForTier(m.tier);
    const maxDays = Math.min(m.maxDays, Number(maxTerm) / DAY);
    const terms = {
      asset: usdgAddr,
      minPrincipal: E(m.min), maxPrincipal: E(m.max),
      minTermSeconds: BigInt(m.minDays * DAY), maxTermSeconds: BigInt(maxDays * DAY),
      validForSeconds: await factory.maxMandateDuration(),
      maxTier: m.tier,
      permittedBorrower: ethers.ZeroAddress,
      baseAprBps: m.base, termPremiumBpsPerDay: m.perDay, depositCreditBpsPerPoint: m.credit,
      minDepositBps: m.minDep, minAprBps: m.floor,
      totalCapacity: E(m.cap),
      // Consent to the insurance contribution in force now, and no more.
      maxInsuranceSkimRateBps: skim,
    };
    const id = await factory.connect(lender).publishMandate.staticCall(terms);
    await (await factory.connect(lender).publishMandate(terms)).wait();
    ids.push(id);
    console.log(`  #${id}  ${m.label}: ${m.min}–${m.max} tUSDG, ${m.base / 100}% base, capacity ${m.cap}`);
  }

  if (process.env.MANDATES_ONLY) {
    console.log("\nMANDATES_ONLY set — no loans opened.");
    return;
  }

  // --- 2. Loans ---------------------------------------------------------------
  console.log("\n2. Loans");
  const loans = [
    { mandate: ids[0], tier: TIER.BLUE, days: 14, principal: E(process.env.BLUE_PRINCIPAL || "2000"), invest: tokens.tWETH, investSym: "tWETH", investShare: 40 },
    { mandate: ids[1], tier: TIER.STANDARD, days: 5, principal: E(process.env.STD_PRINCIPAL || "1000"), invest: tokens.tAAPL, investSym: "tAAPL", investShare: 25 },
  ];

  // What the borrower needs: each loan's deposit (the protocol floor, or the
  // mandate's minimum if higher, plus 1% so rounding never lands below it)
  // and its insurance premium.
  for (const l of loans) {
    const term = BigInt(l.days * DAY);
    const floor = await factory.quoteMinimumDeposit(l.principal, l.tier, term, true);
    const mandateMin = (l.principal * BigInt(MANDATES[l.tier].minDep)) / 10000n;
    const base = floor > mandateMin ? floor : mandateMin;
    l.deposit = base + l.principal / 100n;
    const [, premium] = await factory.quoteFillCost(l.mandate, l.principal, term, true, l.deposit);
    l.premium = premium;
    l.term = term;
  }
  const need = loans.reduce((s, l) => s + l.deposit + l.premium, 0n);
  const have = await usdg.balanceOf(borrower.address);
  console.log(`  borrower holds ${F(have)} tUSDG; the two loans need ${F(need)} (deposits and premiums)`);
  if (have < need) {
    throw new Error("Borrower cannot cover both loans. Lower BLUE_PRINCIPAL / STD_PRINCIPAL, or send the borrower tUSDG.");
  }

  for (const l of loans) {
    const depositBps = (l.deposit * 10000n) / l.principal;
    const [code] = await factory.previewMandateFill(l.mandate, borrower.address, l.principal, l.term, true, l.deposit);
    if (Number(code) !== 0) throw new Error(`Mandate #${l.mandate} would refuse this fill (preview code ${code}).`);
    const apr = await factory.quoteMandateApr(l.mandate, l.term, depositBps);
    await (await usdg.connect(borrower).approve(D.vaultFactory, l.deposit + l.premium)).wait();
    const before = await factory.getVaultsByBorrower(borrower.address);
    await (await factory.connect(borrower).fillMandate(l.mandate, l.principal, l.term, true, l.deposit, apr)).wait();
    const after = await factory.getVaultsByBorrower(borrower.address);
    l.vault = after[after.length - 1];
    if (after.length !== before.length + 1) throw new Error("Fill did not create a vault.");
    console.log(`  ${F(l.principal)} tUSDG for ${l.days} days from mandate #${l.mandate}: deposit ${F(l.deposit)} (${Number(depositBps) / 100}%), premium ${F(l.premium)}, ${Number(apr) / 100}% APR`);
    console.log(`    vault ${l.vault}`);
  }

  // --- 3. Investments -------------------------------------------------------
  console.log("\n3. Investments");
  for (const l of loans) {
    if (!l.invest) { console.log(`  ${l.investSym} not deployed — skipped`); continue; }
    const fee = await registry.poolFeeTier(usdgAddr, l.invest);
    if (!fee) { console.log(`  tUSDG/${l.investSym} pool not approved — skipped (run approve-testnet-pools.js)`); continue; }
    // Each purchase may land at most a little below the average price (the
    // registry's entry-impact limit, fee included), so a large buy into a
    // modest pool is refused. Dry-run first and halve until it fits: no
    // failed transaction is ever sent.
    const vault = await ethers.getContractAt("Vault", l.vault);
    let amountIn = (l.principal * BigInt(l.investShare)) / 100n;
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++, amountIn /= 2n) {
      const [quotable, , minOut] = await lens.quoteSwapOut(l.vault, l.invest, amountIn, fee);
      if (!quotable) { console.log(`  ${l.investSym}: no price quote yet — skipped`); break; }
      try {
        await vault.connect(borrower).swap.staticCall(l.invest, amountIn, minOut, fee);
      } catch {
        continue;
      }
      await (await vault.connect(borrower).swap(l.invest, amountIn, minOut, fee)).wait();
      const pct = Number((amountIn * 10000n) / l.principal) / 100;
      console.log(`  ${F(amountIn)} tUSDG → ${l.investSym} in vault ${l.vault.slice(0, 10)}… (${pct}% of the loan)`);
      done = true;
    }
    if (!done) console.log(`  ${l.investSym}: the pool is too shallow for a purchase this size — the loan stays in tUSDG`);
  }

  console.log("\nDone. The dashboard, Borrow and Lend pages now show this activity.");
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
