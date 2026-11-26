/**
 * Prepares a Uniswap V3 pool so the asset registry will accept it, by growing
 * its price history past the TWAP window (audit KRAIT-004).
 *
 * WHY THIS EXISTS. AssetRegistry.setPoolFeeTier refuses a pool that keeps no
 * more price-history slots than the TWAP window has seconds. Real pools often
 * keep far fewer: the Ethereum wstETH/WETH 0.01% pool keeps 400 against our
 * 1,800-second window (Ethereum deployment plan, 23 Nov 2026). Anyone may pay
 * to grow a pool's history; nobody's permission is needed.
 *
 * TWO THINGS ABOUT HOW UNISWAP DOES THIS, both found the hard way in
 * test/MatchedPairCarryEthereum.test.js:
 *   - Growing only RESERVES the new slots. They switch on when the pool's
 *     current ring of history wraps round: after (slots - current index) more
 *     history entries.
 *   - A pool writes a history entry only when a trade moves the price by at
 *     least one tick, or when liquidity is added or removed around the current
 *     price. Small trades in a deep pool write nothing. So on a quiet pool the
 *     switch-on can take days; this script estimates how long from the pool's
 *     own recent pace.
 *
 * READ-ONLY BY DEFAULT. It reports and sends nothing unless GROW=1 is set.
 * Ethereum mainnet signs only with DEPLOYER_PRIVATE_KEY from .env.mainnet (see
 * hardhat.config.js), so without that key it can only report there.
 *
 * Usage (defaults: Ethereum mainnet, wstETH/WETH 0.01%, 30-minute window):
 *   npx hardhat run scripts/grow-pool-history.js --network mainnet          # report only
 *   GROW=1 npx hardhat run scripts/grow-pool-history.js --network mainnet   # grow (needs the deployer key)
 *
 * Other pools: FACTORY=0x… TOKEN_A=0x… TOKEN_B=0x… FEE=500 WINDOW=1800
 * (PowerShell: set each with $env:NAME = "value" before the command.)
 */

const { checkPoolHistory } = require("./lib/pool-history");

// Ethereum mainnet defaults. Verify on Etherscan.
const ETHEREUM = {
  factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",   // Uniswap V3 Factory
  tokenA:  "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",   // wstETH
  tokenB:  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",   // WETH
  fee:     100,                                             // 0.01%
};
const DEFAULT_WINDOW = 1800;   // AssetRegistry.twapWindow at launch
const STEP = 400;              // slots per transaction (~9M gas), well inside a block

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observations(uint256) view returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized)",
  "function liquidity() view returns (uint128)",
  "function increaseObservationCardinalityNext(uint16 observationCardinalityNext)",
];

/**
 * Reports a pool's price history against the window. Uses the same check as
 * the deploy and listing scripts (lib/pool-history.js), so they cannot disagree.
 */
async function inspectPool({ ethers, factory, tokenA, tokenB, fee, window = DEFAULT_WINDOW, runner }) {
  runner = runner || ethers.provider;
  // checkPoolHistory reads the factory and window from a registry; a stand-in
  // answers those two questions, so this works before any registry exists.
  const registryShim = { uniswapFactory: async () => factory, twapWindow: async () => window };
  const h = await checkPoolHistory(registryShim, tokenA, tokenB, fee, runner);
  if (h.pool === ethers.ZeroAddress) {
    return { exists: false, ok: false, reason: h.reason, window };
  }

  const pool = new ethers.Contract(h.pool, POOL_ABI, runner);
  const s = await pool.slot0();
  const cardinality = Number(s.observationCardinality);
  const cardinalityNext = Number(s.observationCardinalityNext);
  const index = Number(s.observationIndex);
  const target = window + 1;

  // The pool's recent pace: time covered by its history, per entry.
  const latest = await pool.observations(index);
  let oldest = await pool.observations((index + 1) % cardinality);
  if (!oldest.initialized) { oldest = await pool.observations(0); }
  const span = Number(latest.blockTimestamp) - Number(oldest.blockTimestamp);
  const secondsPerEntry = cardinality > 1 && span > 0 ? span / (cardinality - 1) : null;

  // Reserved slots switch on after the ring wraps: (cardinality - index) more entries.
  const growing = cardinalityNext > cardinality;
  const entriesToSwitchOn = growing ? cardinality - index : null;

  return {
    exists: true, pool: h.pool, ok: h.ok, reason: h.reason, window, target,
    cardinality, cardinalityNext, index, liquidity: h.liquidity,
    reserved: cardinalityNext >= target,
    entriesToSwitchOn,
    secondsPerEntry,
    etaSeconds: entriesToSwitchOn !== null && secondsPerEntry ? entriesToSwitchOn * secondsPerEntry : null,
  };
}

