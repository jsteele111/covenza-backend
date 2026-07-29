# Covenza

**Low-collateral lending on Arbitrum. Each loan lives in its own smart contract vault the borrower operates but cannot drain.**

Over-collateralised lending dominates DeFi — borrowers post 100–150%+ of what they borrow, which serves leverage but excludes credit. Under-collateralised lending has repeatedly failed because it requires trusting the borrower with the funds.

Covenza removes that dependency. The loan principal is deposited into a purpose-built vault, not the borrower's wallet. The borrower operates freely within a bounded set of permitted actions — supplying to Aave, swapping between whitelisted major assets — but cannot move value to any outside address while the loan is outstanding. Custody is enforced by code.

**Status:** deployed and proven on Arbitrum Sepolia. Pre-audit. Not deployed to mainnet.

---

## Proven on-chain, not proposed

The hard case — a genuine loss, settled correctly, with the insurance pool paying out — has been executed on a public testnet and is independently verifiable.

In a live test the price was deliberately moved 20% against an open position before settlement:

| | |
|---|---|
| Loan principal | 100 USDC |
| Borrower deposit | 15 USDC |
| Returned to vault at settlement | 95 USDC |
| **Insurance pool draw** | **8 USDC** |
| **Lender payout** | **103 USDC — full principal + fee** |
| Borrower payout | 0 USDC |
| **Protocol fee taken** | **0 USDC** |
| Loss severity recorded | 1 (borrower-only) |

The deposit absorbed the first tranche of loss. The insurance pool automatically covered the remaining shortfall. The lender was made whole in full, with no manual intervention and no oracle.

All three settlement access tiers have been exercised on-chain:

| Tier | Who may settle | Proven outcome |
|---|---|---|
| 1 — before deadline | Borrower only | Early close, lender paid in full |
| 2 — grace period | Lender or borrower | The loss case above |
| 3 — after grace | **Anyone**, with bounty | Third-party keeper settled and earned a bounty |

Tier 3 has been demonstrated twice, capturing both halves of the bounty mechanism: **0.65 USDC** accruing over ~78 seconds past grace, and **2.0 USDC** — the cap — on vaults left abandoned for hours.

### Deployed contracts (Arbitrum Sepolia)

