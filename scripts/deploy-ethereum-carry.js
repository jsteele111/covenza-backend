/**
 * Deploys matched-pair carry to ETHEREUM MAINNET, against the real Uniswap V3
 * wstETH/WETH 0.01% pool (Covenza Ethereum Deployment Plan v2, sections 3–6).
 *
 * The audited contracts are unchanged. Only the settings differ from the
 * Robinhood Chain build, and every one of them is in the plan:
 *
 *   - Only WETH and wstETH are listed. The "Matched pair" tier occupies the
 *     Blue chip slot: 5% volatility, 5% minimum deposit, 120-day maximum
 *     term, 100% exposure cap, 0.25% a year premium. Approving any cross pair
 *     would make that tier unsafe (test/MatchedPairCarry.test.js, check 4).
 *   - Standard and Speculative get the approved launch values. Nothing is
 *     listed at those tiers, but contract defaults must never go live.
 *   - Outage detection OFF: Ethereum has no single block producer
 *     (scripts/lib/production-guards.js).
 *   - Minimum pool depth: 25% of the pool's in-range depth (decision 2).
 *   - Timelock: 2 days (decision 5).
 *   - Price window 30 min, tolerance 2%, grace 36 h, entry impact 1%, insured
 *     window 5 days: these ARE the contract launch defaults, so they are
 *     checked, not set.
 *
 * TWO PHASES, because of the timelock:
 *
 *   Phase 1 (this script, no PHASE set): deploys everything, applies what may
 *   apply at once, and ANNOUNCES what must wait: switching outage detection
 *   off, and wiring the protection reserve to the factory. Names the approved
 *   pool only if its price history is already live.
 *
 *   After 2 days: scripts/execute-timelocked.js executes the announcements.
 *
 *   Phase 2 (PHASE=approve-pool): once the pool's history is live
 *   (scripts/grow-pool-history.js says READY), names it. Then the partner
 *   funds the reserve (at least 500 WETH, decision 4), and
 *   scripts/transfer-control.js hands control to the partner's Safes.
 *
 * REQUIRED ON MAINNET (the production guard refuses otherwise):
 *   ATTESTER_KEY   the partner's identity provider's signing key, not the deployer
 *   OPERATOR_SAFE  the partner's operator multisig, not the deployer
 *   TREASURY_ADDRESS  where protocol fees go
 * Optional:
 *   PROTOCOL_FEE_BPS  as agreed with the partner (contract default 1000 = 10% of interest)
 *   MIN_POOL_LIQUIDITY  override the 25% minimum depth (raw Uniswap liquidity units)
 *
 * Usage (PowerShell: set each variable with $env:NAME = "value" first):
 *   npx hardhat run scripts/deploy-ethereum-carry.js --network mainnet
 *   PHASE=approve-pool npx hardhat run scripts/deploy-ethereum-carry.js --network mainnet
 *
 * TESTNET REHEARSAL (Sepolia; deployment plan decision 1). Two extra settings,
 * both REFUSED on mainnet:
 *   CHAIN_FILE=uniswap-sepolia.json   the test pool from setup-sepolia-carry-pool.js
 *   TIMELOCK_DELAY_SECONDS=3600       a shorter delay, so both phases fit in an afternoon
 * On testnets the attester and treasury default to the deployer, with a warning.
 *
 * PRODUCTION (security review, 26 Nov 2026): the run reads only .env.mainnet
 * and signs only with its DEPLOYER_PRIVATE_KEY (S5); the operator Safe and the
 * treasury must be Safes needing at least 2 of 3 signatures (S1, S2) and must
 * be typed for the run:
 *   $env:CONFIRM_OPERATOR_SAFE="0x…"; $env:CONFIRM_TREASURY="0x…"
 * The tier settings must pass the M-07 calibration rule (S8), and the
 * deployment record carries the audit status and disclosures (S7).
 *   $env:CHAIN_FILE="uniswap-sepolia.json"; $env:TIMELOCK_DELAY_SECONDS="3600"; npx hardhat run scripts/deploy-ethereum-carry.js --network sepolia   (PowerShell)
 */

