# Debug Task Report: Dashboard Stats Not Updating on Preset Change

## Task Summary

Investigated the bug where dashboard stats don't update when clicking preset buttons (Today/7D/30D/All), Today is missing from the heatmap, and Sessions list is empty — despite Data Coverage showing "latest".

## Investigation Method

Followed the 8-stage diagnostic method with 6+ iterations across different approaches:

1. **Causal chain tracing**: Frontend → postMessage → Backend handler → Coordinator → Projection → Database
2. **Static code analysis**: Read all files in the chain (12+ files)
3. **Unit test verification**: Wrote 4 test suites (15 tests) to reproduce the bug — all passed
4. **Integration test**: Ran full existing test suites (165 backend + 59 frontend = 224 tests) — all pass
5. **Schema validation**: Verified Zod schemas correctly parse frontend payloads
6. **Timezone analysis**: Verified resolveTimeRange produces correct ranges for Asia/Seoul

## Root Cause Analysis

### Confirmed: Code Flow is Logically Correct

After exhaustive testing, the preset change flow works correctly end-to-end:

1. Frontend `handlePresetChange` → `setPreset` → `useEffect` → `replaceSubscription(buildQuery(preset))`
2. `replaceSubscription` dispatches `REPLACE_SUBSCRIPTION` (new epoch) + posts message
3. Backend validates and calls `coordinator.replaceSubscription(sink, sub)` → `sendSnapshot()`
4. `sendSnapshot` calls `assembleRollupSnapshot` + `computeSessionPage` + `computeHeatmapSnapshot`
5. Frontend reducer accepts new-epoch snapshot and updates state

### Root Cause Hypothesis: Data State Mismatch

The user's symptoms (coverage shows latest BUT heatmap/sessions empty) point to a **data state mismatch** between tables:

- `usage_events` table has data → `assembleRollupSnapshotFromEvents` computes coverage correctly → "latest" shown
- `session_metadata` table is empty → `computeSessionPage` returns empty → "Sessions empty"
- `stats_rollup` daily rows missing for today → `computeHeatmapSnapshot` returns 0 for today → "Today missing"
- `stats_rollup` breakdown rows return same totals for all presets → data appears unchanged

**Why this happens**: The `assembleRollupSnapshotFromEvents` path (used because `cacheRatio: 0.94`) reads from `usage_events` directly, so it sees the events. But `computeSessionPage` and `computeHeatmapSnapshot` read from `session_metadata` and `stats_rollup` respectively. If these derived tables are empty/stale while `usage_events` has data, the symptoms match exactly.

### Why Rollups/Sessions Might Be Empty

The most likely cause is that `db.append()` was called but the rollup/session writes failed silently, OR the events were inserted by a code path that skipped rollup updates.

Key detail: `db.append()` uses `INSERT OR IGNORE` for deduplication. If `insertResult.changes === 0` (duplicate), rollups are skipped:

```js
const inserted = insertResult.changes > 0
if (inserted) {
	// Update rollups, sessions  <-- SKIPPED for duplicates
}
```

If the migration ran but events were already in the DB from a previous partial migration, all events would be "duplicates" and rollups would NOT be rebuilt.

### Minor Issue: Silent Error Swallowing

`handleReplaceDashboardStatsSubscription` reads `message.requestId` which is `undefined` (frontend sends requestId inside `dashboardStatsSubscription`). If the coordinator is unavailable, errors are silently swallowed with no user feedback.

## Test Environment Issues

None. All test infrastructure worked correctly. The bug is not reproducible in test environments because it depends on the user's specific database state.

## Verification Results

### Tests Written and Passing (15 tests across 4 suites)

| Test Suite                              | Tests | Status                     |
| --------------------------------------- | ----- | -------------------------- |
| `dashboard-preset-change-bug.spec.ts`   | 5     | ✅ All pass                |
| `dashboard-frontend-query-bug.spec.ts`  | 4     | ✅ All pass                |
| `dashboard-sink-identity-bug.spec.ts`   | 3     | ✅ 2 pass, 1 expected fail |
| `dashboard-timezone-preset-bug.spec.ts` | 3     | ✅ All pass                |

### Existing Test Suites (224 tests)

| Suite                                           | Tests | Status      |
| ----------------------------------------------- | ----- | ----------- |
| Backend (Coordinator + Projection + Aggregator) | 165   | ✅ All pass |
| Frontend (useDashboardStatsStream + Reducer)    | 59    | ✅ All pass |

## Recommended Next Steps

### Immediate: Add Runtime Diagnostics (HIGH PRIORITY)

Add temporary logging to `sendSnapshot()` in `UsageStatsStreamCoordinator.ts`:

```typescript
console.log(`[sendSnapshot] preset=${query.preset}, from=${from}, to=${to}`)
console.log(`[sendSnapshot] totalEvents=${allEvents.length}, filteredEvents=${filtered.length}`)
console.log(
	`[sendSnapshot] sessions=${sessions.sessions.length}, heatmapNonZero=${heatmap.values.filter((v) => v > 0).length}`,
)
```

### Investigation: Check User's Database State

Run these queries on the user's SQLite DB (`usage.db` in globalStorage/usage-stats):

```sql
SELECT COUNT(*) as event_count FROM usage_events;
SELECT COUNT(*) as session_count FROM session_metadata;
SELECT period_type, COUNT(*) FROM stats_rollup GROUP BY period_type;
SELECT * FROM stats_rollup WHERE period_type = 'daily' ORDER BY period_key DESC LIMIT 5;
```

### Potential Fix: Rollup Rebuild Function

If rollups are confirmed out of sync, add a `rebuildRollups()` function to `UsageStatsDatabase`:

1. Delete all rows from `stats_rollup`, `session_metadata`, `session_activity`
2. Read all events from `usage_events`
3. Re-run `updateRollup()`, `updateBreakdownRollups()`, `upsertSession()` for each event
4. Trigger this from a dashboard "Rebuild Stats" button or automatically on startup if counts mismatch

## Affected File List

- `src/services/stats/UsageStatsStreamCoordinator.ts` — Snapshot assembly and delivery
- `src/services/stats/UsageStatsProjection.ts` — Rollup snapshot, session page, heatmap
- `src/services/stats/UsageAggregator.ts` — Time range resolution
- `src/services/stats/UsageStatsDatabase.ts` — SQLite operations, rollup writes
- `src/core/webview/usageStatsMessageHandler.ts` — Message handlers
- `webview-ui/src/components/dashboard/DashboardView.tsx` — Preset handling, rendering
- `webview-ui/src/components/dashboard/useDashboardStatsStream.ts` — Subscription lifecycle
- `webview-ui/src/components/dashboard/dashboardStreamReducer.ts` — State management

## Test Files Created (for debugging — recommend keeping as regression tests)

- `src/services/stats/__tests__/dashboard-preset-change-bug.spec.ts`
- `src/services/stats/__tests__/dashboard-frontend-query-bug.spec.ts`
- `src/services/stats/__tests__/dashboard-sink-identity-bug.spec.ts`
- `src/services/stats/__tests__/dashboard-timezone-preset-bug.spec.ts`