| Contract | Address |
|---|---|
| VaultFactory | [`0x36DD23EBE221e30f9a71451F3a49F8cAd26c55Ab`](https://sepolia.arbiscan.io/address/0x36DD23EBE221e30f9a71451F3a49F8cAd26c55Ab) |
| AssetRegistry | [`0x8DB2d815caD86eABF217205523621603F712aAE5`](https://sepolia.arbiscan.io/address/0x8DB2d815caD86eABF217205523621603F712aAE5) |
| InsurancePool | [`0x11D4f02FA69D0352fb01725d822Fb05C54AD6e41`](https://sepolia.arbiscan.io/address/0x11D4f02FA69D0352fb01725d822Fb05C54AD6e41) |
| KYCRegistry | [`0x842629E4C953De726946Db5886e50d4840F61FC4`](https://sepolia.arbiscan.io/address/0x842629E4C953De726946Db5886e50d4840F61FC4) |

---

## How the risk model works

Four layers, each doing one job.

**1. Custody — the vault boundary.**
Principal never touches the borrower's wallet. `Vault.sol` exposes only whitelisted actions: Aave supply/withdraw, and Uniswap V3 swaps into whitelisted assets. There is no withdrawal path to an external address while the loan is live.

**2. Deposit sizing — priced, not guessed.**
The required deposit comes from a dated, versioned VaR model computed per asset and per loan duration from historical price data, rather than a flat ratio. The UI surfaces the model's recommendation at origination (95% and 99% confidence). A 7-day WETH loan and a 90-day WETH loan get materially different buffers, because the risk is materially different.

**3. Deposit segregation — the core invariant.**
The deposit is collateral, not working capital. `_enforceDepositInvariant()` reverts any borrower action that would reduce the vault's loan-asset balance below the deposit:

```solidity
require(
    IERC20(asset).balanceOf(address(this)) >= amount + deposit,
    "Action would touch the deposit - deposit is not investable"
);
```

**4. Protocol fee — an add-on, never a haircut.**
A configurable share of each loan's fee (10% at launch) is charged to the
*borrower* at settlement, taken from their residual after the lender has been
paid in full. The lender's return is untouched by it. Because it comes only
from what survives once the lender is whole, **a loss yields zero protocol
fee** — the protocol earns only when the lender does. An optional referrer
address splits the fee with platforms that integrate Covenza as a lending
backend. Fee terms are snapshotted into each vault at origination and never
re-read, so a rate change can never be applied retroactively to a live loan.

**5. Settlement waterfall — automatic, oracle-free.**
At settlement, held foreign assets are force-swapped back to the loan asset at a **TWAP-bounded** price — the realised output must land within a configured tolerance of the time-weighted average, or the settlement reverts. Settlement happens in the loan asset or not at all. Proceeds are then distributed: deposit absorbs loss first, then a per-asset insurance pool (capped as a percentage of principal, and only post-deadline), and only a genuine tail event reaches the lender's principal.

TWAP bounding is what removes the oracle dependency — no price feed, no oracle governance, no oracle failure mode.

---

## Architecture

| Contract | SLOC | Responsibility |
|---|---|---|
| `Vault.sol` | 567 | Per-loan vault. Deposit invariant, Aave supply/withdraw, directional swaps, TWAP-bounded forced swap-back, three-tier settlement, keeper bounty, protocol fee, payout waterfall |
| `KYCRegistry.sol` | 275 | Signature-based verification, ERC721 badge, operator revocation |
| `AssetRegistry.sol` | 253 | Operator-controlled asset whitelist, aToken mapping, protocol-wide settlement config |
| `InsurancePool.sol` | 226 | Per-asset reserves, fee-skim funding, principal-percentage draw cap, vault-only draws |
| `VaultFactory.sol` | 324 | KYC and whitelist gating, vault deployment, principal transfer, insurance skim routing, protocol fee configuration |
| `libraries/UniswapTwap.sol` | 174 | TWAP quote helper. Tick/price maths vendored unmodified from Uniswap v3-core/periphery |

**1,831 SLOC** of deployed Solidity, excluding test mocks.

### Design decisions worth knowing

- **Reserves are per-asset and never cross-converted.** Converting between assets at draw time would require pricing that conversion — reintroducing exactly the oracle dependency the protocol avoids.
- **The draw cap is a percentage of loan principal**, not a flat amount (doesn't scale) and not a percentage of the pool's own balance (would shrink precisely when the pool is most depleted).
- **No rehypothecation.** Idle reserves sit as plain ERC20 balances. Never lent, staked or supplied anywhere — deliberately zero additional integration surface pre-audit.
- **Whitelist removal never strands a borrower.** Removing an asset blocks *new* exposure to it; swaps *back* from a removed asset are always permitted.
- **Settlement config is live-updatable** without redeploying in-flight vaults — vaults read the registry at action time.
- **Revocation is never automatic.** Lossy settlements are surfaced to the operator for review; pulling someone's KYC is a deliberate human decision.

---

## Tests

**91 tests, all passing.**

```bash
npm install
npx hardhat test
```

| Suite | Tests | Covers |
|---|---|---|
| `GroupA.test.js` | 20 | AssetRegistry whitelist, InsurancePool funding/draw/cap, operator access control |
| `GroupB.test.js` | 13 | Full v2 lifecycle: swaps, deposit invariant, forced swap-back (aligned and diverged TWAP), insurance draws, three-tier access, keeper bounty |
| `GroupD.test.js` | 17 | Guard rails and edge cases |
| `GroupH.test.js` | 15 | Protocol fee: add-on behaviour, zero fee on loss, referrer split, bounty precedence, rate snapshotting, caps |
| `KYCRegistry.test.js` | 26 | Verification, signature path, revocation, operator transfer, badge rendering |

Loss scenarios are tested against real state changes — mock Aave and Uniswap contracts with configurable rates and TWAP ticks, so a genuine loss is reproduced deterministically rather than stubbed.

---

## Running it locally

```bash
npm install
npx hardhat test
npx hardhat run scripts/deploy-v2-infrastructure.js --network hardhat
```

The web interface lives in a separate repository: **[covenza-frontend](https://github.com/jsteele111/covenza-frontend)** — React + Vite + wagmi/RainbowKit. Live at **[covenza.xyz](https://covenza.xyz)**.

---

## Known limitations

Stated plainly, because a security reviewer will find them anyway.

- **The testnet deployment uses mock Aave and Uniswap contracts.** The contracts are written against the real Aave V3 and Uniswap V3 interfaces, but the live proof runs against controlled mocks — deterministically reproducing an adverse price move, which the loss and insurance proof requires, isn't achievable against real testnet liquidity. Integration against live protocols is part of mainnet preparation.
- **Settlement parameters on the current testnet deployment are demo-tuned**, not production values — a 90-second grace period instead of 36 hours, so the full lifecycle proof can run in one sitting. Production defaults are in `AssetRegistry.sol`.
- **Deposit-sizing model v1.1** is computed from a 90-day trailing window of daily closes. Longer-horizon calibration is outstanding.
- **No third-party security audit has been performed.** This is the immediate next step and the reason the codebase is public.
- **Single operator address** governs the whitelist, insurance pool and settlement config. Production intent is a multisig.

---

## Repository layout

```
contracts/            Solidity sources
  interfaces/         Minimal IERC20
  libraries/          Vendored UniswapTwap helper
  mocks/              Test-only mocks (not deployed, not in audit scope)
test/                 91 tests
scripts/              Deployment, lifecycle-proof and settlement scripts
```

Key scripts:

| Script | Purpose |
|---|---|
| `deploy-v2-infrastructure.js` | Deploys the full v2 stack, reusing the existing KYCRegistry |
| `lifecycle-proof.js` | Runs the three-tier settlement proof, including the deliberate loss scenario |
| `settle-stuck-vaults.js` | Settles expired vaults as a third-party keeper |

## Licence

MIT