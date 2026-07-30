# Code Task Report

## Task Summary

Implemented the demand-driven host stream coordinator (Sub-task 4) for the dashboard streaming architecture. This includes the `UsageStatsStreamCoordinator` class with subscription management, bounded drain, coalescing, sequence advancement, rollover, reset, and disposal, plus integration wiring into `UsageStatsService`, `UsageRecorder`, and `Task.ts`.

## Actions Taken

### A. New File: `src/services/stats/UsageStatsStreamCoordinator.ts`

- Defined narrow `StatsStreamSink` interface (`postMessage` + `isVisible`) so coordinator tests do not construct `ClineProvider`
- Implemented full coordinator API:
    - `subscribe(sink, subscription)` — sends initial snapshot, registers for deltas
    - `replaceSubscription(sink, newSubscription)` — new epoch, replaces snapshot
    - `pause(sink)` — stops delta delivery, retains cursor
    - `resume(sink, lastSequence)` — sends deltas since lastSequence or full snapshot if gap > 100 events or generation changed
    - `unsubscribe(sink)` — releases subscription
    - `dispose()` — releases all subscriptions and timers
    - `notifyEventAppended(event)` — schedules coalesced indexed drain (never carries uncommitted data)
    - `notifyExternalChange()` — schedules drain for cross-window changes
    - `resetGeneration()` — clears generation, sends reset snapshot to all subscribers
- Internal behavior:
    - Coalescing: 50 ms batch window, 100 ms max before forced flush
    - Bounded drain: max 100 events / 64 KiB per batch
    - Delta computation via `applyEventToProjection()` from `UsageStatsProjection`
    - Rollover: 30-second interval checks for midnight/DST boundary, sends fresh snapshots
    - Gap detection: subscriber's lastSequence gap > 100 → full snapshot replacement
    - Visibility filtering: deltas skipped when sink not visible; snapshots/errors always delivered
    - Message failure handling: rejected `postMessage` on delta marks subscriber for snapshot fallback

### B. New File: `src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts`

28 unit tests covering all spec-required scenarios:

- No-subscriber idle behavior (2 tests)
- Subscribe initial snapshot (2 tests, including null DB error)
- Local notification coalescing (1 test)
- External notification coalescing (1 test)
- Query filtering (1 test — events outside time range produce zero deltas)
- Max batch/size limits (1 test — bounded to 100 events per drain)
- Duplicate notifications (1 test — no re-send for already-seen sequences)
- Pause and resume (2 tests — stop delivery, resume from last sequence)
- Hidden resume after long period (1 test — gap > 100 → snapshot)
- Gap fallback to snapshot (1 test — generation change → snapshot)
- Rollover at midnight (1 test — day boundary check)
- Clear generation (1 test — reset snapshot to all subscribers)
- Message failure / rejected postMessage (2 tests — no crash, snapshot fallback)
- Disposal cleanup (3 tests — clear subscriptions, no drains after dispose, no new subscriptions)
- Replace subscription (1 test)
- Unsubscribe (2 tests)
- Visibility filtering (2 tests — deltas skipped when hidden, snapshots always delivered)
- Multiple subscribers (2 tests — all active receive deltas, paused excluded)
- Force drain (1 test)

### C. Modified: `src/services/stats/UsageRecorder.ts`

- Added `rootTaskId?: string` to `UsageRecordingContext` interface
- Added `rootTaskId: ctx.rootTaskId` to the event object in `finalizeUsageEvent()`

### D. Modified: `src/core/task/Task.ts`

- Added `rootTaskId: this.rootTaskId` to both `UsageRecordingContext` objects (completed path at line ~3380 and failed/cancelled path at line ~3527)

### E. Modified: `src/services/stats/UsageStatsService.ts`

- Added import of `UsageStatsStreamCoordinator`
- Added `coordinator` field
- Created coordinator on `initialize()` after database initialization
- Added `getCoordinator()` getter
- Wired `coordinator.notifyEventAppended(event)` into `append()` method
- Wired `coordinator.notifyExternalChange()` into file watcher's debounced callback
- Added `coordinator.dispose()` to `dispose()` method

### F. Modified: `src/services/stats/index.ts`

- Added exports for `UsageStatsStreamCoordinator`, `StatsStreamSink`, `StatsStreamErrorCode`

## Result

✅ Success — all tests pass and no new type errors.

### Test Results

- `UsageStatsStreamCoordinator.spec.ts`: 28/28 passed
- `UsageStatsService.spec.ts`: 50/50 passed
- `Task.usage-stats.spec.ts`: 16/16 passed (regression check)
- `tsc --noEmit`: No errors from any modified/created files (pre-existing `mimo.spec.ts` errors are unrelated)

## Issues Discovered

None. The implementation was clean with no architectural conflicts.

## Next Step Recommendations

- Sub-task 5: Wire the VS Code message boundary (`usageStatsMessageHandler.ts`, `webviewMessageHandler.ts`, `ClineProvider.ts`) to route subscribe/replace/pause/resume/unsubscribe messages to the coordinator
- Sub-task 6: Implement the webview reducer and subscription lifecycle

## Affected File List

- `src/services/stats/UsageStatsStreamCoordinator.ts` (new)
- `src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts` (new)
- `src/services/stats/UsageRecorder.ts` (modified — added rootTaskId)
- `src/services/stats/UsageStatsService.ts` (modified — wired coordinator)
- `src/services/stats/index.ts` (modified — added exports)
- `src/core/task/Task.ts` (modified — pass rootTaskId to recording contexts)
