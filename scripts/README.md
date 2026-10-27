# Scripts

Operational scripts for the Robinhood Chain deployment. None of them is in the
audit scope. Every script in this folder works against the current contracts;
scripts written for earlier versions (Arbitrum Sepolia, the single-key KYC
registry, yield venues) were deleted before the audit freeze and remain in git
history.

Most read and write `deployed-addresses.json` (what is deployed where) and
`uniswap-testnet.json` (the test Uniswap V3, its tokens and pools). Run them
with `npx hardhat run scripts/<name>.js --network robinhoodTestnet` unless the
table says otherwise. Each file's header explains why it exists and its
environment variables.

## Deployment

| Script | Purpose |
|---|---|
| `deploy-uniswap-testnet.js` | Deploys real Uniswap V3 (factory, SwapRouter02) to testnet with a tUSDG/tWETH pool we control, and warms its oracle. Uniswap is not on Robinhood testnet. |
| `deploy-robinhood-testnet.js` | Full protocol deploy against that Uniswap: KYCRegistry, InsurancePool, AssetRegistry, TWAP library, Vault implementation, VaultLens, VaultFactory. Lists assets (and any stock tokens already in `uniswap-testnet.json`), names the approved pool for every pair, seeds the insurance pool. Timelocked calls go through `lib/timelock.js`. |
| `deploy-stock-token-testnet.js` | Adds a test tokenised equity: deploys it, opens and seeds a tUSDG pool, warms the oracle, lists it as Standard tier with a 72-hour grace, names its approved pool. |
| `redeploy-factory-v21.js` | Replaces only the factory, Vault implementation, TWAP library and VaultLens, reusing the registries and pool. Refuses if any reused contract is an older version. |
| `list-asset.js` | Lists an already-deployed token on the current registry with its risk tier and grace extension in one call, and names its approved pool. For use after a registry redeploy. |
| `set-tier-config.js` | Changes one tier's parameters, keeping the others. Raising an exposure cap waits on the timelock. |
| `execute-timelocked.js` | Executes admin calls announced earlier, once their delay has passed. `LIST_ONLY=1` to just report. |
| `lib/timelock.js` | Shared helper: sends a timelocked call if it can take effect now, otherwise announces it and records it in `pending-timelock.json`; prints Safe transactions when control is with a Safe. |
| `lib/production-guards.js` | Refuses a mainnet deploy carrying testnet values (zero timelock, 60 s TWAP, outage detection off, deployer as operator or attester). |
| `lib/pool-history.js` | Checks a pool keeps more price-history slots than the TWAP window has seconds before `setPoolFeeTier` (audit KRAIT-004), and says how to grow it if not. Used by the deploy and listing scripts. |
| `check-sizes.js` | Bytecode size of every contract against the 24,576-byte limit (`npx hardhat run scripts/check-sizes.js`). |
| `warm-testnet-pool.js` | Gives a pool the price history approval needs: requests 64 slots, tops liquidity up to ~100,000 a side if shallower, then writes observations with three tiny full-range liquidity additions. Not trades: a pool writes an observation only on a trade that changes the tick, which a 1-token trade in a deep pool does not. `POOL=0x…` for a pool other than the first. |
| `approve-testnet-pools.js` | Names the approved pool for every pair still without one, after checking its history (`lib/pool-history.js`). Run only once the 60-second TWAP window has been executed through the timelock. |
| `verify-testnet-deploy.js` | Read-only, 54 PASS/FAIL checks of a testnet deployment against the values in its `EXPECT` block: code at every address, wiring, roles and timelocks, settlement, insurance and tier parameters, tiers and approved pools, pool history, the reserve, the attester and both test wallets. |

## Redeploying testnet, in order

Two steps wait on the timelock, and pools can only be approved once the
settlement config they are checked against has been executed. In PowerShell,
from the repository root:

```
npx hardhat run scripts/deploy-uniswap-testnet.js --network robinhoodTestnet      # only if testnet was wiped
$env:TIMELOCK_DELAY=3600; npx hardhat run scripts/deploy-robinhood-testnet.js --network robinhoodTestnet
npx hardhat run scripts/deploy-stock-token-testnet.js --network robinhoodTestnet
# wait one hour
npx hardhat run scripts/execute-timelocked.js --network robinhoodTestnet
npx hardhat run scripts/warm-testnet-pool.js --network robinhoodTestnet           # any pool under 61 slots
npx hardhat run scripts/approve-testnet-pools.js --network robinhoodTestnet
npx hardhat run scripts/verify-testnet-deploy.js --network robinhoodTestnet       # expect 54 passed
```

Then copy the addresses from `deployed-addresses.json` into the frontend's
`src/config/contracts.js`. The full checklist, with the reason for each step,
is the Regression-Test Checklist v3.

## Local click-testing

A local Hardhat chain with real Uniswap V3 and pools about 100,000 deep, for
the paths testnet cannot exercise on demand: moving time, and a token that
refuses transfers. Start `npx hardhat node` in its own window, then:

