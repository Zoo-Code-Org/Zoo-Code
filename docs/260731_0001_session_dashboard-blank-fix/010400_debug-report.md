# Debug Task Report — Dashboard "No usage data yet" Despite Existing Data

## Task Summary

Investigate why the Dashboard on `feature/local-usage-stats` renders "No usage data yet" even though the user has usage data. Scope: backend data path only, no code modification. Traced the full chain: `usageStatsMessageHandler` → `UsageStatsService` → `UsageStatsStreamCoordinator` → `UsageStatsProjection` → `UsageStatsDatabase` (plus `ClineProvider` wiring, `UsageEventStore`, `UsageStatsMigration` for context).

## Causal Chain Map (dashboard stats snapshot path)

```
Webview "subscribeDashboardStats"
  └─ handleSubscribeDashboardStats()                    [usageStatsMessageHandler.ts:1045]
       └─ getCoordinatorAndSink()                       [usageStatsMessageHandler.ts:986]
            ├─ provider.getUsageStatsService()          [ClineProvider.ts:3330]
            ├─ service.ensureInitialized()              [UsageStatsService.ts:178]   ← GATE 1
            └─ service.getCoordinator()                 [UsageStatsService.ts:209]   ← GATE 2
       └─ coordinator.subscribe(sink, sub)              [UsageStatsStreamCoordinator.ts:156]
            └─ sendSnapshot(state)                      [UsageStatsStreamCoordinator.ts:441]
                 ├─ assembleRollupSnapshot(db, query)   [UsageStatsProjection.ts:390] ← READS stats_rollup
                 ├─ computeSessionPage(db, ...)         [UsageStatsProjection.ts:586] ← READS session_metadata
                 └─ computeHeatmapSnapshot(db, ...)     [UsageStatsProjection.ts:619] ← READS stats_rollup (daily)
```

Write path (how data gets in):

```
UsageRecorder → service.append(event)                   [UsageStatsService.ts:243]
  └─ store.append(event)                                [UsageEventStore.ts:223]
       ├─ appendInternal(event)  → NDJSON (durable)     [UsageEventStore.ts:234]
       └─ database.append(event) → SQLite usage_events + rollups (BEST-EFFORT, swallowed) [UsageEventStore.ts:239-245]
```

Key architectural fact: **the dashboard stream snapshot reads ONLY from SQLite derived tables (`stats_rollup`, `session_metadata`), never from NDJSON.** The NDJSON store is the durable write path; SQLite is a best-effort mirror. Any divergence between the two shows up exactly as "NDJSON has data, dashboard shows nothing."

---

## Answers to the Three Focus Questions

### (1) Does `ensureInitialized()` fail silently? — YES, in three distinct ways

**1a. `ensureInitialized()` is a no-op when `initialize()` was never called.**
[`UsageStatsService.ensureInitialized()`](src/services/stats/UsageStatsService.ts:178) only awaits `this.initPromise` **if it exists**:

```ts
async ensureInitialized(): Promise<void> {
    if (this.initPromise) {      // ← null if initialize() never invoked
        await this.initPromise
    }
}                                 // silently returns otherwise
```

It never triggers initialization itself. In `ClineProvider` ([ClineProvider.ts:327-331](src/core/webview/ClineProvider.ts:327)) `initialize()` is fired with `.catch()` and on failure sets `this.usageStatsService = undefined`. So the error is "handled" by making the service disappear — but the log line is the only trace.

**1b. SQLite init failure is swallowed with `console.warn`.**
[`doInitialize()`](src/services/stats/UsageStatsService.ts:141-147):

```ts
try {
    this.database.initialize()
} catch (err) {
    console.warn("[UsageStatsService] Failed to initialize SQLite database:", err)
}   // ← continues; service "initializes" successfully without a DB
```

The service still resolves, `store.initialize()` still runs against NDJSON, and a coordinator is created with `database = null` ([UsageStatsService.ts:173-175](src/services/stats/UsageStatsService.ts:173)). `node:sqlite` (`DatabaseSync`) requires a recent Node runtime; if the extension host runs an older Node/Electron where `node:sqlite` is unavailable or throws, this is exactly what happens. Result: NDJSON recording works fine, dashboard snapshot path has no database and `sendSnapshot` emits `STATS_STREAM/subscribe/001 "Database not available"` — which the webview may or may not surface.

**1c. `getDatabase()` returns null after partial init.**
[`getDatabase()`](src/services/stats/UsageStatsService.ts:200) returns `null` when `_isInitialized()` is false, and [`handleRebuildUsageStats`](src/core/webview/usageStatsMessageHandler.ts:249-261) / [`handleGetDashboardSessionPage`](src/core/webview/usageStatsMessageHandler.ts:1287-1299) convert that into a soft error message rather than a hard failure.

