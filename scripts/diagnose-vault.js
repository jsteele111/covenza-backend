/**
 * Prints everything payDeposit() and settle() gate on, for one vault, and
 * static-calls both to surface a decoded revert reason.
 *
 * Exists because Robinhood Chain's RPC does not return revert data in
 * transaction receipts — a failed call comes back as `status: 0` with
 * `reason: null`, which says nothing about why. A staticCall against current
 * state does return the reason, and reads cost no gas.
 *
 * Usage:
 *   VAULT=0x... npx hardhat run scripts/diagnose-vault.js --network robinhoodTestnet
 *
 * With no VAULT set, inspects the most recent vault the factory deployed.
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const { ethers } = hre;
  const [lender, borrower, keeper] = await ethers.getSigners();

  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf8")
  ).robinhoodTestnet;

  const factory = await ethers.getContractAt("VaultFactory", d.vaultFactory);

  let vaultAddr = process.env.VAULT;
  if (!vaultAddr) {
    const total = await factory.totalVaults();
    if (total === 0n) throw new Error("Factory has deployed no vaults.");
    vaultAddr = await factory.allVaults(total - 1n);
    console.log(`No VAULT set — using the latest of ${total}: ${vaultAddr}`);
  }

  const vault = await ethers.getContractAt("Vault", vaultAddr);
  const usdg = await ethers.getContractAt("MockERC20", d.tokens.tUSDG);

  const block = await ethers.provider.getBlock("latest");
  const now = BigInt(block.timestamp);

  const [
    asset, vLender, vBorrower, principal, deposit, required,
    aprBps, originatedAt, term, deadline, isSettled, vaultBalance, heldCount,
  ] = await Promise.all([
    vault.asset(), vault.lender(), vault.borrower(), vault.principal(),
    vault.deposit(), vault.requiredDeposit(), vault.aprBps(),
    vault.originatedAt(), vault.term(), vault.deadline(), vault.isSettled(),
    vault.vaultBalance(), vault.heldAssetCount(),
  ]);

  const fmt = (v) => ethers.formatEther(v);

  console.log("=".repeat(66));
  console.log(`Vault ${vaultAddr}`);
  console.log("=".repeat(66));
  console.log(`code size        ${(await ethers.provider.getCode(vaultAddr)).length / 2 - 1} bytes  (a clone is ~45)`);
  console.log(`asset            ${asset}`);
  console.log(`lender           ${vLender}`);
  console.log(`borrower         ${vBorrower}`);
  console.log(`principal        ${fmt(principal)}`);
  console.log(`deposit paid     ${fmt(deposit)}`);
  console.log(`deposit required ${fmt(required)}`);
  console.log(`aprBps           ${aprBps}`);
  console.log(`isSettled        ${isSettled}`);
  console.log(`vaultBalance     ${fmt(vaultBalance)}`);
  console.log(`held assets      ${heldCount}`);

  console.log("\n--- timing ---");
  console.log(`originatedAt     ${originatedAt}`);
  console.log(`term             ${term}s`);
  console.log(`deadline         ${deadline}`);
  console.log(`block.timestamp  ${now}`);
  const remaining = deadline - now;
  console.log(
    remaining >= 0n
      ? `remaining        ${remaining}s before the deadline`
      : `EXPIRED          ${-remaining}s PAST the deadline`
  );

  console.log("\n--- borrower position ---");
  console.log(`borrower tUSDG   ${fmt(await usdg.balanceOf(vBorrower))}`);
  console.log(`allowance->vault ${fmt(await usdg.allowance(vBorrower, vaultAddr))}`);
  console.log(`borrower ETH     ${fmt(await ethers.provider.getBalance(vBorrower))}`);

  // --- Why a forced swap-back would or would not clear the tolerance -------
  //
  // settle() computes minOut = twapQuote * (1 - tolerance) and requires the
  // swap to beat it. Three numbers decide that, and printing all three says
  // which one is the problem rather than leaving it to inference.
  if (heldCount > 0n) {
    const uni = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "uniswap-testnet.json"), "utf8")
    );
    const registry = await ethers.getContractAt("AssetRegistry", d.assetRegistry);
    const window = Number(await registry.twapWindow());
    const tolBps = await registry.twapToleranceBps();

    const held = await vault.heldAssets(0);
    const feeTier = await vault.swapFeeTierOf(held);
    const heldToken = await ethers.getContractAt("MockERC20", held);
    const heldBal = await heldToken.balanceOf(vaultAddr);

    const pool = await ethers.getContractAt(
      [
        "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 dd, bool e)",
        "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] s)",
        "function token0() view returns (address)",
      ],
      uni.pools[0].address
    );

    const token0 = await pool.token0();
    const heldIsToken0 = held.toLowerCase() === token0.toLowerCase();

    const slot0 = await pool.slot0();
    const [cum] = await pool.observe([window, 0]);
    const twapTick = Number((cum[1] - cum[0]) / BigInt(window));

    // price(tick) = 1.0001^tick, expressed as token1 per token0.
    const priceAt = (tick) => Math.pow(1.0001, tick);
    const impliedOut = (tick) => {
      const p = priceAt(tick);
      const amt = Number(ethers.formatEther(heldBal));
      return heldIsToken0 ? amt * p : amt / p;
    };

    console.log("\n--- forced swap-back arithmetic ---");
    console.log(`held asset       ${held}  (fee tier ${feeTier})`);
    console.log(`held balance     ${fmt(heldBal)}`);
    console.log(`spot tick        ${slot0.tick}`);
    console.log(`twap tick (${window}s) ${twapTick}`);
    console.log(`tick gap         ${Number(slot0.tick) - twapTick}  (spot minus twap)`);
    console.log(`spot-implied out ${impliedOut(Number(slot0.tick)).toFixed(6)}`);
    console.log(`twap-implied out ${impliedOut(twapTick).toFixed(6)}`);
    console.log(`required minOut  ${(impliedOut(twapTick) * (1 - Number(tolBps) / 10000)).toFixed(6)}  (twap less ${tolBps}bps)`);

    // The router is non-view, but staticCall simulates it and returns the
    // amountOut it would actually deliver — the number settle() is judged on.
    try {
      const router = await ethers.getContractAt(
        ["function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) p) payable returns (uint256)"],
        uni.swapRouter
      );
      const actual = await router.exactInputSingle.staticCall({
        tokenIn: held, tokenOut: asset, fee: feeTier,
        recipient: vaultAddr, amountIn: heldBal,
        amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
      });
      const need = impliedOut(twapTick) * (1 - Number(tolBps) / 10000);
      const got = Number(ethers.formatEther(actual));
      console.log(`ACTUAL swap out  ${got.toFixed(6)}`);
      console.log(
        got >= need
          ? `VERDICT          clears the tolerance by ${(got - need).toFixed(6)}`
          : `VERDICT          SHORT by ${(need - got).toFixed(6)} — settle() reverts here`
      );
    } catch (e) {
      const msg = (e.shortMessage || e.message || "");
      console.log(`ACTUAL swap out  simulation failed: ${msg.slice(0, 70)}`);
      if (msg.includes("STF")) {
        console.log("                 (STF = Uniswap's SafeTransferFrom. The simulation runs");
        console.log("                  as this script's signer, who neither holds the held");
        console.log("                  asset nor has approved the router — the vault does");
        console.log("                  both, inside settle(). Compare twap-implied against");
        console.log("                  what the position originally COST instead: a swap-back");
        console.log("                  returns about that, less two fees.)");
      }
    }
  }

  console.log("\n--- static calls (decoded reasons) ---");

  const signerFor = (addr) =>
    [lender, borrower, keeper].find((s) => s.address.toLowerCase() === addr.toLowerCase());

  const bSigner = signerFor(vBorrower);
  if (!bSigner) {
    console.log("  borrower is not a configured signer — cannot simulate as them");
  } else {
    for (const fn of ["payDeposit", "settle"]) {
      try {
        await vault.connect(bSigner)[fn].staticCall();
        console.log(`  ${fn.padEnd(12)} would SUCCEED`);
      } catch (e) {
        const msg = e.shortMessage || e.message || "";
        console.log(`  ${fn.padEnd(12)} reverts: ${msg.replace(/^execution reverted:?\s*/i, "").slice(0, 90)}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
