// Group F — fresh testnet deployment of the v2 multi-asset stack.
//
// Usage:
//   npx hardhat run scripts/deploy-v2-infrastructure.js --network hardhat        (dry run, local)
//   npx hardhat run scripts/deploy-v2-infrastructure.js --network arbitrumSepolia
//
// What this deploys, and why:
//
//   KYCRegistry — REUSED, not redeployed. Its constructor and every function
//   are unchanged by the v2 rebuild (see checklist Group F item 1 — this is
//   the answer). Redeploying it would reset every verified address and
//   badge to zero for no reason. Read from deployed-addresses.json.
//
//   Full mock integration stack (MockERC20 x4, MockAavePool, MockSwapRouter,
//   MockUniswapV3Factory/Pool) — deployed fresh, matching EXACTLY what
//   test/GroupB.test.js already exercises. This was a deliberate choice
//   (not real Aave V3 / Uniswap V3 Sepolia): the checklist's Group F proof
//   requires a "genuine loss settling correctly" and "insurance pool
//   actually paying out" — both need a controllable, reproducible price
//   move. That's not realistically achievable against real (illiquid,
//   unowned) Sepolia Uniswap pools. The mock router's setRate() and the
//   mock pool's setAvgTick() give the lifecycle-proof script exact control,
//   the same way the local test suite gets it.
//
//   InsurancePool, AssetRegistry, VaultFactory — new contracts / new
//   constructor shape (VaultFactory now takes 3 args, not 1). Deployed
//   fresh and wired together.
//
// Whitelists all 4 assets (WETH/WBTC/USDC/USDT) with Aave support on all 4
// (free to do with mocks, maximises what's testable pre-audit). Only wires
// a live Uniswap pool + swap rates for the USDC<->USDT pair — enough for
// the lifecycle proof and initial live UI testing. Adding another pair
// later is the same 3-call pattern used below for USDC<->USDT.
//
// USDC<->USDT specifically (not WETH<->USDC) because both are 6 decimals:
// a Uniswap tick of 0 means a true 1:1 raw-unit ratio, which for
// equal-decimal tokens IS the real 1:1 price — same trick GroupB.test.js
// uses with its two 18dp mock tokens. A WETH(18dp)<->USDC(6dp) pool would
// need a tick computed to offset the 12-decimal gap before tick 0 meant
// anything close to a real price, which is exactly the kind of hand-derived
// tick math worth avoiding when a same-decimal pair does the job with zero
// risk of a silent mismatch between the router's rate and the pool's tick.

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// --- Demo-tuned settlement config ---
// NOT production values. Shortened so the full three-tier lifecycle proof
// (Group F item 3) can run to completion in one sitting instead of over the
// Build-Readiness Spec's real 36-hour grace period. Before a real launch,
// call AssetRegistry.setSettlementConfig() again with production values —
// the operator UI's Settlement Configuration panel (Group E6) does this.
const TWAP_WINDOW_SECONDS   = 1800; // mock pool ignores this either way
const TWAP_TOLERANCE_BPS    = 300;  // 3%
const GRACE_PERIOD_SECONDS  = 90;   // production default is 36 hours
const BOUNTY_RATE_PER_HOUR_BPS = 3000; // production default is 2 — demo-only
const BOUNTY_CAP_BPS        = 200;  // 2%

const INSURANCE_DRAW_CAP_BPS = 1000; // 10% of principal, matches test convention

// --- Protocol fee treasury ---
// Set TREASURY_ADDRESS in .env to your dedicated fee-collection address
// before any deployment you intend to earn from. Deliberately separate from
// the deployer/operator key so revenue and governance are not the same
// wallet. Falls back to the deployer only so local dry runs work without
// configuration — the script warns loudly when it does.
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || "";

