# 🪲 Debug Task Report — Comprehensive Dashboard Loading Investigation

## Task Summary
Investigate why the Dashboard's "Today" preset does not show correctly and why switching to 7d / 30d / Custom / All causes a "Loading" indicator that persists too long. Branch: `feature/local-usage-stats`. **Investigation only — no code changes made.**

## Investigation Method (8-Stage Diagnostic)
Full causal chain traced end-to-end:
`DashboardView preset click → handlePresetChange → useEffect → replaceSubscription (hook) → vscode.postMessage → handleReplaceDashboardStatsSubscription → UsageStatsStreamCoordinator.replaceSubscription → subscribe → sendSnapshot → rebuildRollupsFromEvents guard → snapshot posted back → reducer SNAPSHOT → isResyncing cleared`.

Files read in full: [`useDashboardStatsStream.ts`](webview-ui/src/components/dashboard/useDashboardStatsStream.ts), [`dashboardStreamReducer.ts`](webview-ui/src/components/dashboard/dashboardStreamReducer.ts), [`DashboardView.tsx`](webview-ui/src/components/dashboard/DashboardView.tsx), [`usageStatsMessageHandler.ts`](src/core/webview/usageStatsMessageHandler.ts), [`UsageStatsStreamCoordinator.ts`](src/services/stats/UsageStatsStreamCoordinator.ts), [`UsageStatsDatabase.ts`](src/services/stats/UsageStatsDatabase.ts), [`UsageAggregator.ts`](src/services/stats/UsageAggregator.ts).

---

## Answers to the 8 Investigation Points

### 1. Frontend Loading State (`isLoading`)
[`dashboardStreamReducer.ts`](webview-ui/src/components/dashboard/dashboardStreamReducer.ts:202):
- `SUBSCRIBE` → `status:"loading"`, `isLoading:true`.
- `SNAPSHOT` → `isLoading:false`, `status:"connected"`.
- `REPLACE_SUBSCRIPTION` (line 215): **if prior data exists (`state.totals !== null`), `isLoading` stays `false`.** Only the very first load (no data) sets `isLoading:true`.
- `ERROR` → `isLoading:false`, sets `backgroundError`, `status:"error"`.

So on a preset *switch* with existing data, `isLoading` is **never** re-set. The spinner the user sees on preset switch is **NOT** `isLoading` — it is the separate `isResyncing` local state.

### 2. Preset Change Flow (`handlePresetChange`)
[`DashboardView.tsx`](webview-ui/src/components/dashboard/DashboardView.tsx:262):
```
handlePresetChange(newPreset) → setPreset(newPreset) + setIsResyncing(true)
```
This does **not** call `replaceSubscription` directly. The `preset` state change triggers the `useEffect` at line 185, which detects `presetChanged` and calls [`replaceSubscription(buildQuery(...))`](webview-ui/src/components/dashboard/DashboardView.tsx:202). So yes — every preset click (7d/30d/All/custom) flows through `replaceSubscription`.

`isResyncing` is cleared only by the `useEffect` at line 209, which fires when [`streamState.generatedAt`](webview-ui/src/components/dashboard/DashboardView.tsx:214) changes — i.e. when a **new snapshot** arrives.

### 3. `replaceSubscription` Flow (hook)
[`useDashboardStatsStream.ts`](webview-ui/src/components/dashboard/useDashboardStatsStream.ts:212): generates a **new requestId** (new epoch), dispatches `REPLACE_SUBSCRIPTION`, posts `replaceDashboardStatsSubscription`. The old subscription is replaced atomically on the backend — see #4/#5. **No explicit unsubscribe message is sent from the hook on replace** — the backend's `replaceSubscription` handles removal of the old subscription internally (line 191 deletes the old sink entry before re-subscribing). **No frontend race here** because the new `requestId` epoch causes any stale-epoch snapshot/delta to be silently rejected by the reducer (lines 244, 304, 386).

### 4. Backend Subscription Handler
[`handleReplaceDashboardStatsSubscription`](src/core/webview/usageStatsMessageHandler.ts:1115) validates the payload via Zod and calls [`coordinator.replaceSubscription(sink, sub)`](src/core/webview/usageStatsMessageHandler.ts:1144). It is synchronous (no `await` on the coordinator call). If `replaceSubscription` throws, it posts a `dashboardStatsStreamError`. **It does NOT time out.**

