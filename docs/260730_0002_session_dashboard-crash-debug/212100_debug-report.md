# Debug Task Report — Dashboard 크래시/느림 + 시간 범위 정확성

## Task Summary

Investigate two user-reported symptoms after the streaming+cache architecture landed:

1. "대시보드 한번 들어갔다 나오면 대시보드가 다울되는것같다" — enter dashboard, leave, re-enter → down / extremely slow.
2. "Today, 7Days, 30Days, Custom, All 전부 해당 기간에 대해 잘 나오는거 맞아?" — doubt about per-range data accuracy.

Investigation only (no code changes). Causal chain mapped UI → hook → message boundary → coordinator → service → store/SQLite → projection.

## Causal Chain (Impact Analysis)

| Layer       | File                                                             | Role                                                                                          |
| ----------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| UI          | `webview-ui/src/components/dashboard/DashboardView.tsx`          | preset/groupBy/heatmap state, `buildQuery()`, calls stream hook, renders snapshot/delta state |
| UI          | `webview-ui/src/components/stats/UsageHeatmap.tsx`               | controlled heatmap, local-day indexing of `values[]`                                          |
| Hook        | `webview-ui/src/components/dashboard/useDashboardStatsStream.ts` | subscribe on mount, unsubscribe on unmount, replaceSubscription, pause/resume                 |
| Reducer     | `webview-ui/src/components/dashboard/dashboardStreamReducer.ts`  | epoch(requestId)/generation/sequence gating, stale-while-revalidate                           |
| Boundary    | `src/core/webview/webviewMessageHandler.ts:871-891`              | routes all 7 stream messages                                                                  |
| Boundary    | `src/core/webview/usageStatsMessageHandler.ts`                   | validates payloads, owns per-provider `ProviderStreamSink`                                    |
| Coordinator | `src/services/stats/UsageStatsStreamCoordinator.ts`              | subscribe/drain/snapshot/rollover; 30s rollover interval                                      |
| Service     | `src/services/stats/UsageStatsService.ts`                        | singleton per ClineProvider; owns coordinator + file watcher + NDJSON store                   |
| Store       | `src/services/stats/UsageEventStore.ts`                          | NDJSON append/readAll with warm cache                                                         |
| DB          | `src/services/stats/UsageStatsDatabase.ts`                       | `node:sqlite` DatabaseSync, rollups, session projections, sequences                           |
| Projection  | `src/services/stats/UsageStatsProjection.ts`                     | assembleRollupSnapshot / computeSessionPage / computeHeatmapSnapshot / applyEventToProjection |
| Aggregation | `src/services/stats/UsageAggregator.ts`                          | `resolveTimeRange()`, timezone math, per-event delta                                          |

Lifecycle facts that were verified:

- `ClineProvider` is created **once per window** (`src/extension.ts:201` sidebar, `src/activate/registerCommands.ts:250` tab). The sidebar instance owns `UsageStatsService` (`ClineProvider.ts:321`). Service/coordinator/file-watcher are **singletons**, disposed only in `UsageStatsService.dispose()` — so they do **not** leak on dashboard re-entry.
- `ProviderStreamSink` is created once per provider and cached on `_streamSink` (`usageStatsMessageHandler.ts:985-990`), so `unsubscribe(sink)` correctly removes the single coordinator subscription. **No subscription leak on re-entry.**
- `App.tsx:251` unmounts `DashboardView` on tab switch; the hook's mount-effect cleanup posts `unsubscribeDashboardStats`. ChatView stays mounted, so the webview (and its `window` message listeners) persists — cleanup listeners are removed correctly.

## Root Cause Analysis

### R1 (PRIMARY, crash/slowdown) — Snapshot path does a full synchronous table scan on the extension-host main thread

`assembleRollupSnapshot()` is named "rollup" but never reads the rollup tables for the main snapshot. It calls `db.readAllEvents()` (`UsageStatsProjection.ts:205`), which loads **every event in the database** into a JS array, then filters and aggregates in JS (lines 208-267). There is **no caching** between calls.

This full scan runs **synchronously** because `UsageStatsDatabase` uses `node:sqlite`'s `DatabaseSync` (`UsageStatsDatabase.ts:167`). A synchronous DB call blocks the Node event loop on the extension host.

It is invoked on every one of these triggers:

- dashboard mount → `subscribe()` → `sendSnapshot()` (`UsageStatsStreamCoordinator.ts:179,443-500`)
- every preset/groupBy/heatmap/cacheRatio change → `replaceSubscription()` → `subscribe()` → snapshot
- manual refresh → `replaceSubscription()` → snapshot
- resume with gap>100 → snapshot (`UsageStatsStreamCoordinator.ts:235-238`)
- midnight rollover → snapshot to every subscriber (`UsageStatsStreamCoordinator.ts:583-595`)

