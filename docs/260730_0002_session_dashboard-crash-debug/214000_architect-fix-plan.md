# Architecture Fix Plan — Dashboard Crash / Slowness / Time-Range Accuracy

> Mode: architect
> Date: 2026-07-30 21:40 (Asia/Seoul)
> Source-of-truth investigation: [`docs/260730_0002_session_dashboard-crash-debug/212100_debug-report.md`](./212100_debug-report.md)
> Status: **Design only. No code has been modified.**

---

## 0. Executive Summary

The dashboard becomes unresponsive on re-entry (and shows subtly wrong numbers) because of five independent but compounding defects. The single dominant cause of the crash is **R1**: every dashboard snapshot re-reads the _entire_ `usage_events` table into memory and re-aggregates it on the extension-host main thread, even though a `stats_rollup` table exists precisely to avoid that. R2–R5 are data-accuracy bugs that must be fixed alongside R1 because the rollup-backed fast path only stays correct if the day-bucket keys and time-range math are consistent.

**Fix order (mandatory):** R1 → R2 → R3, then R4 → R5 as a follow-up batch. R2 must land _with or before_ R1's rollup-backed read path, because R1's correctness depends on day buckets being stored in the same timezone basis they are queried in.

---

## [1. Technical Specification]

### 1.1 Goals

- **G1 (R1):** Dashboard re-entry renders in O(range) not O(all events). Eliminate the full synchronous table scan from the snapshot path. Cap main-thread blocking to < ~16 ms for typical datasets.
- **G2 (R2):** Day buckets are stored and queried on a single, consistent timezone basis so "today / 7d / 30d" counts match what the user sees.
- **G3 (R3):** The heatmap's `values` array semantics match its UI label (tokens) _or_ the label matches the values (cost) — one canonical choice, applied end-to-end.
- **G4 (R4, follow-up):** Day-boundary math is DST-correct (no off-by-one-hour at spring/fall transitions).
- **G5 (R5, follow-up):** When the UI supplies explicit `from`/`to`, the backend honors them instead of silently recomputing from `preset`.

### 1.2 Core Constraints

- **Node `node:sqlite` is synchronous.** `DatabaseSync.prepare().all()` blocks the extension-host event loop. Any O(N-events) query on the main thread is a latency/crash risk at scale. → The read path must target pre-aggregated rollup rows.
- **`node:sqlite` runs in-process.** We cannot "move it to a worker" cheaply without re-architecting IPC; the pragmatic fix is to make queries cheap, not to move the DB.
- **The `stats_rollup` schema already supports breakdowns** via `axis` / `axis_value` columns (see [`UsageStatsDatabase.createSchema()`](../../../src/services/stats/UsageStatsDatabase.ts:249)) but only `axis=''` total rows are populated today. The fix must _start_ populating breakdown rows to serve the `groupBy` breakdown table without a full scan.
- **Existing data must keep working.** Day-bucket re-keying (R2) requires either a migration or a dual-read. See R2 options.

### 1.3 Cross-Domain Data Flow (current, broken)

```
DashboardView.tsx (webview)
  └─ useDashboardStatsStream.subscribe  ──postMessage──►  Extension host
                                                            │ subscribeDashboardStats
                                                            ▼
                                            UsageStatsStreamCoordinator.sendSnapshot()
                                                            │ assembleRollupSnapshot(db, query)
                                                            ▼
                                            UsageStatsProjection.assembleRollupSnapshot()
                                                            │ db.readAllEvents()   ← ❌ FULL SCAN
                                                            ▼
                                            UsageStatsDatabase.readAllEvents()  (node:sqlite, sync)
```

The heatmap path (`computeHeatmapSnapshot`) and session path (`computeSessionPage`) already use targeted queries; only the **stats snapshot** path does the full scan.

### 1.4 Type Definitions touched

- [`StatsQuery`](../../../src/services/stats/UsageAggregator.ts) — `preset`, `from`, `to`, `timezone`, `groupBy`, `includeCancelled`, `cacheRatio`.
- [`HeatmapSnapshot`](../../../src/services/stats/UsageStatsProjection.ts) — `{ rangeDays, values }`. The `values` semantics are the subject of R3.
- `DailyRollupRow` — `{ day, totalCost, totalTokens, eventCount }` (already carries both cost and tokens; see [`queryDailyRollups()`](../../../src/services/stats/UsageStatsDatabase.ts:835)).

