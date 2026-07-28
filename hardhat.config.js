require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { DEVTEST_PRIVATE_KEY, BORROWER_PRIVATE_KEY, KEEPER_PRIVATE_KEY, ARBITRUM_SEPOLIA_RPC_URL } = process.env;

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
        // Low runs value optimises for DEPLOYMENT SIZE over runtime gas —
        // the right trade here: VaultFactory embeds the full Vault creation
        // bytecode, so factory size is the binding constraint (24,576-byte
        // Spurious Dragon limit, enforced on Arbitrum too).
        runs: 200,
      },
    },
  },
  networks: {
    arbitrumSepolia: {
      url: ARBITRUM_SEPOLIA_RPC_URL || "",
      accounts: [DEVTEST_PRIVATE_KEY, BORROWER_PRIVATE_KEY, KEEPER_PRIVATE_KEY].filter(Boolean),
    },
  },
};