require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { DEVTEST_PRIVATE_KEY, BORROWER_PRIVATE_KEY, ARBITRUM_SEPOLIA_RPC_URL } = process.env;

module.exports = {
  solidity: "0.8.24",
  networks: {
    arbitrumSepolia: {
      url: ARBITRUM_SEPOLIA_RPC_URL || "",
      accounts: [DEVTEST_PRIVATE_KEY, BORROWER_PRIVATE_KEY].filter(Boolean),
    },
  },
};