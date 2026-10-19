// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Vault} from "../contracts/Vault.sol";
import {VaultFactory} from "../contracts/VaultFactory.sol";
import {AssetRegistry} from "../contracts/AssetRegistry.sol";
import {InsurancePool} from "../contracts/InsurancePool.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockFreezableToken} from "../contracts/mocks/MockFreezableToken.sol";
import {MockSwapRouter} from "../contracts/mocks/MockSwapRouter.sol";
import {MockUniswapV3Factory, MockUniswapV3Pool} from "../contracts/mocks/MockUniswapV3.sol";
import {MockIdentityAdapter} from "../contracts/mocks/MockIdentityAdapter.sol";

import {ProtocolHandler} from "./handlers/ProtocolHandler.sol";

/**
 * @title ProtocolSetup
 * @notice The full stack, deployed for real, plus the handler the fuzzer
 *         drives. Shared by the invariant suite and the handler-path test.
 *
 * @dev    Factory, clones, registry, insurance pool and linked TWAP library
 *         are the real contracts. Uniswap and the router are the same mocks
 *         the Hardhat suites use. Identity uses MockIdentityAdapter, because
 *         KYCRegistry's manual-grant rate limit (5 per 30 days) would
 *         otherwise cap the actors, and identity has its own suites.
 *
 *         Outage detection is left ON. With no heartbeat, the fuzzer's clock
 *         jumps are recorded as outages, which exercises the extended windows;
 *         the handler's botHour() action models the bot running.
 */
abstract contract ProtocolSetup is Test {
    ProtocolHandler internal h;

    VaultFactory internal factory;
    AssetRegistry internal registry;
    InsurancePool internal pool;
    MockERC20 internal weth;
    MockFreezableToken internal usdx;
    MockSwapRouter internal router;
    MockUniswapV3Pool internal uniPool;

    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address[] internal lenders;
    address[] internal borrowers;

    uint256 internal constant ROUTER_LIQUIDITY = 1_000_000 ether;
    uint256 internal constant INITIAL_RESERVE = 50 ether;

    function setUp() public {
        vm.warp(1_800_000_000);

        weth = new MockERC20("Mock WETH", "WETH", 18);
        usdx = new MockFreezableToken("Mock USDX", "USDX", 18);

        router = new MockSwapRouter();
        MockUniswapV3Factory uniFactory = new MockUniswapV3Factory();
        uniPool = new MockUniswapV3Pool();
        uniFactory.setPool(address(weth), address(usdx), 3000, address(uniPool));
        uniPool.setAvgTick(0);
        router.setRate(address(weth), address(usdx), 1, 1);
        router.setRate(address(usdx), address(weth), 1, 1);
        weth.mint(address(router), ROUTER_LIQUIDITY);
        usdx.mint(address(router), ROUTER_LIQUIDITY);

        MockIdentityAdapter id = new MockIdentityAdapter();

        registry = new AssetRegistry(address(this), makeAddr("aave"), address(router),
                                     address(uniFactory), address(weth), 0);
        registry.addAssetWithTier(address(weth), address(0), AssetRegistry.YieldVenue.None, address(0), 0, AssetRegistry.RiskTier.BlueChip);
        registry.addAssetWithTier(address(usdx), address(0), AssetRegistry.YieldVenue.None, address(0), 0, AssetRegistry.RiskTier.BlueChip);
        registry.setPoolFeeTier(address(weth), address(usdx), 3000);
        registry.setSettlementConfig(1800, 200, 1 days, 100, 200);
        // Permissive tier: only the vault's own rules bind, not the floors.
        registry.setTierConfig(AssetRegistry.RiskTier.BlueChip, 0, 0, 365 days, 10000, 100);
        registry.setMaxEntryImpactBps(200);

        pool = new InsurancePool(address(this), 1000, 0);
        Vault impl = new Vault();
        factory = new VaultFactory(address(id), address(registry), address(pool), treasury, address(impl), 0);
        pool.setVaultFactory(address(factory));

        weth.mint(address(this), INITIAL_RESERVE);
        weth.approve(address(pool), INITIAL_RESERVE);
        pool.fund(address(weth), INITIAL_RESERVE);

        for (uint256 i = 0; i < 3; i++) {
            address l = makeAddr(string(abi.encodePacked("lender", vm.toString(i))));
            address b = makeAddr(string(abi.encodePacked("borrower", vm.toString(i))));
            id.set(l, 7);
            id.set(b, 7);
            lenders.push(l);
            borrowers.push(b);
        }

        h = new ProtocolHandler(ProtocolHandler.Deps({
            factory: factory, registry: registry, pool: pool, weth: weth, usdx: usdx,
            router: router, uniPool: uniPool, keeper: keeper,
            initialReserve: INITIAL_RESERVE, wethAlreadyMinted: ROUTER_LIQUIDITY + INITIAL_RESERVE
        }), lenders, borrowers);

        // The fuzzer may freeze the token and set prices, so the handler must
        // be allowed to; the mocks are open to anyone, which is fine here.
        targetContract(address(h));
    }

}
