# Full Audit Report: Dashboard Stats Rollup Rebuild Fix

## Mode: Ask (CPO)

## Date: 260731

## Session: docs/260731_0001_session_dashboard-bugfix/

---

## [1. Philosophy & UX/UI Diagnostics]

### User Intent Alignment

The user reported 3 specific bugs:

1. Preset buttons (Today/7Days/30Days/Custom/All) show no change when clicked
2. Daily Activity heatmap missing Today's data
3. Sessions list empty despite data coverage showing "latest"

The root cause was identified as a data state mismatch: `usage_events` had data but derived tables (`stats_rollup`, `session_metadata`, `session_activity`) were empty/stale. This is a sound diagnosis - the heatmap depends on `stats_rollup`/`session_activity`, and sessions depend on `session_metadata`.

The fix addresses all 3 bugs by:

- Rebuilding all derived tables from raw events ([`rebuildRollupsFromEvents()`](src/services/stats/UsageStatsDatabase.ts:864))
- Auto-detecting staleness on snapshot delivery ([`sendSnapshot()`](src/services/stats/UsageStatsStreamCoordinator.ts:446))
- Providing manual recovery via "Rebuild Stats" button ([`DashboardView.tsx`](webview-ui/src/components/dashboard/DashboardView.tsx:496))

### UX Considerations

- The auto-rebuild is transparent to the user (no UI disruption)
- The manual "Rebuild Stats" button provides a recovery path if auto-detect fails
- After rebuild, `replaceSubscription()` is called to resync the stream, ensuring fresh data flows to the UI

---

## [2. Requirement Checklist Verification]

### [REQ-001] Today/7Days/30Days/Custom/All preset buttons must correctly filter and display data when clicked

**Status**: ✅ VERIFIED

Evidence:

- Preset buttons render at [`DashboardView.tsx:522-531`](webview-ui/src/components/dashboard/DashboardView.tsx:522) with `handlePresetChange` handler
- `handlePresetChange` at [line 254](webview-ui/src/components/dashboard/DashboardView.tsx:254) sets preset state, triggering `useEffect` at [line 178](webview-ui/src/components/dashboard/DashboardView.tsx:178) which calls `replaceSubscription()`
- `buildQuery` at [line 109](webview-ui/src/components/dashboard/DashboardView.tsx:109) correctly maps presets to query parameters
- Root cause (empty `stats_rollup`) is fixed by `rebuildRollupsFromEvents()` which populates daily/monthly/lifetime rollups
- Existing tests verify preset button rendering and fetch triggering (7d, 30d, all presets tested)

### [REQ-002] Daily Activity heatmap must show today's data

**Status**: ✅ VERIFIED

Evidence:

- `rebuildRollupsFromEvents()` at [`UsageStatsDatabase.ts:864-1248`](src/services/stats/UsageStatsDatabase.ts:864) rebuilds `stats_rollup` (daily/monthly/lifetime) and `session_activity` tables
- Auto-detect in `sendSnapshot()` at [`UsageStatsStreamCoordinator.ts:477-506`](src/services/stats/UsageStatsStreamCoordinator.ts:477) checks `heatmap.values.every((v) => v === 0)` and triggers rebuild
- After rebuild, `heatmap = computeHeatmapSnapshot(...)` is re-called at [line 494](src/services/stats/UsageStatsStreamCoordinator.ts:494)
- Tests: "should rebuild with correct local day buckets" and "should rebuild session_activity with local day buckets" verify timezone-correct day bucketing

### [REQ-003] Sessions list must display session entries

**Status**: ✅ VERIFIED

Evidence:

- `rebuildRollupsFromEvents()` rebuilds `session_metadata` table (prepared statement at [line 892](src/services/stats/UsageStatsDatabase.ts:892), execution at [line 1213](src/services/stats/UsageStatsDatabase.ts:1213))
- Auto-detect checks `sessions.sessions.length === 0` at [line 479](src/services/stats/UsageStatsStreamCoordinator.ts:479)
- After rebuild, `sessions = computeSessionPage(...)` is re-called at [line 488](src/services/stats/UsageStatsStreamCoordinator.ts:488)
- Backend handler at [`usageStatsMessageHandler.ts:239-304`](src/core/webview/usageStatsMessageHandler.ts:239) correctly calls `database.rebuildRollupsFromEvents()` and posts response

### [REQ-004] All fixes must pass build verification

**Status**: ✅ VERIFIED (per Phase 5 report)

