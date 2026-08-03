const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  guardProductionConfig,
  guardNoYieldVenues,
  MIN_TWAP_WINDOW,
  MIN_TIMELOCK,
} = require("../scripts/lib/production-guards");

/**
 * The guards exist because every value they reject is LEGAL. The contracts
 * accept a 60-second TWAP window, a zero timelock and a mock yield venue —
 * testing requires them to. So no revert fires, no test fails, and a testnet
 * configuration reaches production silently.
 *
 * That makes these tests the only thing standing between "the default" and
 * "the deployment", which is why they assert the guard fires rather than
 * trusting that it does.
 */
describe("Production deployment guards", function () {

  const SAFE = { timelockDelay: MIN_TIMELOCK, twapWindow: MIN_TWAP_WINDOW };

  afterEach(function () {
    delete process.env.ALLOW_UNSAFE_PRODUCTION;
  });

  it("Ignores testnet networks entirely", function () {
    expect(() =>
      guardProductionConfig("robinhoodTestnet", { timelockDelay: 0, twapWindow: 60 })
    ).to.not.throw();
    expect(() =>
      guardProductionConfig("hardhat", { timelockDelay: 0, twapWindow: 60 })
    ).to.not.throw();
  });

  it("Refuses a zero timelock on production", function () {
    // The default, introduced in the same change that added the timelocks.
    expect(() =>
      guardProductionConfig("robinhoodMainnet", { ...SAFE, timelockDelay: 0 })
    ).to.throw(/timelock delay is 0s/);
  });

  it("Refuses a timelock shorter than a day", function () {
    expect(() =>
      guardProductionConfig("robinhoodMainnet", { ...SAFE, timelockDelay: 3600 })
    ).to.throw(/timelock delay is 3600s/);
  });

  it("Refuses the contract-minimum TWAP window on production", function () {
    expect(() =>
      guardProductionConfig("robinhoodMainnet", { ...SAFE, twapWindow: 60 })
    ).to.throw(/TWAP window is 60s/);
  });

  it("Accepts a properly configured production deployment", function () {
    expect(() => guardProductionConfig("robinhoodMainnet", SAFE)).to.not.throw();
  });

  it("Refuses an operator that is also the deploying key", function () {
    const addr = "0x1111111111111111111111111111111111111111";
    expect(() =>
      guardProductionConfig("robinhoodMainnet", { ...SAFE, operator: addr, deployer: addr })
    ).to.throw(/operator is the deploying EOA/);
  });

  it("Refuses an initial attester that is the deploying key", function () {
    // This regressed once already: fixed in upgrade-kyc-registry.js, then
    // reintroduced by a different deploy script's default. Asserting it here
    // means the next script to get it wrong fails a test rather than shipping.
    const addr = "0x2222222222222222222222222222222222222222";
    expect(() =>
      guardProductionConfig("robinhoodMainnet", { ...SAFE, attesterKey: addr, deployer: addr })
    ).to.throw(/initial attester is the deploying key/);
  });

  it("Reports every problem at once, not just the first", function () {
    // Fixing one thing and rerunning to discover the next is how a deployment
    // at the end of a long day goes wrong.
    let message = "";
    try {
      guardProductionConfig("robinhoodMainnet", { timelockDelay: 0, twapWindow: 60 });
    } catch (e) { message = e.message; }

    expect(message).to.match(/timelock delay/);
    expect(message).to.match(/TWAP window/);
  });

  it("Can be overridden, loudly", function () {
    process.env.ALLOW_UNSAFE_PRODUCTION = "1";
    expect(() =>
      guardProductionConfig("robinhoodMainnet", { timelockDelay: 0, twapWindow: 60 })
    ).to.not.throw();
  });

  // --- Yield venues ---

  it("Refuses production when any asset has a yield venue set", async function () {
    const [operator] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const usdx = await Mock.deploy("USDX", "USDX", 18);
    const aave = await (await ethers.getContractFactory("MockAavePool")).deploy();
    const router = await (await ethers.getContractFactory("MockSwapRouter")).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();

    const registry = await (await ethers.getContractFactory("AssetRegistry")).deploy(
      operator.address, await aave.getAddress(), await router.getAddress(),
      await uniFactory.getAddress(), await usdx.getAddress()
    );

    const vault4626 = await (await ethers.getContractFactory("MockERC4626"))
      .deploy(await usdx.getAddress());

    await registry.addAssetWithVenue(
      await usdx.getAddress(), ethers.ZeroAddress, 2, await vault4626.getAddress(), 0
    );

    await expect(
      guardNoYieldVenues("robinhoodMainnet", registry, [await usdx.getAddress()])
    ).to.be.rejectedWith(/yield venue set/);

    // The same registry is fine on testnet, which is the whole point — the
    // configuration is not wrong, it is wrong THERE.
    await expect(
      guardNoYieldVenues("robinhoodTestnet", registry, [await usdx.getAddress()])
    ).to.not.be.rejected;
  });

  it("Accepts production when every venue is None", async function () {
    const [operator] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    const usdx = await Mock.deploy("USDX", "USDX", 18);
    const aave = await (await ethers.getContractFactory("MockAavePool")).deploy();
    const router = await (await ethers.getContractFactory("MockSwapRouter")).deploy();
    const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();

    const registry = await (await ethers.getContractFactory("AssetRegistry")).deploy(
      operator.address, await aave.getAddress(), await router.getAddress(),
      await uniFactory.getAddress(), await usdx.getAddress()
    );
    await registry.addAsset(await usdx.getAddress(), ethers.ZeroAddress);

    await expect(
      guardNoYieldVenues("robinhoodMainnet", registry, [await usdx.getAddress()])
    ).to.not.be.rejected;
  });
});
