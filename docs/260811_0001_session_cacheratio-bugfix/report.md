# CacheRatio Slider Bugfix Report

**Date**: 2026-08-11  
**Branch**: `feat/dashboard`  
**Worktree**: `C:/Users/k1yt/OneDrive/Projects/ZooCode/.wt-dashboard`

## Summary

The cacheRatio slider in the Dashboard had no effect on cost for **any** provider. Moving the slider did not change the displayed cost. The root cause was a logical error in `providerReportsCache()` that incorrectly classified custom models as "cache-reporting" providers, causing `computeCacheDiscountBase()` to always return `0`.

## Root Cause

### `providerReportsCache()` false positive for custom models

**File**: [`costRecalculation.ts`](file:///C:/Users/k1yt/OneDrive/Projects/ZooCode/.wt-dashboard/src/services/stats/costRecalculation.ts#L281-L311)

The function used `lookupModelInfo()` which has a 3-tier fallback chain:

1. Static provider registry
2. Event-level `modelPricing` (capture-time snapshot)
3. Query-time `customPricing` map (from extension settings)

When a user configures a custom OpenAI-compatible model with `cacheReadsPrice` set, `lookupModelInfo` finds it via tiers 2 or 3, and `providerReportsCache` returns `true` (because `cacheReadsPrice` is a finite number). This makes `computeCacheDiscountBase` return `0`, making the slider inert:

```
displayCost = storedCost − ratio × discountBase
           = storedCost − ratio × 0
           = storedCost  ← cost never changes!
```

**The logical error**: Having `cacheReadsPrice` in user-configured pricing does **not** mean the provider's API returns `cacheReadTokens` in its response. It only means the user specified a price for cache reads. The check should only consider the **static provider registry** — if the model is NOT in the static registry, it's a custom/dynamic model and the provider doesn't report cache info.

## Fix Applied

### `providerReportsCache()` — Static registry only

```diff
 export function providerReportsCache(
     provider: string,
     model: string,
-    modelPricing?: UsageEventV1["modelPricing"],
-    customPricing?: CustomModelPricingMap,
+    _modelPricing?: UsageEventV1["modelPricing"],
+    _customPricing?: CustomModelPricingMap,
 ): boolean {
-    const modelInfo = lookupModelInfo(provider, model, modelPricing, customPricing)
+    // Only check the STATIC provider registry. Custom/user-configured models
+    // may define cacheReadsPrice (for cost estimation), but that does NOT mean
+    // the provider's API actually returns cacheReadTokens in its response.
+    const registry = PROVIDER_MODEL_REGISTRIES[provider]
+    if (!registry) return false
+    // ... direct registry lookup (exact + substring match)
     if (!modelInfo) return false
     return typeof modelInfo.cacheReadsPrice === "number" && ...
 }
```

The function now performs the same model-matching logic (exact match, then case-insensitive substring match) but **only** against the static `PROVIDER_MODEL_REGISTRIES`. Event-level `modelPricing` and query-time `customPricing` are deliberately **not** consulted for this capability check.

### Impact on other call sites

| Call site                                       | Effect                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `computeCacheDiscountBase()`                    | Now returns a **positive** discount base for custom models with `cacheReadsPrice` → slider works |
| `computeEventDelta()`                           | Correctly applies cache discount for custom models                                               |
| `UsageStatsDatabase.rebuildRollupsFromEvents()` | Pre-computed `cache_discount_base` is now correctly non-zero for custom models in rollups        |
| `UsageStatsDatabase.append()`                   | Same — new events get correct `cache_discount_base`                                              |

## Files Changed

| File                                                     | Change                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `src/services/stats/costRecalculation.ts`                | Fixed `providerReportsCache()` to only check static registry |
| `src/services/stats/__tests__/costRecalculation.spec.ts` | Updated 6 tests from buggy assertions to correct behavior    |

## Verification

| Check                                                               | Result                        |
| ------------------------------------------------------------------- | ----------------------------- |
| `vitest run services/stats`                                         | ✅ 17 files, 516 tests passed |
| `vitest run core/webview/__tests__`                                 | ✅ 28 files, 492 tests passed |
| `tsc --noEmit` (src)                                                | ✅ No type errors             |
| `eslint --prune-suppressions --max-warnings=0 costRecalculation.ts` | ✅ Clean                      |

## Note: Existing rollups need a rebuild

For users who already have data in the dashboard, the pre-computed `cache_discount_base` values in the SQLite rollup tables were computed with the old (buggy) `providerReportsCache`. These will all be `0` for custom models. To see the slider take effect on existing data:

- **Event-scan path** (multi-axis queries): Works immediately — `computeEventDelta()` is recalculated at query time
- **Fast rollup path** (single-axis queries): Uses pre-computed `cache_discount_base` from the DB, which is `0`. A `rebuildRollupsFromEvents()` will fix this. The coordinator already has auto-rebuild logic for empty rollup tables, but a manual rebuild may be needed for existing data.