const fs = require("fs");
const path = require("path");
const { guardProductionConfig, isProduction } = require("./lib/production-guards");
const { requireProductionSafe } = require("./lib/safe-checks");
const { envFileFor, requireTypedConfirmation } = require("./lib/production-env");
const { sendOrQueue, readPending, writePending, fmt } = require("./lib/timelock");
const { checkPoolHistory } = require("./lib/pool-history");

// Ethereum mainnet. Verify every address on Etherscan before a real run.
const ETHEREUM = {
  chainId: 1n,
  uniswapFactory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  swapRouter02:   "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  weth:           "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  wstETH:         "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  poolFee:        100,   // the 0.01% pool
};

const TIMELOCK_DELAY = 2 * 86400;          // decision 5
const DRAW_CAP_BPS   = 1000;               // a single draw: at most 10% of the loan's principal
const MIN_DEPTH_SHARE = 4n;                // decision 2: minimum = in-range depth / 4

// Tier slots (AssetRegistry.RiskTier): [assumedVolBps, minDepositBps, maxTermSeconds, maxExposureBps, premiumBps]
const TIERS = [
  { slot: 0, name: "Matched pair (Blue chip slot)", cfg: [500, 500, 120 * 86400, 10000, 25] },
  { slot: 1, name: "Standard (launch values)",       cfg: [10000, 2000, 7 * 86400, 5000, 250] },
  { slot: 2, name: "Speculative (launch values)",    cfg: [20000, 4000, 86400, 2500, 100] },
];

// Launch defaults the plan relies on, checked against the deployed registry.
const EXPECTED = {
  twapWindow: 1800n, twapToleranceBps: 200n, swapBackGracePeriod: 36n * 3600n,
  maxEntryImpactBps: 100n, insuredWindow: 5n * 86400n,
};

const DEFAULT_ADDRESSES_PATH = path.join(__dirname, "..", "deployed-addresses.json");

/**
 * Phase 1. Returns the deployed contracts and what was announced.
 * @param {object} o
 * @param {object} o.ethers, o.deployer (signer), o.network (hre.network.name)
 * @param {string} o.attesterKey, o.operatorSafe, o.treasury
 * @param {number} [o.timelockDelay]  defaults to 2 days
 * @param {number} [o.protocolFeeBps]
 * @param {bigint} [o.minPoolLiquidity]
 * @param {string} [o.addressesPath]  defaults to deployed-addresses.json
 * @param {object} [o.chain]          defaults to ETHEREUM
 * @param {function} [o.log]
 */
