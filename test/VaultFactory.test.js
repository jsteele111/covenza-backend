const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("VaultFactory", function () {

  let registry;
  let factory;
  let owner;
  let operator;
  let verifierKey;
  let lender;
  let borrower;
  let unverifiedBorrower;

  const ONE_ETH      = ethers.parseEther("1.0");
  const REPAYMENT    = ethers.parseEther("1.03");
  const DEPOSIT      = ethers.parseEther("0.15");
  const DURATION     = 30;

  beforeEach(async function () {
    [owner, operator, verifierKey, lender, borrower, unverifiedBorrower] = await ethers.getSigners();

    // Deploy registry with operator
    const RegistryFactory = await ethers.getContractFactory("KYCRegistry");
    registry = await RegistryFactory.deploy(operator.address, verifierKey.address);
    await registry.waitForDeployment();

    // Deploy factory pointing at registry
    const FactoryContract = await ethers.getContractFactory("VaultFactory");
    factory = await FactoryContract.deploy(await registry.getAddress());
    await factory.waitForDeployment();

    // Verify the borrower in the registry
    await registry.connect(operator).verify(borrower.address);
  });

  // --- Deployment ---
  describe("Deployment", function () {

    it("Should set the registry address correctly", async function () {
      expect(await factory.registry()).to.equal(await registry.getAddress());
    });

    it("Should set the owner correctly", async function () {
      expect(await factory.owner()).to.equal(owner.address);
    });

    it("Should start with zero vaults", async function () {
      expect(await factory.totalVaults()).to.equal(0);
    });

    it("Should revert if registry address is zero", async function () {
      const FactoryContract = await ethers.getContractFactory("VaultFactory");
      await expect(
        FactoryContract.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid registry address");
    });

  });

  // --- KYC gate ---
  describe("KYC gate", function () {

    it("Should deploy a vault for a verified borrower", async function () {
      const tx = await factory.connect(lender).deployVault(
        borrower.address,
        REPAYMENT,
        DURATION,
        false,
        DEPOSIT,
        { value: ONE_ETH }
      );
      await tx.wait();
      expect(await factory.totalVaults()).to.equal(1);
    });

    it("Should revert if borrower is not KYC verified", async function () {
      await expect(
        factory.connect(lender).deployVault(
          unverifiedBorrower.address,
          REPAYMENT,
          DURATION,
          false,
          DEPOSIT,
          { value: ONE_ETH }
        )
      ).to.be.revertedWith("Borrower is not KYC verified");
    });

    it("Should revert if borrower's verification has been revoked", async function () {
      await registry.connect(operator).revoke(borrower.address);
      await expect(
        factory.connect(lender).deployVault(
          borrower.address,
          REPAYMENT,
          DURATION,
          false,
          DEPOSIT,
          { value: ONE_ETH }
        )
      ).to.be.revertedWith("Borrower is not KYC verified");
    });

    it("Should allow vault deployment after re-verification", async function () {
      await registry.connect(operator).revoke(borrower.address);
      await registry.connect(operator).verify(borrower.address);
      const tx = await factory.connect(lender).deployVault(
        borrower.address,
        REPAYMENT,
        DURATION,
        false,
        DEPOSIT,
        { value: ONE_ETH }
      );
      await tx.wait();
      expect(await factory.totalVaults()).to.equal(1);
    });

  });

  // --- Vault deployment ---
  describe("Vault deployment", function () {

    let vaultAddress;

    beforeEach(async function () {
      const tx = await factory.connect(lender).deployVault(
        borrower.address,
        REPAYMENT,
        DURATION,
        false,
        DEPOSIT,
        { value: ONE_ETH }
      );
      const receipt = await tx.wait();
      vaultAddress = await factory.allVaults(0);
    });

    it("Should record vault in allVaults", async function () {
      expect(await factory.totalVaults()).to.equal(1);
      expect(await factory.allVaults(0)).to.not.equal(ethers.ZeroAddress);
    });

    it("Should record vault by borrower", async function () {
      const borrowerVaults = await factory.getVaultsByBorrower(borrower.address);
      expect(borrowerVaults.length).to.equal(1);
      expect(borrowerVaults[0]).to.equal(vaultAddress);
    });

    it("Should record vault by lender", async function () {
      const lenderVaults = await factory.getVaultsByLender(lender.address);
      expect(lenderVaults.length).to.equal(1);
      expect(lenderVaults[0]).to.equal(vaultAddress);
    });

    it("Should emit VaultDeployed event", async function () {
      await expect(
        factory.connect(lender).deployVault(
          borrower.address,
          REPAYMENT,
          DURATION,
          false,
          DEPOSIT,
          { value: ONE_ETH }
        )
      ).to.emit(factory, "VaultDeployed");
    });

    it("Should deploy vault with correct principal", async function () {
      const vault = await ethers.getContractAt("Vault", vaultAddress);
      expect(await vault.principal()).to.equal(ONE_ETH);
    });

    it("Should deploy vault with correct borrower", async function () {
      const vault = await ethers.getContractAt("Vault", vaultAddress);
      expect(await vault.borrower()).to.equal(borrower.address);
    });

    it("Should deploy vault with correct lender", async function () {
      const vault = await ethers.getContractAt("Vault", vaultAddress);
      expect(await vault.lender()).to.equal(lender.address);
    });

    it("Should lock principal in the deployed vault", async function () {
      const vault = await ethers.getContractAt("Vault", vaultAddress);
      expect(await vault.vaultBalance()).to.equal(ONE_ETH);
    });

    it("Should allow multiple vaults per borrower", async function () {
      await factory.connect(lender).deployVault(
        borrower.address,
        REPAYMENT,
        DURATION,
        false,
        DEPOSIT,
        { value: ONE_ETH }
      );
      const borrowerVaults = await factory.getVaultsByBorrower(borrower.address);
      expect(borrowerVaults.length).to.equal(2);
    });

  });

  // --- Registry update ---
  describe("Registry update", function () {

    it("Should allow owner to update registry", async function () {
      const RegistryFactory = await ethers.getContractFactory("KYCRegistry");
      const newRegistry = await RegistryFactory.deploy(operator.address, verifierKey.address);
      await newRegistry.waitForDeployment();

      await factory.connect(owner).updateRegistry(await newRegistry.getAddress());
      expect(await factory.registry()).to.equal(await newRegistry.getAddress());
    });

    it("Should emit RegistryUpdated event", async function () {
      const RegistryFactory = await ethers.getContractFactory("KYCRegistry");
      const newRegistry = await RegistryFactory.deploy(operator.address, verifierKey.address);
      await newRegistry.waitForDeployment();

      await expect(
        factory.connect(owner).updateRegistry(await newRegistry.getAddress())
      ).to.emit(factory, "RegistryUpdated");
    });

    it("Should revert if non-owner tries to update registry", async function () {
      const RegistryFactory = await ethers.getContractFactory("KYCRegistry");
      const newRegistry = await RegistryFactory.deploy(operator.address, verifierKey.address);
      await newRegistry.waitForDeployment();

      await expect(
        factory.connect(lender).updateRegistry(await newRegistry.getAddress())
      ).to.be.revertedWith("Caller is not the owner");
    });

  });

});