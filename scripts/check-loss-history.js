// Run from the lending-poc backend root:
//   node scripts/check-loss-history.js
//
// Summarizes settlement-history.json (built up by settle.js on every
// settlement) and flags lossy settlements for manual operator review.
// This is the visibility layer for Group C's auto-revoke item (Option C:
// keep revocation manual, but make losses impossible to miss).
//
// Two severities:
//   borrower-only    — deposit absorbed the loss, lender was paid in full.
//                       Normal risk-taking, likely no action needed.
//   lender-impacted   — loss exceeded the deposit, lender received less
//                       than principal + fee. Worth real operator review —
//                       this is the case where revoking KYC might be
//                       warranted, pending human judgment on intent/context.

const fs = require("fs");
const path = require("path");

function main() {
  const historyPath = path.join(__dirname, "..", "settlement-history.json");

  if (!fs.existsSync(historyPath)) {
    console.log("No settlement-history.json found yet — no settlements have been recorded.");
    console.log("(This file is created automatically the first time settle.js runs a settlement.)");
    return;
  }

  const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));

  if (history.length === 0) {
    console.log("settlement-history.json exists but is empty — no settlements recorded yet.");
    return;
  }

  const lenderImpacted = history.filter(h => h.severity === "lender-impacted");
  const borrowerOnly = history.filter(h => h.severity === "borrower-only");
  const clean = history.filter(h => h.severity === "none");

  console.log(`Total settlements recorded: ${history.length}`);
  console.log(`  Clean (no loss):         ${clean.length}`);
  console.log(`  Borrower-only loss:      ${borrowerOnly.length}`);
  console.log(`  ⚠️  Lender-impacted loss: ${lenderImpacted.length}\n`);

  if (lenderImpacted.length > 0) {
    console.log("═".repeat(70));
    console.log("⚠️  LENDER-IMPACTED LOSSES — worth reviewing for possible revocation");
    console.log("═".repeat(70));
    for (const h of lenderImpacted) {
      printEntry(h);
    }
  }

  if (borrowerOnly.length > 0) {
    console.log("─".repeat(70));
    console.log("Borrower-only losses (deposit absorbed it, lender made whole)");
    console.log("─".repeat(70));
    for (const h of borrowerOnly) {
      printEntry(h);
    }
  }
}

function printEntry(h) {
  console.log(`\nVault: ${h.vaultAddress}  (${h.network})`);
  console.log(`  Borrower: ${h.borrower}`);
  console.log(`  Settled:  ${h.settledAt}  (${h.early ? "early close" : "post-deadline"})`);
  console.log(`  Principal: ${h.principal} ETH | Total returned: ${h.totalReturned} ETH`);
  console.log(`  Lender payout: ${h.lenderPayout} ETH | Borrower payout: ${h.borrowerPayout} ETH`);
  console.log(`  Tx: https://sepolia.arbiscan.io/tx/${h.txHash}`);
}

main();