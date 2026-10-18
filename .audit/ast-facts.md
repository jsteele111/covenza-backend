# AST Facts (Compiler-Verified)

MODE: regex-fallback

> Extraction mode: regex-fallback
> Project root: /c/Users/Jamie Steele/Documents/lending-poc
> Scope directory: /c/Users/Jamie Steele/Documents/lending-poc/contracts
> Extraction timestamp: 2026-10-01T10:53:18Z

## Inheritance Tree
| Contract | File | Inherits From |
|----------|------|---------------|
| AssetRegistry | contracts/AssetRegistry.sol | OperatorControlled |
| InsurancePool | contracts/InsurancePool.sol | Timelocked,OperatorControlled |
| KYCRegistry | contracts/KYCRegistry.sol | Timelocked,OperatorControlled |
| VaultFactory | contracts/VaultFactory.sol | Timelocked |

## Function Registry
### AssetRegistry (contracts/AssetRegistry.sol)
| Function | Visibility | Mutability | Modifiers |
|----------|-----------|------------|-----------|
| addAsset | external | nonpayable | onlyOperator |
| addAssetWithVenue | internal | nonpayable | function,addAssetWithVenue( |
| addAssetWithTier | internal | nonpayable | function,addAssetWithTier( |
| _addAsset | internal | nonpayable | function |
| _validateVenue | internal | pure |  |
| setVenue | internal | nonpayable | function,setVenue( |
| setTier | external | nonpayable | onlyOperator |
| _recordTier | internal | nonpayable |  |
| highestTierSince | internal | nonpayable |  |
| tierHistoryLength | external | view |  |
| setTierConfig | internal | nonpayable | function,setTierConfig( |
| _setTierConfig | internal | nonpayable | function |
| setMaxEntryImpactBps | external | nonpayable | onlyOperator |
| setDepositCoeffBps | external | nonpayable | onlyOperator |
| setGracePeriod | external | nonpayable | onlyOperator |
| removeAsset | external | nonpayable | onlyOperator |
| setSettlementConfig | internal | nonpayable | function,setSettlementConfig( |
| isWhitelisted | external | view |  |
| aTokenOf | external | view |  |
| venueOf | external | view |  |
| gracePeriodOf | external | view |  |
| tierOf | external | view |  |
| minimumDepositBpsForTier | internal | nonpayable |  |
| minimumDepositBps | internal | nonpayable |  |
| maxTermForTier | external | view |  |
| maxTermFor | external | view |  |
| maxExposureBpsFor | external | view |  |
| insurancePremiumBpsFor | external | view |  |
| insurancePremiumBpsForTier | external | view |  |
| _sqrt | private | pure |  |
| totalAssets | external | view |  |
| getWhitelistedAssets | external | view |  |

### InsurancePool (contracts/InsurancePool.sol)
| Function | Visibility | Mutability | Modifiers |
|----------|-----------|------------|-----------|
| setVaultFactory | external | nonpayable | onlyOperator |
| queueSetVaultFactory | external | nonpayable | onlyOperator |
| cancelSetVaultFactory | external | nonpayable | onlyOperator |
| _vaultFactoryId | internal | pure |  |
| setDrawCapBps | external | nonpayable | onlyOperator |
| registerVault | external | nonpayable |  |
| fund | external | nonpayable |  |
| draw | internal | nonpayable | function,draw( |
| queueAdminWithdraw | external | nonpayable | onlyOperator |
| cancelAdminWithdraw | external | nonpayable | onlyOperator |
| adminWithdraw | external | nonpayable | onlyOperator |
| _withdrawId | internal | pure |  |

### KYCRegistry (contracts/KYCRegistry.sol)
| Function | Visibility | Mutability | Modifiers |
|----------|-----------|------------|-----------|
| verifyWithSignature | internal | nonpayable | function,verifyWithSignature( |
| queueAddAttester | internal | nonpayable | function,queueAddAttester( |
| cancelAddAttester | internal | nonpayable | function,cancelAddAttester( |
| addAttester | internal | nonpayable | function,addAttester( |
| _attesterId | internal | nonpayable |  |
| removeAttester | external | nonpayable | onlyOperator |
| _addAttester | internal | nonpayable |  |
| allAttesters | external | view |  |
| isRecognisedAttester | external | view |  |
| verify | external | nonpayable | onlyOperator |
| revoke | external | nonpayable | onlyOperator |
| rotateAttester | external | nonpayable | onlyOperator |
| _setVerified | private | nonpayable |  |
| statusOf | external | view |  |

### Vault (contracts/Vault.sol)
| Function | Visibility | Mutability | Modifiers |
|----------|-----------|------------|-----------|
| supply | external | nonpayable |  |
| withdraw | external | nonpayable |  |
| deposit | external | nonpayable |  |
| withdraw | external | nonpayable |  |
| redeem | external | nonpayable |  |
| convertToAssets | external | view |  |
| exactInputSingle | external | payable |  |
| initialize | internal | nonpayable | function,initialize( |
| fullTermFee | public | view |  |
| accruedFee | public | view |  |
| requiredDeposit | external | view | return |
| depositPaid | public | view | return,deposit |
| payDeposit | external | nonpayable |  |
| creditDeposit | external | nonpayable |  |
| cancel | external | nonpayable |  |
| _enforceDepositInvariant | internal | view |  |
| supplyToYield | public | nonpayable | onlyActiveBorrower |
| withdrawFromYield | public | nonpayable | onlyActiveBorrower |
| supplyToAave | external | nonpayable |  |
| withdrawFromAave | external | nonpayable |  |
| swap | internal | nonpayable | function,swap( |
| _enforceEntryImpact | internal | nonpayable | function |
| _enforceExposureCap | internal | view |  |
| swapBack | internal | nonpayable | function,swapBack( |
| _executeSwap | internal | nonpayable | function |
| _trackHeldAsset | internal | nonpayable |  |
| _untrackIfEmptied | internal | nonpayable |  |
| heldAssetCount | external | view | return,heldAssets.length; |
| settle | external | nonpayable |  |
| _distribute | internal | nonpayable |  |
| _forcedSwapBackAll | internal | nonpayable |  |
| _withdrawAllFromYield | internal | nonpayable |  |
| _effectiveGracePeriod | internal | view |  |
| _accruedBounty | internal | view |  |
| quoteSwapOut | internal | nonpayable |  |
| vaultBalance | external | view |  |
| isExpired | external | view |  |
| yieldPositionValue | external | view |  |
| effectiveGracePeriod | external | view |  |
| lossSeverity | external | view |  |

### VaultFactory (contracts/VaultFactory.sol)
| Function | Visibility | Mutability | Modifiers |
|----------|-----------|------------|-----------|
| transferOwnership | external | nonpayable | onlyOwner |
| cancelOwnershipTransfer | external | nonpayable | onlyOwner |
| acceptOwnership | external | nonpayable |  |
| deployVault | internal | nonpayable | function,deployVault( |
| deployVaultWithTier | internal | nonpayable | function,deployVaultWithTier( |
| _deployVault | internal | nonpayable |  |
| quoteMinimumDeposit | internal | nonpayable | function,quoteMinimumDeposit( |
| quoteFullTermFee | internal | nonpayable | function,quoteFullTermFee( |
| quoteInsuranceSkim | internal | nonpayable | function,quoteInsuranceSkim( |
| quoteProtocolFee | internal | nonpayable | function,quoteProtocolFee( |
| publishMandate | external | nonpayable |  |
| cancelMandate | external | nonpayable |  |
| cancelAllMandates | external | nonpayable |  |
| isMandateLive | public | view |  |
| bindingDepositBps | internal | nonpayable |  |
| quoteMandateApr | internal | nonpayable |  |
| quoteMandateFillable | public | view |  |
| totalMandates | external | view |  |
| fillMandate | internal | nonpayable | function,fillMandate( |
| _fundBorrowerSide | internal | nonpayable |  |
| quoteFillCost | internal | nonpayable |  |
| mandate | external | view |  |
| setInsuranceSkimRateBps | external | nonpayable | onlyOwner |
| setTreasury | external | nonpayable | onlyOwner |
| setProtocolFeeRateBps | external | nonpayable | onlyOwner |
| setReferrerShareBps | external | nonpayable | onlyOwner |
| setMaxMandateDuration | external | nonpayable | onlyOwner |
| setMinimumFeeBps | external | nonpayable | onlyOwner |
| queueSetRegistries | internal | nonpayable | function,queueSetRegistries( |
| cancelSetRegistries | internal | nonpayable | function,cancelSetRegistries( |
| setRegistries | internal | nonpayable | function,setRegistries( |
| _registriesId | internal | pure |  |
| totalVaults | external | view |  |
| getVaultsByBorrower | external | view |  |
| getVaultsByLender | external | view |  |

## Call Graph (External Calls)
| Source File | Line | Call Pattern |
|-----------|------|-------------|
| contracts/InsurancePool.sol | 238 | `bool ok = IERC20(asset).transfer(msg.sender, paid);` |
| contracts/InsurancePool.sol | 292 | `bool ok = IERC20(asset).transfer(to, amount);` |
| contracts/Vault.sol | 508 | `require(IERC20(asset).transfer(lender, balance), "Refund to lender failed");` |
| contracts/Vault.sol | 908 | `require(IERC20(asset).transfer(lender, lenderPayout), "Failed to pay lender");` |
| contracts/Vault.sol | 910 | `require(IERC20(asset).transfer(msg.sender, bounty), "Failed to pay bounty");` |
| contracts/Vault.sol | 913 | `require(IERC20(asset).transfer(treasury, settledProtocolFee), "Failed to pay treasury");` |
| contracts/Vault.sol | 916 | `require(IERC20(asset).transfer(referrer, settledReferrerFee), "Failed to pay referrer");` |
| contracts/Vault.sol | 919 | `require(IERC20(asset).transfer(borrower, settledBorrowerPayout), "Failed to pay borrower");` |

## Modifier Definitions
| Contract | Modifier |
|----------|----------|
| Vault | onlyActiveBorrower |
| VaultFactory | onlyOwner |

## Risk Score Inputs (Exact Counts)
| File | LOC | External Calls | State Writers | Payable Fns | Assembly Blocks | Unchecked Blocks |
|------|-----|---------------|---------------|-------------|----------------|-----------------|
| contracts/AssetRegistry.sol | 770 | 0 | 19 | 0 | 0 | 0 |
| contracts/InsurancePool.sol | 301 | 2 | 9 | 0 | 0 | 0 |
| contracts/KYCRegistry.sol | 349 | 0 | 7 | 0 | 0 | 0 |
| contracts/OperatorControlled.sol | 70 | 0 | 3 | 0 | 0 | 0 |
| contracts/Timelocked.sol | 88 | 0 | 2 | 0 | 0 | 0 |
| contracts/Vault.sol | 1122 | 6 | 25 | 1 | 0 | 0 |
| contracts/VaultFactory.sol | 1031 | 0 | 19 | 0 | 0 | 0 |
| contracts/interfaces/IERC20.sol | 19 | 0 | 5 | 0 | 0 | 0 |
| contracts/libraries/UniswapTwap.sol | 233 | 0 | 1 | 0 | 4 | 2 |
