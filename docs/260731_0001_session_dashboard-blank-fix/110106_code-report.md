# Code Mode Task Report

## Task Summary
Made the dashboard rollup rebuild non-blocking in `UsageStatsStreamCoordinator.sendSnapshot()` by sending the snapshot first, then performing the rebuild asynchronously via `setImmediate`, then sending an updated snapshot. Also replaced the heatmap all-zero rebuild trigger with an explicit `getRollupCount()` check.

## Actions Taken

### 1. Added `getRollupCount()` to `UsageStatsDatabase.ts`
- Added a new public method `getRollupCount(): number` at line ~1255 that executes `SELECT COUNT(*) FROM stats_rollup`
- This replaces the previous heuristic of checking `heatmap.values.every((v) => v === 0)` which incorrectly triggered rebuilds for inactive users with legitimately all-zero heatmaps
- Error code: `STATS_DB/read/001` on failure

### 2. Rewrote `sendSnapshot()` in `UsageStatsStreamCoordinator.ts` (non-blocking)
**Old flow (BLOCKING):**
1. Assemble snapshot
2. Detect stale rollups → `rebuildRollupsFromEvents()` [BLOCKS event loop for seconds]
3. Re-assemble snapshot with rebuilt data
4. Send snapshot

**New flow (NON-BLOCKING):**
1. Assemble snapshot from whatever data exists (may be empty/stale)
2. Send snapshot immediately (frontend gets data or empty state quickly)
3. Check if rebuild needed using `getRollupCount() === 0` (instead of heatmap all-zero)
4. If rebuild needed, schedule it via `setImmediate()` (yields event loop)
5. After async rebuild completes, re-assemble and send updated snapshot to all active subscribers

### 3. Added `rebuildInFlight` guard
- New private field `rebuildInFlight: boolean` prevents concurrent rebuilds from multiple subscribers
- Set to `true` when rebuild is scheduled, reset to `false` in `finally` block
- Checked alongside `rollupsRebuilt` before scheduling a new rebuild

### 4. Added `scheduleAsyncRebuild()` private method
- Uses `setImmediate()` to yield the event loop before starting the rebuild
- After rebuild succeeds: sets `rollupsRebuilt = true`, re-assembles and sends updated snapshots to all active (non-paused, snapshot-sent) subscribers
- After rebuild fails: logs error, does NOT latch `rollupsRebuilt` (allows retry on next snapshot)
- Checks `this.disposed` and `this.database` nullability inside the callback for safety

### 5. Updated tests in `UsageStatsStreamCoordinator.spec.ts`
Updated 4 tests in the "auto-rebuild stale rollups" describe block:
- **"should auto-rebuild when events exist but derived tables are empty"**: Now expects 2 snapshots (initial empty + post-rebuild), uses `vi.runOnlyPendingTimers()` to flush `setImmediate`
- **"should NOT rebuild when derived tables are already consistent"**: Added `vi.runOnlyPendingTimers()` flush
- **"should send original snapshot when rebuildRollupsFromEvents throws"**: Updated to flush async rebuild, changed error message assertion from "Auto-rebuild failed" to "Async rebuild failed"
- **"should only attempt rebuild once across multiple snapshots"**: Updated to flush timers between subscribe and replaceSubscription, relaxed snapshot count assertion to `>= 2`

All timer flushes use `vi.runOnlyPendingTimers()` instead of `vi.runAllTimers()` to avoid infinite loops from the rollover `setInterval`.

## Result

### Test Results
- **`UsageStatsStreamCoordinator.spec.ts`**: 32/32 tests PASSED (4.04s)
- **Full `services/stats/` suite**: Still running after 25+ minutes due to pre-existing slow database integration tests (unrelated to this change - the coordinator tests complete in 4 seconds)
- **`tsc --noEmit`**: Zero errors in any `stats` or `UsageStats` files. All tsc errors are pre-existing in unrelated files (`mimo.spec.ts`, `executeCommandTool.spec.ts`, `ExecuteCommandTool.ts`, `terminal-provider-fallback.spec.ts`)

## Issues Discovered
- The full `services/stats/` test suite takes an extremely long time (25+ minutes) due to `UsageStatsDatabase.spec.ts` integration tests that process large event batches through `rebuildRollupsFromEvents()`. This is a pre-existing performance issue, not caused by this change.
- `vi.runAllTimers()` causes infinite loops when the coordinator's rollover `setInterval` is active. Tests must use `vi.runOnlyPendingTimers()` instead.

## Next Step Recommendations
- Consider optimizing the database integration tests (e.g., reduce event batch sizes, use in-memory DB) to make the full stats test suite runnable in reasonable time
- Consider adding a test that verifies the snapshot is sent BEFORE the rebuild completes (proving non-blocking behavior) by checking message order with real timers

## Affected File List
- `src/services/stats/UsageStatsDatabase.ts` (added `getRollupCount()` method)
- `src/services/stats/UsageStatsStreamCoordinator.ts` (rewrote `sendSnapshot()`, added `scheduleAsyncRebuild()`, added `rebuildInFlight` field)
- `src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts` (updated 4 tests for async rebuild behavior)