### 5. Coordinator Subscription Lifecycle
[`UsageStatsStreamCoordinator.replaceSubscription`](src/services/stats/UsageStatsStreamCoordinator.ts:187): deletes the old sink entry, then calls [`subscribe()`](src/services/stats/UsageStatsStreamCoordinator.ts:157), which calls [`sendSnapshot(state)`](src/services/stats/UsageStatsStreamCoordinator.ts:180). `sendSnapshot` **does** assemble and send the initial snapshot immediately — **but it runs the rebuild guard first**, synchronously, on the extension host's main thread. This is the critical path (see #8).

### 6. Timeout Handling
[`useDashboardStatsStream.ts`](webview-ui/src/components/dashboard/useDashboardStatsStream.ts:180): the timeout is **10 seconds** (not 30s as the task brief stated). It only starts when `state.isLoading` is true. Since preset switches with prior data keep `isLoading:false`, **the timeout never fires on preset switches** — so it cannot rescue a stuck `isResyncing`. On first load (`isLoading:true`), if the snapshot takes >10s, the timeout dispatches `ERROR` with code `STATS_HANDLER/stream/timeout`, which sets `backgroundError` and `status:"error"` and clears `isLoading` — so the first-load spinner self-recovers after 10s. The timer is cleared via the effect cleanup when `isLoading` flips to false (snapshot arrives). **Timeout works correctly but is irrelevant to the reported bug** (which is `isResyncing`, not `isLoading`).

### 7. "Today" Preset Specifics
[`resolveTimeRange`](src/services/stats/UsageAggregator.ts:190): "today" = `startOfDayInTimezone(now)` → same time next day. 7d/30d are computed identically (N calendar days back from tomorrow-midnight). **"today" is not special in range resolution.** The only difference: "today" yields the smallest window, so if the user's events today are zero (or rollups for today are missing), "today" produces an **empty `totals`** → `hasData = totals.events > 0` is false → Dashboard renders the **empty state** ([`DashboardView.tsx`](webview-ui/src/components/dashboard/DashboardView.tsx:633)), which the user may perceive as "not working". This connects directly to #8: if rollups are empty and the rebuild guard doesn't fire or is slow, "today" stays empty.

### 8. `rebuildRollupsFromEvents` — **THE ROOT CAUSE (Performance / Blocking)**
The newly added guard in [`sendSnapshot`](src/services/stats/UsageStatsStreamCoordinator.ts:470):
```
if (!this.rollupsRebuilt) {
    const coverage = queryCoverageStats(from,to)
    const hasRawEvents = coverage.firstEventAt !== undefined
    if (hasRawEvents) {
        const hasEmptyDerivedTables = sessions.sessions.length === 0 || heatmap.values.every(v => v === 0)
        if (hasEmptyDerivedTables) {
            this.database.rebuildRollupsFromEvents()   // ← SYNCHRONOUS, BLOCKING
            ...
        }
    }
}
```

[`rebuildRollupsFromEvents()`](src/services/stats/UsageStatsDatabase.ts:874) is **100% synchronous**:
- `db.exec("BEGIN")`, deletes all rows from `stats_rollup` / `session_metadata` / `session_activity`.
- Loops over **every row** in `usage_events` in batches of 1000.
- Per event: calls [`this.updateRollup()`](src/services/stats/UsageStatsDatabase.ts:964) up to **10 times** (daily/monthly/lifetime aggregate + 3 axis breakdowns × daily/monthly/lifetime + non-cancelled ×3) plus `session_metadata` and `session_activity` prepared-statement upserts, plus `JSON.parse(usage_json)` and `getEffectiveCost`.
- All inside **one transaction**, using better-sqlite3 (synchronous driver).

**Impact**: better-sqlite3 runs on the Node main thread. For a large `usage_events` table, this blocks the extension host event loop for seconds to tens of seconds. During that block, **no webview messages are processed** — including the snapshot response itself and any subsequent preset clicks. The user sees the `isResyncing` spinner hang until the rebuild completes and the snapshot finally posts.

Crucially, the guard's trigger condition `heatmap.values.every(v => v === 0)` means: **on a database where derived tables are empty (or all-zero heatmap) but raw events exist, the rebuild fires on the FIRST snapshot of every new coordinator epoch** — and `rollupsRebuilt` is an instance field reset per coordinator. Since `replaceSubscription` reuses the same coordinator, `rollupsRebuilt` latches true after the first rebuild, so subsequent preset switches are fast. **But on app start / first dashboard open, or after any coordinator recreation, the first preset interaction triggers the full blocking rebuild.** Combined with the empty-derived-tables condition, this explains why "Today" (small/empty window) appears broken and why switching presets right after startup feels stuck.

