# Code Mode Task Report

## Task Summary

Added missing test coverage for dashboard stats auto-rebuild logic in two areas:

1. Auto-rebuild logic in `UsageStatsStreamCoordinator.sendSnapshot()` (4 tests)
2. "Rebuild Stats" button handler in `DashboardView` (4 tests)

## Actions Taken

### Part 1: Auto-rebuild tests in UsageStatsStreamCoordinator.spec.ts

Added a new `describe("auto-rebuild stale rollups")` block with 4 test cases:

1. **Auto-rebuild triggered**: Appends an event, clears derived tables (stats_rollup, session_metadata, session_activity) to simulate stale state, subscribes, and verifies `rebuildRollupsFromEvents()` was called once. Asserts the snapshot contains rebuilt sessions and heatmap data.

2. **No rebuild when data is consistent**: Appends an event normally (derived tables are populated), subscribes, and verifies `rebuildRollupsFromEvents()` was NOT called. Asserts snapshot still has session data.

3. **Error handling**: Appends an event, clears derived tables, mocks `rebuildRollupsFromEvents()` to throw, subscribes, and verifies no crash occurs. Asserts the error was logged via `console.error`, the original snapshot is still sent, and no `dashboardStatsStreamError` message is emitted.

4. **One-time check**: Appends an event, clears derived tables, subscribes (triggers rebuild), then calls `replaceSubscription()` (triggers `sendSnapshot()` again). Verifies `rebuildRollupsFromEvents()` was called only once due to the `rollupsRebuilt` flag.

### Part 2: Rebuild Stats button tests in DashboardView.spec.tsx

The webview test infrastructure already existed (`webview-ui/src/components/dashboard/__tests__/DashboardView.spec.tsx`). Added a new `describe("handleRebuildStats")` block with 4 test cases:

1. **Sends rebuildUsageStats message**: Renders DashboardView with connected state, clicks the rebuild button (`data-testid="dashboard-rebuild-button"`), and verifies `vscode.postMessage` was called with `type: "rebuildUsageStats"` and a requestId containing `"dashboard-rebuild-"`.

2. **Disables rebuild button when no data**: Sets stream state with `events: 0`, and verifies the rebuild button is disabled.

3. **Triggers replaceSubscription on success**: Dispatches a `rebuildUsageStatsResponse` message with `success: true`, and verifies `replaceSubscriptionMock` was called once.

4. **Sets error on failure**: Dispatches a `rebuildUsageStatsResponse` message with `success: false` and an error string, and verifies the `dashboard-error-banner` element appears (the component uses `setError()` which renders as `dashboard-error-banner` when `hasData` is true).

## Result

✅ Success

### Test Results

- **UsageStatsStreamCoordinator.spec.ts**: 32/32 passed (28 existing + 4 new)
- **DashboardView.spec.tsx**: 28/28 passed (24 existing + 4 new)

### ESLint Results

- `src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts`: 0 errors, 0 warnings
- `webview-ui/src/components/dashboard/__tests__/DashboardView.spec.tsx`: 0 errors, 0 warnings

## Issues Discovered

- The initial test for rebuild failure response used `dashboard-background-error` testid, but the component's `setError()` renders as `dashboard-error-banner` when `hasData` is true (the `dashboard-background-error` testid is for `backgroundError` from stream state, not the local `error` state). Fixed by updating the assertion to use the correct testid.

## Next Step Recommendations

- The Ask audit's CONDITIONAL APPROVAL condition (zero test coverage for auto-rebuild and rebuild button) is now resolved. VP can proceed to final review.

## Affected File List

- `src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts` — Added 4 auto-rebuild tests
- `webview-ui/src/components/dashboard/__tests__/DashboardView.spec.tsx` — Added 4 rebuild button tests
