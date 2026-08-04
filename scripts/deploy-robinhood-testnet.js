/**
 * Deploys the Covenza stack to Robinhood Chain testnet, against the REAL
 * Uniswap V3 put there by deploy-uniswap-testnet.js.
 *
 * Differs from deploy-v2-infrastructure.js in three ways that matter:
 *
 *   1. No mock Uniswap. Factory, router and pool come from
 *      uniswap-testnet.json — real audited Uniswap V3 bytecode. This is the
 *      whole point: the mock could not express observation cardinality, which
 *      is how a fund-freeze bug survived 91 passing tests.
 *
 *   2. No Aave. It is not deployed on Robinhood Chain. AssetRegistry's
 *      constructor still requires a non-zero pool address, so a placeholder
 *      goes in and no asset is configured with the Aave venue. The interface
 *      stays in the contracts, dormant, so Aave chains remain available.
 *
 *   3. twapWindow is 60, not 1800. A freshly warmed pool has only a couple of
 *      minutes of observation history, and on a real chain you cannot fast-
 *      forward time. 60 is the contract's floor and the mechanism is
 *      identical — only the wait shortens.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-robinhood-testnet.js --network robinhoodTestnet
 */

const hre = require("hardhat");

// Timelock delay applied to risk-increasing admin actions: administrative
// withdrawal from the insurance pool, repointing the factory's registries, and
// recognising a new identity provider. Zero on testnet so flows can be
// exercised in one sitting; mainnet must pass a real delay. The value is
// IMMUTABLE once deployed — an operator able to shorten it could shorten it to
// zero, act, and restore.
const TIMELOCK_DELAY = Number(process.env.TIMELOCK_DELAY || 0);
const fs = require("fs");
const path = require("path");
const { guardProductionConfig, guardNoYieldVenues } = require("./lib/production-guards");

const TWAP_WINDOW_SECONDS      = 60;   // contract floor; production is 1800
const TWAP_TOLERANCE_BPS       = 300;  // 3%
const GRACE_PERIOD_SECONDS     = 90;   // demo-tuned; production default 36h
const BOUNTY_RATE_PER_HOUR_BPS = 3000; // demo-tuned so a bounty is visible fast
const BOUNTY_CAP_BPS           = 200;  // 2%
const INSURANCE_DRAW_CAP_BPS   = 1000; // 10% of principal

const VENUE_NONE = 0;
const VENUE_4626 = 2;

// Whatever the deployer has left after the Uniswap deployment needs to cover
// the Vault implementation, which is now the largest single deployment here —
// VaultFactory only clones it, so the factory itself is small.
const MIN_BALANCE = ethers => ethers.parseEther("0.0015");

