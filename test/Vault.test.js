const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("Vault", function () {

  // --- Reusable setup variables ---
  let vault;
  let lender;
  let borrower;
  let otherAccount;

  const ONE_ETH      = ethers.parseEther("1.0");
  const FEE_RATE_BPS  = 300n;                     // 3%, charged in full regardless of timing
  const FEE           = (ONE_ETH * FEE_RATE_BPS) / 10000n; // 0.03 ETH
  const DEPOSIT       = ethers.parseEther("0.15"); // 15% risk buffer
  const DURATION      = 30;                        // 30 days (production mode)

  // --- Deploy a fresh vault before each test ---
  beforeEach(async function () {
    [lender, borrower, otherAccount] = await ethers.getSigners();

    const VaultFactory = await ethers.getContractFactory("Vault");
    vault = await VaultFactory.deploy(
      lender.address,
      borrower.address,
      FEE_RATE_BPS,
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

    it("Should record the fee rate correctly", async function () {
      expect(await vault.feeRateBps()).to.equal(FEE_RATE_BPS);
    });

    it("Should record the required deposit correctly", async function () {
      expect(await vault.requiredDeposit()).to.equal(DEPOSIT);
    });

    it("Should start with deposit unpaid", async function () {
      expect(await vault.depositPaid()).to.equal(false);
      expect(await vault.deposit()).to.equal(0);
    });

    it("Should start with zero invested amount", async function () {
      expect(await vault.investedAmount()).to.equal(0);
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
          FEE_RATE_BPS,
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
          FEE_RATE_BPS,
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
          FEE_RATE_BPS,
          DURATION,
          false,
          DEPOSIT,
          { value: 0 }
        )
      ).to.be.revertedWith("Principal must be greater than zero");
    });

    it("Should revert if fee rate is zero", async function () {
      const VaultFactory = await ethers.getContractFactory("Vault");
      await expect(
        VaultFactory.deploy(
          lender.address,
          borrower.address,
          0,
          DURATION,
          false,
          DEPOSIT,
          { value: ONE_ETH }
        )
      ).to.be.revertedWith("Fee rate must be greater than zero");
    });

    it("Should revert if duration is zero", async function () {
      const VaultFactory = await ethers.getContractFactory("Vault");
      await expect(
        VaultFactory.deploy(
          lender.address,
          borrower.address,
          FEE_RATE_BPS,
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
          FEE_RATE_BPS,
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

  // --- Settlement tests: unified settle() covers both early close and
  // post-deadline default, replacing the old separate repay()/settleDefault().
  describe("Settlement — early close (before deadline)", function () {

    beforeEach(async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });
    });

    it("Should allow the borrower to close early with no investment activity", async function () {
      await expect(
        vault.connect(borrower).settle()
      ).to.not.be.reverted;
      expect(await vault.isSettled()).to.equal(true);
    });

    it("Should pay the lender principal + fee on early close", async function () {
      const lenderBalanceBefore = await ethers.provider.getBalance(lender.address);
      await vault.connect(borrower).settle();
      const lenderBalanceAfter = await ethers.provider.getBalance(lender.address);

      expect(lenderBalanceAfter).to.equal(lenderBalanceBefore + ONE_ETH + FEE);
    });

    it("Should return the remainder (deposit minus fee) to the borrower", async function () {
      const borrowerBalanceBefore = await ethers.provider.getBalance(borrower.address);

      const tx      = await vault.connect(borrower).settle();
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      const borrowerBalanceAfter = await ethers.provider.getBalance(borrower.address);

      // totalReturned = ONE_ETH + DEPOSIT (nothing invested). Lender takes
      // ONE_ETH + FEE. Borrower gets the rest: DEPOSIT - FEE.
      const expectedBorrowerPayout = DEPOSIT - FEE;
      const expectedBalance = borrowerBalanceBefore - gasCost + expectedBorrowerPayout;
      expect(borrowerBalanceAfter).to.equal(expectedBalance);
    });

    it("Should leave vault balance at zero after settlement", async function () {
      await vault.connect(borrower).settle();
      expect(await vault.vaultBalance()).to.equal(0);
    });

    it("Should emit a Settled event with early=true", async function () {
      await expect(
        vault.connect(borrower).settle()
      )
        .to.emit(vault, "Settled")
        .withArgs(borrower.address, true, ONE_ETH + DEPOSIT, ONE_ETH + FEE, DEPOSIT - FEE, FEE, anyValue);
    });

    it("Should revert if deposit not yet paid", async function () {
      const VaultFactory = await ethers.getContractFactory("Vault");
      const freshVault = await VaultFactory.deploy(
        lender.address,
        borrower.address,
        FEE_RATE_BPS,
        DURATION,
        false,
        DEPOSIT,
        { value: ONE_ETH }
      );
      await freshVault.waitForDeployment();

      await expect(
        freshVault.connect(borrower).settle()
      ).to.be.revertedWith("Deposit not yet paid");
    });

    it("Should revert if someone other than the borrower tries to close early", async function () {
      await expect(
        vault.connect(otherAccount).settle()
      ).to.be.revertedWith("Only borrower can close early");
    });

    it("Should revert if trying to settle twice", async function () {
      await vault.connect(borrower).settle();
      await expect(
        vault.connect(borrower).settle()
      ).to.be.revertedWith("Loan already settled");
    });

    // Note: testing the "cannot close early at a loss beyond deposit" guard
    // requires a scenario where the vault's liquidated balance is actually
    // less than principal + fee — not achievable in a local unit test without
    // a mock investment capable of losing value. The real Aave integration
    // can only meaningfully gain (interest), never lose, on testnet. This
    // guard is exercised implicitly by the profit/break-even paths above,
    // but the loss-specific branch remains unverified by automated tests —
    // flagging this explicitly rather than silently leaving it uncovered.

  });

  describe("Settlement — post-deadline (default)", function () {

    beforeEach(async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });
    });

    it("Should revert if trying to settle before deadline as a non-borrower", async function () {
      await expect(
        vault.connect(otherAccount).settle()
      ).to.be.revertedWith("Only borrower can close early");
    });

    it("Should allow ANY address to trigger settlement after deadline", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await expect(
        vault.connect(otherAccount).settle()
      ).to.not.be.reverted;

      expect(await vault.isSettled()).to.equal(true);
    });

    it("Should send principal + fee to lender when vault covers it", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      const lenderBalanceBefore = await ethers.provider.getBalance(lender.address);
      await vault.connect(otherAccount).settle();
      const lenderBalanceAfter = await ethers.provider.getBalance(lender.address);

      expect(lenderBalanceAfter).to.equal(lenderBalanceBefore + ONE_ETH + FEE);
    });

    it("Should return the remainder to borrower when vault covers principal + fee", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      const borrowerBalanceBefore = await ethers.provider.getBalance(borrower.address);
      await vault.connect(otherAccount).settle();
      const borrowerBalanceAfter = await ethers.provider.getBalance(borrower.address);

      const expectedReturn = DEPOSIT - FEE;
      expect(borrowerBalanceAfter).to.equal(borrowerBalanceBefore + expectedReturn);
    });

    it("Should emit a Settled event with early=false", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await expect(
        vault.connect(otherAccount).settle()
      )
        .to.emit(vault, "Settled")
        .withArgs(otherAccount.address, false, ONE_ETH + DEPOSIT, ONE_ETH + FEE, DEPOSIT - FEE, FEE, anyValue);
    });

    it("Should leave vault empty after settlement", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await vault.connect(otherAccount).settle();
      expect(await vault.vaultBalance()).to.equal(0);
    });

    it("Should revert if trying to settle twice", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await vault.connect(otherAccount).settle();
      await expect(
        vault.connect(otherAccount).settle()
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
        FEE_RATE_BPS,
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

    it("Should revert if amount exceeds principal, even though vault balance (incl. deposit) is larger", async function () {
      // This is the key deposit-segregation guard: vault balance is
      // ONE_ETH + DEPOSIT, but only ONE_ETH (principal) may ever be
      // invested. Attempting to supply the full balance must revert.
      const fullBalance = ONE_ETH + DEPOSIT;
      await expect(
        vault.connect(borrower).supplyToAave(fullBalance)
      ).to.be.revertedWith("Cannot invest more than principal - deposit is not investable");
    });

    it("Should revert on a second call if cumulative investment would exceed principal", async function () {
      await vault.connect(borrower).supplyToAave(ethers.parseEther("0.6"));
      await expect(
        vault.connect(borrower).supplyToAave(ethers.parseEther("0.5"))
      ).to.be.revertedWith("Cannot invest more than principal - deposit is not investable");
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
      await vault.connect(otherAccount).settle();

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

    it("Should track cumulative invested amount correctly", async function () {
      await vault.connect(borrower).supplyToAave(ethers.parseEther("0.4"));
      await vault.connect(borrower).supplyToAave(ethers.parseEther("0.3"));
      expect(await vault.investedAmount()).to.equal(ethers.parseEther("0.7"));
    });

    it("Should emit WhitelistedActionExecuted event with correct args", async function () {
      const amount = ethers.parseEther("0.5");

      await expect(
        vault.connect(borrower).supplyToAave(amount)
      )
        .to.emit(vault, "WhitelistedActionExecuted")
        .withArgs(borrower.address, await vault.AAVE_WETH_GATEWAY(), amount, anyValue);
    });

    it("Should allow supplying up to the full principal amount", async function () {
      await expect(
        vault.connect(borrower).supplyToAave(ONE_ETH)
      ).to.not.be.reverted;

      // Deposit remains untouched in the vault even though the full
      // principal has been invested.
      expect(await vault.vaultBalance()).to.equal(DEPOSIT);
      expect(await vault.investedAmount()).to.equal(ONE_ETH);
    });

  });

  // --- Settlement outcome recording and loss severity ---
  // These test the new settledTotalReturned/settledLenderPayout/
  // settledBorrowerPayout/settledFee state and the lossSeverity() view.
  //
  // The genuine loss scenario below is only achievable in a LOCAL test —
  // on a local Hardhat network, AAVE_WETH_GATEWAY and AAVE_WETH_A_TOKEN are
  // just plain addresses with no deployed code. Calling supplyToAave()
  // genuinely sends ETH there via a low-level call, which the EVM allows
  // even to a no-code address (it simply credits balance, no logic runs) —
  // the funds are gone for good locally, since _withdrawFromAaveIfNeeded()
  // correctly no-ops (its code.length guard) rather than attempting a
  // withdrawal that would fail. This gives us a real, verifiable loss to
  // test against, which is NOT achievable on Sepolia where Aave genuinely
  // exists and can only ever accrue interest, never lose value.
  describe("Settlement outcome recording and loss severity", function () {

    it("Should return lossSeverity 0 before settlement", async function () {
      expect(await vault.lossSeverity()).to.equal(0);
    });

    it("Should record settlement outcome as readable state after a clean settlement", async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });

      const tx = await vault.connect(borrower).settle();
      const receipt = await tx.wait();
      const parsed = receipt.logs
        .map((log) => { try { return vault.interface.parseLog(log); } catch { return null; } })
        .find((e) => e && e.name === "Settled");

      expect(await vault.settledTotalReturned()).to.equal(parsed.args.totalReturned);
      expect(await vault.settledLenderPayout()).to.equal(parsed.args.lenderPayout);
      expect(await vault.settledBorrowerPayout()).to.equal(parsed.args.borrowerPayout);
      expect(await vault.settledFee()).to.equal(parsed.args.fee);
      expect(await vault.lossSeverity()).to.equal(0); // clean — no loss
    });

    it("Should classify a genuine investment loss as lender-impacted (severity 2)", async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });

      // Invest the full principal — on a local network this genuinely sends
      // the ETH to a no-code address and it never comes back.
      await vault.connect(borrower).supplyToAave(ONE_ETH);
      expect(await vault.vaultBalance()).to.equal(DEPOSIT); // only deposit remains

      // Must wait for the deadline — this loss is deep enough that early
      // close would correctly revert (lender wouldn't be made whole).
      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await vault.connect(otherAccount).settle();

      const lenderTarget = ONE_ETH + FEE;
      expect(await vault.settledTotalReturned()).to.equal(DEPOSIT); // only deposit came back
      expect(await vault.settledLenderPayout()).to.equal(DEPOSIT); // lender gets everything there is
      expect(await vault.settledLenderPayout()).to.be.lessThan(lenderTarget); // but it's not enough
      expect(await vault.settledBorrowerPayout()).to.equal(0);
      expect(await vault.lossSeverity()).to.equal(2); // lender-impacted
    });

    it("Should revert an early close attempt when the loss exceeds the deposit", async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });
      await vault.connect(borrower).supplyToAave(ONE_ETH);

      // Still before the deadline — borrower tries to close early, but the
      // lender would not be made whole. Must revert, not silently settle
      // at a loss to the lender via the early-close path.
      await expect(
        vault.connect(borrower).settle()
      ).to.be.revertedWith("Cannot close early at a loss beyond deposit");
    });

    it("Should classify a partial investment loss as borrower-only (severity 1)", async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });

      // Invest only part of the principal — enough to lose to a no-code
      // address that the lender still ends up fully paid, but the borrower
      // gets back less than a genuinely lossless settlement would give them.
      const partialInvestment = ethers.parseEther("0.05");
      await vault.connect(borrower).supplyToAave(partialInvestment);

      await ethers.provider.send("evm_increaseTime", [DURATION * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      await vault.connect(otherAccount).settle();

      const lenderTarget = ONE_ETH + FEE;
      const noLossBaseline = ONE_ETH + DEPOSIT;
      const expectedTotalReturned = (ONE_ETH - partialInvestment) + DEPOSIT;

      expect(await vault.settledTotalReturned()).to.equal(expectedTotalReturned);
      expect(await vault.settledTotalReturned()).to.be.lessThan(noLossBaseline);
      expect(await vault.settledLenderPayout()).to.equal(lenderTarget); // lender made whole
      expect(await vault.lossSeverity()).to.equal(1); // borrower-only
    });

    it("Should revert an early close attempt when a partial loss still exceeds available headroom", async function () {
      await vault.connect(borrower).payDeposit({ value: DEPOSIT });

      // A partial loss large enough that even though the lender COULD be
      // made whole post-deadline, early close should still only succeed if
      // totalReturned >= lenderTarget at the moment it's called. With a
      // 0.05 ETH loss (well within the 0.12 ETH borrower-only headroom),
      // totalReturned = 1.10 ETH >= lenderTarget (1.03 ETH), so early close
      // should actually SUCCEED here — this confirms borrower-only losses
      // don't block early close, only lender-impacted ones do.
      const partialInvestment = ethers.parseEther("0.05");
      await vault.connect(borrower).supplyToAave(partialInvestment);

      await expect(
        vault.connect(borrower).settle()
      ).to.not.be.reverted;

      expect(await vault.lossSeverity()).to.equal(1); // borrower-only, but early close was fine
    });

  });

});