# Code Task Report: ST-1 — Rollup-backed Snapshot Read Path

## Task Summary
Implemented the rollup-backed snapshot read path (Option A) to eliminate the synchronous full-event scan that caused dashboard crashes on re-entry. The `assembleRollupSnapshot()` function now reads from pre-computed rollup tables instead of scanning all events, and `applyEventToProjection()` uses a direct primary-key lookup instead of `querySessions(100).find(...)`.

## Actions Taken

### 1. `src/services/stats/UsageStatsDatabase.ts`
- **Schema version bumped to 3** with `migrateToV3()` backfill migration
- **`appendInternal()` and `bulkAppend()`**: Now write per-axis breakdown rollup rows (`axis='model'`, `'provider'`, `'mode'`) for daily, monthly, and lifetime periods. Also writes non-cancelled-only rollup rows (`root_task_id='__nc__'`) for `includeCancelled=false` support.
- **Cost consistency**: Changed `costUsd` in rollup writes from `event.usage.costUsd?.value ?? 0` to `getEffectiveCost(event)`, matching `computeEventDelta()` in `UsageAggregator.ts`. This fixes a parity gap where events without `costUsd` would have 0 cost in rollups but computed cost in the aggregator.
- **New methods added**:
  - `queryBreakdownRollups(periodType, fromKey, toKey, axis, includeCancelled)` — queries per-axis breakdown rows
  - `queryDailyRollupsDetailed(fromDay, toDay, includeCancelled)` — queries daily rollups with all token breakdowns
  - `queryLifetimeTotalsFiltered(includeCancelled)` — queries lifetime totals with cancelled filter
  - `queryCoverageStats(fromEpochMs, toEpochMs, includeCancelled)` — fast indexed coverage query
  - `querySessionByRootTaskId(rootTaskId)` — O(1) primary-key session lookup
- **New types**: `BreakdownRollupRow`, `DailyRollupDetailedRow`, `CoverageStats`
- **New constants**: `NON_CANCELLED_KEY = "__nc__"`, `BREAKDOWN_AXES = ["model", "provider", "mode"]`
- **New helpers**: `updateBreakdownRollups()`, `updateNonCancelledRollups()`
- **`migrateToV3()`**: Reads all events in batches and rebuilds breakdown + non-cancelled rollup rows. Idempotent (delete + rebuild).

### 2. `src/services/stats/UsageStatsProjection.ts`
- **`assembleRollupSnapshot()` rewritten** with dual-path strategy:
  - **Fast path** (`assembleRollupSnapshotFast()`): For single-axis queries on `model`/`provider`/`mode`/`day` without `cacheRatio` estimation. Reads O(distinct values) rows from rollup tables instead of O(N) events.
  - **Fallback path** (`assembleRollupSnapshotFromEvents()`): For multi-axis, `week`/`month`/`source`/`status` axes, or `cacheRatio > 0`. Uses the original event-scan logic.
  - **`canUseRollupFastPath()`**: Determines which path to use based on query axes and cacheRatio.
- **`applyEventToProjection()`**: Replaced `db.querySessions(100, undefined).find(s => s.rootTaskId === rootTaskId)` with `db.querySessionByRootTaskId(rootTaskId)`. This is O(1) via primary key and also fixes a bug where sessions beyond the first 100 results would not be found.

### 3. `src/services/stats/__tests__/dashboardStatsPerformance.spec.ts`
- **Parity tests**: 9 tests verifying rollup snapshot matches `UsageAggregator` results for:
  - Single-axis `[model]`, `[provider]`, `[mode]`, `[day]` queries (preset: all)
  - Empty groupBy
  - Cancelled events excluded (includeCancelled: false)
  - Cancelled events included (includeCancelled: true)
  - Coverage (firstEventAt, lastEventAt, backfilledEventCount)
  - Cost recalculation for events without costUsd
- **`querySessionByRootTaskId` tests**: 3 tests verifying:
  - Same result as `querySessions(100).find(...)`
  - Returns undefined for non-existent root_task_id
  - Returns undefined for empty database
- **Performance tests**: 2 tests verifying 10K events snapshot assembly < 200ms for `[model]` and `[day]` axes
- **`applyEventToProjection` tests**: 2 tests verifying:
  - Correct session upsert using direct lookup
  - Works when session has many events (beyond querySessions(100) page size)

### 4. StreamCoordinator (skipped)
The optional snapshot memoization (Option C) was not needed because the rollup-backed read path is already fast enough (< 200ms for 10K events). The StreamCoordinator tests all pass without changes.

## Result
✅ Success — All 190 tests pass across 6 test suites:
- UsageStatsProjection: 41 tests
- UsageStatsDatabase (non-benchmark): 41 tests
- dashboardStatsPerformance: 16 tests (9 parity + 3 querySessionByRootTaskId + 2 performance + 2 applyEventToProjection)
- UsageStatsStreamCoordinator: 28 tests
- UsageStatsService: 50 tests
- UsageStatsMigration: 14 tests

## Issues Discovered
1. **Cost parity gap**: The original `appendInternal()` used `event.usage.costUsd?.value ?? 0` for rollup cost, but `computeEventDelta()` uses `getEffectiveCost(event)` which computes cost on-the-fly for events without `costUsd`. This meant rollup totals would differ from event-scan totals for events with missing cost. Fixed by using `getEffectiveCost(event)` in rollup writes.
2. **`querySessions(100).find(...)` limitation**: The old `applyEventToProjection()` would fail to find sessions beyond the first 100 results (ordered by `last_activity_ms DESC`). The new `querySessionByRootTaskId()` uses a direct primary-key lookup, fixing this latent bug.

## Next Step Recommendations
1. Run the full test suite (including 100K/1M benchmark tests) to verify no performance regressions in bulk append
2. Consider adding a database index on `stats_rollup(period_type, root_task_id, axis, period_key)` for faster breakdown queries
3. The StreamCoordinator snapshot memoization (Option C) can be added later if further optimization is needed

## Affected File List
- `src/services/stats/UsageStatsDatabase.ts` — breakdown rollup writes, new query methods, v3 migration
- `src/services/stats/UsageStatsProjection.ts` — assembleRollupSnapshot rewrite, applyEventToProjection fix
- `src/services/stats/__tests__/dashboardStatsPerformance.spec.ts` — new parity, querySessionByRootTaskId, and performance tests