const POOL_FEE = 3000; // Uniswap V3 0.3% tier, used for the USDC<->USDT pool

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const addressesPath = path.join(__dirname, "..", "deployed-addresses.json");
  if (!fs.existsSync(addressesPath)) {
    throw new Error(
      "deployed-addresses.json not found — run deploy-infrastructure.js first " +
      "to establish a KYCRegistry for this network."
    );
  }
  const allAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const existing = allAddresses[hre.network.name];
  if (!existing || !existing.kycRegistry) {
    throw new Error(`No existing KYCRegistry found for network "${hre.network.name}".`);
  }
  const kycRegistryAddress = existing.kycRegistry;

  const code = await hre.ethers.provider.getCode(kycRegistryAddress);
  if (code === "0x") {
    throw new Error(`No contract code at KYCRegistry address ${kycRegistryAddress} — refusing to build on top of it.`);
  }

  console.log("Deploying v2 multi-asset infrastructure...");
  console.log("Network:              ", hre.network.name);
  console.log("Deployer/operator:    ", deployer.address);
  console.log("Existing KYCRegistry: ", kycRegistryAddress, "(reused, unchanged)");
  console.log();

  // --- Step 1: Mock tokens ---
  const Mock = await hre.ethers.getContractFactory("MockERC20", deployer);
  const weth = await Mock.deploy("Mock Wrapped Ether", "WETH", 18);
  await weth.waitForDeployment();
  const wbtc = await Mock.deploy("Mock Wrapped Bitcoin", "WBTC", 8);
  await wbtc.waitForDeployment();
  const usdc = await Mock.deploy("Mock USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  const usdt = await Mock.deploy("Mock Tether USD", "USDT", 6);
  await usdt.waitForDeployment();
  console.log("✅ Mock tokens deployed:");
  console.log("   WETH:", await weth.getAddress());
  console.log("   WBTC:", await wbtc.getAddress());
  console.log("   USDC:", await usdc.getAddress());
  console.log("   USDT:", await usdt.getAddress());

  // --- Step 2: Mock Aave, configure aTokens for all 4 assets ---
  const aave = await (await hre.ethers.getContractFactory("MockAavePool", deployer)).deploy();
  await aave.waitForDeployment();
  const tokens = { weth, wbtc, usdc, usdt };
  const aTokens = {};
  for (const [symbol, token] of Object.entries(tokens)) {
    const tx = await aave.configureAsset(await token.getAddress());
    await tx.wait();
    aTokens[symbol] = await aave.aTokenOf(await token.getAddress());
  }
  console.log("\n✅ MockAavePool deployed:", await aave.getAddress());
  console.log("   aTokens configured for all 4 assets.");

  // --- Step 3: Mock Uniswap (router + factory), one pool for USDC<->USDT ---
  const router = await (await hre.ethers.getContractFactory("MockSwapRouter", deployer)).deploy();
  await router.waitForDeployment();
  const uniFactory = await (await hre.ethers.getContractFactory("MockUniswapV3Factory", deployer)).deploy();
  await uniFactory.waitForDeployment();
  const usdcUsdtPool = await (await hre.ethers.getContractFactory("MockUniswapV3Pool", deployer)).deploy();
  await usdcUsdtPool.waitForDeployment();

  await (await uniFactory.setPool(
    await usdc.getAddress(), await usdt.getAddress(), POOL_FEE, await usdcUsdtPool.getAddress()
  )).wait();
  await (await usdcUsdtPool.setAvgTick(0)).wait(); // tick 0 = true 1:1 (equal decimals) — lifecycle-proof.js moves it for the loss demo

  // Exact 1:1 both directions, matching tick 0 above.
  await (await router.setRate(await usdc.getAddress(), await usdt.getAddress(), 1n, 1n)).wait();
  await (await router.setRate(await usdt.getAddress(), await usdc.getAddress(), 1n, 1n)).wait();

  // Fund the router so it can actually pay out both directions.
  await (await usdc.mint(await router.getAddress(), hre.ethers.parseUnits("1000000", 6))).wait();
  await (await usdt.mint(await router.getAddress(), hre.ethers.parseUnits("1000000", 6))).wait();

  console.log("\n✅ MockSwapRouter deployed:  ", await router.getAddress());
  console.log("✅ MockUniswapV3Factory:     ", await uniFactory.getAddress());
  console.log("✅ USDC<->USDT pool:         ", await usdcUsdtPool.getAddress());
  console.log("   (Other pairs not wired yet — same 3-call pattern to add one later.)");

  // --- Step 4: InsurancePool ---
  const pool = await (await hre.ethers.getContractFactory("InsurancePool", deployer))
    .deploy(deployer.address, INSURANCE_DRAW_CAP_BPS);
  await pool.waitForDeployment();
  console.log("\n✅ InsurancePool deployed:", await pool.getAddress());

  // --- Step 5: AssetRegistry ---
  const registry = await (await hre.ethers.getContractFactory("AssetRegistry", deployer)).deploy(
    deployer.address,
    await aave.getAddress(),
    await router.getAddress(),
    await uniFactory.getAddress(),
    await weth.getAddress()
  );
  await registry.waitForDeployment();
  console.log("✅ AssetRegistry deployed:", await registry.getAddress());

  for (const [symbol, token] of Object.entries(tokens)) {
    await (await registry.addAsset(await token.getAddress(), aTokens[symbol])).wait();
  }
  console.log("   Whitelisted WETH, WBTC, USDC, USDT (all with Aave support).");

  await (await registry.setSettlementConfig(
    TWAP_WINDOW_SECONDS, TWAP_TOLERANCE_BPS, GRACE_PERIOD_SECONDS,
    BOUNTY_RATE_PER_HOUR_BPS, BOUNTY_CAP_BPS
  )).wait();
  console.log("   Settlement config set (DEMO-TUNED — see script header).");

  // --- Step 6: VaultFactory, wired to the existing KYCRegistry ---
  const treasury = TREASURY_ADDRESS || deployer.address;
  if (!TREASURY_ADDRESS) {
    console.log("\n⚠️  TREASURY_ADDRESS is not set — defaulting the protocol fee");
    console.log("   treasury to the deployer address. Set it in .env before any");
    console.log("   deployment you intend to collect fees from.");
  }

  // Vaults are EIP-1167 clones of one implementation, so the factory no
  // longer embeds Vault bytecode and needs no library link. The
  // IMPLEMENTATION does — it delegatecalls UniswapTwap.
  const twapLib = await (await hre.ethers.getContractFactory("UniswapTwap", deployer)).deploy();
  await twapLib.waitForDeployment();
  const vaultImpl = await (await hre.ethers.getContractFactory("Vault", {
    signer: deployer,
    libraries: { UniswapTwap: await twapLib.getAddress() },
  })).deploy();
  await vaultImpl.waitForDeployment();
  const factory = await (await hre.ethers.getContractFactory("VaultFactory", deployer)).deploy(
    kycRegistryAddress, await registry.getAddress(), await pool.getAddress(), treasury,
      await vaultImpl.getAddress()   // clone source
  );
  await factory.waitForDeployment();
  console.log("✅ VaultFactory deployed:", await factory.getAddress());
  console.log("   Protocol fee treasury:", treasury);
  console.log("   Protocol fee rate:     10% of each loan's fee (add-on, charged to borrower)");

  await (await pool.setVaultFactory(await factory.getAddress())).wait();
  console.log("   InsurancePool wired to the new factory.");

  // --- Step 7: seed balances for testing ---
  // USDC is the currency the lifecycle-proof.js demo loans are denominated
  // in (see that script's header for why) — seed generously in USDC/USDT,
  // plus a smaller round of WETH/WBTC so the live UI has something to show
  // for every asset from the start.
  const borrowerAddress = existing.verifiedBorrower;
  await (await usdc.mint(deployer.address, hre.ethers.parseUnits("100000", 6))).wait();
  await (await usdc.mint(borrowerAddress, hre.ethers.parseUnits("1000", 6))).wait();
  await (await weth.mint(deployer.address, hre.ethers.parseUnits("100", 18))).wait();
  await (await weth.mint(borrowerAddress, hre.ethers.parseUnits("5", 18))).wait();
  await (await wbtc.mint(deployer.address, hre.ethers.parseUnits("5", 8))).wait();
  console.log("\n✅ Seed balances minted to deployer (lender) and existing verified borrower.");

  // Seed the insurance pool's USDC reserve directly, on top of whatever the
  // first vault's own origination skim contributes — makes the tier-2 loss
  // demo's payout meaningfully visible rather than capped by a near-empty
  // reserve on the very first loan.
  const seedReserve = hre.ethers.parseUnits("2000", 6);
  await (await usdc.approve(await pool.getAddress(), seedReserve)).wait();
  await (await pool.fund(await usdc.getAddress(), seedReserve)).wait();
  console.log("✅ Insurance pool seeded with 2,000 USDC in its USDC reserve.");

  // --- Step 8: persist addresses ---
  const updated = {
    ...existing,
    kycRegistry: kycRegistryAddress, // unchanged, kept explicit
    vaultFactory: await factory.getAddress(),
    assetRegistry: await registry.getAddress(),
    insurancePool: await pool.getAddress(),
    treasury: treasury,
    tokens: {
      weth: await weth.getAddress(),
      wbtc: await wbtc.getAddress(),
      usdc: await usdc.getAddress(),
      usdt: await usdt.getAddress(),
    },
    mocks: {
      aavePool: await aave.getAddress(),
      swapRouter: await router.getAddress(),
      uniswapFactory: await uniFactory.getAddress(),
      usdcUsdtPool: await usdcUsdtPool.getAddress(),
    },
    previousVaultFactory: existing.vaultFactory,
    v2DeployedAt: new Date().toISOString(),
  };
  allAddresses[hre.network.name] = updated;
  fs.writeFileSync(addressesPath, JSON.stringify(allAddresses, null, 2));
  console.log("\n📄 deployed-addresses.json updated.");

  // --- Step 9: verification command list ---
  console.log("\n─".repeat(60));
  console.log("Independent on-chain verification (Group F item 2) — run these:\n");
  console.log(`npx hardhat verify --network ${hre.network.name} ${await weth.getAddress()} "Mock Wrapped Ether" "WETH" 18`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${await wbtc.getAddress()} "Mock Wrapped Bitcoin" "WBTC" 8`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${await usdc.getAddress()} "Mock USD Coin" "USDC" 6`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${await usdt.getAddress()} "Mock Tether USD" "USDT" 6`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${await aave.getAddress()}`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${await router.getAddress()}`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${await uniFactory.getAddress()}`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${await usdcUsdtPool.getAddress()}`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${await pool.getAddress()} ${deployer.address} ${INSURANCE_DRAW_CAP_BPS}`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${await registry.getAddress()} ${deployer.address} ${await aave.getAddress()} ${await router.getAddress()} ${await uniFactory.getAddress()} ${await weth.getAddress()}`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${await factory.getAddress()} ${kycRegistryAddress} ${await registry.getAddress()} ${await pool.getAddress()} ${treasury}`);
  console.log("\nExplorer root: https://sepolia.arbiscan.io/address/" + (await factory.getAddress()));

  console.log("\n⚠️  Next: send the updated deployed-addresses.json (or just the new");
  console.log("   addresses) back so the frontend's config/contracts.js can be updated.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});