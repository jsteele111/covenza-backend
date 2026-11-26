/**
 * Security review, 26 November 2026 — Part A: the deployment guards.
 *
 *   S1  the operator and the treasury must be Safes, and must be typed for
 *       the run (a confirmation stored in the environment file is refused)
 *   S2  production Safes need at least 2 of 3 signatures
 *   S5  a production network reads only its own environment file
 *   S8  the M-07 tier calibration rule, which no setting can waive
 *   and: operator, treasury and attester must be three different addresses
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { guardProductionConfig, calibrationProblem, MIN_TIMELOCK, MIN_TWAP_WINDOW } = require("../scripts/lib/production-guards");
const { requireProductionSafe } = require("../scripts/lib/safe-checks");
const { selectedNetwork, envFileFor, requireTypedConfirmation } = require("../scripts/lib/production-env");
const { TIERS } = require("../scripts/deploy-ethereum-carry");

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const OK = { timelockDelay: MIN_TIMELOCK, twapWindow: MIN_TWAP_WINDOW, outageGapThreshold: 0 };
const tiersOf = (rows) => rows.map(([name, vol, cap]) => ({ name, assumedVolBps: vol, maxExposureBps: cap }));

describe("Security review Part A — deployment guards", function () {
  afterEach(function () { delete process.env.ALLOW_UNSAFE_PRODUCTION; });

  describe("S8 — the M-07 calibration rule, not waivable", function () {
    it("refuses the contract defaults (Blue chip 1.00 x 60% above Standard 0.50 x 100%)", function () {
      const t = tiersOf([["Blue chip", 6000, 10000], ["Standard", 10000, 5000], ["Speculative", 20000, 2500]]);
      expect(() => guardProductionConfig("mainnet", { ...OK, tiers: t })).to.throw(/calibration rule broken/);
    });
    it("stays refused even with ALLOW_UNSAFE_PRODUCTION=1", function () {
      process.env.ALLOW_UNSAFE_PRODUCTION = "1";
      const t = tiersOf([["Blue chip", 6000, 10000], ["Standard", 10000, 5000]]);
      expect(() => guardProductionConfig("mainnet", { ...OK, tiers: t })).to.throw(/cannot be overridden/);
    });
    it("accepts the Ethereum carry tiers (0.05 <= 0.50 <= 0.50) and the Robinhood launch shape (0.42 <= 0.50 <= 0.50)", function () {
      const carry = TIERS.map((x) => ({ name: x.name, assumedVolBps: x.cfg[0], maxExposureBps: x.cfg[3] }));
      expect(calibrationProblem(carry)).to.equal(null);
      expect(calibrationProblem(tiersOf([["Blue chip", 6000, 7000], ["Standard", 10000, 5000], ["Speculative", 20000, 2500]]))).to.equal(null);
    });
  });

  describe("Separate roles, not waivable", function () {
    it("refuses the treasury and the operator at the same address, even with the override", function () {
      process.env.ALLOW_UNSAFE_PRODUCTION = "1";
      expect(() => guardProductionConfig("mainnet", { ...OK, operator: A, treasury: A, attesterKey: B }))
        .to.throw(/operator and the treasury are the same address/);
    });
    it("refuses the attester at the treasury's address", function () {
      expect(() => guardProductionConfig("mainnet", { ...OK, operator: A, treasury: B, attesterKey: B }))
        .to.throw(/treasury and the attester are the same address/);
    });
    it("accepts three different addresses, and ignores test networks", function () {
      expect(() => guardProductionConfig("mainnet", { ...OK, operator: A, treasury: B, attesterKey: C })).to.not.throw();
      expect(() => guardProductionConfig("sepolia", { operator: A, treasury: A, attesterKey: A })).to.not.throw();
    });
  });

  describe("S1 and S2 — production Safes need at least 2 of 3", function () {
    let owners, Safe;
    before(async function () {
      owners = (await ethers.getSigners()).slice(1, 4).map((s) => s.address);
      Safe = await ethers.getContractFactory("MockSafe");
    });
    it("refuses a single key", async function () {
      await expect(requireProductionSafe(ethers, owners[0], "Treasury")).to.be.rejectedWith(/single key, not a Safe/);
    });
    it("refuses a contract that is not a Safe", async function () {
      const token = await (await ethers.getContractFactory("MockERC20")).deploy("X", "X", 18);
      await expect(requireProductionSafe(ethers, await token.getAddress(), "Treasury")).to.be.rejectedWith(/not a Safe/);
    });
    it("refuses 1 of 1, 1 of 3 and 2 of 2", async function () {
      for (const [o, t] of [[owners.slice(0, 1), 1], [owners, 1], [owners.slice(0, 2), 2]]) {
        const s = await Safe.deploy(o, t);
        await expect(requireProductionSafe(ethers, await s.getAddress(), "Operator Safe")).to.be.rejectedWith(/at least 2 of 3/);
      }
    });
    it("accepts 2 of 3", async function () {
      const s = await Safe.deploy(owners, 2);
      const r = await requireProductionSafe(ethers, await s.getAddress(), "Operator Safe");
      expect(r.threshold).to.equal(2);
    });
  });

  describe("S5 — a production network reads only its own environment file", function () {
    it("chooses .env.mainnet and .env.robinhoodMainnet for production, .env for everything else", function () {
      expect(path.basename(envFileFor("mainnet", "/r"))).to.equal(".env.mainnet");
      expect(path.basename(envFileFor("robinhoodMainnet", "/r"))).to.equal(".env.robinhoodMainnet");
      for (const n of ["sepolia", "hardhat", "robinhoodTestnet"]) expect(path.basename(envFileFor(n, "/r"))).to.equal(".env");
    });
    it("reads the network from --network, then HARDHAT_NETWORK, then defaults to hardhat", function () {
      expect(selectedNetwork(["node", "hh", "run", "x", "--network", "mainnet"], {})).to.equal("mainnet");
      expect(selectedNetwork(["node", "hh"], { HARDHAT_NETWORK: "sepolia" })).to.equal("sepolia");
      expect(selectedNetwork(["node", "hh"], {})).to.equal("hardhat");
    });
  });

  describe("S1 — production addresses are typed for the run", function () {
    const file = path.join(os.tmpdir(), `covenza-env-${Date.now()}`);
    after(function () { if (fs.existsSync(file)) fs.unlinkSync(file); });
    it("refuses when not typed, or typed differently", function () {
      fs.writeFileSync(file, "TREASURY_ADDRESS=" + A + "\n");
      expect(() => requireTypedConfirmation({ name: "TREASURY", value: A, envFile: file, env: {} })).to.throw(/by typing it/);
      expect(() => requireTypedConfirmation({ name: "TREASURY", value: A, envFile: file, env: { CONFIRM_TREASURY: B } })).to.throw(/does not match/);
    });
    it("refuses a confirmation stored in the environment file, even if it matches", function () {
      fs.writeFileSync(file, `TREASURY_ADDRESS=${A}\nCONFIRM_TREASURY=${A}\n`);
      expect(() => requireTypedConfirmation({ name: "TREASURY", value: A, envFile: file, env: { CONFIRM_TREASURY: A } })).to.throw(/must be typed/);
    });
    it("accepts a typed match, ignoring letter case", function () {
      fs.writeFileSync(file, "TREASURY_ADDRESS=" + A + "\n");
      expect(() => requireTypedConfirmation({ name: "TREASURY", value: A, envFile: file, env: { CONFIRM_TREASURY: A.toUpperCase().replace("0X", "0x") } })).to.not.throw();
    });
  });
});
