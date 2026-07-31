# Re-Audit Report: Dashboard Stats Rollup Rebuild Fix (Phase 6 Final)

## Mode: Ask (CPO)

## Date: 260731

## Session: docs/260731_0001_session_dashboard-bugfix/

---

## [1. Requirement Checklist Verification]

### [REQ-001] Today/7Days/30Days/Custom/All preset buttons must correctly filter and display data when clicked

**Status**: ✅ IMPLEMENTED

Evidence verified at source:

- Preset buttons render at [`DashboardView.tsx:522-531`](webview-ui/src/components/dashboard/DashboardView.tsx:522) with all 5 presets (`today`, `7d`, `30d`, `custom`, `all`) mapped to `handlePresetChange`
- Root cause (empty `stats_rollup` table) is fixed by `rebuildRollupsFromEvents()` which repopulates daily/monthly/lifetime rollups from raw `usage_events`
- Auto-detect in [`sendSnapshot()`](src/services/stats/UsageStatsStreamCoordinator.ts:474) triggers rebuild when `stats.totals.events > 0` but derived tables are empty, ensuring preset queries return data

### [REQ-002] Daily Activity heatmap must show today's data

**Status**: ✅ IMPLEMENTED

Evidence verified at source:

- `rebuildRollupsFromEvents()` rebuilds `stats_rollup` and `session_activity` tables from raw events
- Auto-detect at [`UsageStatsStreamCoordinator.ts:477-480`](src/services/stats/UsageStatsStreamCoordinator.ts:477) checks `heatmap.values.every((v) => v === 0)` and triggers rebuild
- After rebuild, `heatmap = computeHeatmapSnapshot(...)` is re-called at [line 494](src/services/stats/UsageStatsStreamCoordinator.ts:494) to deliver fresh heatmap data
- Test "should auto-rebuild when events exist but derived tables are empty" asserts `snapshot!.heatmap.values.some((v) => v > 0)` is true after rebuild

### [REQ-003] Sessions list must display session entries

**Status**: ✅ IMPLEMENTED

Evidence verified at source:

- `rebuildRollupsFromEvents()` rebuilds `session_metadata` table from raw events
- Auto-detect at [`UsageStatsStreamCoordinator.ts:479`](src/services/stats/UsageStatsStreamCoordinator.ts:479) checks `sessions.sessions.length === 0` and triggers rebuild
- After rebuild, `sessions = computeSessionPage(...)` is re-called at [line 488](src/services/stats/UsageStatsStreamCoordinator.ts:488)
- Test "should auto-rebuild when events exist but derived tables are empty" asserts `snapshot!.sessions.sessions.length` is greater than 0 after rebuild

### [REQ-004] All fixes must pass build verification

**Status**: ✅ VERIFIED (per VP Phase 5 report)

- TypeScript build: 0 errors
- ESLint: 0 errors

### [REQ-005] Existing tests must continue to pass

**Status**: ✅ VERIFIED (per VP Phase 5 report + Code report)

- 140/140 tests pass (132 original + 8 new)
- UsageStatsStreamCoordinator.spec.ts: 32/32 pass (28 existing + 4 new)
- DashboardView.spec.tsx: 28/28 pass (24 existing + 4 new)

---

## [2. Condition Resolution Status]

### Condition 1: Add tests for auto-rebuild logic in UsageStatsStreamCoordinator.spec.ts

**Status**: ✅ RESOLVED

Verified 4 tests in `describe("auto-rebuild stale rollups")` block at [`UsageStatsStreamCoordinator.spec.ts:681-814`](src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts:681):

| #   | Test Name                                                                     | What It Verifies                                                                | Result |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------ |
| 1   | "should auto-rebuild when events exist but derived tables are empty"          | Rebuild triggered, snapshot has sessions + heatmap data                         | ✅     |
| 2   | "should NOT rebuild when derived tables are already consistent"               | Rebuild NOT called when data is present                                         | ✅     |
| 3   | "should send original snapshot when rebuildRollupsFromEvents throws"          | No crash, error logged, original snapshot sent, no error message emitted        | ✅     |
| 4   | "should only attempt rebuild once across multiple snapshots (one-time check)" | `rollupsRebuilt` flag prevents repeated rebuilds across `replaceSubscription()` | ✅     |