| Script | Purpose |
|---|---|
| `deploy-local.js` | Full stack against real Uniswap: tUSDG, tWETH and a freezable tAAPL, pools warmed, 1-hour timelock fast-forwarded, outage detection off; wallets verify through the interface with `mock-verify-server.js` and account #4's key. Addresses are deterministic on a fresh node. |
| `local-inspect.js` | Read-only snapshot: every account's token balances and every vault's state. |
| `local-freeze.js` | Freezes or unfreezes tAAPL (`FROZEN='true'` or `'false'`), to exercise refused swaps, refused payouts and in-kind settlement. |
| `local-time-travel.js` | Moves chain time forward `HOURS` hours, to reach grace, keeper and in-kind windows. |

The six Hardhat default accounts play operator, lender, borrower, keeper,
attester and a newcomer. Their keys are public test keys: use a separate
browser profile.

## Heartbeat bot (item 16)

| Script | Purpose |
|---|---|
| `heartbeat-bot.js` | Calls `AssetRegistry.heartbeat()` every 5 minutes, with Telegram alerts. Plain Node: `node scripts/heartbeat-bot.js`, or under pm2 with `ecosystem.config.js`. See the main README. |
| `generate-heartbeat-key.js` | Creates the bot's gas-only key straight into `.env` and prints its address (`node scripts/generate-heartbeat-key.js`). |

## Identity (KYC v2)

| Script | Purpose |
|---|---|
| `manage-attesters.js` | Adds, removes or rotates a recognised identity provider. Additions and rotations are announced first and executed after the delay. |
| `check-verifier-key.js` | Lists the providers whose attestations the registry accepts. |
| `generate-verifier-key.js` | Generates a keypair for a test attester (`node scripts/generate-verifier-key.js`). |
| `mock-verify.js` | Signs one EIP-712 attestation locally, for testing without a provider. |
| `mock-verify-server.js` | Local HTTP server (port 4000) standing in for a provider, so the frontend's verification flow works in development (`node scripts/mock-verify-server.js`). |
| `lib/kyc-attestation.js` | Shared EIP-712 attestation builder used by both mock verifiers. |
| `diagnose-kyc.js` | What the registry says about a wallet: claims, expiry, manual grant, and eligibility as borrower and lender. |

## Governance handover

| Script | Purpose |
|---|---|
| `check-safe-support.js` | Checks Safe's contracts exist on the chain. |
| `create-safes.js` | Creates the operator and owner Safes. |
| `transfer-control.js` | Nominates the Safes as operator and owner (step one of two). |
| `safe-accept-roles.js` | Accepts the roles from inside each Safe (step two). |
| `verify-handover.js` | Proves the old key is refused and the Safe governs. |
| `verify-two-step.js` | Proves on chain that the deployed contracts hold the two-step transfer, then restores state. |

## Proofs on testnet

| Script | Purpose |
|---|---|
| `lifecycle-proof-robinhood.js` | Full loan lifecycle against real Uniswap, moving prices by trading. |
| `prove-insurance-draw.js` | Forces a loss beyond the deposit and shows the insurance pool paying. |
| `prove-keeper-bounty.js` | An abandoned loan settled by a stranger, who is paid the bounty. |
| `force-loss-testnet.js` | Crashes a test pool's price so a live loan settles at a loss. |
| `settle-stuck-vaults.js` | Settles every expired, unsettled vault as the keeper account. |
| `preflight-mandate.js` | Checks balances, allowances, eligibility and the deposit floor before a manual mandate walkthrough. |

## Diagnostics and accounts

| Script | Purpose |
|---|---|
| `diagnose-chain.js` | Checks the live state the deploy and proof scripts depend on (pool history, reserves, addresses). |
| `diagnose-vault.js` | Everything `payDeposit()` and `settle()` gate on for one vault, with decoded revert reasons. |
| `show-accounts.js` | Addresses and balances of every configured account. |
| `fund-accounts.js` | Shares ETH from the deployer to the borrower and keeper accounts. |
| `generate-keeper.js` | Generates a throwaway testnet keeper wallet. |
| `model-insurance-solvency.js` | Models expected insurance draws against premium income per tier (item 8). |

## Environment (`.env`)

```
ROBINHOOD_TESTNET_RPC_URL=    # optional; defaults to the public RPC
ROBINHOOD_MAINNET_RPC_URL=
DEVTEST_PRIVATE_KEY=          # deployer / operator / lender
BORROWER_PRIVATE_KEY=         # borrower
KEEPER_PRIVATE_KEY=           # third-party keeper, for the bounty tier
HEARTBEAT_PRIVATE_KEY=        # heartbeat bot, gas money only
TELEGRAM_BOT_TOKEN=           # heartbeat alerts
TELEGRAM_CHAT_ID=
ATTESTER_KEY=                 # address of the initial attester (production: a provider, never the deployer)
VERIFIER_PRIVATE_KEY=         # mock attester's signing key, testnet only
TREASURY_ADDRESS=             # protocol fee recipient
TIMELOCK_DELAY=               # seconds; 3600 on testnet (27 October stack), at least 86400 on mainnet
```
