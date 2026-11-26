/**
 * RoutedVault, step 1 of the aggregator build (Swap Executor and Price Module
 * Design Note v2): the new vault template must fit under the contract size
 * limit, and the audited Vault must be untouched.
 *
 * WHY A TEST: a contract over 24,576 bytes cannot be deployed at all. Every
 * later step adds to RoutedVault, so this fails the moment one goes too far,
 * not on deployment day.
 */
const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");

const LIMIT = 24576;
const size = async (name) => ((await artifacts.readArtifact(name)).deployedBytecode.length - 2) / 2;

describe("RoutedVault — size and template safety (aggregator build, step 1)", function () {
  it("fits under the 24,576-byte contract limit", async function () {
    const bytes = await size("RoutedVault");
    console.log(`      [RoutedVault ${bytes} bytes, ${LIMIT - bytes} to spare]`);
    expect(bytes).to.be.lessThan(LIMIT);
  });

  it("leaves the audited Vault as it was (24,414 bytes)", async function () {
    expect(await size("Vault")).to.equal(24414);
  });

  it("refuses a price router or swap executor with no code", async function () {
    const [someone] = await ethers.getSigners();
    const F = await ethers.getContractFactory("RoutedVault");
    const code = await (await ethers.getContractFactory("MockERC20")).deploy("Any", "ANY", 18);
    await expect(F.deploy(ethers.ZeroAddress, await code.getAddress())).to.be.revertedWith("Invalid price router");
    await expect(F.deploy(someone.address, await code.getAddress())).to.be.revertedWith("Invalid price router");
    await expect(F.deploy(await code.getAddress(), someone.address)).to.be.revertedWith("Invalid swap executor");
  });

  it("locks the template itself, so only clones can be initialised", async function () {
    const code = await (await ethers.getContractFactory("MockERC20")).deploy("Any", "ANY", 18);
    const a = await code.getAddress();
    const t = await (await ethers.getContractFactory("RoutedVault")).deploy(a, a);
    expect(await t.factory()).to.equal(await t.getAddress());
    expect(await t.PRICE_ROUTER()).to.equal(a);
    expect(await t.SWAP_EXECUTOR()).to.equal(a);
  });
});
