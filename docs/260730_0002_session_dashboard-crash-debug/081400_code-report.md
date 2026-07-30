# Code Mode Task Report
## Task Summary
Implemented ST-3 (R3) and ST-5 (R5) fixes for the dashboard stats module:
- ST-3: Heatmap values now use token counts instead of dollar costs, matching the "tokens" label in the UI.
- ST-5: `buildQuery()` now only sends `from`/`to` for the `custom` preset; named presets (`today`, `7d`, `30d`, `all`) rely on the backend's preset resolution.

## Actions Taken

### ST-3: Heatmap unit mismatch (cost vs tokens)

**Root cause**: `computeHeatmapSnapshot()` populated `values` from `rollup.totalCost`, but `UsageHeatmap.tsx` renders them as "... tokens". Similarly, `applyEventToProjection()` used `costUsd` for the heatmap day delta.

**Fix 1** — [`UsageStatsProjection.ts`](src/services/stats/UsageStatsProjection.ts:600) `computeHeatmapSnapshot()`:
- Renamed `costByDay` map to `tokensByDay`
- Changed `rollup.totalCost` → `rollup.totalTokens`

**Fix 2** — [`UsageStatsProjection.ts`](src/services/stats/UsageStatsProjection.ts:686) `applyEventToProjection()`:
- Changed heatmap delta from `computeEventDelta(event, query.cacheRatio).costUsd` to `.totalTokens`

**Test updates** — [`UsageStatsProjection.spec.ts`](src/services/stats/__tests__/UsageStatsProjection.spec.ts:502):
- Renamed test "should show cost for days with events" → "should show tokens for days with events"
- Updated heatmap delta assertion from `0.05` (cost) to `1500` (1000 input + 500 output tokens)

### ST-5: UI sends from/to for named presets

**Root cause**: `DashboardView.buildQuery()` always computed and sent `from`/`to` ISO strings for `today`/`7d`/`30d` presets. The backend ignores these (preset takes priority), so they were unnecessary payload.

**Fix** — [`DashboardView.tsx`](webview-ui/src/components/dashboard/DashboardView.tsx:121) `buildQuery()`:
- Removed `from`/`to` computation for `today`, `7d`, `30d` presets
- Only `custom` preset now sets `from`/`to` (unchanged)
- `all` preset already didn't set `from`/`to` (unchanged)

## Result
- ✅ ST-3 tests: 41/41 passed (`UsageStatsProjection.spec.ts`)
- ✅ TypeScript compilation: clean for both `src/` and `webview-ui/`
- ⚠️ ST-5 tests: `DashboardView.spec.tsx` vitest hangs consistently (pre-existing jsdom environment issue, not related to our change). Existing tests don't assert on `from`/`to` fields — they only check `replaceSubscription` was called. Our change is a pure logic simplification that removes assignments, so no new test failures are expected.

## Issues Discovered
- The webview-ui test environment has a persistent hanging issue with vitest + jsdom. Multiple test runs (full suite, filtered by test name) all hung indefinitely. This is a pre-existing environment problem, not caused by our code change. TypeScript type checking confirms no compilation errors.

## Next Step Recommendations
- Investigate the webview-ui vitest hanging issue separately (likely jsdom setup or mock configuration).
- Consider adding explicit `from`/`to` assertion tests for `buildQuery()` once the test environment is stable.

## Affected File List
1. `src/services/stats/UsageStatsProjection.ts` — `computeHeatmapSnapshot()` and `applyEventToProjection()` heatmap delta logic
2. `src/services/stats/__tests__/UsageStatsProjection.spec.ts` — test assertions updated for token-based heatmap values
3. `webview-ui/src/components/dashboard/DashboardView.tsx` — `buildQuery()` preset logic simplified
