# Code Task Report: Define and Validate the Shared Stream Contract

## Task Summary

Implemented runtime-validated Zod schemas, inferred TypeScript types, and message union members for the dashboard streaming protocol (Sub-task 1 of the dashboard streaming architecture).

## Actions Taken

### 1. `packages/types/src/usage-stats.ts` — Added stream types

- Added optional `rootTaskId` field to [`UsageEventV1`](packages/types/src/usage-stats.ts:35) for stable root-session identity (backward compatible).
- Added 10 new Zod schemas with inferred types:
    - [`DashboardSessionPageRequest`](packages/types/src/usage-stats.ts:1) — cursor-paged request (limit 1–100, default 50, optional cursor)
    - [`DashboardStatsSubscription`](packages/types/src/usage-stats.ts:1) — subscribe request (requestId, range, sessionPageSize 1–100, heatmapRangeDays 1–365)
    - [`DashboardSessionSummary`](packages/types/src/usage-stats.ts:1) — session row (rootTaskId, title, totalCost, totalTokens, model, provider, lastActivity, eventCount)
    - [`DashboardSessionPage`](packages/types/src/usage-stats.ts:1) — cursor-paged sessions (requestId, sessions, cursor, totalEstimate)
    - [`HeatmapSnapshot`](packages/types/src/usage-stats.ts:1) — daily values (rangeDays, values array)
    - [`DashboardStatsSnapshot`](packages/types/src/usage-stats.ts:1) — full state (requestId, generation, sequence, stats, sessions, cursor, heatmap)
    - [`StatsBucketDelta`](packages/types/src/usage-stats.ts:1) — signed bucket delta (all StatsBucket numeric fields as signed deltas)
    - [`DashboardSessionUpsert`](packages/types/src/usage-stats.ts:1) — session upsert (same shape as DashboardSessionSummary)
    - [`DashboardStatsDelta`](packages/types/src/usage-stats.ts:1) — incremental (requestId, generation, sequence, totalDelta, breakdownDelta, heatmapDayDelta, sessionUpsert)
    - [`DashboardStatsError`](packages/types/src/usage-stats.ts:1) — typed error (requestId, code, message)

### 2. `packages/types/src/vscode-extension-host.ts` — Added message union members

- Added 4 new `ExtensionMessage` type members: `dashboardStatsStreamSnapshot`, `dashboardStatsStreamDelta`, `dashboardStatsStreamError`, `dashboardSessionPageResponse`
- Added 7 new `WebviewMessage` type members: `subscribeDashboardStats`, `unsubscribeDashboardStats`, `replaceDashboardStatsSubscription`, `pauseDashboardStats`, `resumeDashboardStats`, `resyncDashboardStats`, `getDashboardSessionPage`
- Added 4 new payload fields to `ExtensionMessage`: `dashboardStatsStreamSnapshot`, `dashboardStatsStreamDelta`, `dashboardStatsStreamError`, `dashboardSessionPage`
- Added 3 new payload fields to `WebviewMessage`: `dashboardStatsSubscription`, `dashboardSessionCursor`, `dashboardSessionLimit`
- Updated import to include all new stream types from `usage-stats.js`

### 3. `packages/types/src/__tests__/usage-stats.spec.ts` — Extended tests

- Added 2 tests for `rootTaskId` backward compatibility on `UsageEventV1`

### 4. `packages/types/src/__tests__/dashboard-stats-stream.spec.ts` — New protocol tests

- 73 tests covering all new schemas:
    - `DashboardSessionPageRequest`: limit bounds (1–100), default, cursor, non-integer rejection
    - `DashboardStatsSubscription`: all fields, sessionPageSize bounds, heatmapRangeDays bounds, missing field rejection
    - `DashboardSessionSummary`: valid parse, missing field rejection
    - `DashboardSessionPage`: valid with/without cursor, empty sessions, missing field rejection
    - `HeatmapSnapshot`: valid, empty values, rangeDays bounds
    - `StatsBucketDelta`: positive/negative/zero values, missing field rejection
    - `DashboardSessionUpsert`: valid, missing field rejection
    - `DashboardStatsSnapshot`: all fields, optional cursor, integer constraints, missing field rejection
    - `DashboardStatsDelta`: all fields, optional heatmapDayDelta, empty arrays, negative deltas, integer constraints, dayIndex validation
    - `DashboardStatsError`: valid, missing field rejection
    - Serialization round-trips for snapshot, delta, error, and session page

## Result

✅ Success — all 108 tests pass (35 existing + 2 new rootTaskId + 73 new stream protocol), `tsc --noEmit` exits clean.

### Verification Evidence

```
cd packages/types; npx vitest run src/__tests__/usage-stats.spec.ts src/__tests__/dashboard-stats-stream.spec.ts
 Test Files  2 passed (2)
      Tests  108 passed (108)

cd packages/types; npx tsc --noEmit
(exit code 0, no errors)
```

## Issues Discovered

None. All existing types preserved — only additions were made. No existing tests were modified (only appended to).

## Next Step Recommendations

- Sub-task 2 (indexed canonical store and migration) can proceed using these contract types.
- The `rootTaskId` field on `UsageEventV1` is now available for the recorder and migration to populate.
- The message union members are ready for handler wiring in `usageStatsMessageHandler.ts` and `webviewMessageHandler.ts`.

## Affected File List

- `packages/types/src/usage-stats.ts` (modified — added rootTaskId + 10 new schemas/types)
- `packages/types/src/vscode-extension-host.ts` (modified — added import, 11 union members, 7 payload fields)
- `packages/types/src/__tests__/usage-stats.spec.ts` (modified — added 2 rootTaskId tests)
- `packages/types/src/__tests__/dashboard-stats-stream.spec.ts` (new — 73 protocol tests)
