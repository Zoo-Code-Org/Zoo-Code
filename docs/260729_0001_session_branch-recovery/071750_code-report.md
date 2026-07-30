# Code Task Report

## Task Summary

Sub-task 3: Exposed reusable event contribution and projection query logic for the dashboard streaming architecture.

## Actions Taken

### A. UsageAggregator.ts — Extracted pure contribution function

- Extracted `computeEventContribution(event, query)` as a public pure function that returns `StatsBucketDelta | null`
- Extracted `computeEventDelta(event, cacheRatio)` as the internal pure delta computation (no key, no filtering)
- Extracted standalone pure functions: `resolveTimeRange()`, `computeTimeBuckets()`, `computeGroupKeys()`, `serializeBucketKey()`
- Refactored `accumulateIntoBucket()` to delegate to `computeEventDelta()` (single-source logic, no duplication)
- The class methods now call the standalone functions, preserving all existing behavior

### B. UsageStatsProjection.ts — New file with 4 public functions

- `assembleRollupSnapshot(db, query, options?)` — Reads events from DB, aggregates using the same pure logic as UsageAggregator, returns StatsSnapshot
- `computeSessionPage(db, requestId, cursor?, limit?)` — Reads session_metadata via `db.querySessions()`, returns cursor-paged DashboardSessionPage
- `computeHeatmapSnapshot(db, rangeDays, timezone)` — Reads daily rollups, applies edge-day correction using timezone-aware day buckets, returns HeatmapSnapshot
- `applyEventToProjection(db, event, query, requestId, heatmapRangeDays, generation, sequence)` — Computes DashboardStatsDelta for one event using pure `computeEventContribution`, includes breakdown deltas, heatmap day delta, and session upserts
- `computeDayBucket(occurredAt, timezone)` — Public edge-day correction function using Intl API for DST/midnight handling
- Cost recalculation remains single-source: all deltas use `computeEventDelta()` which calls `getEffectiveCost()` — no SQL arithmetic duplication

### C. UsageAggregator.spec.ts — Added contribution function tests

- `computeEventContribution` tests: matching/non-matching events, cancelled filtering, cost fallback, unknown semantics, cache ratio estimation, totalTokens recomputation
- `computeEventDelta` tests: keyless delta, all status types
- `computeGroupKeys` tests: empty groupBy, day bucket, provider+endpoint, multi-axis Cartesian product, mixed sources
- `serializeBucketKey` tests: stable serialization regardless of insertion order, pipe-separated format, empty key
- `resolveTimeRange` tests: today/7d/30d/all presets, explicit from/to
- `computeTimeBuckets` tests: day/week/month, midnight boundary, UTC timezone
- Property-style tests: folding per-event deltas equals full aggregate (across statuses, cost fallback, cache ratio, unknown semantics, timezones, each supported group axis)

### D. UsageStatsProjection.spec.ts — New file with property-style tests

- `computeDayBucket` edge-day correction: midday, midnight KST, midnight UTC, midnight NY, DST spring forward/fall back, timezone consistency, timezone boundary divergence
- `assembleRollupSnapshot`: empty DB, single event, matches UsageAggregator results, cost fallback, time range filtering, cancelled filtering, coverage computation
- `computeSessionPage`: empty DB, ordering, session aggregation, cursor pagination, cursor consistency (no gaps/duplicates), requestId propagation
- `computeHeatmapSnapshot`: correct day count, zeros for empty DB, cost for days with events, different range sizes
- `applyEventToProjection`: matching event delta, zero delta for out-of-range, cancelled filtering, breakdown deltas, heatmap day delta, session upsert, cost recalculation
- Property test: folding per-event deltas equals full aggregate (with DB)
- Stable bucket-key serialization: insertion order independence, uniqueness, empty/single/three-axis keys
- Error handling: StatsProjError on database failure

## Result

✅ Success — All 127 tests pass (2 test files, 0 failures)
✅ Type check: Zero errors in modified files (pre-existing errors in `api/providers/__tests__/mimo.spec.ts` are unrelated)

### Verification Commands

```
cd src; npx vitest run services/stats/__tests__/UsageAggregator.spec.ts services/stats/__tests__/UsageStatsProjection.spec.ts
# Result: 2 passed, 127 tests passed, 0 failed

cd src; npx tsc --noEmit
# Result: No errors in services/stats/ files (pre-existing mimo.spec.ts errors unrelated)
```

## Issues Discovered

- The DB's `upsertSession()` stores `totalTokens` as `inputTokens + outputTokens` (not the event's stored `totalTokens` field), which is the correct provider-neutral recomputation. One test assertion was initially wrong (expected 3000 instead of 4500) and was corrected to match the correct behavior.

## Next Step Recommendations

- Sub-task 4: Implement the demand-driven host stream coordinator (`UsageStatsStreamCoordinator.ts`)
- The `applyEventToProjection` function currently reads session metadata via `db.querySessions()` — when the stream coordinator is implemented, it should call `db.append()` first, then `applyEventToProjection()` to compute the delta

## Affected File List

- `src/services/stats/UsageAggregator.ts` (modified — extracted pure functions)
- `src/services/stats/UsageStatsProjection.ts` (new — projection query logic)
- `src/services/stats/__tests__/UsageAggregator.spec.ts` (modified — added contribution tests)
- `src/services/stats/__tests__/UsageStatsProjection.spec.ts` (new — property-style tests)