---

## Root Cause Assessment
- **Confidence: HIGH** (static analysis; blocking synchronous DB call on main thread is unambiguous).
- **Primary root cause**: [`UsageStatsDatabase.rebuildRollupsFromEvents()`](src/services/stats/UsageStatsDatabase.ts:874) is a synchronous, O(N events × ~12 upserts) blocking operation invoked from [`UsageStatsStreamCoordinator.sendSnapshot()`](src/services/stats/UsageStatsStreamCoordinator.ts:482) on the extension host main thread. It delays the snapshot response, so `isResyncing` (cleared only by a new `generatedAt`) stays true for the entire rebuild duration. It is "real loading", not "fake loading" — but it is real loading caused by a blocking main-thread rebuild, not by streaming latency.
- **Secondary (Today-specific)**: when "today" has no events / empty rollups, `hasData=false` renders the empty state, and the rebuild guard's `heatmap.all-zero` trigger means "today" is the preset most likely to both (a) show empty and (b) be the first snapshot that triggers the rebuild.

## Answers to Key Questions
- **Frontend stuck, or backend slow?** Backend slow. `rebuildRollupsFromEvents` blocks the event loop; the snapshot that would clear `isResyncing` is delayed by the rebuild.
- **Race condition between unsubscribe/subscribe?** No. Epoch-based stale rejection (requestId) makes stale snapshots/deltas harmless. Coordinator replaces the sink atomically.
- **Does the timeout work?** Yes (10s, first-load only), but it never engages on preset switches because `isLoading` stays false; the visible hang is `isResyncing`, which has no timeout.
- **Is `rebuildRollupsFromEvents()` blocking and slow?** Yes — synchronous better-sqlite3, single transaction, ~12 upserts per event across all events.
- **Does "today" produce empty while others work?** It can, when today's rollups are empty/missing — which is also what flips the rebuild guard on.

## Recommendations (for Code mode — NOT applied)
1. Make the rebuild **non-blocking**: run `rebuildRollupsFromEvents` off the main thread (worker) or chunk it with `setImmediate`/`process.nextTick` yields between batches, and send the snapshot immediately with a "rebuilding" flag rather than after.
2. Send the snapshot **first** (even with empty derived tables), then trigger the rebuild asynchronously and push a fresh snapshot/delta on completion. This matches the stale-while-revalidate design already used by `REPLACE_SUBSCRIPTION`.
3. Reconsider the trigger: `heatmap.all-zero` is a weak proxy for "derived tables empty" (a legitimately inactive user has an all-zero heatmap). Prefer an explicit `SELECT COUNT(*) FROM stats_rollup` emptiness check.
4. Optionally give `isResyncing` its own timeout/clear path so the UI can never hang indefinitely regardless of backend latency.

## Test Environment Issues
None encountered. This was a static investigation; no test infra changes were needed.

## Verification
Static trace of the full chain only. To confirm dynamically (next phase): launch the extension host, seed a large `usage_events` table with empty derived tables, open Dashboard, and time `sendSnapshot` / observe the extension-host event-loop block during the first preset interaction.

## Next Step Recommendations
Escalate to **Code mode** with recommendation #1/#2 (make rebuild async + snapshot-first). Severity: **Medium structural** — direct fix is safe and localized to the coordinator/database layer; no plan rejection needed.

## Affected File List
- [`src/services/stats/UsageStatsStreamCoordinator.ts`](src/services/stats/UsageStatsStreamCoordinator.ts) (rebuild guard, snapshot path)
- [`src/services/stats/UsageStatsDatabase.ts`](src/services/stats/UsageStatsDatabase.ts) (`rebuildRollupsFromEvents`)
- [`webview-ui/src/components/dashboard/DashboardView.tsx`](webview-ui/src/components/dashboard/DashboardView.tsx) (`isResyncing` lifecycle)
- [`webview-ui/src/components/dashboard/useDashboardStatsStream.ts`](webview-ui/src/components/dashboard/useDashboardStatsStream.ts) (timeout scope — informational)
- [`webview-ui/src/components/dashboard/dashboardStreamReducer.ts`](webview-ui/src/components/dashboard/dashboardStreamReducer.ts) (`isLoading` semantics — informational)
- [`src/services/stats/UsageAggregator.ts`](src/services/stats/UsageAggregator.ts) (`resolveTimeRange` — informational)