---

## [2. Architecture Decisions]

### R1 — Snapshot path does a full synchronous table scan (PRIMARY)

**Root cause (confirmed):** [`assembleRollupSnapshot()`](../../../src/services/stats/UsageStatsProjection.ts:205) calls `db.readAllEvents()` (line 205), filters and re-aggregates every event in JS (lines 209–247). Called synchronously from [`UsageStatsStreamCoordinator.sendSnapshot()`](../../../src/services/stats/UsageStatsStreamCoordinator.ts:454). Every re-entry, every `replaceSubscription`, and every snapshot-fallback re-runs it.

**Secondary amplifier:** [`applyEventToProjection()`](../../../src/services/stats/UsageStatsProjection.ts:432) calls `db.querySessions(100, undefined)` _per appended event_ to find one session row. This is O(sessions) per event and should be a targeted point lookup.

#### Option A — The Standard / The Right Way (rollup-backed reads) ✅ RECOMMENDED

Serve the snapshot from `stats_rollup` instead of raw events.

- Populate breakdown rollup rows at write time in [`UsageStatsDatabase.appendInternal()`](../../../src/services/stats/UsageStatsDatabase.ts:354) and [`bulkAppend()`](../../../src/services/stats/UsageStatsDatabase.ts:542): for each event, in addition to the existing total row, upsert one row per `(axis, axis_value)` breakdown for the axes the dashboard supports (`model`, `provider`, `mode`, `day`). [`updateRollup()`](../../../src/services/stats/UsageStatsDatabase.ts:1019) already accepts arbitrary `axis`/`axis_value` and is idempotent via `ON CONFLICT`.
- Rewrite [`assembleRollupSnapshot()`](../../../src/services/stats/UsageStatsProjection.ts:198) to:
    - Read `queryLifetimeTotals()` for the `totals` bucket when range is `all`, else `SUM` over `queryDailyRollups(fromDay, toDay)`.
    - Read breakdown rows with a new `queryBreakdownRollups(periodType, fromKey, toKey, axis)` for the `groupBy` table.
    - Compute `cacheRatio`-adjusted fields. ⚠️ **Constraint:** `cacheRatio` re-weights cache tokens at query time. Rollups store raw cache tokens, so cache-adjusted cost must be derived from raw components (input/output/cacheRead/cacheWrite) — which the rollup already stores. Confirm the exact formula in [`computeEventDelta()`](../../../src/services/stats/UsageAggregator.ts:375) and replicate it over rollup columns.
- Replace the per-event `db.querySessions(100, undefined)` in [`applyEventToProjection()`](../../../src/services/stats/UsageStatsProjection.ts:432) with a new point query `db.querySessionByRootTaskId(rootTaskId)` (single-row `SELECT ... WHERE root_task_id = ?`).

_Trade-offs:_ Effort **High** (write-path + read-path + cacheRatio parity + backfill). Risk **Medium** (must keep rollup sums bit-identical to event aggregation; needs a one-time backfill of breakdown rows for existing events). Outcome **crash eliminated, all groupBy axes fast.**

#### Option B — The Practical / The Pragmatic Way

Keep the JS aggregation but bound it: only scan events inside the resolved time range using the existing `idx_usage_events_occurred` index.

- Add `db.readEventsInRange(fromEpochMs, toEpochMs)` and use `resolveTimeRange(query)` to bound the scan in [`assembleRollupSnapshot()`](../../../src/services/stats/UsageStatsProjection.ts:208). `all` preset still scans everything.
- Add the `querySessionByRootTaskId` point lookup (same as A).

_Trade-offs:_ Effort **Low–Medium**. Risk **Low**. Outcome **today/7d/30d fast; `all` still slow.** Does not fix the root cause, only narrows it. Acceptable as an interim if A is too large for one phase.

#### Option C — The Staging / The Incremental Way

Add a per-(generation, query, cacheRatio) snapshot memo in [`UsageStatsStreamCoordinator`](../../../src/services/stats/UsageStatsStreamCoordinator.ts) so repeat subscriptions within the same generation reuse the last snapshot instead of recomputing.

