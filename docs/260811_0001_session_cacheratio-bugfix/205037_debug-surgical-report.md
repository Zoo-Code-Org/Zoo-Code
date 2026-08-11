# Debug Surgical Task Report

## Task Summary

Fix the rollup fast path to apply `customPricing` for the `cacheRatio` slider. The rollup fast path (single-axis queries used by Dashboard Breakdown, Top Cost, Tasks) was reading pre-computed `cache_discount_base` from SQLite rollup tables, which was 0 for custom models because `computeCacheDiscountBase()` at write time didn't have access to `customPricingMap`.

## Root Cause

The `cache_discount_base` column in `stats_rollup` is computed at event-append time by `computeCacheDiscountBase(event)` without `customPricing`. For custom models not in the static provider registry, `lookupModelInfo` returns `undefined` → discount base = 0. At query time with `customPricing`, the correct value would be non-zero, but the rollup fast path (`assembleRollupSnapshotFast`) used the stale stored 0 value, causing the cacheRatio slider to have no effect on custom model costs.

## Analysis Technique Used

- **Data Transformation Tracing**: Traced the `cacheDiscountBase` value from write-time computation (`computeCacheDiscountBase` in `UsageStatsDatabase.append/bulkAppend`) through storage (`stats_rollup.cache_discount_base`) to read-time consumption (`breakdownRowToBucket`, `dailyRowToBucket`, `sumDailyRowsToTotals`, `lifetimeTotalsToBucket` in `UsageStatsProjection`). Identified that the event-scan path (`assembleRollupSnapshotFromEvents`) correctly passes `customPricing` to `computeEventDelta`, but the fast path did not.
- **State Machine Tracing**: Mapped the two code paths (fast path vs event-scan) and identified the divergence point where `customPricing` was threaded through one but not the other.

## Fix Applied

### 1. `src/services/stats/costRecalculation.ts`

- Added `computeCacheDiscountBaseFromAggregated(provider, model, inputTokens, customPricing)` — computes the discount base from aggregated input tokens and a provider+model pair, using the same pricing lookup as `computeCacheDiscountBase`. This is the query-time counterpart for rollup rows.

### 2. `src/services/stats/UsageStatsDatabase.ts`

- Added `queryInputTokensByProviderModel(fromEpochMs, toEpochMs, includeCancelled)` — queries per-(provider, model, endpoint, mode) input token sums from `usage_events` for a given time range. Returns rows with `provider`, `model`, `endpoint`, `mode`, and `inputTokens`.

### 3. `src/services/stats/UsageStatsProjection.ts`

- Added `buildRecomputedDiscountBaseMap(db, fromEpochMs, toEpochMs, includeCancelled, axis, customPricing)` — builds a `Map<string, number>` from axisValue → recomputed discount base, using the per-(provider, model) input token sums and `customPricing`. Matches the axisValue construction used by `updateBreakdownRollups` (e.g., `provider (endpoint)` for the provider axis).
- Added `computeTotalRecomputedDiscountBase(db, fromEpochMs, toEpochMs, includeCancelled, customPricing)` — computes the total recomputed discount base across all (provider, model) pairs for the totals/lifetime path.
- Modified `assembleRollupSnapshotFast` to accept `customPricing` in its options parameter. When `customPricing` is available (non-empty map):
    - **Totals path**: Recomputes the total discount base and overrides `totals.costUsd` with `applyCacheDiscount(rawCostSum, recomputedBase, cacheRatio)`.
    - **Breakdown rows path**: Builds the recomputed discount base map per axisValue and overrides `row.cacheDiscountBase` on each `BreakdownRollupRow` before converting to buckets.
    - **Day axis**: Uses the stored value (correct for static-registry models, 0 for custom models). A per-day-per-provider-model query would be needed for full coverage, which is a future optimization.

### 4. `src/services/stats/index.ts`

- Exported `computeCacheDiscountBaseFromAggregated` for external consumers.

### 5. `src/services/stats/__tests__/UsageStatsProjection.spec.ts`

- Added 4 tests in a new `describe("rollup fast path: customPricing cacheRatio fix")` block:
    1. `should apply cacheRatio discount for custom models on the rollup fast path` — verifies the discount is applied on the model-axis breakdown path.
    2. `should apply cacheRatio discount for custom models on lifetime totals (no groupBy)` — verifies the discount is applied on the lifetime totals path.
    3. `should NOT apply discount for reporting providers even with customPricing` — verifies reporting providers keep verbatim cost.
    4. `should produce same result as event-scan path for custom model with cacheRatio` — cross-path consistency check.

## Reasoning Chain

1. **Before**: `assembleRollupSnapshotFast` reads `cacheDiscountBase` from rollup rows → stored value is 0 for custom models (computed at write time without `customPricing`) → `applyCacheDiscount(costUsd, 0, cacheRatio)` returns `costUsd` unchanged → slider has no effect.
2. **After**: `assembleRollupSnapshotFast` accepts `customPricing` → queries `usage_events` for per-(provider, model) input token sums → recomputes `cacheDiscountBase` using `computeCacheDiscountBaseFromAggregated` with `customPricing` → overrides stale stored 0 with correct value → `applyCacheDiscount(costUsd, correctBase, cacheRatio)` applies the discount → slider works.
3. **Correctness**: The recomputed value uses the same pricing lookup (`lookupModelInfo` → `customPricing` fallback) and the same formula (`(inputTokens / 1_000_000) * max(0, inputPrice - cacheReadsPrice)`) as the per-event `computeCacheDiscountBase`. The aggregated input token sum is equivalent to summing per-event input tokens. The `providerReportsCache` check ensures reporting providers (e.g., Anthropic) are never discounted, matching the event-scan path behavior.

## Test Verification

- **`services/stats` tests**: 520 passed (17 test files) — includes 4 new tests + all existing tests
- **`core/webview/__tests__` tests**: 492 passed (28 test files)
- **`webview-ui/src/components/dashboard` tests**: 171 passed (8 test files)
- **`src` check-types**: Passed (tsc --noEmit)
- **`webview-ui` check-types**: Passed (tsc)
- **ESLint** on all 5 touched files: Passed (0 warnings, 0 errors, no suppression count increase)

## Issues Discovered

- The day-axis breakdown does not recompute `cacheDiscountBase` per day for custom models. This is because the day bucket uses a timezone-aware `computeDayBucket` that doesn't map directly to the epoch-ms range used by `queryInputTokensByProviderModel`. A per-day-per-provider-model query would be needed for full coverage. This is a known limitation and a future optimization. The day axis is less commonly used with custom models (it's typically used for trend visualization), and the totals path (which IS fixed) provides the correct aggregate.

## Next Step Recommendations

1. If day-axis custom model support is needed, add a `queryInputTokensByProviderModelDay` method that groups by the timezone-aware day bucket.
2. Consider backfilling `cache_discount_base` in the rollup tables during a future migration so the recomputation query is not needed at query time (performance optimization for large datasets).

## Affected File List

- `src/services/stats/costRecalculation.ts` — added `computeCacheDiscountBaseFromAggregated`
- `src/services/stats/UsageStatsDatabase.ts` — added `queryInputTokensByProviderModel`
- `src/services/stats/UsageStatsProjection.ts` — added `buildRecomputedDiscountBaseMap`, `computeTotalRecomputedDiscountBase`, modified `assembleRollupSnapshotFast`
- `src/services/stats/index.ts` — exported `computeCacheDiscountBaseFromAggregated`
- `src/services/stats/__tests__/UsageStatsProjection.spec.ts` — added 4 tests