### (2) Are rollup tables empty while `usage_events` has data? — YES, this is the primary structural defect, and the self-heal guard is inverted

The dashboard never reads `usage_events` directly on the fast path. [`assembleRollupSnapshot()`](src/services/stats/UsageStatsProjection.ts:390) routes single-axis queries (model/provider/mode/day — the dashboard default) to [`assembleRollupSnapshotFast()`](src/services/stats/UsageStatsProjection.ts:410), which reads exclusively from `stats_rollup` via `queryLifetimeTotalsFiltered` / `queryDailyRollupsDetailed` / `queryBreakdownRollups`. Sessions come from `session_metadata` via `querySessions`. Heatmap comes from `stats_rollup` daily rows.

**How rollups can be empty while `usage_events` has rows:**

- **Events appended before DB existed.** [`UsageEventStore.append()`](src/services/stats/UsageEventStore.ts:239) only mirrors to SQLite `if (this.database && this.database._isInitialized())`. Everything recorded before the SQLite feature landed (or while init failed) lives only in NDJSON.
- **DB append failures are swallowed.** [UsageEventStore.ts:242-244](src/services/stats/UsageEventStore.ts:242): `catch (dbErr) { console.warn(...) }` — the NDJSON write already succeeded, so the event exists for export/query-by-scan but never reaches `usage_events`/rollups.
- **NDJSON→SQLite migration is checkpointed and one-shot-ish.** [`UsageStatsMigration.migrate()`](src/services/stats/UsageStatsMigration.ts:81) returns early when `checkpoint.complete` is true. If migration ran against an empty/partial NDJSON dir (or crashed after marking progress), later events are only migrated if the migration is re-run — it only runs inside `doInitialize()` and only when `this.database._isInitialized()`. If it throws, it's swallowed ([UsageStatsService.ts:165-167](src/services/stats/UsageStatsService.ts:165)).
- **Rollup writes are not retroactive.** `appendInternal`/`bulkAppend` update rollups only for the event being inserted right then. There is no background reconciliation from `usage_events` → `stats_rollup`.

**The auto-rebuild guard meant to catch exactly this case is inverted** — [`UsageStatsStreamCoordinator.sendSnapshot()`](src/services/stats/UsageStatsStreamCoordinator.ts:468):

```ts
// Auto-detect rollup staleness: if stats has data but sessions/heatmap
// are empty, the derived tables ... are stale or missing.
if (!this.rollupsRebuilt && stats.totals.events > 0) {
    const hasEmptyDerivedTables = sessions.sessions.length === 0 || heatmap.values.every((v) => v === 0)
    if (hasEmptyDerivedTables) { ... rebuildRollupsFromEvents() ... }
}
```

`stats.totals.events` is itself computed **from `stats_rollup`** (fast path). If the whole rollup table is empty/stale, `stats.totals.events === 0`, so the condition `stats.totals.events > 0` is false and the rebuild **never fires**. The detector uses the very table whose emptiness it's supposed to detect as its own precondition. The correct source-of-truth check would be against `usage_events` (e.g. `queryCoverageStats` / a `COUNT(*)` on `usage_events`, which reads the raw table, not rollups). As written, the only recovery path is the manual `rebuildUsageStats` message — which itself requires `service.getDatabase()` to be non-null ([usageStatsMessageHandler.ts:249](src/core/webview/usageStatsMessageHandler.ts:249)).

Additionally `rollupsRebuilt` is a one-shot flag per coordinator instance; if the first rebuild attempt throws, it's set to `true` in the catch block ([UsageStatsStreamCoordinator.ts:489-491](src/services/stats/UsageStatsStreamCoordinator.ts:489)) and never retried for the lifetime of that coordinator.

### (3) Does `assembleRollupSnapshot` return empty? — YES, by design, when rollup tables are empty

[`assembleRollupSnapshot()`](src/services/stats/UsageStatsProjection.ts:390) never throws for the empty-rollup case; it returns a well-formed but zero-valued snapshot:

- Fast path (dashboard default single-axis queries): [`queryLifetimeTotalsFiltered()`](src/services/stats/UsageStatsDatabase.ts:2065) returns an all-zero row object when no `stats_rollup` lifetime row exists ([UsageStatsDatabase.ts:2095-2110](src/services/stats/UsageStatsDatabase.ts:2095)). `queryDailyRollupsDetailed` / `queryBreakdownRollups` return `[]`. Result: `totals.events = 0`, `buckets = []`.
- `coverage.firstEventAt/lastEventAt` come from [`queryCoverageStats()`](src/services/stats/UsageStatsDatabase.ts:2139), which **does** read raw `usage_events` — so if `usage_events` has rows but rollups are empty, the snapshot has `totals.events = 0` **while `coverage.firstEventAt` is set**. That mismatch is a reliable fingerprint of this bug and can be confirmed from the webview's received snapshot payload.
- The event-scan fallback path (`assembleRollupSnapshotFromEvents`, used for multi-axis/week/month/source/status/cacheRatio queries) reads `usage_events` via `readAllEvents()` — so those query shapes would show data. This explains why the bug is specific to the dashboard's default single-axis view.