_Trade-offs:_ Effort **Low**. Risk **Low** (invalidation on `notifyEventAppended` / `resetGeneration` is already modeled). Outcome **re-entry is instant after first compute, but the first compute still blocks.** Pure mitigation; does not fix accuracy or first-load cost. Good companion to A or B, not a substitute.

**Decision driver:** A is the only option that removes the O(N) main-thread scan for _all_ presets. Given "Boil the Ocean" (completeness first) and that R2/R3 must touch the same read path anyway, **A is recommended**, optionally staged as **C now + A next** if the VP needs a same-day mitigation.

---

### R2 — Day buckets stored as UTC date, queried as local-timezone date (data accuracy)

**Root cause (confirmed):** [`appendInternal()`](../../../src/services/stats/UsageStatsDatabase.ts:364) and `bulkAppend()` (line ~556) compute `dayBucket = event.occurredAt.slice(0, 10)` — a **UTC** calendar day. But [`computeHeatmapRange()`](../../../src/services/stats/UsageStatsProjection.ts:159) and [`computeDayBucket()`](../../../src/services/stats/UsageStatsProjection.ts:143) build `fromDay`/`toDay`/day keys in the **query timezone**. For UTC+9 (Seoul), an event at 23:30 UTC is stored under UTC day _D_ but queried under local day _D+1_ → it vanishes from "today" and is double-counted across boundaries.

**Design decision — canonical day basis.** Store day buckets in the **event's own local timezone** at write time. Each `UsageEventV1` already carries `timezone_offset_minutes` (schema line 225). Compute `dayBucket = localDate(occurredAt, timezone_offset_minutes)` instead of `occurredAt.slice(0,10)`.

#### Option A — Store local-day + migrate existing rows ✅ RECOMMENDED

- Change the day-bucket computation in [`appendInternal()`](../../../src/services/stats/UsageStatsDatabase.ts:364) and `bulkAppend()` to use `occurred_epoch_ms + timezone_offset_minutes` → local `YYYY-MM-DD`.
- Add a schema-version bump + migration in [`runMigrations()`](../../../src/services/stats/UsageStatsDatabase.ts:330) that recomputes `stats_rollup` daily rows and `session_activity.day` from `usage_events.occurred_epoch_ms + timezone_offset_minutes`. Because rollups are derived data, the safest migration is: rebuild daily/session-activity rollups from `usage_events` in a transaction.

_Trade-offs:_ Effort **Medium** (one migration). Risk **Medium** (migration must be transactional and idempotent). Outcome **permanently correct; single basis.**

#### Option B — Store UTC-day, query in UTC-day

Keep storage as-is and convert the _query_ range to UTC days. Requires converting the user's local-midnight range into the set of UTC days it overlaps — which is lossy for partial edge days and reintroduces the same mismatch at the edges.

_Trade-offs:_ Effort **Low**. Risk **High** (edge-day miscounts persist; semantically confusing). Outcome **not actually correct.** Rejected.

#### Option C — Dual-write both day bases during a transition window

Write both `day_utc` and `day_local` columns, read local, backfill lazily.

_Trade-offs:_ Effort **Medium–High**. Risk **Low** (no destructive migration). Outcome **correct reads quickly, but schema carries dead weight.** Choose only if a same-day ship is required before the migration can be validated.

**Note:** R2 must land _with or before_ R1-Option-A's read path, because the rollup-backed breakdown read keys on `period_key` (the day). If storage stays UTC while queries go local, R1-A returns wrong numbers faster.

---

### R3 — Heatmap `values` are cost, UI labels tokens (data accuracy)

**Root cause (confirmed):** [`computeHeatmapSnapshot()`](../../../src/services/stats/UsageStatsProjection.ts:338-344) builds `costByDay` from `rollup.totalCost` and emits `values` = cost. But [`UsageHeatmap.tsx`](../../../webview-ui/src/components/stats/UsageHeatmap.tsx:113) stores `values[i]` into `totalTokens` and renders tooltips `"… tokens"` (lines 194, 203) and `maxTokens` intensity (line 148). Cost (≈$0–5) vs tokens (≈0–millions) are on wildly different scales, so the heatmap is both mislabeled and mis-scaled.

**Design decision — pick one semantic.** The heatmap is a _usage activity_ visualization; **tokens** is the natural unit and matches the existing label.

