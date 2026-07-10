const hre = require("hardhat");

async function main() {
  const [lender] = await hre.ethers.getSigners();

  const borrowerAddress = "0x6369ffc9F3D8cdAB69Fa0e6C002ABE617A5D576D";
  const principalAmount = hre.ethers.parseEther("0.001");
  const repaymentDue    = hre.ethers.parseEther("0.00103");  // principal + 3%
  const depositAmount   = hre.ethers.parseEther("0.00015");  // 15% of principal
  const durationDays    = 7;

  console.log("Deploying Vault (production mode — days)...");
  console.log("Lender:       ", lender.address);
  console.log("Borrower:     ", borrowerAddress);
  console.log("Principal:    ", hre.ethers.formatEther(principalAmount), "ETH");
  console.log("Repayment due:", hre.ethers.formatEther(repaymentDue), "ETH");
  console.log("Deposit req:  ", hre.ethers.formatEther(depositAmount), "ETH");
  console.log("Duration:     ", durationDays, "days");

  const VaultFactory = await hre.ethers.getContractFactory("Vault");
 const vault = await VaultFactory.deploy(
    lender.address,
    borrowerAddress,
    repaymentDue,
    durationDays,
    false,
    depositAmount,
    { value: principalAmount }
  );

  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();

  console.log("\n✅ Vault deployed successfully!");
  console.log("   Vault address:", vaultAddress);
  console.log("   Explorer: https://sepolia.arbiscan.io/address/" + vaultAddress);
  console.log("\n   Next: borrower must call payDeposit() with", hre.ethers.formatEther(depositAmount), "ETH");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
