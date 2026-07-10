const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("Vault", function () {

  // --- Reusable setup variables ---
  let vault;
  let lender;
  let borrower;
  let otherAccount;

  const ONE_ETH   = ethers.parseEther("1.0");
  const REPAYMENT = ethers.parseEther("1.03");  // principal + 3% fee
  const DEPOSIT   = ethers.parseEther("0.15");  // 15% risk buffer
  const DURATION  = 30;                          // 30 days (production mode)

  // --- Deploy a fresh vault before each test ---
  beforeEach(async function () {
    [lender, borrower, otherAccount] = await ethers.getSigners();

    const VaultFactory = await ethers.getContractFactory("Vault");
    vault = await VaultFactory.deploy(
      lender.address,
      borrower.address,
      REPAYMENT,
      DURATION,
      false,
      DEPOSIT,
      { value: ONE_ETH }
    );
    await vault.waitForDeployment();
  });

  // --- Deployment tests ---
  describe("Deployment", function () {

    it("Should record the lender as the deploying address", async function () {
      expect(await vault.lender()).to.equal(lender.address);
    });

    it("Should record the borrower address correctly", async function () {
      expect(await vault.borrower()).to.equal(borrower.address);
    });

    it("Should record the principal correctly", async function () {
      expect(await vault.principal()).to.equal(ONE_ETH);
    });

    it("Should record the repayment amount correctly", async function () {
      expect(await vault.repaymentDue()).to.equal(REPAYMENT);
    });

    it("Should record the required deposit correctly", async function () {
      expect(await vault.requiredDeposit()).to.equal(DEPOSIT);
    });

    it("Should start with deposit unpaid", async function () {
      expect(await vault.depositPaid()).to.equal(false);
      expect(await vault.deposit()).to.equal(0);
    });

    it("Should lock the principal inside the vault", async function () {
      expect(await vault.vaultBalance()).to.equal(ONE_ETH);
    });

    it("Should not be settled at deployment", async function () {
      expect(await vault.isSettled()).to.equal(false);
    });

    it("Should not be expired immediately after deployment", async function () {
      expect(await vault.isExpired()).to.equal(false);
    });

    it("Should set a deadline in the future", async function () {
      const block    = await ethers.provider.getBlock("latest");
      const deadline = await vault.deadline();
      expect(deadline).to.be.greaterThan(block.timestamp);
    });

  });

  // --- Deployment guard tests ---
  describe("Deployment guards", function () {

    it("Should revert if lender address is zero", async function () {
      const VaultFactory = await ethers.getContractFactory("Vault");
      await expect(
        VaultFactory.deploy(
          ethers.ZeroAddress,
          borrower.address,
          REPAYMENT,
          DURATION,
          false,
          DEPOSIT,
          { value: ONE_ETH }
        )
      ).to.be.revertedWith("Invalid lender address");
    });

    it("Should revert if borrower address is zero", async function () {
      const VaultFactory = await ethers.getContractFactory("Vault");
      await expect(
        VaultFactory.deploy(
          lender.address,
          ethers.ZeroAddress,
          REPAYMENT,
          DURATION,
          false,
          DEPOSIT,
          { value: ONE_ETH }
        )
      ).to.be.revertedWith("Invalid borrower address");
    });

    it("Should revert if no ETH is sent as principal", async function () {
      const VaultFactory = await ethers.getContractFactory("Vault");
      await expect(
        VaultFactory.deploy(
          lender.address,
          borrower.address,
          REPAYMENT,
          DURATION,
          false,
          DEPOSIT,
          { value: 0 }
        )
      ).to.be.revertedWith("Principal must be greater than zero");
    });

    it("Should revert if repayment is less than principal", async function () {
      const VaultFactory = await ethers.getContractFactory("Vault");
      await expect(
        VaultFactory.deploy(
          lender.address,
          borrower.address,
          ethers.parseEther("0.5"),
          DURATION,
          false,
          DEPOSIT,
          { value: ONE_ETH }
        )
      ).to.be.revertedWith("Repayment must be >= principal");
    });

    it("Should revert if duration is zero", async function () {
      const VaultFactory = await ethers.getContractFactory("Vault");
      await expect(
        VaultFactory.deploy(
          lender.address,
          borrower.address,
          REPAYMENT,
          0,
          false,
          DEPOSIT,
          { value: ONE_ETH }
        )
      ).to.be.revertedWith("Duration must be greater than zero");
    });

    it("Should revert if deposit amount is zero", async function () {
      const VaultFactory = await ethers.getContractFactory("Vault");
      await expect(
        VaultFactory.deploy(
          lender.address,
          borrower.address,
          REPAYMENT,
          DURATION,
          false,
          0,
          { value: ONE_ETH }
        )
      ).to.be.revertedWith("Deposit must be greater than zero");
    });

  });

  // --- Deposit payment tests ---
  describe("Deposit payment", function () {

    it("Should allow borrower to pay the deposit", async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });
      expect(await vault.depositPaid()).to.equal(true);
      expect(await vault.deposit()).to.equal(DEPOSIT);
    });

    it("Should increase vault balance after deposit is paid", async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });
      expect(await vault.vaultBalance()).to.equal(ONE_ETH + DEPOSIT);
    });

    it("Should emit DepositReceived event on payment", async function () {
      await expect(
        vault.connect(borrower).payDeposit({ value: DEPOSIT })
      ).to.emit(vault, "DepositReceived");
    });

    it("Should revert if non-borrower tries to pay deposit", async function () {
      await expect(
        vault.connect(otherAccount).payDeposit({ value: DEPOSIT })
      ).to.be.revertedWith("Only borrower can pay deposit");
    });

    it("Should revert if wrong deposit amount is sent", async function () {
      await expect(
        vault.connect(borrower).payDeposit({ value: ethers.parseEther("0.05") })
      ).to.be.revertedWith("Must send exact deposit amount");
    });

    it("Should revert if deposit is paid twice", async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });
      await expect(
        vault.connect(borrower).payDeposit({ value: DEPOSIT })
      ).to.be.revertedWith("Deposit already paid");
    });

  });

  // --- Repayment tests ---
  describe("Repayment", function () {

    // Pay deposit before each repayment test
    beforeEach(async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });
    });

    it("Should allow the borrower to repay in full before the deadline", async function () {
      await expect(
        vault.connect(borrower).repay({ value: REPAYMENT })
      ).to.not.be.reverted;
      expect(await vault.isSettled()).to.equal(true);
    });

    it("Should return the deposit to the borrower on repayment", async function () {
      const borrowerBalanceBefore = await ethers.provider.getBalance(borrower.address);

      const tx      = await vault.connect(borrower).repay({ value: REPAYMENT });
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      const borrowerBalanceAfter = await ethers.provider.getBalance(borrower.address);

      // Borrower paid REPAYMENT + gas, received back principal + deposit
      const expectedBalance = borrowerBalanceBefore - REPAYMENT - gasCost + ONE_ETH + DEPOSIT;
      expect(borrowerBalanceAfter).to.equal(expectedBalance);
    });

    it("Should send the repayment to the lender", async function () {
      const lenderBalanceBefore = await ethers.provider.getBalance(lender.address);
      await vault.connect(borrower).repay({ value: REPAYMENT });
      const lenderBalanceAfter = await ethers.provider.getBalance(lender.address);
      expect(lenderBalanceAfter).to.equal(lenderBalanceBefore + REPAYMENT);
    });

    it("Should leave vault balance at zero after repayment", async function () {
      await vault.connect(borrower).repay({ value: REPAYMENT });
      expect(await vault.vaultBalance()).to.equal(0);
    });

    it("Should emit a LoanRepaid event on successful repayment", async function () {
      await expect(
        vault.connect(borrower).repay({ value: REPAYMENT })
      ).to.emit(vault, "LoanRepaid");
    });

    it("Should revert if deposit not yet paid", async function () {
      const VaultFactory = await ethers.getContractFactory("Vault");
      const freshVault = await VaultFactory.deploy(
        lender.address,
        borrower.address,
        REPAYMENT,
        DURATION,
        false,
        DEPOSIT,
        { value: ONE_ETH }
      );
      await freshVault.waitForDeployment();

      await expect(
        freshVault.connect(borrower).repay({ value: REPAYMENT })
      ).to.be.revertedWith("Deposit not yet paid");
    });

    it("Should revert if someone other than the borrower tries to repay", async function () {
      await expect(
        vault.connect(otherAccount).repay({ value: REPAYMENT })
      ).to.be.revertedWith("Only borrower can repay");
    });

    it("Should revert if the wrong repayment amount is sent", async function () {
      await expect(
        vault.connect(borrower).repay({ value: ethers.parseEther("0.5") })
      ).to.be.revertedWith("Must repay exact amount owed");
    });

    it("Should revert if trying to repay after the deadline", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await expect(
        vault.connect(borrower).repay({ value: REPAYMENT })
      ).to.be.revertedWith("Loan deadline has passed");
    });

    it("Should revert if trying to repay twice", async function () {
      await vault.connect(borrower).repay({ value: REPAYMENT });
      await expect(
        vault.connect(borrower).repay({ value: REPAYMENT })
      ).to.be.revertedWith("Loan already settled");
    });

  });

  // --- Default settlement tests ---
  describe("Default settlement", function () {

    beforeEach(async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });
    });

    it("Should revert if trying to settle before deadline", async function () {
      await expect(
        vault.connect(otherAccount).settleDefault()
      ).to.be.revertedWith("Deadline has not yet passed");
    });

    it("Should allow ANY address to trigger settlement after deadline", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await expect(
        vault.connect(otherAccount).settleDefault()
      ).to.not.be.reverted;

      expect(await vault.isSettled()).to.equal(true);
    });

    it("Should send full repaymentDue to lender when vault covers it", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      const lenderBalanceBefore = await ethers.provider.getBalance(lender.address);
      await vault.connect(otherAccount).settleDefault();
      const lenderBalanceAfter = await ethers.provider.getBalance(lender.address);

      expect(lenderBalanceAfter).to.equal(lenderBalanceBefore + REPAYMENT);
    });

    it("Should return excess deposit to borrower when vault covers repaymentDue", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      const borrowerBalanceBefore = await ethers.provider.getBalance(borrower.address);
      await vault.connect(otherAccount).settleDefault();
      const borrowerBalanceAfter = await ethers.provider.getBalance(borrower.address);

      const expectedReturn = ONE_ETH + DEPOSIT - REPAYMENT; // 0.12 ETH
      expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore + expectedReturn);
    });

    it("Should emit LoanDefaulted event on settlement", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await expect(
        vault.connect(otherAccount).settleDefault()
      ).to.emit(vault, "LoanDefaulted");
    });

    it("Should leave vault empty after settlement", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await vault.connect(otherAccount).settleDefault();
      expect(await vault.vaultBalance()).to.equal(0);
    });

    it("Should revert if trying to settle twice", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await vault.connect(otherAccount).settleDefault();
      await expect(
        vault.connect(otherAccount).settleDefault()
      ).to.be.revertedWith("Loan already settled");
    });

    it("Should revert if borrower tries to repay after default settled", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await vault.connect(otherAccount).settleDefault();
      await expect(
        vault.connect(borrower).repay({ value: REPAYMENT })
      ).to.be.revertedWith("Loan already settled");
    });

  });

  // --- Whitelisted Aave supply tests ---
  describe("Whitelisted Aave supply", function () {

    beforeEach(async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });
    });

    it("Should revert if non-borrower tries to call supplyToAave", async function () {
      await expect(
        vault.connect(otherAccount).supplyToAave(ONE_ETH)
      ).to.be.revertedWith("Only borrower can execute");
    });

    it("Should revert if deposit not yet paid", async function () {
      const VaultFactory = await ethers.getContractFactory("Vault");
      const freshVault = await VaultFactory.deploy(
        lender.address,
        borrower.address,
        REPAYMENT,
        DURATION,
        false,
        DEPOSIT,
        { value: ONE_ETH }
      );
      await freshVault.waitForDeployment();

      await expect(
        freshVault.connect(borrower).supplyToAave(ONE_ETH)
      ).to.be.revertedWith("Deposit not yet paid");
    });

    it("Should revert if amount is zero", async function () {
      await expect(
        vault.connect(borrower).supplyToAave(0)
      ).to.be.revertedWith("Amount must be greater than zero");
    });

    it("Should revert if amount exceeds vault balance", async function () {
      const tooMuch = ONE_ETH + DEPOSIT + ethers.parseEther("1.0");
      await expect(
        vault.connect(borrower).supplyToAave(tooMuch)
      ).to.be.revertedWith("Insufficient vault balance");
    });

    it("Should revert if loan deadline has passed", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await expect(
        vault.connect(borrower).supplyToAave(ONE_ETH)
      ).to.be.revertedWith("Loan deadline has passed");
    });

    it("Should revert if loan already settled", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
      await vault.connect(otherAccount).settleDefault();

      await expect(
        vault.connect(borrower).supplyToAave(ONE_ETH)
      ).to.be.revertedWith("Loan already settled");
    });

    // --- Note: the following tests confirm the vault correctly transfers ETH
    // and emits events when calling the whitelisted address. They do NOT
    // confirm real Aave deposit logic executes, since the Aave WETH Gateway
    // does not exist on a local Hardhat network. Real Aave behavior is only
    // verifiable on Arbitrum Sepolia.

    it("Should transfer the specified amount out of the vault", async function () {
      const amount = ethers.parseEther("0.5");
      const balanceBefore = await vault.vaultBalance();

      await vault.connect(borrower).supplyToAave(amount);

      const balanceAfter = await vault.vaultBalance();
      expect(balanceAfter).to.equal(balanceBefore - amount);
    });

    it("Should emit WhitelistedActionExecuted event with correct args", async function () {
      const amount = ethers.parseEther("0.5");

      await expect(
        vault.connect(borrower).supplyToAave(amount)
      )
        .to.emit(vault, "WhitelistedActionExecuted")
        .withArgs(borrower.address, await vault.AAVE_WETH_GATEWAY(), amount, anyValue);
    });

    it("Should allow supplying the full vault balance", async function () {
      const fullBalance = await vault.vaultBalance();

      await expect(
        vault.connect(borrower).supplyToAave(fullBalance)
      ).to.not.be.reverted;

      expect(await vault.vaultBalance()).to.equal(0);
    });

  });

});