- Change [`computeHeatmapSnapshot()`](../../../src/services/stats/UsageStatsProjection.ts:338) to build `tokensByDay` from `rollup.totalTokens` (already returned by [`queryDailyRollups()`](../../../src/services/stats/UsageStatsDatabase.ts:835) as `totalTokens`).
- Change the matching heatmap-delta path in [`applyEventToProjection()`](../../../src/services/stats/UsageStatsProjection.ts:425) to add the event's **token** delta instead of `costUsd`, so live deltas match the snapshot basis.
- No UI change needed (label already says tokens). If product later prefers cost, change the label + i18n key `stats:heatmap.*` instead and keep `values` as cost — but that is a product decision, not this fix.

_Trade-offs:_ Effort **Low**. Risk **Low**. Outcome **label and data agree; intensity scale is meaningful.**

---

### R4 — DST off-by-one-hour in day-boundary math (follow-up)

**Root cause (confirmed):** [`startOfDay()`](../../../src/services/stats/UsageAggregator.ts:134-150) and the duplicate [`toTimezoneStartOfDay()`](../../../src/services/stats/UsageStatsService.ts:509-528) compute the UTC offset **at `date` (= now)** and apply it to the target day's midnight. Across a DST transition the offset at _now_ differs from the offset at the _target midnight_ by one hour, so the computed `from`/`to` is off by 3600 s and events near midnight leak into the adjacent day.

**Fix:** Iterate the offset at the _target_ wall-clock midnight, not at `date`:

1. Compute candidate midnight UTC from the target `(year, month, day)`.
2. Evaluate `getTimezoneOffsetMinutes(candidateMidnightUtc, timezone)`.
3. Recompute `midnightEpoch + offset` once (one iteration converges for all real IANA zones; a second pass guards the rare 2-fold case).

Apply identically in **both** [`UsageAggregator.startOfDay()`](../../../src/services/stats/UsageAggregator.ts:134) and [`UsageStatsService.toTimezoneStartOfDay()`](../../../src/services/stats/UsageStatsService.ts:509) — better, extract a single shared `startOfDayInTimezone(date, timezone)` helper (e.g. in `UsageAggregator.ts`, exported) and have `UsageStatsService` import it to eliminate the duplicated logic.

_Trade-offs:_ Effort **Low**. Risk **Low** (pure function, well-testable). Outcome **DST-correct ranges.**

---

### R5 — Preset `from`/`to` ignored (follow-up)