/**
 * Grows the pool's reserved history to `target` slots, STEP at a time.
 * Sends nothing if it is already reserved. Returns { sent, gasUsed }.
 */
async function growPoolHistory({ ethers, signer, pool, target, step = STEP }) {
  const p = new ethers.Contract(pool, POOL_ABI, signer);
  let next = Number((await p.slot0()).observationCardinalityNext);
  let sent = 0;
  let gasUsed = 0n;
  while (next < target) {
    const to = Math.min(next + step, target);
    // Explicit fee overrides (twice the estimate), as for every write in this repo.
    const fees = await ethers.provider.getFeeData();
    const overrides = fees.maxFeePerGas
      ? { maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: (fees.maxPriorityFeePerGas || 0n) * 2n }
      : {};
    const rc = await (await p.increaseObservationCardinalityNext(to, overrides)).wait();
    gasUsed += rc.gasUsed;
    sent++;
    console.log(`  grew reserved history to ${to} slots (tx ${rc.hash}, ${rc.gasUsed} gas)`);
    next = to;
  }
  return { sent, gasUsed };
}

function summarise(r) {
  const days = (s) => (s < 2 * 86400 ? `${(s / 3600).toFixed(1)} hours` : `${(s / 86400).toFixed(1)} days`);
  const lines = [];
  lines.push(`Pool            ${r.pool}`);
  lines.push(`History slots   ${r.cardinality} live, ${r.cardinalityNext} reserved (current entry ${r.index})`);
  lines.push(`Needed          more than ${r.window}, i.e. at least ${r.target}`);
  if (r.secondsPerEntry) {
    lines.push(`Recent pace     one history entry every ${(r.secondsPerEntry / 60).toFixed(0)} minutes`);
  }
  if (r.ok) {
    lines.push("Status          READY: the registry will accept this pool.");
  } else if (r.reserved) {
    lines.push(`Status          GROWING: ${r.target} slots reserved; they switch on after ${r.entriesToSwitchOn} more history entries` +
      (r.etaSeconds ? ` (about ${days(r.etaSeconds)} at the recent pace).` : "."));
    lines.push("                Re-run this script to check. Nothing more needs sending.");
  } else {
    const slots = r.target - r.cardinalityNext;
    lines.push(`Status          NOT READY: ${slots} more slots must be reserved (about ${(slots * 22_300 / 1e6).toFixed(1)}M gas).`);
    lines.push("                Run again with GROW=1 to reserve them.");
  }
  return lines.join("\n");
}

async function main() {
  const hre = require("hardhat");
  const { ethers } = hre;
  const cfg = {
    factory: process.env.FACTORY || ETHEREUM.factory,
    tokenA:  process.env.TOKEN_A || ETHEREUM.tokenA,
    tokenB:  process.env.TOKEN_B || ETHEREUM.tokenB,
    fee:     Number(process.env.FEE || ETHEREUM.fee),
    window:  Number(process.env.WINDOW || DEFAULT_WINDOW),
  };

  console.log(`Network         ${hre.network.name} (chain ${(await ethers.provider.getNetwork()).chainId})`);
  if ((await ethers.provider.getCode(cfg.factory)) === "0x") {
    throw new Error(`No Uniswap V3 factory at ${cfg.factory} on this network. Pass FACTORY=0x… for this chain.`);
  }

  let r = await inspectPool({ ethers, ...cfg });
  if (!r.exists) { throw new Error(`No pool: ${r.reason}`); }
  console.log(summarise(r));

  if (process.env.GROW !== "1") {
    if (!r.reserved) console.log("\nRead-only run: nothing sent.");
    return;
  }
  if (r.reserved) {
    console.log("\nGROW=1 set, but the slots are already reserved: nothing to send.");
    return;
  }

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      `No signer for ${hre.network.name}. On Ethereum mainnet only DEPLOYER_PRIVATE_KEY in .env.mainnet ` +
      "can sign (hardhat.config.js); add it to .env.mainnet when it is time to deploy."
    );
  }
  console.log(`\nGrowing from ${signers[0].address}:`);
  const g = await growPoolHistory({ ethers, signer: signers[0], pool: r.pool, target: r.target });
  console.log(`Sent ${g.sent} transaction(s), ${g.gasUsed} gas in total.\n`);

  r = await inspectPool({ ethers, ...cfg });
  console.log(summarise(r));
}

module.exports = { inspectPool, growPoolHistory, summarise, ETHEREUM, DEFAULT_WINDOW };

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
}
