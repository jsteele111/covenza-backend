# Legacy scripts

Kept for history only. **None of these works against the current contracts**,
and none is maintained. They also resolve paths relative to `scripts/`, so
they would not find `deployed-addresses.json` from here without editing.

| Script | Why retired |
|---|---|
| `deploy-v2-infrastructure.js` | Deployed to Arbitrum Sepolia against mock Uniswap and Aave. Replaced by `deploy-robinhood-testnet.js`. |
| `lifecycle-proof.js` | Drove prices with the mock router; cannot run against real Uniswap. Replaced by `lifecycle-proof-robinhood.js`. |
| `set-verifier-key.js` | Rotated the single `verifierKey`, which no longer exists. Replaced by `manage-attesters.js`. |
| `upgrade-kyc-registry.js` | One-off migration from the single-key registry to the attester registry. Superseded by KYC v2 (#7), which needs a full redeploy. |
