const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("KYCRegistry", function () {

  let registry;
  let operator;
  let verifierKey;
  let wallet1;
  let wallet2;
  let otherAccount;

  beforeEach(async function () {
    [operator, verifierKey, wallet1, wallet2, otherAccount] = await ethers.getSigners();

    const RegistryFactory = await ethers.getContractFactory("KYCRegistry");
    registry = await RegistryFactory.deploy(operator.address, verifierKey.address);
    await registry.waitForDeployment();
  });

  // --- Deployment ---
  describe("Deployment", function () {

    it("Should set the operator correctly", async function () {
      expect(await registry.operator()).to.equal(operator.address);
    });

    it("Should set the verifier key correctly", async function () {
      expect(await registry.verifierKey()).to.equal(verifierKey.address);
    });

    it("Should start with no addresses verified", async function () {
      expect(await registry.isVerified(wallet1.address)).to.equal(false);
    });

  });

  // --- Deployment guards ---
  describe("Deployment guards", function () {

    it("Should revert if operator address is zero", async function () {
      const RegistryFactory = await ethers.getContractFactory("KYCRegistry");
      await expect(
        RegistryFactory.deploy(ethers.ZeroAddress, verifierKey.address)
      ).to.be.revertedWith("Invalid operator address");
    });

    it("Should revert if verifier key address is zero", async function () {
      const RegistryFactory = await ethers.getContractFactory("KYCRegistry");
      await expect(
        RegistryFactory.deploy(operator.address, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid verifier key address");
    });

  });

  // --- Verification ---
  describe("Verification", function () {

    it("Should allow operator to verify an address", async function () {
      await registry.connect(operator).verify(wallet1.address);
      expect(await registry.isVerified(wallet1.address)).to.equal(true);
    });

    it("Should record verification timestamp", async function () {
      await registry.connect(operator).verify(wallet1.address);
      const block = await ethers.provider.getBlock("latest");
      const { verifiedTs } = await registry.statusOf(wallet1.address);
      expect(verifiedTs).to.equal(block.timestamp);
    });

    it("Should emit AddressVerified event", async function () {
      await expect(
        registry.connect(operator).verify(wallet1.address)
      ).to.emit(registry, "AddressVerified");
    });

    it("Should revert if non-operator tries to verify", async function () {
      await expect(
        registry.connect(otherAccount).verify(wallet1.address)
      ).to.be.revertedWith("Caller is not the operator");
    });

    it("Should revert if address is already verified", async function () {
      await registry.connect(operator).verify(wallet1.address);
      await expect(
        registry.connect(operator).verify(wallet1.address)
      ).to.be.revertedWith("Address already verified");
    });

    it("Should revert if wallet address is zero", async function () {
      await expect(
        registry.connect(operator).verify(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid wallet address");
    });

    it("Should verify multiple addresses independently", async function () {
      await registry.connect(operator).verify(wallet1.address);
      await registry.connect(operator).verify(wallet2.address);
      expect(await registry.isVerified(wallet1.address)).to.equal(true);
      expect(await registry.isVerified(wallet2.address)).to.equal(true);
    });

  });

  // --- Revocation ---
  describe("Revocation", function () {

    beforeEach(async function () {
      await registry.connect(operator).verify(wallet1.address);
    });

    it("Should allow operator to revoke a verified address", async function () {
      await registry.connect(operator).revoke(wallet1.address);
      expect(await registry.isVerified(wallet1.address)).to.equal(false);
    });

    it("Should record revocation timestamp", async function () {
      await registry.connect(operator).revoke(wallet1.address);
      const block = await ethers.provider.getBlock("latest");
      const { revokedTs } = await registry.statusOf(wallet1.address);
      expect(revokedTs).to.equal(block.timestamp);
    });

    it("Should emit AddressRevoked event", async function () {
      await expect(
        registry.connect(operator).revoke(wallet1.address)
      ).to.emit(registry, "AddressRevoked");
    });

    it("Should revert if non-operator tries to revoke", async function () {
      await expect(
        registry.connect(otherAccount).revoke(wallet1.address)
      ).to.be.revertedWith("Caller is not the operator");
    });

    it("Should revert if address is not verified", async function () {
      await expect(
        registry.connect(operator).revoke(wallet2.address)
      ).to.be.revertedWith("Address is not verified");
    });

  });

  // --- Operator transfer ---
  describe("Operator transfer", function () {

    it("Should allow operator to transfer role", async function () {
      await registry.connect(operator).transferOperator(otherAccount.address);
      expect(await registry.operator()).to.equal(otherAccount.address);
    });

    it("Should emit OperatorUpdated event", async function () {
      await expect(
        registry.connect(operator).transferOperator(otherAccount.address)
      ).to.emit(registry, "OperatorUpdated");
    });

    it("Should revert if non-operator tries to transfer", async function () {
      await expect(
        registry.connect(otherAccount).transferOperator(wallet1.address)
      ).to.be.revertedWith("Caller is not the operator");
    });

    it("Should revert if new operator address is zero", async function () {
      await expect(
        registry.connect(operator).transferOperator(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid operator address");
    });

    it("Should allow new operator to verify after transfer", async function () {
      await registry.connect(operator).transferOperator(otherAccount.address);
      await registry.connect(otherAccount).verify(wallet1.address);
      expect(await registry.isVerified(wallet1.address)).to.equal(true);
    });

    it("Should prevent old operator from verifying after transfer", async function () {
      await registry.connect(operator).transferOperator(otherAccount.address);
      await expect(
        registry.connect(operator).verify(wallet1.address)
      ).to.be.revertedWith("Caller is not the operator");
    });

  });

  // --- statusOf view ---
  describe("statusOf", function () {

    it("Should return correct status for unverified address", async function () {
      const { verified, verifiedTs, revokedTs } = await registry.statusOf(wallet1.address);
      expect(verified).to.equal(false);
      expect(verifiedTs).to.equal(0);
      expect(revokedTs).to.equal(0);
    });

    it("Should return correct status for verified address", async function () {
      await registry.connect(operator).verify(wallet1.address);
      const { verified } = await registry.statusOf(wallet1.address);
      expect(verified).to.equal(true);
    });

    it("Should return correct status after revocation", async function () {
      await registry.connect(operator).verify(wallet1.address);
      await registry.connect(operator).revoke(wallet1.address);
      const { verified, revokedTs } = await registry.statusOf(wallet1.address);
      expect(verified).to.equal(false);
      expect(revokedTs).to.be.greaterThan(0);
    });

  });

});