async function main() {

  // Refuses a mainnet deployment carrying testnet values. Every one of them is
  // a legal value the contracts accept, which is exactly why nothing else
  // catches it.
  guardProductionConfig(hre.network.name, {
    timelockDelay: TIMELOCK_DELAY,
    twapWindow: TWAP_WINDOW_SECONDS,
  });
  const { ethers } = hre;
  const [deployer, borrower, keeper] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  if (net.chainId !== 46630n) {
    throw new Error(`Expected Robinhood testnet (46630), got ${net.chainId}.`);
  }

  const uniPath = path.join(__dirname, "..", "uniswap-testnet.json");
  if (!fs.existsSync(uniPath)) {
    throw new Error("uniswap-testnet.json not found — run deploy-uniswap-testnet.js first.");
  }
  const uni = JSON.parse(fs.readFileSync(uniPath, "utf8"));

  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("=".repeat(70));
  console.log("Covenza -> Robinhood Chain testnet, against real Uniswap V3");
  console.log("=".repeat(70));
  console.log(`\nDeployer  ${deployer.address}`);
  console.log(`Balance   ${ethers.formatEther(balance)} ETH`);
  console.log(`\nUniswap factory  ${uni.uniswapFactory}`);
  console.log(`SwapRouter02     ${uni.swapRouter}`);
  console.log(`tUSDG            ${uni.tokens.tUSDG}`);
  console.log(`tWETH            ${uni.tokens.tWETH}`);

  if (balance < MIN_BALANCE(ethers)) {
    throw new Error(
      `Balance too low — VaultFactory alone is a large deployment. ` +
      `Claim from the faucet and retry.`
    );
  }

  const usdg = uni.tokens.tUSDG;
  const weth = uni.tokens.tWETH;

  // --- Prerequisites must actually exist ---------------------------------
  //
  // A call to an address with no code SUCCEEDS with empty returndata. So a
  // vanished token silently accepts mint() and approve() as no-ops, and the
  // failure only surfaces later where a bool return is decoded — which is how
  // a wiped testnet presented as "Funding transfer failed" three steps
  // downstream of the actual problem.
  //
  // Robinhood Chain testnet HAS been reset at least once, taking every
  // deployed contract with it. Check before doing any work.
  for (const [label, addr] of [
    ["Uniswap factory", uni.uniswapFactory],
    ["SwapRouter02",    uni.swapRouter],
    ["tUSDG",           usdg],
    ["tWETH",           weth],
    ["pool",            uni.pools[0].address],
  ]) {
    if ((await ethers.provider.getCode(addr)).length <= 2) {
      throw new Error(
        `${label} at ${addr} has no code.\n\n` +
        `Everything in uniswap-testnet.json is gone — the testnet has been reset.\n` +
        `Re-run scripts/deploy-uniswap-testnet.js first, then this script.`
      );
    }
  }
  console.log("\nPrerequisites verified — Uniswap and tokens still deployed.");

  // --- 1. KYCRegistry (fresh — nothing exists on this chain) -----------

  // ATTESTER_KEY is the identity provider's signing key. Defaulting it to the
  // deployer makes Covenza its own identity provider — able to admit any
  // wallet with a signature it produces itself, which is the arrangement the
  // attester redesign exists to remove. That default was fixed in
  // upgrade-kyc-registry.js and reintroduced here, because the fix went into
  // one script rather than everywhere the constructor is called.
  //
  // Tolerated on testnet, where the mock signer has to come from somewhere,
  // but it is announced rather than silent — and the production guard refuses
  // it outright.
  const attesterKey = process.env.ATTESTER_KEY || deployer.address;
  if (attesterKey.toLowerCase() === deployer.address.toLowerCase()) {
    console.log("\n  NOTE: no ATTESTER_KEY set — the deployer is the initial attester.");
    console.log("  Covenza can attest for itself until this key is delisted.");
    console.log("  Delist it once a real provider is recognised.");
  }

  const kyc = await (await ethers.getContractFactory("KYCRegistry", deployer))
    .deploy(deployer.address, attesterKey, TIMELOCK_DELAY);
  await kyc.waitForDeployment();
  console.log(`\nKYCRegistry     ${await kyc.getAddress()}`);

  await (await kyc.verify(borrower.address)).wait();
  console.log(`  verified borrower ${borrower.address}`);

  // --- 2. ERC-4626 yield venue over tUSDG ------------------------------
  //
  // Stands in for a MetaMorpho vault until one is confirmed on this chain.
  // Deploying it now means the 4626 path is exercised on-chain rather than
  // only in the local suite — and it is the path that will actually be used
  // in production, since Aave is not here.

  const venue = await (await ethers.getContractFactory("MockERC4626", deployer)).deploy(usdg);
  await venue.waitForDeployment();
  const venueAddress = await venue.getAddress();
  console.log(`\nERC-4626 venue  ${venueAddress} (over tUSDG)`);

  // --- 3. InsurancePool -------------------------------------------------

  const pool = await (await ethers.getContractFactory("InsurancePool", deployer))
    .deploy(deployer.address, INSURANCE_DRAW_CAP_BPS, TIMELOCK_DELAY);
  await pool.waitForDeployment();
  console.log(`InsurancePool   ${await pool.getAddress()}`);

  // --- 4. AssetRegistry, pointed at REAL Uniswap -----------------------
  //
  // The Aave pool argument is a placeholder: the constructor rejects zero,
  // but nothing reads it unless an asset is given the Aave venue, and none is.

  const registry = await (await ethers.getContractFactory("AssetRegistry", deployer)).deploy(
    deployer.address,
    deployer.address,      // aavePool placeholder — Aave is not on this chain
    uni.swapRouter,
    uni.uniswapFactory,
    weth
  );
  await registry.waitForDeployment();
  console.log(`AssetRegistry   ${await registry.getAddress()}`);

  // tUSDG earns yield through the 4626 venue; tWETH is swap-only. Neither
  // carries a grace extension — both are continuously tradeable. Stock
  // tokens are where extensions apply.
  await (await registry.addAssetWithVenue(
    usdg, ethers.ZeroAddress, VENUE_4626, venueAddress, 0
  )).wait();
  await (await registry.addAssetWithVenue(
    weth, ethers.ZeroAddress, VENUE_NONE, ethers.ZeroAddress, 0
  )).wait();
  console.log("  whitelisted tUSDG (ERC-4626 venue) and tWETH (swap-only)");

  await (await registry.setSettlementConfig(
    TWAP_WINDOW_SECONDS, TWAP_TOLERANCE_BPS, GRACE_PERIOD_SECONDS,
    BOUNTY_RATE_PER_HOUR_BPS, BOUNTY_CAP_BPS
  )).wait();
  console.log(`  settlement config set (twapWindow ${TWAP_WINDOW_SECONDS}s — see header)`);

  // --- Risk tiers ---
  //
  // Launch defaults are in the constructor; these override them for a testnet
  // where terms are measured in minutes. The deposit floor scales with
  // sqrt(term), so at 900 seconds the volatility component is ~0.6% and the
  // absolute floor governs — without one, a testnet loan would need no deposit
  // at all and the settlement paths would never be exercised properly.
  //
  // Maximum terms stay short deliberately: they are what makes a volatile
  // asset lendable, and testnet is where that should be visible.
  // Blue chip exposure is 70%, not 100%. At full exposure the deposit is the
  // only thing between the asset and the pool, so a 14.9% fall at seven days —
  // 1.9 sigma, ~2.8% likely — starts costing the pool, against a premium of
  // 1.92bp. Modelled expected draw there was 9.01bp: underwritten roughly
  // fivefold. Tightening exposure rather than raising the premium keeps to the
  // principle the tiers were built on — deposits are the control, rates are the
  // compensation. See scripts/model-insurance-solvency.js.
  await (await registry.setTierConfig(0, 6000, 1000,  30 * 86400, 7000, 100)).wait();
  await (await registry.setTierConfig(1, 10000, 2000,  7 * 86400,  5000, 250)).wait();
  // Speculative's premium is 100bps, not 600. Its 40% deposit exceeds the 25%
  // maximum possible loss, so the pool's exposure is not merely improbable, it
  // is arithmetically zero — the position cannot fall far enough. No tail model
  // changes that, which is what separates it from Standard, whose 4.9-sigma
  // threshold fat tails could plausibly reach.
  //
  // Charging 600bps for cover that cannot pay is not a solvency problem; it is
  // selling something that does not exist. Kept nominal rather than zero
  // because the tier still consumes administration and reserve capacity.
  await (await registry.setTierConfig(2, 20000, 4000,      86400,  2500, 100)).wait();
  console.log("  tier config set (BlueChip / Standard / Speculative)");

  // Both test tokens are blue chip here — they are mock ERC-20s against a pool
  // we control, so the tier reflects how they behave rather than what they are
  // named after.
  await (await registry.setTier(usdg, 0)).wait();
  await (await registry.setTier(weth, 0)).wait();
  console.log("  tUSDG and tWETH tagged BlueChip");

  // --- 5. VaultFactory ---------------------------------------------------

  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  if (!process.env.TREASURY_ADDRESS) {
    console.log("\n  TREASURY_ADDRESS unset — protocol fees will go to the deployer.");
  }

  // Vaults are EIP-1167 clones of one implementation, so the factory no
  // longer embeds Vault bytecode and needs no library link. The
  // IMPLEMENTATION does — it delegatecalls UniswapTwap.
  const twapLib = await (await ethers.getContractFactory("UniswapTwap", deployer)).deploy();
  await twapLib.waitForDeployment();
  const vaultImpl = await (await ethers.getContractFactory("Vault", {
    signer: deployer,
    libraries: { UniswapTwap: await twapLib.getAddress() },
  })).deploy();
  await vaultImpl.waitForDeployment();
  console.log(`\nUniswapTwap lib ${await twapLib.getAddress()}`);
  console.log(`Vault impl      ${await vaultImpl.getAddress()} (clone source, never initialised)`);

  const factory = await (await ethers.getContractFactory("VaultFactory", deployer)).deploy(
    await kyc.getAddress(), await registry.getAddress(), await pool.getAddress(), treasury,
    await vaultImpl.getAddress()
  ,
    TIMELOCK_DELAY);
  await factory.waitForDeployment();
  console.log(`VaultFactory    ${await factory.getAddress()}`);

  await (await pool.setVaultFactory(await factory.getAddress())).wait();
  console.log("  InsurancePool wired to factory");

  // --- 6. Confirm the guard agrees with reality ------------------------
  //
  // The most valuable line of output here. canQuote() is what stops a
  // borrower entering a position settlement could not exit, and this is it
  // being evaluated against real Uniswap rather than against a mock.

  console.log("\n" + "-".repeat(70));
  console.log("Verifying the TWAP guard against the real pool:");

  // canQuote is an internal library function with no external surface, so
  // probe the pool with the exact call the library makes.
  const poolAbi = ["function observe(uint32[]) view returns (int56[], uint160[])"];
  const poolContract = await ethers.getContractAt(poolAbi, uni.pools[0].address);

  for (const w of [TWAP_WINDOW_SECONDS, 1800]) {
    try {
      await poolContract.observe([w, 0]);
      console.log(`  ${String(w).padStart(4)}s window: quotable`);
    } catch {
      console.log(`  ${String(w).padStart(4)}s window: NOT quotable — swaps at this window would be refused`);
    }
  }

  // --- 7. Seed balances -------------------------------------------------

  const Mock = await ethers.getContractFactory("MockERC20", deployer);
  const usdgToken = Mock.attach(usdg);
  const wethToken = Mock.attach(weth);

  await (await usdgToken.mint(deployer.address, ethers.parseEther("100000"))).wait();
  await (await usdgToken.mint(borrower.address, ethers.parseEther("1000"))).wait();
  await (await wethToken.mint(borrower.address, ethers.parseEther("10"))).wait();
  console.log("\nSeeded tUSDG/tWETH to deployer and borrower");

  const seed = ethers.parseEther("2000");
  await (await usdgToken.approve(await pool.getAddress(), seed)).wait();
  await (await pool.fund(usdg, seed)).wait();
  console.log("Insurance pool seeded with 2,000 tUSDG");

  // --- 8. Persist --------------------------------------------------------

  const addressesPath = path.join(__dirname, "..", "deployed-addresses.json");
  const all = fs.existsSync(addressesPath)
    ? JSON.parse(fs.readFileSync(addressesPath, "utf8"))
    : {};

  all.robinhoodTestnet = {
    chainId: 46630,
    kycRegistry:    await kyc.getAddress(),
    assetRegistry:  await registry.getAddress(),
    insurancePool:  await pool.getAddress(),
    vaultFactory:   await factory.getAddress(),
    // Recorded because redeploying only the factory later needs both, and
    // because the implementation is what a verifier should be pointed at —
    // clones carry no code of their own for an explorer to show.
    vaultImplementation: await vaultImpl.getAddress(),
    uniswapTwapLibrary:  await twapLib.getAddress(),
    treasury,
    yieldVenue4626: venueAddress,
    verifiedBorrower: borrower.address,
    keeper: keeper ? keeper.address : null,
    tokens: { tUSDG: usdg, tWETH: weth },
    uniswap: {
      factory: uni.uniswapFactory,
      router: uni.swapRouter,
      pool: uni.pools[0].address,
      note: "REAL Uniswap V3, deployed by deploy-uniswap-testnet.js",
    },
    twapWindow: TWAP_WINDOW_SECONDS,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(addressesPath, JSON.stringify(all, null, 2));

  const spent = balance - (await ethers.provider.getBalance(deployer.address));

  console.log("\n" + "=".repeat(70));
  console.log("deployed-addresses.json updated (robinhoodTestnet)");
  console.log(`Gas spent: ${ethers.formatEther(spent)} ETH`);
  console.log(`Remaining: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log(`\nExplorer: https://explorer.testnet.chain.robinhood.com/address/${await factory.getAddress()}`);
  console.log("=".repeat(70));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