The webview receives `dashboardStatsStreamSnapshot` with zero totals, empty sessions, all-zero heatmap — and renders "No usage data yet".

---

## Root Cause Assessment

- **Confidence: HIGH** (static-analysis based; runtime confirmation recommended via the fingerprint below)
- **Primary defect:** [`UsageStatsStreamCoordinator.sendSnapshot()`](src/services/stats/UsageStatsStreamCoordinator.ts:468) staleness detector keys off `stats.totals.events > 0`, a value derived from the same `stats_rollup` table whose emptiness it is meant to detect. When `usage_events` has data and rollups are empty, the self-heal never triggers and the dashboard renders the empty state permanently.
- **Contributing defects (silent-failure chain):**
  1. [`UsageStatsService.doInitialize()`](src/services/stats/UsageStatsService.ts:143-147) swallows DB init failure → coordinator created with `database = null` → `STATS_STREAM/subscribe/001`.
  2. [`UsageEventStore.append()`](src/services/stats/UsageEventStore.ts:239-245) treats SQLite as best-effort; NDJSON↔SQLite divergence is permanent without reconciliation.
  3. [`ensureInitialized()`](src/services/stats/UsageStatsService.ts:178) is a no-op if `initialize()` was never called.
  4. Migration checkpoint `complete=true` is terminal; a partially migrated store never resumes.

## Fingerprint to Confirm at Runtime (no code change needed)

1. Open the actual DB at `<globalStorage>/usage-stats/usage.db` and run:
   - `SELECT COUNT(*) FROM usage_events;` → expect **> 0**
   - `SELECT COUNT(*) FROM stats_rollup;` → expect **0** (or far fewer than events)
   - `SELECT COUNT(*) FROM session_metadata;` → expect **0**
2. In the webview, inspect the received `dashboardStatsStreamSnapshot`: `stats.totals.events === 0` while `stats.coverage.firstEventAt` is non-null → confirms rollup-empty/events-present split-brain.
3. Extension host logs: look for `[UsageStatsService] Failed to initialize SQLite database:` or `[UsageEventStore] database append failed`.

## Suggested Fix Directions (for VP/Code mode — NOT applied)

1. Fix the detector precondition: in `sendSnapshot`, check `usage_events` emptiness directly (e.g. `queryCoverageStats(0, MAX_SAFE_INTEGER)` or a cheap `SELECT 1 ... LIMIT 1`) instead of `stats.totals.events > 0`, then rebuild when events exist but derived tables are empty. Don't set `rollupsRebuilt = true` on failure — retry with backoff.
2. Surface DB init failure: make `doInitialize` propagate or at least expose `databaseInitError` so the webview can show "stats database unavailable" instead of "No usage data yet".
3. Add a reconcile-on-start: after migration, if `usage_events` count ≠ rollup-derived event count, run `rebuildRollupsFromEvents()`.
4. Route the "manual rebuild" button through the same guard so users always have an escape hatch even when `getDatabase()` is null (currently blocked at handler level).

## Test Environment Issues

None encountered. Investigation was pure static analysis; no test environment setup was required (task explicitly forbade code modification and requested the backend trace only).

## Verification Status

- Static trace: complete, all 5 requested files read in full (UsageStatsDatabase.ts: 2699 lines, read in two chunks).
- Runtime test: not executed (no-modification constraint; host DB location is user-machine-specific). The fingerprint procedure above is ready for VP/user execution.

## Affected File List (read/analyzed, none modified)

- `src/core/webview/usageStatsMessageHandler.ts`
- `src/services/stats/UsageStatsService.ts`
- `src/services/stats/UsageStatsStreamCoordinator.ts`
- `src/services/stats/UsageStatsProjection.ts`
- `src/services/stats/UsageStatsDatabase.ts`
- `src/core/webview/ClineProvider.ts` (lines 92-343, 827-828, 3326-3332)
- `src/services/stats/UsageEventStore.ts` (lines 121-280, 894-896)
- `src/services/stats/UsageStatsMigration.ts` (lines 60-209)

## Next Step Recommendations

1. Route to **Code mode** with fix direction #1 (detector precondition) as the primary surgical fix — smallest blast radius, directly resolves the reported symptom.
2. Have the user run the 3-query fingerprint against their live `usage.db` to confirm the rollup-empty split-brain before and after the fix.
3. Consider a follow-up task for fix directions #2/#3 (init-failure surfacing + startup reconciliation) as hardening, since they cover the adjacent silent-failure paths found during impact analysis.
