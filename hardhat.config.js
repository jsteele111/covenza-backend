require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const {
  DEVTEST_PRIVATE_KEY,
  BORROWER_PRIVATE_KEY,
  KEEPER_PRIVATE_KEY,
  ARBITRUM_SEPOLIA_RPC_URL,
  ROBINHOOD_TESTNET_RPC_URL,
  ROBINHOOD_MAINNET_RPC_URL,
} = process.env;

const devAccounts = [DEVTEST_PRIVATE_KEY, BORROWER_PRIVATE_KEY, KEEPER_PRIVATE_KEY].filter(Boolean);

// KEEPER_PRIVATE_KEY is new for Group F: the three-tier settlement proof
// needs a genuinely third-party account (neither lender nor borrower) to
// demonstrate the post-grace "anyone can settle, earns a bounty" tier.
// Reusing the deployer/lender key for that step wouldn't prove anything —
// settle() explicitly excludes lender and borrower from the bounty branch.
// Optional: only lifecycle-proof.js's tier-3 step needs it, everything
// else still works without it (falsy entries are filtered out below,
// same pattern already used for the other two keys).

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        // Back to a runtime-gas bias now that size pressure is gone.
        //
        // History worth keeping, because it explains two structural decisions
        // in the contracts. VaultFactory used to embed Vault's entire creation
        // bytecode via `new Vault(...)`, and reached 25,106 bytes against the
        // 24,576-byte EIP-170 limit — undeployable. Dropping runs from 200 to 1
        // recovered only 93 bytes, which made clear the optimizer was never the
        // answer. What actually fixed it:
        //
        //   - UniswapTwap became a deployed library rather than inlined code,
        //     moving the vendored tick math out of Vault  (-2,785 bytes)
        //   - VaultFactory clones a Vault implementation instead of
        //     constructing one, so it holds no Vault bytecode at all
        //     (22,228 -> 6,320 bytes)
        //
        // Vault is now the contract to watch, at ~16.1KB. scripts/check-sizes.js
        // reports headroom; `hardhat compile` does NOT enforce the limit, so an
        // oversized contract compiles cleanly and fails only at deployment.
        runs: 200,
      },
    },
  },
  networks: {
    arbitrumSepolia: {
      url: ARBITRUM_SEPOLIA_RPC_URL || "",
      accounts: devAccounts,
    },

    // Robinhood Chain — Arbitrum Orbit L2, ETH gas token.
    // Public RPCs are rpc.{testnet,mainnet}.chain.robinhood.com; Alchemy is
    // the recommended provider and is what these env vars are expected to
    // hold. chainId is pinned so a misconfigured RPC fails loudly rather
    // than deploying to the wrong network.
    robinhoodTestnet: {
      url: ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts: devAccounts,
    },
    robinhoodMainnet: {
      url: ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts: devAccounts,
    },
  },
};