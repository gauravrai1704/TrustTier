require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      // local in-memory chain used for the Week 1-2 mocked-verification milestone
    },
    localhost: {
      // explicit block so `--network localhost` (used by the off-chain
      // router and deploy.js in Weeks 2-6) is documented here rather than
      // relying purely on Hardhat's built-in default.
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      // Only include the account if a key is actually set, so running any
      // other network (hardhat/localhost) never fails just because .env
      // hasn't been filled in yet.
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 11155111,
    },
  },
  etherscan: {
    // Used by `npx hardhat verify` (see scripts/verify.js / README) to
    // publish source code on Sepolia Etherscan after deployment.
    apiKey: ETHERSCAN_API_KEY,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    scripts: "./scripts",
  },
};
