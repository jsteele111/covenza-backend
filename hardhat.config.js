require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { DEVTEST_PRIVATE_KEY, BORROWER_PRIVATE_KEY, ARBITRUM_SEPOLIA_RPC_URL } = process.env;

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
      accounts: [DEVTEST_PRIVATE_KEY, BORROWER_PRIVATE_KEY].filter(Boolean),
    },
  },
};