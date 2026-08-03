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
    registry = await RegistryFactory.deploy(operator.address, verifierKey.address, 0);
    await registry.waitForDeployment();
  });

  // --- Deployment ---
  describe("Deployment", function () {

    it("Should set the operator correctly", async function () {
      expect(await registry.operator()).to.equal(operator.address);
    });

    it("Should recognise the constructor key as the first attester", async function () {
      expect(await registry.isRecognisedAttester(verifierKey.address)).to.equal(true);
      expect(await registry.allAttesters()).to.deep.equal([verifierKey.address]);
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
        RegistryFactory.deploy(ethers.ZeroAddress, verifierKey.address, 0)
      ).to.be.revertedWith("Invalid operator address");
    });

    it("Should revert if verifier key address is zero", async function () {
      const RegistryFactory = await ethers.getContractFactory("KYCRegistry");
      await expect(
        RegistryFactory.deploy(operator.address, ethers.ZeroAddress, 0)
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

  // --- Recognised attesters ---
  //
  // Covenza does not perform identity checks and does not issue attestations.
  // It accepts attestations signed by providers on this list, which makes the
  // list the entire trust boundary — so these tests are about who can admit a
  // borrower, not about what a check contains.
  describe("Recognised attesters", function () {

    async function attestation(signer, wallet, expiry) {
      const nonce = await registry.nonces(wallet);
      const structHash = ethers.solidityPackedKeccak256(
        ["address", "uint256", "uint256", "address"],
        [wallet, expiry, nonce, await registry.getAddress()]
      );
      return signer.signMessage(ethers.getBytes(structHash));
    }

    // Chain time, not wall-clock. These tests passed in isolation and failed
    // in the full suite: other files advance block.timestamp by days for term
    // and grace scenarios, so Date.now() was already in the chain's past and
    // every signature read as expired.
    async function future() {
      const block = await ethers.provider.getBlock("latest");
      return block.timestamp + 3600;
    }

    it("Should accept a signature from a recognised attester", async function () {
      const expiry = await future();
      const sig = await attestation(verifierKey, wallet1.address, expiry);

      await registry.verifyWithSignature(wallet1.address, expiry, sig);
      expect(await registry.isVerified(wallet1.address)).to.equal(true);
    });

    it("Should record which attester admitted the wallet", async function () {
      const expiry = await future();
      const sig = await attestation(verifierKey, wallet1.address, expiry);
      await registry.verifyWithSignature(wallet1.address, expiry, sig);

      // Without this, a delisted provider's admissions are indistinguishable
      // from everyone else's and cannot be reviewed.
      expect(await registry.attestedBy(wallet1.address)).to.equal(verifierKey.address);
    });

    it("Should reject a signature from a key that was never recognised", async function () {
      const expiry = await future();
      const sig = await attestation(otherAccount, wallet1.address, expiry);

      await expect(
        registry.verifyWithSignature(wallet1.address, expiry, sig)
      ).to.be.revertedWith("Signature is not from a recognised attester");
    });

    it("Should accept signatures from a second attester once added", async function () {
      await registry.connect(operator).queueAddAttester(otherAccount.address, "Second provider", "https://example.com/verify");
      await registry.connect(operator).addAttester(otherAccount.address, "Second provider", "https://example.com/verify");

      const expiry = await future();
      const sig = await attestation(otherAccount, wallet2.address, expiry);
      await registry.verifyWithSignature(wallet2.address, expiry, sig);

      expect(await registry.isVerified(wallet2.address)).to.equal(true);
    });

    it("Should stop accepting a delisted attester's signatures", async function () {
      await registry.connect(operator).removeAttester(verifierKey.address);

      const expiry = await future();
      const sig = await attestation(verifierKey, wallet1.address, expiry);

      await expect(
        registry.verifyWithSignature(wallet1.address, expiry, sig)
      ).to.be.revertedWith("Signature is not from a recognised attester");
    });

    it("Should leave existing verifications standing when an attester is delisted", async function () {
      const expiry = await future();
      const sig = await attestation(verifierKey, wallet1.address, expiry);
      await registry.verifyWithSignature(wallet1.address, expiry, sig);

      await registry.connect(operator).removeAttester(verifierKey.address);

      // Delisting a provider commercially is not the same as doubting every
      // check they ever ran. Revocation stays a deliberate, per-wallet act.
      expect(await registry.isVerified(wallet1.address)).to.equal(true);
    });

    it("Should keep delisted keys in the historical list", async function () {
      await registry.connect(operator).removeAttester(verifierKey.address);

      expect(await registry.allAttesters()).to.deep.equal([verifierKey.address]);
      expect(await registry.isRecognisedAttester(verifierKey.address)).to.equal(false);
    });

    it("Should rotate a key and carry the provider name across", async function () {
      await registry.connect(operator).rotateAttester(verifierKey.address, otherAccount.address);

      expect(await registry.isRecognisedAttester(verifierKey.address)).to.equal(false);
      expect(await registry.isRecognisedAttester(otherAccount.address)).to.equal(true);

      const rotated = await registry.attesters(otherAccount.address);
      expect(rotated.name).to.equal("Initial attester");
    });

    it("Should publish where an unverified borrower can get checked", async function () {
      await registry
        .connect(operator)
        .queueAddAttester(otherAccount.address, "Second provider", "https://example.com/verify");
      await registry
        .connect(operator)
        .addAttester(otherAccount.address, "Second provider", "https://example.com/verify");

      // On chain rather than in a frontend config: recognising a provider and
      // telling people where to find them are the same decision, and splitting
      // them means the list and the links drift apart.
      const a = await registry.attesters(otherAccount.address);
      expect(a.url).to.equal("https://example.com/verify");
    });

    it("Should only let the operator add an attester", async function () {
      await expect(
        registry.connect(wallet1).queueAddAttester(otherAccount.address, "Rogue", "")
      ).to.be.revertedWith("Caller is not the operator");
    });

    it("Should only let the operator remove an attester", async function () {
      await expect(
        registry.connect(wallet1).removeAttester(verifierKey.address)
      ).to.be.revertedWith("Caller is not the operator");
    });

    it("Should reject adding an attester twice", async function () {
      await registry.connect(operator).queueAddAttester(verifierKey.address, "Duplicate", "");
      await expect(
        registry.connect(operator).addAttester(verifierKey.address, "Duplicate", "")
      ).to.be.revertedWith("Attester already recognised");
    });

    it("Should reject the zero address as an attester", async function () {
      await expect(
        registry.connect(operator).queueAddAttester(ethers.ZeroAddress, "Nobody", "")
      ).to.be.revertedWith("Invalid attester address");
    });

  });

});