async function deployCarry(o) {
  const { ethers, deployer, network } = o;
  const chain = o.chain || ETHEREUM;
  const delay = o.timelockDelay ?? TIMELOCK_DELAY;
  const log = o.log || console.log;
  const send = (c, m, args, label) => sendOrQueue(c, m, args, { network, label });

  // --- 0. Refuse a bad configuration before spending anything -------------
  if (isProduction(network)) {
    for (const [name, v] of [["ATTESTER_KEY", o.attesterKey], ["OPERATOR_SAFE", o.operatorSafe], ["TREASURY_ADDRESS", o.treasury]]) {
      if (!v) throw new Error(`${name} must be set for ${network}. See the header of this script.`);
    }
  }
  guardProductionConfig(network, {
    timelockDelay: delay,
    twapWindow: Number(EXPECTED.twapWindow),
    outageGapThreshold: 0,                 // the INTENDED setting, announced below
    operator: o.operatorSafe,
    attesterKey: o.attesterKey,
    treasury: o.treasury,
    deployer: deployer.address,
    // S8: the M-07 calibration rule, checked on the tiers this script sets.
    tiers: TIERS.map((t) => ({ name: t.name, assumedVolBps: t.cfg[0], maxExposureBps: t.cfg[3] })),
  });
  // S1 and S2 (security review, 26 Nov 2026): on production the operator and
  // the treasury must be Safes needing at least 2 of 3 signatures.
  if (isProduction(network)) {
    await requireProductionSafe(ethers, o.operatorSafe, "Operator Safe");
    await requireProductionSafe(ethers, o.treasury, "Treasury");
  }

  const net = await ethers.provider.getNetwork();
  if (isProduction(network) && net.chainId !== chain.chainId) {
    throw new Error(`Expected chain ${chain.chainId}, connected to ${net.chainId}.`);
  }
  for (const [label, addr] of [["Uniswap V3 factory", chain.uniswapFactory], ["SwapRouter02", chain.swapRouter02],
                               ["WETH", chain.weth], ["wstETH", chain.wstETH]]) {
    if ((await ethers.provider.getCode(addr)) === "0x") throw new Error(`${label} at ${addr} has no code on this network.`);
  }
  const uniFactory = new ethers.Contract(chain.uniswapFactory, ["function getPool(address,address,uint24) view returns (address)"], deployer);
  const poolAddr = await uniFactory.getPool(chain.wstETH, chain.weth, chain.poolFee);
  if (poolAddr === ethers.ZeroAddress) throw new Error("No wstETH/WETH pool at the 0.01% fee tier.");

  log("=".repeat(70));
  log(`Covenza matched-pair carry -> ${network} (chain ${net.chainId})`);
  log("=".repeat(70));
  log(`Deployer        ${deployer.address}  (${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH)`);
  log(`Attester        ${o.attesterKey}`);
  log(`Operator Safe   ${o.operatorSafe || "(none: testing only)"}`);
  log(`Treasury        ${o.treasury}`);
  log(`Timelock        ${fmt(delay)}`);
  log(`Pool            ${poolAddr} (wstETH/WETH 0.01%)`);

  // --- 1. Identity registry: the partner's provider is the attester -------
  const kyc = await (await ethers.getContractFactory("KYCRegistry", deployer)).deploy(deployer.address, o.attesterKey, delay);
  await kyc.waitForDeployment();
  log(`\nKYCRegistry     ${await kyc.getAddress()}`);

  // --- 2. Protection reserve ----------------------------------------------
  const reserve = await (await ethers.getContractFactory("InsurancePool", deployer)).deploy(deployer.address, DRAW_CAP_BPS, delay);
  await reserve.waitForDeployment();
  log(`InsurancePool   ${await reserve.getAddress()}  (protection reserve; draw cap ${DRAW_CAP_BPS / 100}% of principal)`);

  // --- 3. Asset registry: matched pairs only -------------------------------
  const registry = await (await ethers.getContractFactory("AssetRegistry", deployer)).deploy(
    deployer.address, chain.swapRouter02, chain.uniswapFactory, delay);
  await registry.waitForDeployment();
  log(`AssetRegistry   ${await registry.getAddress()}`);

  for (const [k, v] of Object.entries(EXPECTED)) {
    const actual = await registry[k]();
    if (actual !== v) throw new Error(`Registry ${k} is ${actual}, the plan expects ${v}. Stop and review.`);
  }
  log("  launch defaults confirmed: 30-min window, 2% tolerance, 36h grace, 1% entry impact, 5-day insured window");

  // Brand-new listings are instant. Both at the matched-pair slot.
  await (await registry.addAssetWithTier(chain.weth, 0, 0)).wait();
  await (await registry.addAssetWithTier(chain.wstETH, 0, 0)).wait();
  log("  listed WETH and wstETH (matched-pair tier); nothing else");

  // None of these raises an exposure cap, so none waits.
  for (const t of TIERS) {
    await send(registry, "setTierConfig", [t.slot, ...t.cfg], `tier: ${t.name}`);
  }

  // Always timelocked: announced now, executed by execute-timelocked.js.
  await send(registry, "setOutageConfig", [0, 0, 0], "outage detection OFF (Ethereum has no single block producer)");

  // Minimum pool depth: instant while no pool is named for the pair (M-01).
  const poolLiquidity = await new ethers.Contract(poolAddr, ["function liquidity() view returns (uint128)"], deployer).liquidity();
  const minLiquidity = o.minPoolLiquidity ?? poolLiquidity / MIN_DEPTH_SHARE;
  await send(registry, "setMinPoolLiquidity", [chain.wstETH, chain.weth, minLiquidity],
    `minimum pool depth ${minLiquidity} (${o.minPoolLiquidity ? "override" : "25% of in-range depth now"})`);

  // --- 4. Vault implementation, price library, lens, factory ---------------
  const twapLib = await (await ethers.getContractFactory("UniswapTwap", deployer)).deploy();
  await twapLib.waitForDeployment();
  const libs = { libraries: { UniswapTwap: await twapLib.getAddress() } };
  const vaultImpl = await (await ethers.getContractFactory("Vault", { signer: deployer, ...libs })).deploy();
  await vaultImpl.waitForDeployment();
  const lens = await (await ethers.getContractFactory("VaultLens", { signer: deployer, ...libs })).deploy();
  await lens.waitForDeployment();
  const factory = await (await ethers.getContractFactory("VaultFactory", deployer)).deploy(
    await kyc.getAddress(), await registry.getAddress(), await reserve.getAddress(), o.treasury,
    await vaultImpl.getAddress(), delay);
  await factory.waitForDeployment();
  log(`\nUniswapTwap lib ${await twapLib.getAddress()}`);
  log(`Vault impl      ${await vaultImpl.getAddress()}  (clone source, never initialised)`);
  log(`VaultLens       ${await lens.getAddress()}`);
  log(`VaultFactory    ${await factory.getAddress()}`);

  if (o.protocolFeeBps !== undefined) {
    await (await factory.setProtocolFeeRateBps(o.protocolFeeBps)).wait();
    log(`  protocol fee ${o.protocolFeeBps} bps of interest (borrower's add-on)`);
  }

  // --- 5. Wire the reserve to the factory (audit M-05: always announced) ---
  const factoryAddr = await factory.getAddress();
  await (await reserve.queueSetVaultFactory(factoryAddr)).wait();
  if (delay === 0) {
    await (await reserve.setVaultFactory(factoryAddr)).wait();
    log("  protection reserve wired to the factory");
  } else {
    const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "address"], ["setVaultFactory", factoryAddr]));
    const pending = readPending();
    pending[network] = (pending[network] || []).filter((p) => p.id !== id);
    pending[network].push({
      label: `InsurancePool.setVaultFactory(${factoryAddr})`,
      target: await reserve.getAddress(), method: "setVaultFactory", args: [factoryAddr],
      data: reserve.interface.encodeFunctionData("setVaultFactory", [factoryAddr]), id,
      executableAt: new Date((Math.floor(Date.now() / 1000) + delay) * 1000).toISOString(),
      queuedBy: deployer.address,
    });
    writePending(pending);
    log(`  protection reserve wiring ANNOUNCED: executable in ${fmt(delay)}. No loan can open until then.`);
  }

  // --- 6. Record ------------------------------------------------------------
  const addressesPath = o.addressesPath || DEFAULT_ADDRESSES_PATH;
  const all = fs.existsSync(addressesPath) ? JSON.parse(fs.readFileSync(addressesPath, "utf8")) : {};
  // MERGE, never replace: other scripts record Safes and more under this key.
  all[network] = {
    ...(all[network] || {}),
    product: "matched-pair carry",
    chainId: Number(net.chainId),
    kycRegistry: await kyc.getAddress(),
    assetRegistry: await registry.getAddress(),
    insurancePool: await reserve.getAddress(),
    vaultFactory: factoryAddr,
    vaultImplementation: await vaultImpl.getAddress(),
    vaultLens: await lens.getAddress(),
    uniswapTwapLibrary: await twapLib.getAddress(),
    treasury: o.treasury,
    attester: o.attesterKey,
    intendedOperatorSafe: o.operatorSafe || null,
    tokens: { WETH: chain.weth, wstETH: chain.wstETH },
    uniswap: { factory: chain.uniswapFactory, router: chain.swapRouter02, pool: poolAddr, fee: chain.poolFee },
    timelockDelay: delay,
    deployer: deployer.address,
    drawCapBps: DRAW_CAP_BPS,
    guidance: { maxLoanWeth: 500, minReserveWeth: 500, note: "Deployment plan v2, decisions 3 and 4" },
    // S7 (security review, 26 Nov 2026): what a reader of this record must know.
    auditStatus: "Contracts: Audited by Zealynx — fixes under verification, final report pending (audit-fixes branch, 8b7311a). " +
                 "This deployment's scripts and settings are NOT AUDITED.",
    disclosures: isProduction(network) ? [
      "Outage detection is OFF on Ethereum by design: Ethereum has no single block producer, so there is no sequencer outage to detect. " +
      "The audit's M-06 fix review assumed detection is on in production; that assumption does not apply to this deployment.",
      "The 5% matched-pair tier is safe only while matched-pair pools alone are approved and the protection reserve is at least twice the largest open loan.",
    ] : ["TEST NETWORK: test tokens and settings only."],
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(addressesPath, JSON.stringify(all, null, 2));
  log(`\nRecorded under "${network}" in ${path.basename(addressesPath)}`);

  // --- 7. Name the pool now, if its history is already live ----------------
  const named = await approvePool({ ethers, deployer, network, registry, chain, log });

  log("\n" + "-".repeat(70));
  log("NEXT, in order:");
  if (!named) log(`  - Grow the pool's history: $env:GROW="1"; npx hardhat run scripts/grow-pool-history.js --network ${network}`);
  log(`  - After ${fmt(delay)}: npx hardhat run scripts/execute-timelocked.js --network ${network}`);
  log("      (switches outage detection off and wires the protection reserve)");
  if (!named) log(`  - When grow-pool-history says READY: $env:PHASE="approve-pool"; npx hardhat run scripts/deploy-ethereum-carry.js --network ${network}` +
                  (isProduction(network) ? "" : " (with CHAIN_FILE as before)"));
  log("  - The partner funds the protection reserve: at least 500 WETH (decision 4).");
  log(`  - Verify every contract above on Etherscan: npx hardhat run scripts/verify-ethereum-carry.js --network ${network}`);
  log(`  - Hand control to the partner: $env:OPERATOR_SAFE="0x…"; $env:OWNER_SAFE="0x…"; npx hardhat run scripts/transfer-control.js --network ${network}`);
  log(`      then the Safes accept: npx hardhat run scripts/safe-accept-roles.js --network ${network}`);
  log("-".repeat(70));

  return { kyc, reserve, registry, twapLib, vaultImpl, lens, factory, poolAddr, minLiquidity, named };
}