- TypeScript build: 0 errors
- ESLint: 0 errors
- (Ask mode cannot independently execute builds; relying on VP's Phase 5 verification)

### [REQ-005] Existing tests must continue to pass

**Status**: ✅ VERIFIED (per Phase 5 report)

- 132/132 tests pass (7 new + 125 regression)
- 7 new tests cover `rebuildRollupsFromEvents()` in `UsageStatsDatabase.spec.ts` (lines 903-1230):
    - Rebuild after clearing derived tables
    - Idempotency (double rebuild produces same result)
    - Empty events (no throw)
    - Local day bucket timezone correctness
    - Breakdown rollups (per model/provider/mode axis)
    - Non-cancelled-only rollups
    - Session activity with local day buckets

---

## [3. 1:1 Cross-Validation Results]

### Implementation vs. Plan Alignment

| Planned Component                          | Implemented | Location                                                                                          |
| ------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------- |
| `rebuildRollupsFromEvents()` public method | ✅          | [`UsageStatsDatabase.ts:864`](src/services/stats/UsageStatsDatabase.ts:864)                       |
| Auto-detect in `sendSnapshot()`            | ✅          | [`UsageStatsStreamCoordinator.ts:474-506`](src/services/stats/UsageStatsStreamCoordinator.ts:474) |
| "Rebuild Stats" button in DashboardView    | ✅          | [`DashboardView.tsx:496-505`](webview-ui/src/components/dashboard/DashboardView.tsx:496)          |
| Backend message handler                    | ✅          | [`usageStatsMessageHandler.ts:239-304`](src/core/webview/usageStatsMessageHandler.ts:239)         |
| `rebuildUsageStatsResponse` handler in UI  | ✅          | [`DashboardView.tsx:350-361`](webview-ui/src/components/dashboard/DashboardView.tsx:350)          |

### Devil's Advocate Findings

**🟡 Should Fix — Missing test coverage for auto-rebuild logic in StreamCoordinator**
The auto-detect logic in `sendSnapshot()` (lines 474-506) is a critical new feature with no dedicated tests in `UsageStatsStreamCoordinator.spec.ts`. The 7 new tests only cover `rebuildRollupsFromEvents()` at the database level. There are no tests verifying:

- Auto-rebuild triggers when sessions empty + heatmap all zeros
- Auto-rebuild does NOT trigger when data is present
- `rollupsRebuilt` flag prevents repeated rebuilds
- Re-assembled snapshot after rebuild contains correct data
- Error path when `rebuildRollupsFromEvents()` throws

**🟡 Should Fix — Missing test coverage for Rebuild Stats button in DashboardView**
No tests found in `DashboardView.spec.tsx` for:

- `handleRebuildStats` button click posts `rebuildUsageStats` message
- `rebuildUsageStatsResponse` success triggers `replaceSubscription`
- `rebuildUsageStatsResponse` failure sets error state

**🟢 Nice to Have — Auto-rebuild is one-time only**
The `rollupsRebuilt` flag (line 133, 485, 501, 504) ensures rebuild runs at most once per coordinator instance. If derived tables become stale again later (e.g., concurrent window writes events without updating rollups), auto-rebuild won't re-trigger. The manual "Rebuild Stats" button covers this case, so this is acceptable.

**🟢 Nice to Have — Error surfacing for auto-rebuild failures**
If `rebuildRollupsFromEvents()` throws during auto-detect (line 499-502), the error is logged to console but not surfaced to the user in the UI. The user would see empty data with no explanation. The manual button has proper error handling (line 358-360), but auto-rebuild failures are silent. Consider adding a background error banner for auto-rebuild failures.

**🟢 Nice to Have — `bulkAppend` indentation inconsistency**
At [`UsageStatsDatabase.ts:1621-1665`](src/services/stats/UsageStatsDatabase.ts:1621), the `bulkAppend` method has inconsistent indentation (extra tab on lines 1622-1664). This is a pre-existing issue not introduced by this fix, but worth noting for code quality.

---

## [4. Inquiries for VP & User]

No critical trade-off decisions required. The implementation is straightforward and well-aligned with user intent.

**Optional consideration for VP**: The missing test coverage for auto-rebuild logic (StreamCoordinator) and Rebuild Stats button (DashboardView) could be addressed in a follow-up. These are not blocking issues since:

- The database-level `rebuildRollupsFromEvents()` has thorough test coverage (7 tests)
- The auto-rebuild logic is simple (if/else with try/catch)
- The button wiring follows existing patterns (same as clear/export buttons)

---

## [5. Final Verdict]

### **CONDITIONAL APPROVAL** 🔶

The implementation faithfully addresses all 3 user-reported bugs and satisfies REQ-001 through REQ-005. The root cause diagnosis is correct, the fix is well-designed (idempotent, transactional, with auto-detect + manual recovery), and the database-level rebuild has thorough test coverage.

**Conditions (non-blocking, can be addressed post-merge):**

1. Add tests for auto-rebuild logic in `UsageStatsStreamCoordinator.spec.ts` — verify trigger conditions, flag behavior, re-assembly, and error path
2. Add tests for "Rebuild Stats" button in `DashboardView.spec.tsx` — verify click handler, success response, and error response

**Rationale for CONDITIONAL rather than PASS**: The auto-rebuild in `sendSnapshot()` is the primary user-facing fix mechanism (it's what makes the dashboard "just work" again without manual intervention), yet it has zero test coverage. While the logic is simple, a regression in this code path would reintroduce all 3 bugs silently. VP may proceed to Phase 7 Final Review, but the test gap should be tracked as a follow-up task.
