const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/**
 * KYCRegistry, redesigned 18 October 2026 (#7): expiring, claim-bearing,
 * chain- and contract-bound attestations; a manual path with six safeguards;
 * attester rotation behind the timelock.
 */
const DAY = 86400;
const KYC = 1, SANCTIONS = 2, JURISDICTION = 4, ALL = 7;
const REF = ethers.id("case-0001");

describe("KYCRegistry", function () {

  let registry, operator, verifierKey, wallet1, wallet2, otherAccount, signers;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    [operator, verifierKey, wallet1, wallet2, otherAccount] = signers;
    registry = await (await ethers.getContractFactory("KYCRegistry")).deploy(operator.address, verifierKey.address, 0);
    await registry.waitForDeployment();
  });

  // Signs an EIP-712 attestation. Domain and nonce can be overridden to
  // prove the bindings.
  async function attest(signer, wallet, opts = {}) {
    const now = BigInt(await time.latest());
    const claims = opts.claims ?? ALL;
    const validUntil = opts.validUntil ?? now + BigInt(180 * DAY);
    const deadline = opts.deadline ?? now + 3600n;
    const nonce = opts.nonce ?? await registry.nonces(wallet);
    const domain = {
      name: "Covenza KYC", version: "2",
      chainId: opts.chainId ?? (await ethers.provider.getNetwork()).chainId,
      verifyingContract: opts.verifyingContract ?? await registry.getAddress(),
    };
    const types = { Attestation: [
      { name: "wallet", type: "address" }, { name: "claims", type: "uint256" },
      { name: "validUntil", type: "uint256" }, { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ] };
    const sig = await signer.signTypedData(domain, types, { wallet, claims, validUntil, deadline, nonce });
    return [wallet, claims, validUntil, deadline, sig];
  }

  // --- Deployment ---
  describe("Deployment", function () {
    it("Should set the operator correctly", async function () {
      expect(await registry.operator()).to.equal(operator.address);
    });
    it("Should recognise the constructor key as the first attester", async function () {
      expect(await registry.isRecognisedAttester(verifierKey.address)).to.equal(true);
      expect(await registry.allAttesters()).to.deep.equal([verifierKey.address]);
    });
    it("Should start with no addresses verified or eligible", async function () {
      expect(await registry.isVerified(wallet1.address)).to.equal(false);
      expect(await registry.isEligible(wallet1.address, ALL)).to.equal(false);
    });
  });

  describe("Deployment guards", function () {
    it("Should revert if operator address is zero", async function () {
      await expect((await ethers.getContractFactory("KYCRegistry")).deploy(ethers.ZeroAddress, verifierKey.address, 0))
        .to.be.revertedWith("Invalid operator address");
    });
    it("Should revert if verifier key address is zero", async function () {
      await expect((await ethers.getContractFactory("KYCRegistry")).deploy(operator.address, ethers.ZeroAddress, 0))
        .to.be.revertedWith("Invalid verifier key address");
    });
  });

  // --- Provider attestations ---
  describe("Provider attestations", function () {
    it("Accepts a recognised provider's attestation and makes the wallet eligible", async function () {
      await registry.verifyWithSignature(...await attest(verifierKey, wallet1.address));
      expect(await registry.isEligible(wallet1.address, ALL)).to.equal(true);
    });

    it("Records the provider, claims and validity", async function () {
      const args = await attest(verifierKey, wallet1.address, { claims: SANCTIONS });
      await expect(registry.verifyWithSignature(...args))
        .to.emit(registry, "AttestationAccepted").withArgs(wallet1.address, verifierKey.address, SANCTIONS, args[2]);
      const v = await registry.verificationOf(wallet1.address);
      expect(v.attester).to.equal(verifierKey.address);
      expect(v.claims).to.equal(SANCTIONS);
      expect(v.validUntil).to.equal(args[2]);
      expect(v.manual).to.equal(false);
      expect(await registry.attestedBy(wallet1.address)).to.equal(verifierKey.address);
    });

    it("Rejects a key that was never recognised", async function () {
      await expect(registry.verifyWithSignature(...await attest(otherAccount, wallet1.address)))
        .to.be.revertedWith("Signature is not from a recognised attester");
    });

    it("Rejects a signature submitted after its deadline", async function () {
      const args = await attest(verifierKey, wallet1.address);
      await time.increase(3601);
      await expect(registry.verifyWithSignature(...args)).to.be.revertedWith("Signature expired");
    });

    it("Rejects validity beyond the 365-day cap", async function () {
      const now = BigInt(await time.latest());
      await expect(registry.verifyWithSignature(...await attest(verifierKey, wallet1.address,
        { validUntil: now + BigInt(366 * DAY) }))).to.be.revertedWith("Validity beyond the 365-day cap");
    });

    it("Rejects an attestation that has already expired", async function () {
      const now = BigInt(await time.latest());
      await expect(registry.verifyWithSignature(...await attest(verifierKey, wallet1.address,
        { validUntil: now }))).to.be.revertedWith("Attestation already expired");
    });

    it("Rejects empty or unknown claims", async function () {
      await expect(registry.verifyWithSignature(...await attest(verifierKey, wallet1.address, { claims: 0 })))
        .to.be.revertedWith("Unknown or empty claims");
      await expect(registry.verifyWithSignature(...await attest(verifierKey, wallet1.address, { claims: 8 })))
        .to.be.revertedWith("Unknown or empty claims");
    });

    it("Cannot be replayed: the nonce moves on every use", async function () {
      const args = await attest(verifierKey, wallet1.address);
      await registry.verifyWithSignature(...args);
      await expect(registry.verifyWithSignature(...args))
        .to.be.revertedWith("Signature is not from a recognised attester");
    });

    it("Is bound to this chain: a signature for another chain id is refused", async function () {
      await expect(registry.verifyWithSignature(...await attest(verifierKey, wallet1.address, { chainId: 1n })))
        .to.be.revertedWith("Signature is not from a recognised attester");
    });

    it("Is bound to this contract: a signature for another adapter is refused", async function () {
      const other = await (await ethers.getContractFactory("KYCRegistry")).deploy(operator.address, verifierKey.address, 0);
      await expect(registry.verifyWithSignature(...await attest(verifierKey, wallet1.address,
        { verifyingContract: await other.getAddress() })))
        .to.be.revertedWith("Signature is not from a recognised attester");
    });

    it("Renews before expiry without a revocation", async function () {
      await registry.verifyWithSignature(...await attest(verifierKey, wallet1.address));
      const first = (await registry.verificationOf(wallet1.address)).validUntil;
      await time.increase(100 * DAY);
      await registry.verifyWithSignature(...await attest(verifierKey, wallet1.address));
      expect((await registry.verificationOf(wallet1.address)).validUntil).to.be.gt(first);
    });

    it("Revocation kills a signature already issued but not yet used", async function () {
      await registry.verifyWithSignature(...await attest(verifierKey, wallet1.address));
      const pending = await attest(verifierKey, wallet1.address);
      await registry.revoke(wallet1.address);
      await expect(registry.verifyWithSignature(...pending))
        .to.be.revertedWith("Signature is not from a recognised attester");
    });
  });

  // --- Eligibility at the point of use ---
  describe("Eligibility", function () {
    it("Lasts until validUntil and not a second longer", async function () {
      const args = await attest(verifierKey, wallet1.address, { validUntil: BigInt(await time.latest()) + BigInt(30 * DAY) });
      await registry.verifyWithSignature(...args);
      await time.increaseTo(args[2]);
      expect(await registry.isEligible(wallet1.address, ALL)).to.equal(true);
      await time.increase(1);
      expect(await registry.isEligible(wallet1.address, ALL)).to.equal(false);
    });

    it("Requires every claim asked for", async function () {
      await registry.verifyWithSignature(...await attest(verifierKey, wallet1.address, { claims: SANCTIONS }));
      expect(await registry.isEligible(wallet1.address, SANCTIONS)).to.equal(true);
      expect(await registry.isEligible(wallet1.address, ALL)).to.equal(false);
      expect(await registry.isEligible(wallet1.address, KYC | SANCTIONS)).to.equal(false);
    });

    it("A revoked wallet is not eligible", async function () {
      await registry.verifyWithSignature(...await attest(verifierKey, wallet1.address));
      await registry.revoke(wallet1.address);
      expect(await registry.isEligible(wallet1.address, SANCTIONS)).to.equal(false);
    });
  });

  // --- Manual grants and their six safeguards ---
  describe("Manual grants", function () {
    it("Grants 30 days, marked manual, with the case reference on record", async function () {
      await expect(registry.verify(wallet1.address, ALL, REF))
        .to.emit(registry, "ManualGrant");
      const v = await registry.verificationOf(wallet1.address);
      expect(v.manual).to.equal(true);
      expect(v.attester).to.equal(ethers.ZeroAddress);
      expect(v.caseRef).to.equal(REF);
      expect(v.validUntil).to.equal(BigInt(await time.latest()) + BigInt(30 * DAY));
    });

    it("Lapses after 30 days", async function () {
      await registry.verify(wallet1.address, ALL, REF);
      await time.increase(30 * DAY + 1);
      expect(await registry.isEligible(wallet1.address, ALL)).to.equal(false);
    });

    it("Refuses a grant without a case reference", async function () {
      await expect(registry.verify(wallet1.address, ALL, ethers.ZeroHash))
        .to.be.revertedWith("A case reference is required");
    });

    it("Cannot be chained: once per wallet per year, then a provider must attest", async function () {
      await registry.verify(wallet1.address, ALL, REF);
      await time.increase(31 * DAY);
      await expect(registry.verify(wallet1.address, ALL, REF))
        .to.be.revertedWith("Manual grant used within the last year");
      await time.increase(335 * DAY);
      await registry.verify(wallet1.address, ALL, REF);
    });

    it("Allows at most five in any 30 days", async function () {
      for (let i = 5; i < 10; i++) { await registry.verify(signers[i].address, ALL, REF); }
      await expect(registry.verify(signers[10].address, ALL, REF))
        .to.be.revertedWith("Manual grant rate limit reached");
      await time.increase(30 * DAY);
      await registry.verify(signers[10].address, ALL, REF);
    });

    it("Waits on the timelock, bound to the exact wallet", async function () {
      const slow = await (await ethers.getContractFactory("KYCRegistry")).deploy(operator.address, verifierKey.address, 2 * DAY);
      await expect(slow.verify(wallet1.address, ALL, REF)).to.be.revertedWith("Action was not queued");

      const data = slow.interface.encodeFunctionData("verify", [wallet1.address, ALL, REF]);
      await slow.queueAction(ethers.keccak256(data));
      await expect(slow.verify(wallet1.address, ALL, REF)).to.be.revertedWith("Timelock has not elapsed");
      await time.increase(2 * DAY);
      await expect(slow.verify(wallet2.address, ALL, REF)).to.be.revertedWith("Action was not queued");
      await slow.verify(wallet1.address, ALL, REF);
      expect(await slow.isEligible(wallet1.address, ALL)).to.equal(true);
    });

    it("Can be cancelled while announced", async function () {
      const slow = await (await ethers.getContractFactory("KYCRegistry")).deploy(operator.address, verifierKey.address, 2 * DAY);
      const id = ethers.keccak256(slow.interface.encodeFunctionData("verify", [wallet1.address, ALL, REF]));
      await slow.queueAction(id);
      await slow.cancelAction(id);
      await time.increase(2 * DAY);
      await expect(slow.verify(wallet1.address, ALL, REF)).to.be.revertedWith("Action was not queued");
    });

    it("Only the operator may grant", async function () {
      await expect(registry.connect(otherAccount).verify(wallet1.address, ALL, REF))
        .to.be.revertedWith("Caller is not the operator");
    });

    it("Rejects the zero address and empty claims", async function () {
      await expect(registry.verify(ethers.ZeroAddress, ALL, REF)).to.be.revertedWith("Invalid wallet address");
      await expect(registry.verify(wallet1.address, 0, REF)).to.be.revertedWith("Unknown or empty claims");
    });
  });

  // --- Revocation ---
  describe("Revocation", function () {
    beforeEach(async function () { await registry.verify(wallet1.address, ALL, REF); });

    it("Should allow operator to revoke a verified address", async function () {
      await registry.revoke(wallet1.address);
      expect(await registry.isVerified(wallet1.address)).to.equal(false);
    });
    it("Should record revocation timestamp", async function () {
      await registry.revoke(wallet1.address);
      expect(await registry.revokedAt(wallet1.address)).to.equal(BigInt(await time.latest()));
    });
    it("Should emit AddressRevoked event", async function () {
      await expect(registry.revoke(wallet1.address)).to.emit(registry, "AddressRevoked");
    });
    it("Should revert if non-operator tries to revoke", async function () {
      await expect(registry.connect(otherAccount).revoke(wallet1.address)).to.be.revertedWith("Caller is not the operator");
    });
    it("Should revert if address is not verified", async function () {
      await expect(registry.revoke(wallet2.address)).to.be.revertedWith("Address is not verified");
    });
  });

  // --- Operator transfer ---
  describe("Operator transfer", function () {
    it("Should nominate rather than transfer, leaving the current operator in place", async function () {
      await registry.transferOperator(otherAccount.address);
      expect(await registry.operator()).to.equal(operator.address);
      expect(await registry.pendingOperator()).to.equal(otherAccount.address);
    });
    it("Should emit OperatorTransferStarted on nomination", async function () {
      await expect(registry.transferOperator(otherAccount.address))
        .to.emit(registry, "OperatorTransferStarted").withArgs(operator.address, otherAccount.address);
    });
    it("Should emit OperatorUpdated only on acceptance", async function () {
      await registry.transferOperator(otherAccount.address);
      await expect(registry.connect(otherAccount).acceptOperator())
        .to.emit(registry, "OperatorUpdated").withArgs(operator.address, otherAccount.address);
    });
    it("Should revert if non-operator tries to transfer", async function () {
      await expect(registry.connect(otherAccount).transferOperator(wallet1.address)).to.be.revertedWith("Caller is not the operator");
    });
    it("Should revert if new operator address is zero", async function () {
      await expect(registry.transferOperator(ethers.ZeroAddress)).to.be.revertedWith("Invalid operator address");
    });
    it("Should grant no powers to a nominee who has not accepted", async function () {
      await registry.transferOperator(otherAccount.address);
      await expect(registry.connect(otherAccount).verify(wallet1.address, ALL, REF)).to.be.revertedWith("Caller is not the operator");
    });
    it("Should reject acceptance from anyone but the nominee", async function () {
      await registry.transferOperator(otherAccount.address);
      await expect(registry.connect(wallet1).acceptOperator()).to.be.revertedWith("Caller is not the pending operator");
    });
    it("Should reject acceptance when no transfer is pending", async function () {
      await expect(registry.connect(otherAccount).acceptOperator()).to.be.revertedWith("Caller is not the pending operator");
    });
    it("Should allow new operator to grant after accepting", async function () {
      await registry.transferOperator(otherAccount.address);
      await registry.connect(otherAccount).acceptOperator();
      await registry.connect(otherAccount).verify(wallet1.address, ALL, REF);
      expect(await registry.isVerified(wallet1.address)).to.equal(true);
    });
    it("Should prevent old operator from granting after acceptance", async function () {
      await registry.transferOperator(otherAccount.address);
      await registry.connect(otherAccount).acceptOperator();
      await expect(registry.verify(wallet1.address, ALL, REF)).to.be.revertedWith("Caller is not the operator");
    });
    it("Should let the operator cancel a nomination before it is accepted", async function () {
      await registry.transferOperator(otherAccount.address);
      await registry.cancelOperatorTransfer();
      expect(await registry.pendingOperator()).to.equal(ethers.ZeroAddress);
      await expect(registry.connect(otherAccount).acceptOperator()).to.be.revertedWith("Caller is not the pending operator");
    });
    it("Should replace an outstanding nomination rather than queueing a second", async function () {
      await registry.transferOperator(otherAccount.address);
      await registry.transferOperator(wallet1.address);
      expect(await registry.pendingOperator()).to.equal(wallet1.address);
      await expect(registry.connect(otherAccount).acceptOperator()).to.be.revertedWith("Caller is not the pending operator");
    });
    it("Should clear the nomination after acceptance so it cannot be replayed", async function () {
      await registry.transferOperator(otherAccount.address);
      await registry.connect(otherAccount).acceptOperator();
      expect(await registry.pendingOperator()).to.equal(ethers.ZeroAddress);
      await expect(registry.connect(otherAccount).acceptOperator()).to.be.revertedWith("Caller is not the pending operator");
    });
  });

  // --- statusOf ---
  describe("statusOf", function () {
    it("Should return correct status for unverified address", async function () {
      const [v, ts, rts] = await registry.statusOf(wallet1.address);
      expect(v).to.equal(false); expect(ts).to.equal(0); expect(rts).to.equal(0);
    });
    it("Should return correct status for verified address", async function () {
      await registry.verify(wallet1.address, ALL, REF);
      const [v, ts] = await registry.statusOf(wallet1.address);
      expect(v).to.equal(true); expect(ts).to.be.gt(0);
    });
    it("Should return correct status after revocation", async function () {
      await registry.verify(wallet1.address, ALL, REF);
      await registry.revoke(wallet1.address);
      const [v, , rts] = await registry.statusOf(wallet1.address);
      expect(v).to.equal(false); expect(rts).to.be.gt(0);
    });
  });

  // --- Attesters ---
  describe("Recognised attesters", function () {
    async function addAttester(key, name = "Provider", url = "https://example.test") {
      await registry.queueAddAttester(key, name, url);
      await registry.addAttester(key, name, url);
    }

    it("Should accept signatures from a second attester once added", async function () {
      await addAttester(otherAccount.address);
      await registry.verifyWithSignature(...await attest(otherAccount, wallet1.address));
      expect(await registry.attestedBy(wallet1.address)).to.equal(otherAccount.address);
    });
    it("Should stop accepting a delisted attester's signatures", async function () {
      await registry.removeAttester(verifierKey.address);
      await expect(registry.verifyWithSignature(...await attest(verifierKey, wallet1.address)))
        .to.be.revertedWith("Signature is not from a recognised attester");
    });
    it("Should leave existing verifications standing (until they expire) when an attester is delisted", async function () {
      await registry.verifyWithSignature(...await attest(verifierKey, wallet1.address));
      await registry.removeAttester(verifierKey.address);
      expect(await registry.isEligible(wallet1.address, ALL)).to.equal(true);
      await time.increase(181 * DAY);
      expect(await registry.isEligible(wallet1.address, ALL)).to.equal(false);
    });
    it("Should keep delisted keys in the historical list", async function () {
      await registry.removeAttester(verifierKey.address);
      expect(await registry.allAttesters()).to.deep.equal([verifierKey.address]);
    });
    it("Should rotate a key, after announcement, and carry the provider name across", async function () {
      await registry.queueRotateAttester(verifierKey.address, otherAccount.address);
      await registry.rotateAttester(verifierKey.address, otherAccount.address);
      expect(await registry.isRecognisedAttester(verifierKey.address)).to.equal(false);
      expect((await registry.attesters(otherAccount.address)).name).to.equal("Initial attester");
    });
    it("Should refuse a rotation that was not announced (Krait: timelock bypass)", async function () {
      await expect(registry.rotateAttester(verifierKey.address, otherAccount.address))
        .to.be.revertedWith("Action was not queued");
    });
    it("Should hold a rotation for the full delay", async function () {
      const slow = await (await ethers.getContractFactory("KYCRegistry")).deploy(operator.address, verifierKey.address, 2 * DAY);
      await slow.queueRotateAttester(verifierKey.address, otherAccount.address);
      await expect(slow.rotateAttester(verifierKey.address, otherAccount.address)).to.be.revertedWith("Timelock has not elapsed");
      await time.increase(2 * DAY);
      await slow.rotateAttester(verifierKey.address, otherAccount.address);
    });
    it("Should publish where an unverified borrower can get checked", async function () {
      await addAttester(otherAccount.address, "Acme ID", "https://acme.example/verify");
      expect((await registry.attesters(otherAccount.address)).url).to.equal("https://acme.example/verify");
    });
    it("Should only let the operator add an attester", async function () {
      await expect(registry.connect(otherAccount).queueAddAttester(otherAccount.address, "x", "y"))
        .to.be.revertedWith("Caller is not the operator");
    });
    it("Should only let the operator remove an attester", async function () {
      await expect(registry.connect(otherAccount).removeAttester(verifierKey.address))
        .to.be.revertedWith("Caller is not the operator");
    });
    it("Should reject adding an attester twice", async function () {
      await registry.queueAddAttester(verifierKey.address, "Initial attester", "");
      await expect(registry.addAttester(verifierKey.address, "Initial attester", ""))
        .to.be.revertedWith("Attester already recognised");
    });
    it("Should reject the zero address as an attester", async function () {
      await expect(registry.queueAddAttester(ethers.ZeroAddress, "x", "y")).to.be.revertedWith("Invalid attester address");
    });
  });
});