/**
 * Phase 2 (also tried at the end of phase 1). Names the wstETH/WETH pool as
 * the approved pool, but only once its history is live and its minimum depth
 * is set. Naming the FIRST pool for a pair is instant. Returns true if named.
 */
async function approvePool({ ethers, deployer, network, registry, chain = ETHEREUM, log = console.log }) {
  if ((await registry.poolFeeTier(chain.wstETH, chain.weth)) !== 0n) {
    log("\nApproved pool: already named.");
    return true;
  }
  const history = await checkPoolHistory(registry, chain.wstETH, chain.weth, chain.poolFee, deployer);
  if (!history.ok) {
    log(`\nApproved pool: NOT YET. ${history.reason}`);
    return false;
  }
  const min = await registry.minPoolLiquidity(chain.wstETH, chain.weth);
  if (min === 0n) { log("\nApproved pool: NOT YET. The minimum pool depth is not set."); return false; }
  if (history.liquidity < min) {
    log(`\nApproved pool: NOT YET. The pool's depth ${history.liquidity} is below the minimum ${min}.`);
    return false;
  }
  const r = await sendOrQueue(registry, "setPoolFeeTier", [chain.wstETH, chain.weth, chain.poolFee],
    { network, label: "approved pool: wstETH/WETH 0.01%" });
  return r === "executed";
}

