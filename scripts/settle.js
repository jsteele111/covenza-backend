const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Consolidated settlement script — replaces the old repay.js, settle.js, and
// settle-specific.js. Works for both early voluntary close (borrower-only,
// before deadline) and post-deadline default settlement (callable by anyone),
// since both now go through the single Vault.settle() function.
//
// Usage:
//   npx hardhat run scripts/settle.js --network <network>
//     — settles the most recently deployed vault for this network.
//
//   To target a specific vault instead, set VAULT_ADDRESS_OVERRIDE below.
//
// Also appends every settlement outcome to settlement-history.json — this
// is the record used by check-loss-history.js to flag lossy settlements
// for manual operator review (Group C item: auto-revoke, Option C). Kept
// as a running record rather than reconstructed from historical events,
// since Alchemy's free-tier eth_getLogs block-range limit makes scanning
// wide historical ranges impractical.

const VAULT_ADDRESS_OVERRIDE = null; // e.g. "0x..." to target a specific vault

async function main() {
  // --- Resolve which vault to act on ---
  let vaultAddress = VAULT_ADDRESS_OVERRIDE;

  if (!vaultAddress) {
    const vaultsPath = path.join(__dirname, "..", "deployed-vaults.json");
    if (!fs.existsSync(vaultsPath)) {
      throw new Error("deployed-vaults.json not found — run deploy-vault.js first.");
    }
    const vaults = JSON.parse(fs.readFileSync(vaultsPath, "utf8"));
    const vaultsOnThisNetwork = vaults.filter(v => v.network === hre.network.name);
    if (vaultsOnThisNetwork.length === 0) {
      throw new Error(`No vaults found for network "${hre.network.name}" in deployed-vaults.json.`);
    }
    vaultAddress = vaultsOnThisNetwork[vaultsOnThisNetwork.length - 1].vaultAddress;
  }

  const [lender, borrower] = await hre.ethers.getSigners();
  const vault = await hre.ethers.getContractAt("Vault", vaultAddress);

  console.log("Network:", hre.network.name);
  console.log("Vault:", vaultAddress);

  // --- Local networks only: force a block to be mined so block.timestamp catches up ---
  const isLocalNetwork = hre.network.name === "hardhat" || hre.network.name === "localhost";
  if (isLocalNetwork) {
    await hre.network.provider.send("evm_mine");
  }

  const isSettled = await vault.isSettled();
  if (isSettled) {
    console.log("\n❌ This vault is already settled — nothing to do.");
    return;
  }

  const [principal, feeRateBps, deadline, balance] = await Promise.all([
    vault.principal(),
    vault.feeRateBps(),
    vault.deadline(),
    vault.vaultBalance(),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const isEarly = now <= Number(deadline);
  const expectedFee = (principal * feeRateBps) / 10000n;

  console.log("Mode:", isEarly ? "EARLY CLOSE (borrower-triggered)" : "POST-DEADLINE (keeper-triggered)");
  console.log("Principal:", hre.ethers.formatEther(principal), "ETH");
  console.log("Fee rate:", Number(feeRateBps) / 100, "%  (expected fee:", hre.ethers.formatEther(expectedFee), "ETH)");
  console.log("Current plain ETH balance:", hre.ethers.formatEther(balance), "ETH");

  // Early close must be triggered by the borrower specifically.
  const caller = isEarly ? borrower : lender;
  console.log("Calling as:", caller.address, isEarly ? "(borrower)" : "(keeper — anyone can call post-deadline)");

  const tx = await vault.connect(caller).settle();
  console.log("\nTransaction sent, waiting for confirmation...");
  const receipt = await tx.wait();

  // --- Decode the Settled event for a clear picture of what actually happened ---
  let settledEvent = null;
  for (const log of receipt.logs) {
    try {
      const parsed = vault.interface.parseLog(log);
      if (parsed.name === "Settled") {
        settledEvent = parsed.args;
      }
    } catch (e) {
      // log from elsewhere — ignore
    }
  }

  console.log("\n✅ Settlement confirmed!");
  console.log("   Transaction hash:", receipt.hash);
  console.log("   View on explorer: https://sepolia.arbiscan.io/tx/" + receipt.hash);

  if (settledEvent) {
    const lenderTarget = principal + expectedFee;
    const lenderShortfall = lenderTarget - settledEvent.lenderPayout; // >0 means lender took a loss
    const borrowerShortfallVsDeposit = (await vault.deposit()) - settledEvent.borrowerPayout; // >0 means borrower lost some/all deposit
    // Note: deposit() itself is still readable post-settlement — it's never zeroed out.

    let severity = "none";
    if (lenderShortfall > 0n) severity = "lender-impacted";
    else if (borrowerShortfallVsDeposit > 0n) severity = "borrower-only";

    console.log("   Early close:", settledEvent.early);
    console.log("   Total returned to vault at settlement:", hre.ethers.formatEther(settledEvent.totalReturned), "ETH");
    console.log("   Lender payout:", hre.ethers.formatEther(settledEvent.lenderPayout), "ETH");
    console.log("   Borrower payout:", hre.ethers.formatEther(settledEvent.borrowerPayout), "ETH");
    console.log("   Fee charged:", hre.ethers.formatEther(settledEvent.fee), "ETH");
    console.log("   Loss severity:", severity);

    // --- Append to settlement-history.json ---
    const historyPath = path.join(__dirname, "..", "settlement-history.json");
    const history = fs.existsSync(historyPath)
      ? JSON.parse(fs.readFileSync(historyPath, "utf8"))
      : [];

    history.push({
      vaultAddress,
      network: hre.network.name,
      txHash: receipt.hash,
      borrower: await vault.borrower(),
      lender: await vault.lender(),
      early: settledEvent.early,
      principal: hre.ethers.formatEther(principal),
      totalReturned: hre.ethers.formatEther(settledEvent.totalReturned),
      lenderPayout: hre.ethers.formatEther(settledEvent.lenderPayout),
      borrowerPayout: hre.ethers.formatEther(settledEvent.borrowerPayout),
      fee: hre.ethers.formatEther(settledEvent.fee),
      severity,
      settledAt: new Date().toISOString(),
    });

    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    console.log("📄 Recorded to settlement-history.json (severity: " + severity + ")");
  } else {
    console.log("   (Settled event not found in receipt — check manually via vaultBalance()/isSettled())");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});