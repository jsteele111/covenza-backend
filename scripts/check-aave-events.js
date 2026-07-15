// Run from the lending-poc backend root:
//   node scripts/check-aave-events.js
//
// Reads full event history for the vaults flagged as Aave-relevant by
// check-aave-lifecycle.js, to see the actual sequence of what happened
// (rather than inferring from current balances alone).

require("dotenv").config();
const { ethers } = require("ethers");

const VAULTS_OF_INTEREST = [
  "0xb935919Ed043B0ad25A02824B5cCF44681213D36", // currently holds aWETH, unsettled
  "0xC237Cc6A1114614aA9e068ad136e2aa7B6B335C2", // currently holds aWETH, unsettled
  "0xeAFA0C7112B235caF83f12e34B734Ee33616C227", // settled, dust balance — check if Aave was involved
];

const VAULT_ABI = [
  "event VaultInitialised(address indexed lender, address indexed borrower, uint256 principal, uint256 requiredDeposit, uint256 repaymentDue, uint256 deadline)",
  "event DepositReceived(address indexed borrower, uint256 amount)",
  "event LoanRepaid(address indexed borrower, uint256 amountRepaid, uint256 depositReturned, uint256 timestamp)",
  "event LoanDefaulted(address indexed triggeredBy, uint256 principalSwept, uint256 depositApplied, uint256 depositReturned, uint256 timestamp)",
  "event WhitelistedActionExecuted(address indexed borrower, address indexed target, uint256 amount, uint256 timestamp)",
  "event AaveWithdrawn(uint256 amount, uint256 timestamp)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);

  for (const address of VAULTS_OF_INTEREST) {
    console.log("═".repeat(70));
    console.log("Vault:", address);

    const vault = new ethers.Contract(address, VAULT_ABI, provider);

    const filter = {
      address,
      fromBlock: 0,
      toBlock: "latest",
    };

    const logs = await provider.getLogs(filter);
    console.log(`Found ${logs.length} total event(s).\n`);

    for (const log of logs) {
      try {
        const parsed = vault.interface.parseLog(log);
        const block = await provider.getBlock(log.blockNumber);
        const timestamp = new Date(Number(block.timestamp) * 1000).toISOString();
        console.log(`[${timestamp}] ${parsed.name}`);
        for (const [key, value] of Object.entries(parsed.args)) {
          if (isNaN(Number(key))) {
            const display = typeof value === "bigint" ? ethers.formatEther(value) + " ETH" : value;
            console.log(`    ${key}: ${display}`);
          }
        }
      } catch (err) {
        console.log("    (unparseable log, tx:", log.transactionHash, ")");
      }
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});