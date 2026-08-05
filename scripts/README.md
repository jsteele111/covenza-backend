# Scripts

Every script here works against the current v2.1 contracts. Anything targeting
the v1 contracts has been removed — see git history if you need it.

## Deployment

| Script | Purpose |
|---|---|
| `deploy-v2-infrastructure.js` | Full stack deploy: mock tokens, mock Aave/Uniswap, InsurancePool, AssetRegistry, VaultFactory. Reuses the existing KYCRegistry rather than redeploying it, since that contract is unchanged and redeploying would reset every verified badge. Prints ready-to-paste `hardhat verify` commands. |
| `redeploy-factory-v21.js` | Replaces **only** the VaultFactory, reusing the live KYCRegistry, AssetRegistry and InsurancePool. Used for the v2.1 protocol fee upgrade. Verifies the deployer is the pool operator before starting, and confirms reserves survive the rewire. |

```bash
npx hardhat run scripts/deploy-v2-infrastructure.js --network arbitrumSepolia
npx hardhat run scripts/redeploy-factory-v21.js     --network arbitrumSepolia
```

Both read and write `deployed-addresses.json`, which is the single source of
truth for what is deployed where.

## Proof and settlement

| Script | Purpose |
|---|---|
| `lifecycle-proof.js` | Originates and settles three vaults, one at each settlement access tier, including a deliberate 20% adverse price move to prove the deposit → insurance → lender waterfall and the zero-protocol-fee-on-loss property. Takes 5–8 minutes; it waits out real grace periods. |
| `settle-stuck-vaults.js` | Settles every expired-but-unsettled vault **as the keeper account**, earning the time-accrued bounty. Both cleanup utility and a live demonstration of tier-3 settlement. |

`lifecycle-proof.js` requires `KEEPER_PRIVATE_KEY` in `.env` — the tier-3 proof
needs a genuinely third-party account, since `settle()` excludes the lender and
borrower from the bounty branch.

## KYC verifier key

The KYCRegistry verifies wallets via a signed attestation from an
operator-rotatable verifier key. These manage that key.

| Script | Purpose |
|---|---|
| `generate-verifier-key.js` | Generates a fresh keypair. Print the address into `.env` as `VERIFIER_ADDRESS`. |
| `set-verifier-key.js` | Points the deployed KYCRegistry at a new verifier key. Operator only. |
| `check-verifier-key.js` | Reads back the currently configured key. |
| `mock-verify.js` | Signs a single attestation locally, for testing the verification path without a real KYC provider. |
| `mock-verify-server.js` | Local HTTP server on port 4000 standing in for the production verifier function, so the frontend's KYC flow works in development. |

## Utilities

| Script | Purpose |
|---|---|

## Environment

```
ARBITRUM_SEPOLIA_RPC_URL=     # RPC endpoint
DEVTEST_PRIVATE_KEY=          # deployer / operator / lender
BORROWER_PRIVATE_KEY=         # borrower
KEEPER_PRIVATE_KEY=           # third-party keeper, for tier-3 settlement
VERIFIER_ADDRESS=             # public address of the KYC verifier key
TREASURY_ADDRESS=             # protocol fee recipient
```