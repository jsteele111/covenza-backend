require("dotenv").config();
const { ethers } = require("ethers");

const VAULT_ADDRESS = "0x91A281636470C28efD16AcCbb231bBa45c0a94ae"; // placeholder — Jamie will need to paste the full address
const AAVE_WETH_A_TOKEN = "0xf5f17EbE81E516Dc7cB38D61908EC252F150CE60";

const ABI = [
  "function isSettled() view returns (bool)",
  "function vaultBalance() view returns (uint256)",
  "function lender() view returns (address)",
  "function borrower() view returns (address)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL);
  const vault = new ethers.Contract(VAULT_ADDRESS, ABI, provider);
  const aToken = new ethers.Contract(AAVE_WETH_A_TOKEN, ERC20_ABI, provider);

  const [isSettled, balance, aWethBalance] = await Promise.all([
    vault.isSettled(),
    vault.vaultBalance(),
    aToken.balanceOf(VAULT_ADDRESS),
  ]);

  console.log("Vault:", VAULT_ADDRESS);
  console.log("isSettled (independent read):", isSettled);
  console.log("Vault ETH balance:", ethers.formatEther(balance), "ETH");
  console.log("aWETH balance (should be 0 — confirms Aave withdrawal genuinely happened):", ethers.formatEther(aWethBalance), "aWETH");
}

main().catch((err) => { console.error(err); process.exit(1); });