### Condition 2: Add tests for "Rebuild Stats" button in DashboardView.spec.tsx

**Status**: ✅ RESOLVED

Verified 4 tests in `describe("handleRebuildStats")` block at [`DashboardView.spec.tsx:715-810`](webview-ui/src/components/dashboard/__tests__/DashboardView.spec.tsx:715):

| #   | Test Name                                                           | What It Verifies                                                                                      | Result |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| 1   | "sends rebuildUsageStats message on rebuild button click"           | `postMessage` called with `type: "rebuildUsageStats"` and requestId containing `"dashboard-rebuild-"` | ✅     |
| 2   | "disables rebuild button when no data"                              | Button `disabled` is true when `events: 0`                                                            | ✅     |
| 3   | "triggers replaceSubscription on rebuildUsageStatsResponse success" | `replaceSubscriptionMock` called once on `success: true` response                                     | ✅     |
| 4   | "sets error on rebuildUsageStatsResponse failure"                   | `dashboard-error-banner` element appears on `success: false` response                                 | ✅     |

---

## [3. 1:1 Cross-Validation: Previous Audit Findings vs. Current State]

| Previous Audit Finding                                           | Severity        | Current Status                                                                  |
| ---------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------- |
| Missing test coverage for auto-rebuild trigger conditions        | 🟡 Should Fix   | ✅ Resolved (Test 1 + Test 2)                                                   |
| Missing test for auto-rebuild does NOT trigger when data present | 🟡 Should Fix   | ✅ Resolved (Test 2)                                                            |
| Missing test for `rollupsRebuilt` flag behavior                  | 🟡 Should Fix   | ✅ Resolved (Test 4)                                                            |
| Missing test for re-assembled snapshot after rebuild             | 🟡 Should Fix   | ✅ Resolved (Test 1 asserts sessions.length > 0 and heatmap.values.some(v > 0)) |
| Missing test for error path when rebuild throws                  | 🟡 Should Fix   | ✅ Resolved (Test 3)                                                            |
| Missing test for Rebuild Stats button click handler              | 🟡 Should Fix   | ✅ Resolved (DashboardView Test 1)                                              |
| Missing test for rebuild response success → replaceSubscription  | 🟡 Should Fix   | ✅ Resolved (DashboardView Test 3)                                              |
| Missing test for rebuild response failure → error state          | 🟡 Should Fix   | ✅ Resolved (DashboardView Test 4)                                              |
| Auto-rebuild is one-time only                                    | 🟢 Nice to Have | Acceptable — manual button covers re-staleness                                  |
| Auto-rebuild failures are silent (console.error only)            | 🟢 Nice to Have | Acceptable — manual button has proper error UI                                  |
| `bulkAppend` indentation inconsistency                           | 🟢 Nice to Have | Pre-existing, not introduced by this fix                                        |

---

## [4. Devil's Advocate — Final Critical Review]

**No blocking issues found.** All previously identified gaps are closed. The test coverage now directly exercises:

- The exact trigger condition (`stats.totals.events > 0 && sessions.sessions.length === 0 && heatmap.values.every(v => v === 0)`)
- The negative case (no rebuild when data is consistent)
- The error path (rebuild throws → graceful degradation)
- The one-time guard (`rollupsRebuilt` flag)
- The full UI flow (button click → message → response → replaceSubscription/error banner)

The implementation in [`sendSnapshot()`](src/services/stats/UsageStatsStreamCoordinator.ts:446) is sound: it re-assigns `stats`, `sessions`, and `heatmap` using `let` declarations (lines 457, 460, 468), allowing the rebuild block to overwrite them with fresh data before the snapshot is assembled at line 512.

---

## [5. Final Verdict]

### **PASS** ✅

All 5 requirements (REQ-001 through REQ-005) are fully implemented and verified. Both conditions from the previous CONDITIONAL APPROVAL are resolved with 8 new tests (4 in StreamCoordinator, 4 in DashboardView), all passing. The fix addresses all 3 user-reported bugs at the root cause level (stale derived tables) with both automatic detection and manual recovery. VP may proceed to Phase 7 Final Review.