/** Reads CHAIN_FILE (testnets only) into the shape deployCarry expects. */
function loadChainFile(file) {
  const c = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  for (const k of ["chainId", "uniswapFactory", "swapRouter02", "weth", "wstETH", "poolFee"]) {
    if (c[k] === undefined) throw new Error(`${file} has no ${k}.`);
  }
  return { ...c, chainId: BigInt(c.chainId), poolFee: Number(c.poolFee) };
}

async function main() {
  const hre = require("hardhat");
  const { ethers } = hre;
  const network = hre.network.name;
  const production = isProduction(network);
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(`No signer for ${network}. On a production network only DEPLOYER_PRIVATE_KEY in .env.${network} can sign (hardhat.config.js).`);
  }

  // Testnet-only settings are refused outright on a production network.
  if (production && (process.env.CHAIN_FILE || process.env.TIMELOCK_DELAY_SECONDS)) {
    throw new Error(`CHAIN_FILE and TIMELOCK_DELAY_SECONDS are for test networks only, not ${network}.`);
  }
  let chain = ETHEREUM;
  if (!production) {
    if (process.env.CHAIN_FILE) chain = loadChainFile(process.env.CHAIN_FILE);
    else if (network !== "hardhat") {
      throw new Error(`On ${network}, set $env:CHAIN_FILE="uniswap-sepolia.json" (written by setup-sepolia-carry-pool.js).`);
    }
  }

  if (process.env.PHASE === "approve-pool") {
    const d = JSON.parse(fs.readFileSync(DEFAULT_ADDRESSES_PATH, "utf8"))[network];
    if (!d || !d.assetRegistry) throw new Error(`No deployment recorded for ${network}. Run phase 1 first.`);
    const registry = await ethers.getContractAt("AssetRegistry", d.assetRegistry, deployer);
    await approvePool({ ethers, deployer, network, registry, chain });
    return;
  }

  let attesterKey = process.env.ATTESTER_KEY;
  let treasury = process.env.TREASURY_ADDRESS;
  if (!production) {
    if (!attesterKey) { attesterKey = deployer.address; console.log("NOTE (testnet): no ATTESTER_KEY; the deployer is the identity attester."); }
    if (!treasury)    { treasury = deployer.address;    console.log("NOTE (testnet): no TREASURY_ADDRESS; fees go to the deployer."); }
  }

  // S1: on production, the operator Safe and the treasury are typed in the
  // terminal for this run, so a stale value in the environment file cannot
  // slip through unseen.
  if (production) {
    const envFile = envFileFor(network, path.join(__dirname, ".."));
    requireTypedConfirmation({ name: "OPERATOR_SAFE", value: process.env.OPERATOR_SAFE || "(not set)", envFile });
    requireTypedConfirmation({ name: "TREASURY", value: treasury || "(not set)", envFile });
  }

  await deployCarry({
    ethers, deployer, network, chain, attesterKey, treasury,
    operatorSafe: process.env.OPERATOR_SAFE,
    timelockDelay: !production && process.env.TIMELOCK_DELAY_SECONDS ? Number(process.env.TIMELOCK_DELAY_SECONDS) : undefined,
    protocolFeeBps: process.env.PROTOCOL_FEE_BPS !== undefined ? Number(process.env.PROTOCOL_FEE_BPS) : undefined,
    minPoolLiquidity: process.env.MIN_POOL_LIQUIDITY ? BigInt(process.env.MIN_POOL_LIQUIDITY) : undefined,
  });
}

module.exports = { deployCarry, approvePool, loadChainFile, ETHEREUM, TIERS, TIMELOCK_DELAY, EXPECTED, DRAW_CAP_BPS };

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
}
