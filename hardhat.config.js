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
        // Optimises for DEPLOYMENT SIZE over runtime gas. VaultFactory embeds
        // the full Vault creation bytecode, so factory size is the binding
        // constraint (24,576-byte Spurious Dragon limit, enforced on Arbitrum
        // and Orbit chains too).
        //
        // Dropped from 200 to 1 when the factory hit 25,106 bytes after the
        // yield-venue and annualised-interest work. 1 is the most size-biased
        // setting available.
        //
        // Worth knowing this is a delaying tactic, not a fix: every addition to
        // Vault pushes the factory back toward the ceiling, and the risk-tier
        // and exposure-cap work still to come is all Vault logic. The durable
        // answer is a clone factory — deploy one Vault implementation and have
        // the factory produce minimal proxies of it, which makes factory size
        // constant. That needs Vault to become initialisable rather than
        // constructor-configured, so it is a deliberate refactor rather than
        // something to attempt while unblocking a test run.
        runs: 1,
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