// Settles every expired-but-unsettled vault deployed by the current
// factory — as the KEEPER account, not the lender.
//
// Usage:
//   npx hardhat run scripts/settle-stuck-vaults.js --network arbitrumSepolia
//
// Why this exists: the two failed lifecycle-proof runs (the TWAP tick-sign
// bug, then the unfunded keeper) each left a vault originated, deposited,
// and swapped — but never settled. They sit in the UI flagged "Needs
// settlement", which is untidy for demo footage.
//
// Why settle as the keeper specifically: these vaults are all well past
// their deadline AND past the swap-back grace period, which puts them in
// tier 3 of the access model — open to anyone, with a time-accrued bounty
// paid to whoever does the work. Settling them from the keeper account
// isn't just cleanup, it's a second live demonstration of that tier
// working, on vaults that genuinely sat abandoned rather than ones the
// script deliberately parked there. (Settling as the lender would work
// too, but earns no bounty and proves nothing new.)
//
// Note this is deliberately NOT the old scripts/settle.js — that one is
// v1-era: it formats every amount with formatEther (wrong for 6-decimal
// USDC), assumes a single ETH-denominated vault, and always calls as the
// lender. Rather than retrofit it, this reads each vault's own asset and
// decimals, the same way the v2 UI does.

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const signers = await hre.ethers.getSigners();
  const [lender, borrower, keeper] = signers;
  if (!keeper) {
    throw new Error(
      "No third signer available — add KEEPER_PRIVATE_KEY to .env and fund it with a little Sepolia ETH."
    );
  }

  const addressesPath = path.join(__dirname, "..", "deployed-addresses.json");
  const allAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const d = allAddresses[hre.network.name];
  if (!d || !d.vaultFactory) {
    throw new Error(`No v2 deployment found for network "${hre.network.name}".`);
  }

  const factory = await hre.ethers.getContractAt("VaultFactory", d.vaultFactory);
  const registry = await hre.ethers.getContractAt("AssetRegistry", d.assetRegistry);
  const graceSeconds = Number(await registry.swapBackGracePeriod());

  const total = Number(await factory.totalVaults());
  console.log(`Scanning ${total} vault(s) on ${hre.network.name}...`);
  console.log(`Keeper account: ${keeper.address}\n`);

  const now = Math.floor(Date.now() / 1000);
  const stuck = [];

  for (let i = 0; i < total; i++) {
    const addr = await factory.allVaults(i);
    const vault = await hre.ethers.getContractAt("Vault", addr);
    const [isSettled, deadline] = await Promise.all([vault.isSettled(), vault.deadline()]);
    if (isSettled) continue;
    if (now <= Number(deadline)) {
      console.log(`  ${addr} — still active (not expired), skipping.`);
      continue;
    }
    // The grace period, and therefore the bounty, only exist for vaults
    // HOLDING a foreign asset — those are the ones whose forced swap-back
    // needs a market to be open. A cash-only vault past its deadline is open
    // to anyone immediately and pays nothing. Reporting "bounty applies" on
    // those was simply false, and would have had a keeper expecting payment.
    const held = Number(await vault.heldAssetCount());
    const graceEnd = Number(deadline) + graceSeconds;
    const tier3 = held > 0 && now > graceEnd;
    const label = held === 0
      ? "no foreign assets — open to anyone, no bounty"
      : tier3
      ? "past grace — bounty applies"
      : "in grace — lender or borrower only";
    stuck.push({ addr, vault, tier3 });
    console.log(`  ${addr} — EXPIRED, unsettled (${label})`);
  }

  if (stuck.length === 0) {
    console.log("\nNothing to clean up — no expired unsettled vaults found.");
    return;
  }

  console.log(`\nSettling ${stuck.length} vault(s) as the keeper...\n`);

  for (const { addr, vault, tier3 } of stuck) {
    console.log("─".repeat(60));
    console.log("Vault:", addr);

    if (!tier3) {
      console.log("  Still inside the grace period — only the lender or borrower may settle.");
      console.log("  Skipping (re-run once the grace period has elapsed).");
      continue;
    }

    // Read this vault's own asset + decimals rather than assuming ETH/18.
    const assetAddr = await vault.asset();
    const asset = await hre.ethers.getContractAt("MockERC20", assetAddr);
    const decimals = Number(await asset.decimals());
    const symbol = await asset.symbol();
    const fmt = (v) => `${hre.ethers.formatUnits(v, decimals)} ${symbol}`;

    const keeperBefore = await asset.balanceOf(keeper.address);

    try {
      const tx = await vault.connect(keeper).settle();
      console.log("  Transaction sent, waiting for confirmation...");
      const receipt = await tx.wait();
      console.log("  ✅ Settled. Tx:", receipt.hash);
      // Hardcoded to Arbitrum Sepolia, which produced links to a chain the
      // transaction was never on. Explorer follows the network now.
      const explorers = {
        robinhoodTestnet: "https://explorer.testnet.chain.robinhood.com/tx/",
        robinhoodMainnet: "https://robinhoodchain.blockscout.com/tx/",
        arbitrumSepolia:  "https://sepolia.arbiscan.io/tx/",
      };
      const explorer = explorers[hre.network.name];
      if (explorer) { console.log("     " + explorer + receipt.hash); }

      const [totalReturned, lenderPayout, borrowerPayout, insuranceDraw, bounty, severity] =
        await Promise.all([
          vault.settledTotalReturned(),
          vault.settledLenderPayout(),
          vault.settledBorrowerPayout(),
          vault.settledInsuranceDraw(),
          vault.settledBounty(),
          vault.lossSeverity(),
        ]);

      const keeperAfter = await asset.balanceOf(keeper.address);

      console.log("     Total returned: ", fmt(totalReturned));
      console.log("     Lender payout:  ", fmt(lenderPayout));
      console.log("     Borrower payout:", fmt(borrowerPayout));
      console.log("     Insurance draw: ", fmt(insuranceDraw));
      console.log("     Keeper bounty:  ", fmt(bounty), `(keeper balance ${fmt(keeperBefore)} -> ${fmt(keeperAfter)})`);
      console.log("     Loss severity:  ", Number(severity), "(0 = none, 1 = borrower-only, 2 = lender-impacted)");
    } catch (err) {
      console.log("  ❌ Settlement failed:", err.shortMessage || err.message);
      console.log("     (Most likely the forced swap-back's TWAP bound — check the mock router's");
      console.log("      current rate matches the mock pool's tick for this vault's held asset.)");
    }
    console.log();
  }

  console.log("─".repeat(60));
  console.log("Cleanup complete. Refresh the UI — those vaults should now show as Settled.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});