Compounding factor on re-entry: the hook **never passes `visible`**, so `visible` defaults to `true` (`useDashboardStatsStream.ts:57`; `DashboardView.tsx:171`). The webview's `resume` on `didBecomeVisible` never fires in production (`useDashboardStatsStream.ts:143-156`), and the pause/resume effect is dead (`useDashboardStatsStream.ts:166-180`). Meanwhile `postMessageToWebview` swallows all errors and VS Code **queues** messages for hidden sidebar webviews (`ClineProvider.ts:1381-1391`), so messages posted while the user is on the chat tab accumulate and are flushed on return — the reducer drops stale-epoch ones, but the host already paid the snapshot cost.

Why it matches "한번 들어갔다 나오면 다운": the _first_ entry after events have accumulated scans all events; subsequent entries and every filter change re-scan. As history grows the synchronous scan grows, and during it the whole extension host (not just the dashboard) stalls — which the user perceives as the dashboard "going down". This violates architecture goal 1.1#3 ("session-count-independent active cost") and 1.4A (rollups should serve queries). **Confidence: HIGH.**

Secondary cost on the delta path: `applyEventToProjection()` calls `db.querySessions(100, undefined)` (`UsageStatsProjection.ts:432`) — a `session_metadata` read plus a separate `COUNT(*)` — **for every single drained event**, just to find one `rootTaskId` row. Under a burst this is O(events × 100-row query).

### R2 (data accuracy) — Day buckets stored as UTC date, queried as local-timezone date

`UsageStatsDatabase.appendInternal()` stores `dayBucket = event.occurredAt.slice(0, 10)` (`UsageStatsDatabase.ts:364`, same in `bulkAppend` line 556). `occurredAt` is an ISO UTC string, so the slice is the **UTC calendar day**.

But the query side uses the **IANA timezone**:

- heatmap: `computeDayBucket()` uses `Intl.DateTimeFormat` with `query.timezone` (`UsageStatsProjection.ts:143-152`) and `computeHeatmapRange()` builds the day list in that timezone.
- main snapshot totals: `resolveTimeRange()` computes from/to in the query timezone (`UsageAggregator.ts:158-193`).

For any non-UTC user (the reporter is UTC+9), an event near a local midnight is filed under a different UTC day than its local day. Consequences:

- The **heatmap** (`computeHeatmapSnapshot`) reads UTC-day rollups but labels them with local-day indices in `UsageHeatmap.tsx:101-119` (local `setDate` arithmetic). Cells can be shifted by a day; "today" can show yesterday's value or zero.
- The **main Today/7d/30d totals** are actually computed by re-filtering `occurred_epoch_ms` in JS inside `assembleRollupSnapshot` (not from rollups), so they are range-correct — but they will **disagree with the heatmap** derived from UTC-day rollups. This is exactly the "기간에 대해 잘 나오는거 맞아?" doubt. **Confidence: HIGH.**

### R3 (data accuracy) — Heatmap plots dollars but labels them as tokens

`computeHeatmapSnapshot()` fills `values` from `rollup.totalCost` (`UsageStatsProjection.ts:339-344`). `UsageHeatmap` renders `day.totalTokens` and tooltips "… tokens" (`UsageHeatmap.tsx:111-113, 194-203`). Units mismatch: the color scale and numbers are cost (USD), not tokens. Every range (30/60/120/360) is affected. **Confidence: HIGH.**

### R4 (data accuracy, proven) — DST off-by-one-hour in day-boundary math

`startOfDay()` (`UsageAggregator.ts:134-150`) and `UsageStatsService.toTimezoneStartOfDay()` (`UsageStatsService.ts:509-528`) compute the timezone offset **at `now`** and apply that fixed offset to midnight. Across a DST transition the offset at midnight differs from the offset at `now`.

Runtime proof (executed): for `America/New_York` at `2026-03-08T15:00:00Z` (after spring-forward), the code computes local midnight as `2026-03-08T04:00:00Z`, but the correct NY midnight is `2026-03-08T05:00:00Z` — exactly one hour off. Events in that hour are assigned to the wrong day for `today`/`7d`/`30d`. Korea has no DST, so this does not affect the reporter, but it is a latent correctness bug for DST timezones. **Confidence: HIGH (proven by execution).**

### R5 (minor, correctness gap vs. architecture) — Preset re-derivation ignores frontend from/to; 7d/30d include partial first day

Both `UsageStatsService.filterEventsByQuery()` (`UsageStatsService.ts:444-452`) and `resolveTimeRange()` (`UsageAggregator.ts:159`) **ignore `query.from`/`query.to` whenever `preset` is set** and recompute from the preset. Meanwhile `DashboardView.buildQuery()` sends a `from` computed with the **current time-of-day** for `7d`/`30d` (`DashboardView.tsx:126-135`) but midnight for `today`. The dead `from` fields are misleading, and the two interpretations differ (backend uses calendar-day windows: `today` = local midnight→next midnight; `7d` = local midnight 7 days ago→tomorrow midnight). Net effect on reported numbers is consistent within the backend, so this is a **maintainability/footgun** issue rather than a wrong-number bug for presets. For `custom`, preset is absent so explicit `from`/`to` are honored — custom works as the user expects.

