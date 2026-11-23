/**
 * Sets up a wstETH/WETH-style pool on SEPOLIA so the Ethereum carry deployment
 * can be rehearsed end to end on a public test network (deployment plan,
 * decision 1).
 *
 * WHY: Sepolia has no real wstETH/WETH pool with price history. As with
 * scripts/deploy-uniswap-testnet.js for Robinhood Chain, we bring our own:
 * REAL Uniswap V3 bytecode (from the npm artifacts), test tokens we can mint,
 * and a 0.01% pool shaped like the mainnet one:
 *
 *   - Test WETH (tWETH) and test wstETH (twstETH), both 18 decimals, mintable.
 *   - The 0.01% fee tier switched on, as on mainnet.
 *   - Price 1.25 tWETH per twstETH, deep full-range liquidity.
 *   - Price history grown to 1,801 slots and switched on, so the registry
 *     accepts the pool (KRAIT-004). Swaps need 30 minutes of history on top,
 *     which only real time can provide: wait 31 minutes after this script.
 *
 * Writes uniswap-sepolia.json, which deploy-ethereum-carry.js reads through
 * CHAIN_FILE on testnets. Refuses to run on Ethereum mainnet.
 *
 * Usage:
 *   npx hardhat run scripts/setup-sepolia-carry-pool.js --network sepolia
 */

const fs = require("fs");
const path = require("path");
const { growPoolHistory } = require("./grow-pool-history");

const FACTORY_ARTIFACT = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const POOL_ARTIFACT    = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const ROUTER_ARTIFACT  = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const FEE = 100;                     // 0.01%, as the mainnet pool
const PRICE = 1.25;                  // tWETH per twstETH, close to mainnet's 1.249
const LIQUIDITY = 10n ** 24n;        // deep: a 500 tWETH trade moves the price ~0.1%
const WINDOW = 1800;
const DEFAULT_OUT = path.join(__dirname, "..", "uniswap-sepolia.json");

function isqrt(n) { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }

/**
 * @returns the chain description deploy-ethereum-carry.js expects, plus extras.
 */
async function setupCarryPool({ ethers, deployer, outPath = DEFAULT_OUT, log = console.log }) {
  const net = await ethers.provider.getNetwork();
  if (net.chainId === 1n) throw new Error("Refusing to run on Ethereum mainnet: the real pool exists there.");
  const E = ethers.parseEther;

  log(`Setting up a test carry pool on chain ${net.chainId} from ${deployer.address}`);
  log(`Balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  const Mock = await ethers.getContractFactory("MockERC20", deployer);
  const weth = await Mock.deploy("Test WETH", "tWETH", 18);
  await weth.waitForDeployment();
  const wst = await Mock.deploy("Test wstETH", "twstETH", 18);
  await wst.waitForDeployment();
  log(`tWETH           ${await weth.getAddress()}`);
  log(`twstETH         ${await wst.getAddress()}`);

  const factory = await new ethers.ContractFactory(FACTORY_ARTIFACT.abi, FACTORY_ARTIFACT.bytecode, deployer).deploy();
  await factory.waitForDeployment();
  await (await factory.enableFeeAmount(FEE, 1)).wait();
  const router = await new ethers.ContractFactory(ROUTER_ARTIFACT.abi, ROUTER_ARTIFACT.bytecode, deployer)
    .deploy(ethers.ZeroAddress, await factory.getAddress(), ethers.ZeroAddress, await weth.getAddress());
  await router.waitForDeployment();
  log(`UniswapV3Factory ${await factory.getAddress()} (0.01% tier enabled)`);
  log(`SwapRouter02    ${await router.getAddress()}`);

  const lp = await (await ethers.getContractFactory("UniswapLiquidityHelper", deployer)).deploy();
  await lp.waitForDeployment();
  await (await weth.mint(await lp.getAddress(), E("100000000"))).wait();
  await (await wst.mint(await lp.getAddress(), E("100000000"))).wait();

  await (await factory.createPool(await wst.getAddress(), await weth.getAddress(), FEE)).wait();
  const poolAddr = await factory.getPool(await wst.getAddress(), await weth.getAddress(), FEE);
  const pool = new ethers.Contract(poolAddr, POOL_ARTIFACT.abi, deployer);
  const p = BigInt(Math.round(PRICE * 1e9));
  const wstIsToken0 = BigInt(await wst.getAddress()) < BigInt(await weth.getAddress());
  const Q192 = 2n ** 192n;
  await (await pool.initialize(wstIsToken0 ? isqrt((p * Q192) / 1_000_000_000n) : isqrt((1_000_000_000n * Q192) / p))).wait();
  await (await lp.addFullRangeLiquidity(poolAddr, LIQUIDITY)).wait();
  log(`Pool            ${poolAddr} (twstETH/tWETH 0.01%, price ${PRICE})`);

  // Grow the history, then one more history entry switches the new slots on
  // (a fresh pool's ring is one slot long, so it wraps on the very next entry).
  const g = await growPoolHistory({ ethers, signer: deployer, pool: poolAddr, target: WINDOW + 1 });
  await (await lp.addFullRangeLiquidity(poolAddr, 1000n)).wait();
  const s = await pool.slot0();
  log(`History         ${s.observationCardinality} slots live (${g.gasUsed} gas to grow)`);

  const chain = {
    chainId: Number(net.chainId),
    uniswapFactory: await factory.getAddress(),
    swapRouter02: await router.getAddress(),
    weth: await weth.getAddress(),
    wstETH: await wst.getAddress(),
    poolFee: FEE,
    pool: poolAddr,
    liquidityHelper: await lp.getAddress(),
    note: "TEST tokens and our own Uniswap V3 on a testnet. Written by setup-sepolia-carry-pool.js.",
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(outPath, JSON.stringify(chain, null, 2));
  log(`\nWritten ${path.basename(outPath)}.`);
  log("NEXT: wait at least 31 minutes (swaps need 30 minutes of price history), then run");
  log("  CHAIN_FILE=uniswap-sepolia.json TIMELOCK_DELAY_SECONDS=3600 npx hardhat run scripts/deploy-ethereum-carry.js --network sepolia");
  return { chain, weth, wst, factory, router, pool, lp };
}

async function main() {
  const hre = require("hardhat");
  const { isProduction } = require("./lib/production-guards");
  if (isProduction(hre.network.name)) throw new Error(`Refusing to run on ${hre.network.name}: test networks only.`);
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error(`No signer for ${hre.network.name}. Check DEVTEST_PRIVATE_KEY in .env.`);
  await setupCarryPool({ ethers: hre.ethers, deployer });
}

module.exports = { setupCarryPool, FEE, PRICE };

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
}
