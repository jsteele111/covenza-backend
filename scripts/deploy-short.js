const hre = require("hardhat");

async function main() {
  const [lender] = await hre.ethers.getSigners();

  const borrowerAddress = "0x6369ffc9F3D8cdAB69Fa0e6C002ABE617A5D576D";
  const principalAmount = hre.ethers.parseEther("0.001");
  const repaymentDue    = hre.ethers.parseEther("0.00103");
  const depositAmount   = hre.ethers.parseEther("0.00015");  // 15% of principal
  const durationSeconds = 180; // 3 minutes — enough time to pay deposit then default

  console.log("Deploying short-duration vault (3 minute expiry)...");
  console.log("Lender:      ", lender.address);
  console.log("Borrower:    ", borrowerAddress);
  console.log("Principal:   ", hre.ethers.formatEther(principalAmount), "ETH");
  console.log("Deposit req: ", hre.ethers.formatEther(depositAmount), "ETH");
  console.log("Duration:    ", durationSeconds, "seconds");

  const VaultFactory = await hre.ethers.getContractFactory("Vault");
  const vault = await VaultFactory.deploy(
    lender.address,
    borrowerAddress,
    repaymentDue,
    durationSeconds,
    true,           // _useSeconds = true (test mode)
    depositAmount,
    { value: principalAmount }
  );

  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  const deadline     = await vault.deadline();
  const deadlineDate = new Date(Number(deadline) * 1000).toUTCString();

  console.log("\n✅ Short-duration vault deployed!");
  console.log("   Vault address:", vaultAddress);
  console.log("   Deadline:     ", deadlineDate);
  console.log("   Explorer: https://sepolia.arbiscan.io/address/" + vaultAddress);
  console.log("\n⚡ Step 1: Run pay-deposit.js immediately.");
  console.log("   Step 2: Wait until deadline passes.");
  console.log("   Step 3: Run settle.js to trigger default settlement.");
  console.log("\n   Copy vault address:", vaultAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