### Non-findings (ruled out)

- No listener/subscription/timer/coordinator/file-watcher **leak** on re-entry (singletons verified; cleanup verified).
- No duplicate `usageStatsChanged` storm into the dashboard (dashboard no longer listens to it; the remaining producers are harmless no-ops).
- Session DOM is virtualized (`Virtuoso`, `SessionList.tsx:235`) — not the bottleneck.
- `postMessageToWebview` never throws, so the coordinator's `sendDelta` catch-based snapshot-fallback (`UsageStatsStreamCoordinator.ts:514-521`) is dead code — not a crash cause, but a recovery gap worth noting.

## Fix Details (recommended, not applied — investigation only)

1. R1: Serve the main snapshot from `stats_rollup` (daily interior + lifetime for `all`, with edge-day event slices for `today`/custom edges) instead of `readAllEvents()`; add per-query memoization keyed by (generation, sequence, query, cacheRatio). Wire `visible` from the sidebar visibility into the hook so pause/resume actually works. Make `applyEventToProjection` fetch the single session row by `rootTaskId` rather than `querySessions(100)`.
2. R2: Store the rollup `day` bucket in the **event's local timezone** (use `computeDayBucket(event.occurredAt, tz)`), or store UTC epoch and compute day at query time — one canonical choice, applied to both append and query paths.
3. R3: Decide the heatmap metric. If tokens, use `total_tokens`; if cost, change labels/tooltips to cost. Match front/back.
4. R4: Compute the offset **at the target midnight** (iterate: guess → format → recompute offset → adjust), or use a TZ-aware library; add a fake-time DST test.
5. R5: Make one side authoritative: either stop sending `from`/`to` for presets, or honor explicit `from`/`to` in the backend. Align `7d`/`30d` to calendar days in `buildQuery()` if calendar semantics are intended.

## Test Environment Issues

None. No test environment changes were needed. The DST proof was a standalone `node -e` against the system `Intl` API (exit 0); no project deps required.

## Verification Results

- Read every file in scope (DashboardView, hook, reducer, coordinator, service, store, aggregator, message handler, database, projection, heatmap, session list, App.tsx, webviewMessageHandler routing, ClineProvider lifecycle/postMessage).
- Executed a DST reproduction proving R4 (`04:00:00Z` vs correct `05:00:00Z`).
- Confirmed virtualization, singleton lifecycle, message routing for all 7 stream message types, and the dead pause/resume path.

## Issues Discovered

- R1 full-scan snapshot on main thread (primary perf/crash driver).
- R2 UTC-vs-local day bucket mismatch (heatmap + rollup drift).
- R3 heatmap cost-vs-token unit mismatch.
- R4 DST off-by-one-hour (proven).
- R5 preset from/to ignored + 7d/30d partial-day semantics.
- Dead code: pause/resume never active (no `visible` passed); coordinator `sendDelta` snapshot-fallback unreachable (`postMessageToWebview` never rejects); `usageStatsChanged` producers orphaned.

## Next Step Recommendations

- Route to **code** for R1 (highest user impact) with R2/R3 in the same pass (all in the stats projection/database layer).
- Add regression tests at the lowest layer: `UsageStatsProjection.spec.ts` (rollup-backed snapshot, per-event session fetch), `UsageAggregator.spec.ts` (DST boundary), `UsageStatsDatabase.spec.ts` (local-day bucket storage), and a heatmap units assertion in `UsageHeatmap.spec.tsx`.
- Treat R4/R5 as follow-ups gated on a TZ decision; R4 needs a fake-time test around a DST transition.

## Affected File List

- `webview-ui/src/components/dashboard/DashboardView.tsx`
- `webview-ui/src/components/dashboard/useDashboardStatsStream.ts`
- `webview-ui/src/components/dashboard/dashboardStreamReducer.ts`
- `webview-ui/src/components/dashboard/SessionList.tsx`
- `webview-ui/src/components/stats/UsageHeatmap.tsx`
- `webview-ui/src/App.tsx`
- `src/core/webview/usageStatsMessageHandler.ts`
- `src/core/webview/webviewMessageHandler.ts`
- `src/core/webview/ClineProvider.ts`
- `src/services/stats/UsageStatsStreamCoordinator.ts`
- `src/services/stats/UsageStatsService.ts`
- `src/services/stats/UsageEventStore.ts`
- `src/services/stats/UsageAggregator.ts`
- `src/services/stats/UsageStatsDatabase.ts`
- `src/services/stats/UsageStatsProjection.ts`
- `src/extension.ts`, `src/activate/registerCommands.ts` (lifecycle reference only)