**Root cause (confirmed):** The UI's [`buildQuery()`](../../../webview-ui/src/components/dashboard/DashboardView.tsx:121-147) _always_ sends `from`/`to` for `today`/`7d`/`30d` (computed in the browser's local tz) _and_ a `preset`. But the backend gives `preset` precedence and recomputes the range: [`filterEventsByQuery()`](../../../src/services/stats/UsageStatsService.ts:444-448) and [`resolveTimeRange()`](../../../src/services/stats/UsageAggregator.ts:159-187) both ignore `from`/`to` when `preset` is set. The two computations use different day-boundary code (and R4's DST bug), so the backend's range can differ from what the UI displayed.

**Design decision — single source of truth.** The backend should be authoritative for range resolution (it owns timezone-correct math after R4). Therefore:

- **Option A (recommended):** UI stops sending `from`/`to` for named presets; it sends only `preset` + `timezone`, and the backend resolves. `custom` preset continues to send explicit `from`/`to`. This removes the duplication rather than trying to keep two computations in lockstep.
- **Option B:** Backend honors explicit `from`/`to` over `preset` when both are present. Keeps the browser as source of truth but imports the browser's less-correct day math into the backend. Rejected.

Net change is in [`DashboardView.buildQuery()`](../../../webview-ui/src/components/dashboard/DashboardView.tsx:121-147): only set `from`/`to` when `currentPreset === "custom"`. No backend change needed for A (preset path already wins).

_Trade-offs:_ Effort **Low**. Risk **Low**. Outcome **UI and backend always agree; one less duplicated range computation.**

---

## [3. Implementation Plan (Sub-tasks)]

Each sub-task is independent and delegable to `code`. Land in order: **ST-2 (R2) before/with ST-1 (R1)**, then ST-3 (R3), then ST-4 (R4), ST-5 (R5).

---

### ST-1 (R1) — Rollup-backed snapshot read path

**Files to modify:**

- [`src/services/stats/UsageStatsProjection.ts`](../../../src/services/stats/UsageStatsProjection.ts) — rewrite `assembleRollupSnapshot()` (lines 198–275) to read rollups; change `applyEventToProjection()` session lookup (line 432).
- [`src/services/stats/UsageStatsDatabase.ts`](../../../src/services/stats/UsageStatsDatabase.ts) — add `queryBreakdownRollups(periodType, fromKey, toKey, axis)`; add `querySessionByRootTaskId(rootTaskId)`; populate breakdown rows in `appendInternal()` (line 354) and `bulkAppend()` (line 542); add breakdown backfill for existing events.
- (optional, Option C companion) [`src/services/stats/UsageStatsStreamCoordinator.ts`](../../../src/services/stats/UsageStatsStreamCoordinator.ts) — snapshot memo keyed by (generation, serialized query, cacheRatio).

**Prerequisites:** ST-2 day-bucket basis decided (rollup `period_key` basis must match). `computeEventDelta()` cacheRatio formula replicated over rollup columns.

**Verification & Test Protocol:**

- Existing suite: `src/services/stats/__tests__/UsageStatsProjection.spec.ts`, `UsageStatsDatabase.spec.ts`, `UsageStatsStreamCoordinator.spec.ts`, and `dashboardStatsPerformance.spec.ts`.
- Add assertions: snapshot from rollups **equals** snapshot from raw events for a seeded fixture (parity test); `querySessionByRootTaskId` returns the same row the old `querySessions(100).find(...)` returned.
- Performance: extend `dashboardStatsPerformance.spec.ts` to assert snapshot assembly stays under a time budget with N events seeded (e.g. 50k events → < 200 ms).
- Command: `cd src && npx vitest run services/stats/__tests__/UsageStatsProjection.spec.ts services/stats/__tests__/UsageStatsDatabase.spec.ts services/stats/__tests__/dashboardStatsPerformance.spec.ts`

---

### ST-2 (R2) — Local-timezone day buckets + migration

**Files to modify:**

- [`src/services/stats/UsageStatsDatabase.ts`](../../../src/services/stats/UsageStatsDatabase.ts) — day-bucket computation in `appendInternal()` (line 364) and `bulkAppend()` (line ~556); schema version bump + migration in `runMigrations()` (line 330) rebuilding daily `stats_rollup` rows and `session_activity.day` from `occurred_epoch_ms + timezone_offset_minutes`.

**Prerequisites:** none (foundation for ST-1's read path).

**Verification & Test Protocol:**

- Existing suite: `UsageStatsDatabase.spec.ts`, `UsageStatsMigration.spec.ts`.
- New tests: event at `2026-07-29T23:30:00Z` with `timezone_offset_minutes = 540` (Seoul) is bucketed under `2026-07-30`, and `queryDailyRollups("2026-07-30","2026-07-30")` returns it. Migration test: seed UTC-bucketed rows, run migration, assert re-keyed to local day.
- Command: `cd src && npx vitest run services/stats/__tests__/UsageStatsDatabase.spec.ts services/stats/__tests__/UsageStatsMigration.spec.ts`

---

### ST-3 (R3) — Heatmap values = tokens

**Files to modify:**

- [`src/services/stats/UsageStatsProjection.ts`](../../../src/services/stats/UsageStatsProjection.ts) — `computeHeatmapSnapshot()` (lines 338–344) → tokens; `applyEventToProjection()` heatmap delta (line 425) → token delta.
- (verify only, no change expected) [`webview-ui/src/components/stats/UsageHeatmap.tsx`](../../../webview-ui/src/components/stats/UsageHeatmap.tsx).

**Prerequisites:** none. Independent of ST-1/ST-2 but touches the same projection file — sequence after ST-1 to avoid conflicts.

**Verification & Test Protocol:**

- Existing: `UsageStatsProjection.spec.ts`. New assertion: `computeHeatmapSnapshot` values equal seeded daily `totalTokens`, and a live delta adds the event's token count to the correct `dayIndex`.
- Command: `cd src && npx vitest run services/stats/__tests__/UsageStatsProjection.spec.ts`

---

### ST-4 (R4, follow-up) — DST-correct startOfDay

**Files to modify:**

- [`src/services/stats/UsageAggregator.ts`](../../../src/services/stats/UsageAggregator.ts) — fix `startOfDay()` (lines 134–150); export a shared `startOfDayInTimezone()`.
- [`src/services/stats/UsageStatsService.ts`](../../../src/services/stats/UsageStatsService.ts) — replace `toTimezoneStartOfDay()` (lines 509–528) with the shared helper.

**Prerequisites:** none.

**Verification & Test Protocol:**

- Existing: `UsageAggregator.spec.ts`, `UsageStatsService.spec.ts`.
- New tests around a real DST boundary (e.g. `America/New_York`, 2026-03-08 spring-forward and 2026-11-01 fall-back): the resolved `from` for "today" equals true local midnight UTC (offset evaluated at that midnight, not at now).
- Command: `cd src && npx vitest run services/stats/__tests__/UsageAggregator.spec.ts services/stats/__tests__/UsageStatsService.spec.ts`

---

### ST-5 (R5, follow-up) — UI sends preset-only for named presets

**Files to modify:**

- [`webview-ui/src/components/dashboard/DashboardView.tsx`](../../../webview-ui/src/components/dashboard/DashboardView.tsx) — `buildQuery()` (lines 121–147): only set `from`/`to` for `custom`.

**Prerequisites:** ST-4 recommended (so the backend's preset resolution is the trusted one).

**Verification & Test Protocol:**

- New webview test: `webview-ui/src/components/dashboard/__tests__/DashboardView.spec.tsx` (create if absent) asserting `buildQuery("today", …)` returns `{ preset: "today", from: undefined, to: undefined, … }` and `buildQuery("custom", …)` returns explicit `from`/`to`.
- Command: `cd webview-ui && npx vitest run src/components/dashboard/__tests__/DashboardView.spec.tsx`

---

## Issues Discovered (beyond the 5 root causes)

- **Duplicated day-boundary logic** exists in three places (`UsageAggregator.startOfDay`, `UsageStatsService.toTimezoneStartOfDay`, and the inline day math in `computeDayBucket`/`computeHeatmapRange`). R4 is the right time to consolidate into one exported helper to prevent future drift.
- **`applyEventToProjection` per-event `querySessions(100)`** is an O(sessions) scan on the hot append path, independent of the snapshot scan. Folded into ST-1.
- **`cacheRatio` is applied at read time**, so any rollup-backed read must derive adjusted cost from raw token components rather than a pre-baked cost column. This is a correctness constraint on ST-1, flagged for the auditor.

## Next Step Recommendations

1. VP: approve fix order **ST-2 → ST-1 → ST-3** for this phase (crash + the two accuracy bugs that share the read path), and schedule **ST-4 + ST-5** as the immediate follow-up batch.
2. If a same-day mitigation is required before ST-1 lands, ship **ST-1 Option C (snapshot memo)** first; it is low-risk and independently useful.
3. Delegate ST-2 and ST-1 to `code` together (same files), with the parity test (rollup snapshot == event snapshot) as the acceptance gate.

## Affected File List

- [`src/services/stats/UsageStatsProjection.ts`](../../../src/services/stats/UsageStatsProjection.ts) — ST-1, ST-3
- [`src/services/stats/UsageStatsDatabase.ts`](../../../src/services/stats/UsageStatsDatabase.ts) — ST-1, ST-2
- [`src/services/stats/UsageStatsStreamCoordinator.ts`](../../../src/services/stats/UsageStatsStreamCoordinator.ts) — ST-1 (optional memo)
- [`src/services/stats/UsageAggregator.ts`](../../../src/services/stats/UsageAggregator.ts) — ST-4
- [`src/services/stats/UsageStatsService.ts`](../../../src/services/stats/UsageStatsService.ts) — ST-4
- [`webview-ui/src/components/dashboard/DashboardView.tsx`](../../../webview-ui/src/components/dashboard/DashboardView.tsx) — ST-5
- [`webview-ui/src/components/stats/UsageHeatmap.tsx`](../../../webview-ui/src/components/stats/UsageHeatmap.tsx) — ST-3 (verify only)
- Tests: `src/services/stats/__tests__/{UsageStatsProjection,UsageStatsDatabase,UsageStatsStreamCoordinator,UsageStatsMigration,UsageAggregator,UsageStatsService,dashboardStatsPerformance}.spec.ts`, `webview-ui/src/components/dashboard/__tests__/DashboardView.spec.tsx`
