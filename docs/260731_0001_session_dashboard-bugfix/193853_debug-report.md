# Debug Task Report — Phase 5: Technical Review

## Task Summary

Verify the 3-part dashboard stats rollup rebuild fix implemented by Code mode on branch `feature/local-usage-stats`:

1. `rebuildRollupsFromEvents()` in `UsageStatsDatabase.ts`
2. Auto-detect + rebuild in `UsageStatsStreamCoordinator.ts`
3. "Rebuild Stats" button + message handler in Dashboard UI

---

## Code Review Findings

### 1. `rebuildRollupsFromEvents()` — [`UsageStatsDatabase.ts:864`](src/services/stats/UsageStatsDatabase.ts#L864)

**Verdict: Correct. No issues found.**

- **Transaction safety**: Wraps entire operation in `BEGIN` / `COMMIT` with `ROLLBACK` on error. Throws a properly coded `StatsDbError("STATS_DB/rebuild/001", ...)` on failure — compliant with the error code standard.
- **Batch processing**: Reads events in batches of 1,000 using cursor-based pagination (`seq > afterSeq ORDER BY seq ASC LIMIT 1000`). Memory-safe for large event stores.
- **Completeness**: Rebuilds all derived tables:
    - `stats_rollup`: daily/monthly/lifetime aggregates (axis='') + breakdown rollups (model/provider/mode) + non-cancelled-only rollups (`root_task_id='__nc__'`)
    - `session_metadata`: lifetime totals per `root_task_id` with upsert-on-conflict
    - `session_activity`: per-day per-`root_task_id` with upsert-on-conflict
- **Idempotency**: Deletes all derived data first, then rebuilds from source-of-truth `usage_events`. Running twice produces identical results (confirmed by test).
- **Cost consistency**: Uses `getEffectiveCost()` for cost calculation, matching the same function used by `computeEventDelta` in the normal append path.
- **Day bucketing**: Uses `computeLocalDayBucket()` with timezone offset — consistent with the v2 migration logic.
- **Does NOT touch**: `usage_events` (source of truth) and `stats_meta` (schema version, generation) — correct separation of concerns.

### 2. Auto-detect logic — [`UsageStatsStreamCoordinator.ts:474-506`](src/services/stats/UsageStatsStreamCoordinator.ts#L474)

**Verdict: Correct. No issues found.**

- **Detection heuristic**: Checks `stats.totals.events > 0` (raw events exist) AND `sessions.sessions.length === 0 && heatmap.values.every(v => v === 0)` (derived tables empty). This correctly identifies the "migration gap" scenario where events were inserted before rollup tables existed.
- **One-time guard**: `rollupsRebuilt` flag (line 134) ensures the check runs at most once per coordinator lifetime. Set to `true` in all three branches: rebuild success, rebuild failure, and no rebuild needed.
- **Post-rebuild refresh**: After successful rebuild, re-assembles `stats`, `sessions`, and `heatmap` from the database — the snapshot sent to the subscriber contains the rebuilt data.
- **Error handling**: Catches rebuild errors, logs to console, sets `rollupsRebuilt = true` to prevent retry loops, and continues to send the (possibly stale) snapshot. Graceful degradation.
- **Edge case note**: If `stats.totals.events === 0` (truly empty database), the auto-detect is skipped — correct behavior since there's nothing to rebuild.

### 3. "Rebuild Stats" button — [`DashboardView.tsx:495-504`](webview-ui/src/components/dashboard/DashboardView.tsx#L495)

**Verdict: Correct. No issues found.**

- **Button**: Ghost variant with `Database` icon, tooltip via `StandardTooltip`, disabled when `!hasData`. Consistent with existing Export and Clear buttons.
- **Message flow**: `handleRebuildStats` (line 406) posts `{ type: "rebuildUsageStats", requestId }` to the extension host.
- **Response handling**: Listens for `rebuildUsageStatsResponse` (line 350). On success, calls `replaceSubscription()` to re-sync the dashboard with fresh data. On failure, sets error state.
- **Request ID**: Uses timestamp + random suffix for uniqueness — matches the pattern used by export and clear operations.

---

## Test Results

### New Tests: `rebuildRollupsFromEvents` (7 tests)

| #   | Test                                                             | Result  |
| --- | ---------------------------------------------------------------- | ------- |
| 1   | should rebuild rollups from events after clearing derived tables | ✅ PASS |
| 2   | should be idempotent (running twice produces same result)        | ✅ PASS |
| 3   | should handle empty database gracefully (no events)              | ✅ PASS |
| 4   | should rebuild with correct local day buckets                    | ✅ PASS |
| 5   | should rebuild breakdown rollups (per model/provider/mode axis)  | ✅ PASS |
| 6   | should rebuild non-cancelled-only rollups                        | ✅ PASS |
| 7   | should rebuild session_activity with local day buckets           | ✅ PASS |

**Result: 7/7 PASSED** (1.87s)

### Regression Tests (3 suites)

| Suite                                 | Tests   | Result                     |
| ------------------------------------- | ------- | -------------------------- |
| `UsageStatsProjection.spec.ts`        | —       | ✅ PASS                    |
| `UsageStatsStreamCoordinator.spec.ts` | —       | ✅ PASS                    |
| `usageStatsMessageHandler.spec.ts`    | —       | ✅ PASS                    |
| **Total**                             | **125** | **125/125 PASSED** (3.40s) |

### Build Verification

| Check              | Result                |
| ------------------ | --------------------- |
| `npx tsc --noEmit` | ✅ PASS (zero errors) |

---

## Issues Discovered

None. The implementation is clean, well-tested, and follows project conventions.

---

## Test Environment Issues

None encountered. The `-t "rebuildRollupsFromEvents"` filter successfully skipped the pre-existing 1M event performance test, allowing the new tests to run in ~2 seconds.

---

## Recommendation

**PASS** — All three parts of the fix are correctly implemented, thoroughly tested, and cause no regressions. The code follows the project's error code standard, uses consistent cost/bucketing logic, and handles edge cases (empty DB, idempotency, concurrent batch processing) properly.

---

## Affected File List

| File                                                      | Change                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/services/stats/UsageStatsDatabase.ts`                | Added `rebuildRollupsFromEvents()` method (~400 lines)                                           |
| `src/services/stats/UsageStatsStreamCoordinator.ts`       | Added auto-detect + rebuild logic in `sendSnapshot()`, added `rollupsRebuilt` field              |
| `webview-ui/src/components/dashboard/DashboardView.tsx`   | Added "Rebuild Stats" button, `handleRebuildStats` callback, `rebuildUsageStatsResponse` handler |
| `src/services/stats/__tests__/UsageStatsDatabase.spec.ts` | Added 7 new tests for `rebuildRollupsFromEvents`                                                 |
