# Code Mode Task Report

## Task Summary

ST-2: Fixed local timezone day bucket calculation in UsageStatsDatabase and added v1→v2 schema migration to recompute existing rows.

## Actions Taken

### 1. Added `computeLocalDayBucket()` helper function

- **File**: `src/services/stats/UsageStatsDatabase.ts` (exported, line ~111)
- Computes YYYY-MM-DD from `epochMs + timezoneOffsetMinutes * 60_000`
- Uses UTC getters on the shifted Date to extract year/month/day
- Handles midnight boundaries, year boundaries, and negative offsets correctly

### 2. Fixed `appendInternal()` day bucket calculation (line ~364)

- **Before**: `const dayBucket = event.occurredAt.slice(0, 10)` (UTC calendar date)
- **After**: `const dayBucket = computeLocalDayBucket(occurredEpochMs, event.timezoneOffsetMinutes)`
- `monthBucket` now derived from `dayBucket.slice(0, 7)` instead of `occurredAt.slice(0, 7)`

### 3. Fixed `bulkAppend()` day bucket calculation (line ~556)

- Same fix applied: `computeLocalDayBucket()` instead of `occurredAt.slice(0, 10)`

### 4. Added v1→v2 schema migration (`migrateToV2()`)

- Bumped `SCHEMA_VERSION` from 1 to 2
- `runMigrations()` now checks `meta.schemaVersion < 2` and calls `migrateToV2()`
- Migration logic (all in a single transaction):
    1. Deletes existing daily/monthly rollups (`period_type IN ('daily', 'monthly') AND root_task_id = '' AND axis = ''`)
    2. Deletes all `session_activity` rows
    3. Reads all `usage_events` in batches of 1000
    4. For each event: recomputes day/month bucket using `computeLocalDayBucket(epochMs, tzOffset)`
    5. Rebuilds daily rollup, monthly rollup, and session_activity
    6. Updates `schemaVersion` to 2 in meta
- `session_metadata` (lifetime totals) is NOT touched — lifetime totals are timezone-independent
- Idempotent: running twice produces identical results (delete + rebuild)

### 5. Added 13 new tests

- **`computeLocalDayBucket` (5 tests)**: UTC+9 Seoul, UTC+0, UTC-5, midnight boundary, year boundary
- **`local timezone day bucketing` (3 tests)**: append buckets by local day, bulkAppend buckets by local day, session_activity uses local day
- **`v2 migration` (5 tests)**: migrates UTC buckets to local, rebuilds session_activity, idempotent, preserves lifetime totals, handles empty DB

## Result

✅ All 38 non-benchmark tests pass (5 computeLocalDayBucket + 3 local timezone + 5 migration + 25 existing)
✅ No TypeScript errors
✅ No regressions in existing test suite

## Issues Discovered

None. The implementation matches the architect's specification exactly.

## Next Step Recommendations

- The background terminal running the full test suite (including 1K/100K/1M benchmarks) is still running. Those benchmarks are unaffected by this change since they use `new Date()` (local time) for `occurredAt` with `timezoneOffsetMinutes: 540`, and the local day bucket computation is consistent.
- VP should proceed with Phase 4 Batch 2 (next batch in the dashboard crash debug session).

## Affected File List

- `src/services/stats/UsageStatsDatabase.ts` — added `computeLocalDayBucket()`, fixed `appendInternal()` + `bulkAppend()`, added `migrateToV2()` + updated `runMigrations()`, bumped `SCHEMA_VERSION` to 2
- `src/services/stats/__tests__/UsageStatsDatabase.spec.ts` — added 13 new tests across 3 describe blocks
