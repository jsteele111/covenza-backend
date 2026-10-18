const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

/**
 * #7 at the point of use: the factory asks the identity adapter, at every
 * origination, whether borrower and lender hold the required claims NOW.
 */
const E = ethers.parseEther;
const DAY = 86400;
const KYC = 1, SANCTIONS = 2, JURISDICTION = 4, ALL = 7;

describe("Identity adapter — eligibility checked at origination", function () {

  async function stack(adapterKind = "kyc", factoryDelay = 0) {
    const [operator, lender, borrower, attester] = await ethers.getSigners();
    const weth = await (await ethers.getContractFactory("MockERC20", operator)).deploy("WETH", "WETH", 18);
    const aave = await (await ethers.getContractFactory("MockAavePool", operator)).deploy();
    const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
      operator.address, await aave.getAddress(), operator.address, operator.address, await weth.getAddress(), 0);
    await registry.addAssetWithTier(await weth.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress, 0, 0);
    const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
    const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
    const impl = await (await ethers.getContractFactory("Vault", { signer: operator, libraries: { UniswapTwap: await twapLib.getAddress() } })).deploy();

    const adapter = adapterKind === "kyc"
      ? await (await ethers.getContractFactory("KYCRegistry", operator)).deploy(operator.address, attester.address, 0)
      : await (await ethers.getContractFactory("MockIdentityAdapter", operator)).deploy();
    const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
      await adapter.getAddress(), await registry.getAddress(), await pool.getAddress(), operator.address, await impl.getAddress(), factoryDelay);
    await pool.setVaultFactory(await factory.getAddress());
    return { operator, lender, borrower, attester, weth, adapter, factory };
  }

  async function attest(adapter, signer, wallet, claims, validFor) {
    const now = BigInt(await time.latest());
    const args = { wallet, claims, validUntil: now + BigInt(validFor), deadline: now + 3600n, nonce: await adapter.nonces(wallet) };
    const domain = { name: "Covenza KYC", version: "2", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await adapter.getAddress() };
    const types = { Attestation: [
      { name: "wallet", type: "address" }, { name: "claims", type: "uint256" }, { name: "validUntil", type: "uint256" },
      { name: "deadline", type: "uint256" }, { name: "nonce", type: "uint256" }] };
    const sig = await signer.signTypedData(domain, types, args);
    await adapter.verifyWithSignature(wallet, claims, args.validUntil, args.deadline, sig);
  }

  async function originate(f) {
    const P = E("10"), D = E("2");
    await f.weth.mint(f.lender.address, P);
    await f.weth.connect(f.lender).approve(await f.factory.getAddress(), P);
    return f.factory.connect(f.lender).deployVaultWithTier(
      await f.weth.getAddress(), f.borrower.address, P, 1200, 7, false, D, ethers.ZeroAddress, 0);
  }

  const kycStack = () => stack("kyc");
  const slowFactoryStack = () => stack("kyc", 2 * DAY);
  const mockStack = () => stack("mock");

  it("Originates when both parties hold current attestations", async function () {
    const f = await loadFixture(kycStack);
    await attest(f.adapter, f.attester, f.borrower.address, ALL, 90 * DAY);
    await attest(f.adapter, f.attester, f.lender.address, SANCTIONS, 90 * DAY);
    await originate(f);
    expect(await f.factory.totalVaults()).to.equal(1);
  });

  it("Refuses a borrower whose attestation has expired, though it was valid when given", async function () {
    const f = await loadFixture(kycStack);
    await attest(f.adapter, f.attester, f.borrower.address, ALL, 10 * DAY);
    await attest(f.adapter, f.attester, f.lender.address, SANCTIONS, 90 * DAY);
    await time.increase(11 * DAY);
    await expect(originate(f)).to.be.revertedWith("Borrower is not KYC verified");
  });

  it("Refuses a borrower missing any one of the three claims", async function () {
    const f = await loadFixture(kycStack);
    await attest(f.adapter, f.attester, f.borrower.address, KYC | SANCTIONS, 90 * DAY);  // no jurisdiction
    await attest(f.adapter, f.attester, f.lender.address, SANCTIONS, 90 * DAY);
    await expect(originate(f)).to.be.revertedWith("Borrower is not KYC verified");
  });

  it("Refuses a lender without sanctions screening", async function () {
    const f = await loadFixture(kycStack);
    await attest(f.adapter, f.attester, f.borrower.address, ALL, 90 * DAY);
    await expect(originate(f)).to.be.revertedWith("Lender is not eligible");
  });

  it("Tightening a requirement is instant", async function () {
    const f = await loadFixture(slowFactoryStack);
    await f.factory.setRequiredClaims(ALL, SANCTIONS | KYC);
    expect(await f.factory.requiredLenderClaims()).to.equal(SANCTIONS | KYC);
  });

  it("Loosening one waits on the timelock, e.g. switching lender screening off", async function () {
    const f = await loadFixture(slowFactoryStack);
    await expect(f.factory.setRequiredClaims(ALL, 0)).to.be.revertedWith("Action was not queued");
    const id = ethers.keccak256(f.factory.interface.encodeFunctionData("setRequiredClaims", [ALL, 0]));
    await f.factory.queueAction(id);
    await time.increase(2 * DAY);
    await f.factory.setRequiredClaims(ALL, 0);
    expect(await f.factory.requiredLenderClaims()).to.equal(0);
  });

  it("Never lets the borrower requirement be empty, and only the owner may change it", async function () {
    const f = await loadFixture(kycStack);
    await expect(f.factory.setRequiredClaims(0, SANCTIONS)).to.be.revertedWith("Borrowers must be screened");
    await expect(f.factory.connect(f.lender).setRequiredClaims(ALL, SANCTIONS)).to.be.revertedWith("Caller is not the owner");
  });

  it("Works with any adapter: a stand-in for a future ZK adapter", async function () {
    const f = await loadFixture(mockStack);
    await f.adapter.set(f.borrower.address, ALL);
    await f.adapter.set(f.lender.address, SANCTIONS);
    await originate(f);
    expect(await f.factory.totalVaults()).to.equal(1);
  });
});
