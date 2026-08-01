# Code Task Report

## Task Summary
Fix inverted rollup rebuild guard in `UsageStatsStreamCoordinator.ts` `sendSnapshot()`. The guard checked `stats.totals.events > 0`, but that value is derived from `stats_rollup` itself. When rollups are empty but `usage_events` has raw data, `events` is 0 so the rebuild never fires.

## Actions Taken
1. **Read** `src/services/stats/UsageStatsStreamCoordinator.ts` lines 440-540 to locate the guard.
2. **Read** `src/services/stats/UsageStatsDatabase.ts` `queryCoverageStats()` to confirm it queries raw `usage_events` (not rollups).
3. **Read** `src/services/stats/UsageAggregator.ts` `resolveTimeRange()` to derive `fromEpochMs`/`toEpochMs` from `StatsQuery`.
4. **Fixed** `UsageStatsStreamCoordinator.ts`:
   - Replaced `stats.totals.events > 0` guard with `queryCoverageStats()` on raw `usage_events`.
   - Used `resolveTimeRange(query)` to compute the time range for coverage query.
   - Added `resolveTimeRange` import from `./UsageAggregator`.
   - Removed `this.rollupsRebuilt = true` from the `catch` block so transient failures don't permanently disable the rebuild guard.
5. **Discovered pre-existing bug**: `UsageStatsDatabase.ts` `createSchema()` had a `try { ... } catch` JS block embedded **inside** the SQL template literal (line 335-339), causing `Error: near "try": syntax error` and breaking ALL stats tests.
6. **Fixed** `UsageStatsDatabase.ts`: moved the `ALTER TABLE stats_rollup ADD COLUMN uncached_input_tokens` migration outside the SQL string into proper JS code after `db.exec()`.
7. **Ran tests**:
   - `UsageStatsStreamCoordinator.spec.ts`: 32/32 passed.
   - `UsageStatsProjection.spec.ts`: 41/41 passed.
   - Remaining stats tests: 176/177 passed (1 failure in `dashboard-sink-identity-bug.spec.ts` is pre-existing and unrelated — confirmed by stashing changes and re-running).

## Result
✅ Success. The rebuild guard now correctly detects raw events via `queryCoverageStats()` and triggers `rebuildRollupsFromEvents()` when rollups are empty but raw data exists. The guard no longer latches on failure.

## Issues Discovered
1. **Pre-existing SQL syntax error** in `UsageStatsDatabase.ts` `createSchema()` — a JS `try/catch` block was embedded inside the SQL template literal. This broke all stats tests. Fixed as part of this task.
2. **Pre-existing test failure** in `dashboard-sink-identity-bug.spec.ts` — documents a known sink-identity bug (expects `_subscriptionCount()` to be 1 but it's 2). This failure exists on the base branch and is unrelated to this fix.
3. **Branch mismatch**: User requested `feature/local-usage-stats` but current branch is `feature/vsix-build-fixed`. VP must handle branch switching.

## Next Step Recommendations
- VP should switch to `feature/local-usage-stats` branch before committing.
- Consider fixing the pre-existing `dashboard-sink-identity-bug.spec.ts` failure in a separate task.
- The `UsageStatsDatabase.ts` schema fix should be reviewed to ensure the `ALTER TABLE` migration is idempotent and safe for existing databases.

## Affected File List
- `src/services/stats/UsageStatsStreamCoordinator.ts`
- `src/services/stats/UsageStatsDatabase.ts`
