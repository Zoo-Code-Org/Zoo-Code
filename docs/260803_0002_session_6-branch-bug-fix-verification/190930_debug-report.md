# Debug Task Report: 17-PR Bug Fix Presence Verification

## Task Summary
Verified whether the 10 cherry-picked bug fixes are reflected in the 6 target PRs on `myk1yt/Zoo-Code`, and confirmed the remaining 11 PRs are unaffected.

## Method
- `get_pull_request_files` for PRs #24, #26, #28, #31, #33, #36 (patch-level diff inspection).
- `get_file_contents` on PR head branches where the diff context was insufficient to prove presence/absence (PR #31 `ExtensionStateContext.tsx`, PR #33 `UsageStatsService.ts`, PR #36 `UsageStatsDatabase.ts` + `DashboardView.tsx`).
- Spot-checked the other PRs via PR bodies + file lists (#22, #23, #25, #29 full evidence; remainder scoped by stacked-PR file declarations).

## PR Verification Results

| PR | Bug(s) | Fix Present? | Evidence |
|----|--------|-------------|----------|
| #24 | #5, #6 | ✅ | [`TaskOrganizationStore.ts`](src/core/task-persistence/TaskOrganizationStore.ts): `revisionAtCallTime` captured as first statement inside `withLock()` callback (bug #5); `resolveUnit()` "task" case resolves ANY known task via `resolveTaskClosure()` — comment: "Resolve any known task through its closure. This covers both children and roots that have children" (bug #6). Regression tests included: "resolves a root drag with children to its full group" and "captures each concurrent mutation's revision after it acquires the lock" (expects revisions [1,2,3,4,5]). |
| #26 | #1-1, #1-2, #1-3 | ✅ | [`base-provider.ts`](src/api/providers/base-provider.ts): `convertToolsForOpenAI(tools, strictMode = false)` 2nd param; zero-arg schema normalization `if (result.properties === undefined) { result.properties = {}; result.required = [] }`. 9 provider call sites pass `this.options.openAiToolStrictMode ?? false` (deepseek, friendli, kenari, lite-llm, lm-studio, openai-compatible, opencode-go, openrouter, openai). [`openai.ts`](src/api/providers/openai.ts): O3 paths use `...(reasoning && reasoning)` from `getModel()` instead of `modelInfo.reasoningEffort` (user override wins; tests assert `reasoning_effort: "high"`). `parallel_tool_calls` only sent when tools present. |
| #28 | #10 | ✅ | [`ToolErrorInterceptor.ts`](src/core/tools/error-interception/ToolErrorInterceptor.ts) `getTaskState()`: `if (!task) { return { categoryCounts: new Map(), shellCircuitOpen: false } }` with comment "WeakMap keys must be objects; null/undefined are invalid and would throw TypeError on .set(). Fail-open". `resetTaskState()` guards `hasTaskErrorState()` before `getTaskErrorState()`. Regression test: "returns early when task has no state and does not materialize TaskErrorState". |
| #31 | #7 | ✅ | [`ExtensionStateContext.tsx`](webview-ui/src/context/ExtensionStateContext.tsx): `taskOrgRevisionRef = useRef<number>(0)` declared next to `pendingTaskOrgMutations`; sync `useEffect(() => { taskOrgRevisionRef.current = state.taskOrganization?.revision ?? 0 }, [state.taskOrganization?.revision])`; `mutateTaskOrganization` reads `const currentRevision = taskOrgRevisionRef.current` with `useCallback` deps `[]` (stale closure eliminated). |
| #33 | #8 | ❌ **FAIL** | [`UsageStatsService.ts`](src/services/stats/UsageStatsService.ts) at PR head `pr/b14-usage-aggregation-v2` (sha 96ab8d10): `CSV_COLUMNS` contains 30 columns ending `...cacheReadInInput, cacheWriteInInput, reasoningInOutput, provenance` — **no `rootTaskId`, no `endpoint`**, and no `extractCsvValue` cases for them. The `endpoint` field exists in the schema and aggregator grouping, and the code report `173630_code-report.md` claims the columns were added, but the cherry-pick to this PR branch did NOT include the CSV column change. |
| #36 | #9, #11 | ✅ | [`UsageStatsDatabase.ts`](src/services/stats/UsageStatsDatabase.ts) `initialize()` catch: `if (this.db) { try { this.db.close() } catch {} ; this.db = null }` before `throw new StatsDbError("STATS_DB/open/001", ...)` (bug #9). [`DashboardView.tsx`](webview-ui/src/components/dashboard/DashboardView.tsx): `latestSessionDetailTaskIdRef` added; `handleToggleSession` calls `fetchSessionDetail(taskId)` OUTSIDE the `setExpandedTaskId` updater; response handler resolves `const taskId = latestSessionDetailTaskIdRef.current` instead of render-time `expandedTaskId` (bug #11). |

## Remaining 11 PRs — No Unexpected Bug-Fix Changes

| PR | Branch (feature stage) | Status |
|----|------------------------|--------|
| #22 | B04 shell contracts | ✅ Clean — terminal shell settings schema/UI only |
| #23 | B01 error contracts (1/3) | ✅ Clean — types/errorPatterns/ErrorClassifier only; explicitly excludes B02 runtime files |
| #25 | B13 usage store (1/4) | ✅ Clean — UsageEventStore + schema only |
| #27 | B03 error integration | ✅ Clean (scoped by stacked-PR declaration; integration-only) |
| #29 | B09 task-org-ipc (2/3) | ✅ Clean — taskOrganizationMessageHandler/webviewMessageHandler/ClineProvider only; does NOT touch `ExtensionStateContext.tsx` or `TaskOrganizationStore.ts` |
| #30 | B11 mimo capability | ✅ Clean (stacked-PR scope) |
| #32 | B12 mimo enforcement | ✅ Clean (stacked-PR scope) |
| #34 | B15 usage capture (3/4) | ✅ Clean (stacked-PR scope; capture path only) |
| #35 | B06 terminal lifecycle | ✅ Clean (stacked-PR scope) |
| #37 | B07 shell integration | ✅ Clean (stacked-PR scope) |
| #38 | B17 provider cost | ✅ Clean (stacked-PR scope) |

Note: #27, #30, #32, #34, #35, #37, #38 were verified via their stacked-PR file-scope declarations ("포함 파일/제외 범위") rather than full patch reads. #22, #23, #25, #29 were verified with direct evidence (full file list or PR body + head branch). None of the 6 bug-fix files (`TaskOrganizationStore.ts`, provider files, `ToolErrorInterceptor.ts`, `ExtensionStateContext.tsx`, `UsageStatsService.ts` CSV section, `UsageStatsDatabase.ts` init, `DashboardView.tsx` fetch logic) appear outside their designated PRs.

## Issues Discovered
1. **PR #33 is missing the bug #8 fix.** The worktree code report (`173630_code-report.md`) states `rootTaskId` and `endpoint` were added to `CSV_COLUMNS` and `extractCsvValue()`, but the file at the PR head does not contain them. The cherry-pick to `pr/b14-usage-aggregation-v2` either missed the commit or was overwritten by a later push. **Action needed: re-apply the CSV column commit to PR #33** (add `"rootTaskId"` and `"endpoint"` to `CSV_COLUMNS` and their `extractCsvValue` cases, plus the regression test in `UsageStatsService.spec.ts`).

## Result
- 5 of 6 target PRs verified correct.
- 1 of 6 (PR #33) missing the assigned bug fix.
- 0 of 11 non-target PRs show bug-fix contamination.

## Next Step Recommendations
1. Route to code mode: re-apply the bug #8 CSV commit onto `pr/b14-usage-aggregation-v2` and force-push PR #33.
2. After re-push, re-run this verification for PR #33 only (check `CSV_COLUMNS` includes `rootTaskId` and `endpoint`).

## Affected File List (verified; none modified)
- `src/core/task-persistence/TaskOrganizationStore.ts` (PR #24)
- `src/api/providers/base-provider.ts`, `openai.ts`, + 7 sibling providers (PR #26)
- `src/core/tools/error-interception/ToolErrorInterceptor.ts` (PR #28)
- `webview-ui/src/context/ExtensionStateContext.tsx` (PR #31)
- `src/services/stats/UsageStatsService.ts` (PR #33 — FAIL)
- `src/services/stats/UsageStatsDatabase.ts`, `webview-ui/src/components/dashboard/DashboardView.tsx` (PR #36)
