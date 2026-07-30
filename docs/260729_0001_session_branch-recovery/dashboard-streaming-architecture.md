# Dashboard Streaming Update Architecture

> ⚠️ Written based on internal knowledge (potentially outdated) due to search restrictions. The external search did not confirm the runtime status of the built-in [`node:sqlite`](src/package.json:14) API. Before implementation, validate it against the [Node.js SQLite documentation](https://nodejs.org/api/sqlite.html) and the Node.js runtime embedded by the supported [VS Code 1.100 engine](src/package.json:13). If that API is unavailable or unsuitable, dependency adoption requires a separate Architecture Decision Record rather than an unreviewed package addition.

## Overview

The dashboard currently has push **invalidation**, not push **data**. A completed usage event causes the extension host to send [`usageStatsChanged`](packages/types/src/vscode-extension-host.ts:119). [`DashboardView()`](webview-ui/src/components/dashboard/DashboardView.tsx:41) waits 250 ms and then requests two complete datasets. During each automatic request, [`fetchStats()`](webview-ui/src/components/dashboard/DashboardView.tsx:186) sets the page-level loading flag, and [`fetchSessions()`](webview-ui/src/components/dashboard/DashboardView.tsx:212) sets the session loading flag. The render branch then removes the dashboard data and shows a loading state. This is the direct source of flicker.

The full request is also proportional to accumulated history. [`UsageStatsService.queryStats()`](src/services/stats/UsageStatsService.ts:171) reads every event, and [`UsageAggregator.query()`](src/services/stats/UsageAggregator.ts:73) filters and aggregates the entire array. Session loading repeats the read and then groups, sorts, and derives a title for every matching session in [`buildSessionSummaries()`](src/core/webview/usageStatsMessageHandler.ts:522). The UI finally renders every session through [`sessions.map()`](webview-ui/src/components/dashboard/SessionList.tsx:218). A 250 ms debounce reduces request count, but it does not change the cost of each request.

The recommended design is **Option A**, a durable indexed usage read model plus a versioned dashboard subscription over VS Code [`postMessage()`](webview-ui/src/components/dashboard/DashboardView.tsx:199). The host sends one bounded initial snapshot, then coalesced additive deltas. The webview applies deltas through a reducer while retaining the current DOM. Only affected numeric values and rows render again. Sessions are cursor-paged and virtualized, so extension-host query cost, message size, webview memory, and DOM count remain bounded as session history grows.

This plan follows the project principles in [`ethos.md`](../../../.roo/rules/ethos.md): search before building, use a proven local database instead of inventing an index, preserve user control, keep sensitive content out of telemetry, and test the Frontend ↔ Backend boundary.

---

# 1. Technical Specification

## 1.1 Goals and measurable constraints

1. **No automatic page replacement.** Once the first snapshot is visible, background updates must not set page-level or session-list loading state. A manual refresh, reset, reconnect, range change, or midnight rollover keeps the old view mounted until an atomic replacement arrives.
2. **Incremental numeric updates.** A committed usage event updates totals, one selected breakdown bucket, one heatmap day, and one session summary. Numeric displays animate from the prior value to the new value over 120–180 ms, respect reduced-motion settings, and use tabular numerals.
3. **Session-count-independent active cost.** Normal append and stream work is bounded by indexes, the number of events in the current batch, and the configured page size. It must not read, send, retain, or render every historic session.
4. **Bounded resources.** Default session page size is 50, maximum is 100. A stream batch contains at most 100 events or 64 KiB of serialized delta data, whichever comes first. The host keeps one query descriptor and cursors per visible dashboard, not a copy of the event history.
5. **Exact recovery.** Every durable event has a monotonic sequence and store generation. Duplicate deltas are ignored. A gap, generation mismatch, reset, or malformed delta causes a background snapshot replacement without blanking the page.
6. **Filter consistency.** Main dashboard filters continue to support today, 7 days, 30 days, custom, and all-time behavior from [`buildQuery()`](webview-ui/src/components/dashboard/DashboardView.tsx:119). The independent heatmap continues to support 30, 60, 120, and 360 days from [`RANGE_DAYS`](webview-ui/src/components/stats/UsageHeatmap.tsx:68).
7. **Lifecycle correctness.** Leaving the internal dashboard tab unsubscribes because [`App()`](webview-ui/src/App.tsx:251) unmounts the dashboard. Hiding and showing the VS Code webview pauses delta delivery and resumes from the last sequence or replaces the snapshot if recovery cannot be satisfied.
8. **Privacy parity.** Stream payloads contain only existing usage-stat fields. Prompt bodies, response bodies, API keys, and workspace paths remain excluded by [`UsageEventV1`](packages/types/src/usage-stats.ts:35).

## 1.2 Current data flow analysis

### A. Initial load and user-triggered refresh

| Step | From                                                                               | Boundary payload                                                                                                                                     | To                                                                              | Current consequence                                                                                                       |
| ---- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1    | [`DashboardView()`](webview-ui/src/components/dashboard/DashboardView.tsx:41)      | [`getUsageStats`](packages/types/src/vscode-extension-host.ts:740) with request correlation and [`StatsQuery`](packages/types/src/usage-stats.ts:77) | Extension host                                                                  | [`fetchStats()`](webview-ui/src/components/dashboard/DashboardView.tsx:186) sets page loading before sending.             |
| 2    | [`handleGetUsageStats()`](src/core/webview/usageStatsMessageHandler.ts:52)         | Validated query                                                                                                                                      | [`UsageStatsService.queryStats()`](src/services/stats/UsageStatsService.ts:171) | The service requests all stored events.                                                                                   |
| 3    | [`UsageEventStore.readAll()`](src/services/stats/UsageEventStore.ts:257)           | Entire cached or rescanned event array                                                                                                               | [`UsageAggregator.query()`](src/services/stats/UsageAggregator.ts:73)           | Warm disk reads can be cached, but filtering, projection, grouping, totals, and coverage are still linear in event count. |
| 4    | Extension host                                                                     | [`getUsageStatsResponse`](packages/types/src/vscode-extension-host.ts:115) with complete [`StatsSnapshot`](packages/types/src/usage-stats.ts:116)    | [`DashboardView()`](webview-ui/src/components/dashboard/DashboardView.tsx:346)  | The complete snapshot replaces component state.                                                                           |
| 5    | [`DashboardView()`](webview-ui/src/components/dashboard/DashboardView.tsx:212)     | [`getDashboardSessions`](packages/types/src/vscode-extension-host.ts:747) with the same range                                                        | Extension host                                                                  | Session loading is set independently.                                                                                     |
| 6    | [`handleGetDashboardSessions()`](src/core/webview/usageStatsMessageHandler.ts:606) | Filtered raw events                                                                                                                                  | [`buildSessionSummaries()`](src/core/webview/usageStatsMessageHandler.ts:522)   | Every matching event is grouped and each matching task title is read before the whole array is returned.                  |
| 7    | Extension host                                                                     | [`dashboardSessionsResponse`](packages/types/src/vscode-extension-host.ts:122) with every summary                                                    | [`SessionList()`](webview-ui/src/components/dashboard/SessionList.tsx:191)      | Every session remains in React state and is mapped into the DOM.                                                          |

### B. Same-window update

| Step | From                                                                            | Event                                                                          | To                                                                          | Current consequence                                                                                           |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1    | Task lifecycle                                                                  | [`UsageRecorder.finalizeUsageEvent()`](src/services/stats/UsageRecorder.ts:94) | [`UsageStatsService.append()`](src/services/stats/UsageStatsService.ts:160) | One event is durably appended at terminal API-attempt finalization, not per token chunk.                      |
| 2    | [`UsageRecorder.finalizeUsageEvent()`](src/services/stats/UsageRecorder.ts:149) | Successful append callback                                                     | [`ClineProvider.postMessageToWebview()`](src/core/task/Task.ts:639)         | A payload-free [`usageStatsChanged`](packages/types/src/vscode-extension-host.ts:119) invalidation is pushed. |
| 3    | [`DashboardView()`](webview-ui/src/components/dashboard/DashboardView.tsx:360)  | Debounced invalidation                                                         | Both full request paths                                                     | The page and session loading branches are re-entered, causing flicker and repeated history-wide work.         |

### C. Cross-window update

| Step | From                                                                             | Event                     | To                                                                                    | Current consequence                                                                               |
| ---- | -------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1    | Another VS Code window                                                           | Segment-file append       | [`UsageStatsService.setupFileWatcher()`](src/services/stats/UsageStatsService.ts:327) | File changes are coalesced for 300 ms.                                                            |
| 2    | [`UsageStatsService.onDidChange()`](src/services/stats/UsageStatsService.ts:141) | Payload-free notification | [`ClineProvider`](src/core/webview/ClineProvider.ts:329)                              | The current window pushes [`usageStatsChanged`](packages/types/src/vscode-extension-host.ts:119). |
| 3    | Dashboard listener                                                               | Debounced invalidation    | Full snapshot and full session requests                                               | The same history-wide work occurs after an additional debounce layer.                             |

### D. Heatmap behavior

[`UsageHeatmap()`](webview-ui/src/components/stats/UsageHeatmap.tsx:79) owns a separate request and listener. It loads once on mount and whenever the user changes its range through [`handleRangeChange()`](webview-ui/src/components/stats/UsageHeatmap.tsx:141). It does **not** react to [`usageStatsChanged`](packages/types/src/vscode-extension-host.ts:119), so today’s heatmap cell can remain stale while the summary and sessions refresh.

### E. Existing push/subscription answer

There is an existing push path, but no query-scoped subscription and no changed data in its payload. The push path is therefore an invalidation bus, not a streaming architecture. It can wake an active dashboard, including after a cross-window append, but it cannot update a number without issuing a full query.

### F. Source wiring blocker found during investigation

The message contracts declare [`getUsageStats`](packages/types/src/vscode-extension-host.ts:740) and the handler functions exist in [`usageStatsMessageHandler.ts`](src/core/webview/usageStatsMessageHandler.ts:1), but the current source copy of [`webviewMessageHandler.ts`](src/core/webview/webviewMessageHandler.ts:1) contains no imports or routing cases for those handlers. Direct tests call the handlers themselves in [`usageStatsMessageHandler.spec.ts`](src/core/webview/__tests__/usageStatsMessageHandler.spec.ts:121), which does not prove end-to-end source routing. This appears consistent with an incomplete branch-recovery state. Stream implementation must first restore or explicitly confirm runtime routing; otherwise both the existing and proposed protocols are unreachable from source builds.

## 1.3 Why current cost grows

| Area            |                                                                                                       Current complexity | Growth symptom                                               |                                                                                           Required bound |
| --------------- | -----------------------------------------------------------------------------------------------------------------------: | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------: |
| Stats refresh   |          Linear in all events for each request via [`UsageAggregator.query()`](src/services/stats/UsageAggregator.ts:73) | CPU and allocations grow even on a warm event cache.         |                                                    Indexed or materialized query plus event-sized delta. |
| Session refresh | Linear in filtered events and sessions via [`buildSessionSummaries()`](src/core/webview/usageStatsMessageHandler.ts:522) | Repeated sorting, grouping, title reads, and large messages. |                         Cursor page of at most 100 summaries plus one upsert per changed active session. |
| Webview state   |                                                                                              Linear in returned sessions | Heap grows with all summaries.                               |                                                                One bounded page and one expanded detail. |
| Session DOM     |              Linear in returned sessions via [`sessions.map()`](webview-ui/src/components/dashboard/SessionList.tsx:218) | React reconciliation and layout grow.                        | Existing [`react-virtuoso`](webview-ui/src/components/history/HistoryView.tsx:7) with bounded page data. |
| Automatic UX    |         Full data branch removed whenever [`loading`](webview-ui/src/components/dashboard/DashboardView.tsx:680) is true | Visible spinner and page replacement.                        |                                               Initial-only loading; background state is non-destructive. |

## 1.4 Proposed streaming architecture

### A. Storage and projection model

Use one shared SQLite database under the existing usage-stat storage directory. Keep the public roles of [`UsageEventStore`](src/services/stats/UsageEventStore.ts:120), [`UsageStatsService`](src/services/stats/UsageStatsService.ts:90), and [`UsageAggregator`](src/services/stats/UsageAggregator.ts:65), but replace history-wide NDJSON reads for dashboard paths with indexed queries and persisted projections.

The database owns these logical tables:

| Planned table                                                    | Purpose                                                                                 | Key indexes                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`usage_events`](src/services/stats/UsageStatsDatabase.ts:1)     | Canonical, privacy-safe event rows with a monotonic sequence and unique event identity. | Unique event identity; sequence; occurrence time; root task; model; provider; mode. |
| [`stats_rollup`](src/services/stats/UsageStatsDatabase.ts:1)     | Additive totals by day, month, lifetime, and dashboard axis/value.                      | Grain plus period plus axis/value.                                                  |
| [`session_metadata`](src/services/stats/UsageStatsDatabase.ts:1) | One row per root session with title and lifetime totals.                                | Root task identity; last activity descending.                                       |
| [`session_activity`](src/services/stats/UsageStatsDatabase.ts:1) | Per-root, per-day additive totals for range-filtered session pages.                     | Day plus last activity; root plus day.                                              |
| [`stats_meta`](src/services/stats/UsageStatsDatabase.ts:1)       | Schema version, store generation, migration checkpoint, and last sequence.              | Singleton metadata key.                                                             |

One transaction inserts an event idempotently and updates its rollups and session projection. This makes an event and its dashboard contribution atomic. Existing NDJSON segments are migrated once in bounded batches, preserving event identity and existing privacy rules. The migration checkpoint makes interruption safe. Old segments remain untouched until a separately approved cleanup policy exists.

New events need a stable root-session identity. Extend [`UsageEventV1`](packages/types/src/usage-stats.ts:35) with an optional root task field for backward compatibility. [`UsageRecorder.finalizeUsageEvent()`](src/services/stats/UsageRecorder.ts:94) receives it from the task hierarchy. Migration resolves legacy parent chains with the existing cycle guard in [`resolveRootTaskId()`](src/core/webview/usageStatsMessageHandler.ts:475).

The normal query path uses rollups. Exact custom-range edge hours may read only the two edge-day event slices, while complete interior days use rollups. All-time queries use lifetime rollups. The work therefore depends on returned buckets and edge slices, not the number of accumulated sessions.

### B. Host stream coordinator

Add [`UsageStatsStreamCoordinator`](src/services/stats/UsageStatsStreamCoordinator.ts:1) as the only stream lifecycle authority for one provider/webview. It stores:

- one active subscription descriptor,
- current store generation,
- last delivered sequence,
- one coalescing timer,
- one in-flight drain promise,
- visibility state,
- no event-history copy.

Both same-window appends and cross-window file/database notifications call [`scheduleDrain()`](src/services/stats/UsageStatsStreamCoordinator.ts:1). The drain reads rows after the last sequence through an index, folds at most 100 events into one delta, and advances the cursor even when some events fall outside the active queries. A second drain is scheduled if rows remain.

The coordinator is demand-driven. It does no dashboard aggregation and sends no stream traffic without an active visible subscription.

### C. Proposed Frontend ↔ Backend data flow diagram

| Phase         | Frontend/UI                                                                                                                                                              | VS Code message boundary                                                                                                                               | Backend/System                                                                                                                                                                                                | Durable state                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Subscribe     | [`useDashboardStatsStream()`](webview-ui/src/components/dashboard/useDashboardStatsStream.ts:1) builds main, heatmap, and first-session-page queries.                    | [`subscribeDashboardStats`](packages/types/src/vscode-extension-host.ts:1)                                                                             | [`handleSubscribeDashboardStats()`](src/core/webview/usageStatsMessageHandler.ts:1) validates the request and activates [`UsageStatsStreamCoordinator`](src/services/stats/UsageStatsStreamCoordinator.ts:1). | Indexed snapshot query reads projections.              |
| Hydrate       | Reducer has no prior data, so initial loading remains visible.                                                                                                           | [`dashboardStatsStreamSnapshot`](packages/types/src/vscode-extension-host.ts:1)                                                                        | Host sends correlated snapshot, generation, sequence, heatmap buckets, and one session page.                                                                                                                  | No raw event array crosses the boundary.               |
| Commit        | No UI action is required.                                                                                                                                                | No request.                                                                                                                                            | [`UsageRecorder.finalizeUsageEvent()`](src/services/stats/UsageRecorder.ts:94) records one terminal event.                                                                                                    | Event and projections commit in one transaction.       |
| Drain         | Existing dashboard remains mounted.                                                                                                                                      | [`dashboardStatsStreamDelta`](packages/types/src/vscode-extension-host.ts:1)                                                                           | Coordinator batches unseen sequences and computes query-scoped additive deltas and session upserts.                                                                                                           | Cursor advances only after successful message posting. |
| Apply         | [`dashboardStreamReducer()`](webview-ui/src/components/dashboard/dashboardStreamReducer.ts:1) verifies generation and sequence, then updates stable bucket/session maps. | No request on success.                                                                                                                                 | No history-wide query.                                                                                                                                                                                        | Only affected references change.                       |
| Gap recovery  | Old values remain visible with a subtle stale indicator.                                                                                                                 | [`resyncDashboardStats`](packages/types/src/vscode-extension-host.ts:1)                                                                                | Host returns a new authoritative snapshot.                                                                                                                                                                    | Atomic state replacement on receipt.                   |
| Filter change | Existing view remains visible until replacement.                                                                                                                         | [`replaceDashboardStatsSubscription`](packages/types/src/vscode-extension-host.ts:1)                                                                   | Coordinator validates new main, heatmap, and page queries and changes the subscription epoch.                                                                                                                 | Old-epoch responses are ignored.                       |
| Unmount/hide  | Hook stops animation and marks stream inactive.                                                                                                                          | [`unsubscribeDashboardStats`](packages/types/src/vscode-extension-host.ts:1) or [`pauseDashboardStats`](packages/types/src/vscode-extension-host.ts:1) | Coordinator releases descriptor/timer or retains only cursors while hidden.                                                                                                                                   | No history copy retained.                              |
| Return/show   | Hook starts a new epoch or presents its last sequence.                                                                                                                   | [`resumeDashboardStats`](packages/types/src/vscode-extension-host.ts:1)                                                                                | Host drains the bounded gap or sends a replacement snapshot.                                                                                                                                                  | UI never relies on messages missed while unmounted.    |

### D. Cross-boundary type definitions

The types below belong in [`usage-stats.ts`](packages/types/src/usage-stats.ts:1) and are referenced by the two message unions in [`vscode-extension-host.ts`](packages/types/src/vscode-extension-host.ts:1). Runtime validation is required for every webview-originated query.

| Planned declaration                                                             | Required fields                                                                                                                                                             | Invariant                                                                                                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`interface DashboardStatsSubscription`](packages/types/src/usage-stats.ts:1)   | subscription identity, epoch, main [`StatsQuery`](packages/types/src/usage-stats.ts:77), heatmap [`StatsQuery`](packages/types/src/usage-stats.ts:77), session page request | Page limit is 1–100. Main and heatmap queries are validated independently.                                                                   |
| [`interface DashboardSessionPageRequest`](packages/types/src/usage-stats.ts:1)  | limit, optional opaque cursor                                                                                                                                               | Cursor is host-issued, query-bound, and invalid after generation/query change.                                                               |
| [`interface DashboardSessionPage`](packages/types/src/usage-stats.ts:1)         | items, optional next cursor, total-known flag                                                                                                                               | At most the requested bounded number of summaries is returned.                                                                               |
| [`interface DashboardStatsStreamSnapshot`](packages/types/src/usage-stats.ts:1) | subscription identity, epoch, generation, through-sequence, main snapshot, heatmap buckets, session page                                                                    | Authoritative for its query and epoch. Applied atomically.                                                                                   |
| [`interface StatsBucketDelta`](packages/types/src/usage-stats.ts:1)             | stable serialized bucket key, additive [`StatsBucket`](packages/types/src/usage-stats.ts:96) fields                                                                         | Key fields are identities, numeric fields are signed deltas. Signed values support correction/reset migrations.                              |
| [`interface DashboardStatsStreamDelta`](packages/types/src/usage-stats.ts:1)    | subscription identity, epoch, generation, after-sequence, through-sequence, total delta, bucket deltas, heatmap deltas, session upserts                                     | The reducer accepts it only when generation and after-sequence match local state.                                                            |
| [`interface DashboardSessionUpsert`](packages/types/src/usage-stats.ts:1)       | stable root task identity and complete current summary values                                                                                                               | Existing rows update in place. A newly created session may be inserted at the top; ordinary numeric updates do not reorder the visible page. |
| [`interface DashboardStatsStreamError`](packages/types/src/usage-stats.ts:1)    | subscription identity, epoch, typed error code, recoverability, optional retry delay                                                                                        | Existing data stays visible for recoverable errors. No stack trace crosses the boundary.                                                     |

### E. Ordering and idempotency rules

1. Store generation changes on clear, destructive migration, or projection rebuild.
2. Sequence increases once per committed canonical event.
3. Subscription epoch increases whenever a query set is replaced.
4. A snapshot is accepted only for the current subscription identity and epoch.
5. A delta is accepted only if its generation matches and its after-sequence equals the local through-sequence.
6. A delta whose through-sequence is less than or equal to local state is a duplicate and is ignored.
7. A forward gap triggers one coalesced background resync. Additional deltas are ignored until the snapshot arrives.
8. Clear emits a reset for a new generation. The reducer atomically replaces values with zero and keeps the dashboard shell mounted.

### F. Query and time-boundary behavior

- Fixed custom ranges do not move. A newly committed event contributes only when its timestamp falls in the interval.
- All-time ranges accept every visible event.
- Today, 7-day, 30-day, and heatmap rolling ranges require expiry handling. The coordinator schedules an authoritative replacement at the next calendar-day boundary in the query timezone. This subtracts the expired day without inventing reverse events.
- Daylight-saving transitions use the existing IANA timezone field in [`StatsQuery`](packages/types/src/usage-stats.ts:81), not a fixed 24-hour subtraction.
- Changing cache estimation ratio creates a new subscription epoch because [`UsageAggregator.accumulateIntoBucket()`](src/services/stats/UsageAggregator.ts:433) changes cache-derived values. It is not modeled as an event delta.
- The 30, 60, 120, and 360-day heatmap ranges are part of the same composite subscription, so the current day updates with the main dashboard.

### G. Webview state and rendering

Create [`dashboardStreamReducer()`](webview-ui/src/components/dashboard/dashboardStreamReducer.ts:1) as a pure reducer with normalized maps:

- bucket map keyed by a stable serialization of group keys,
- heatmap map keyed by local calendar day,
- session page keyed by root task identity plus an explicit stable order array,
- stream metadata containing subscription identity, epoch, generation, sequence, connection state, and background error.

[`DashboardView()`](webview-ui/src/components/dashboard/DashboardView.tsx:41) uses initial loading only while no snapshot exists. Background replacement sets a small updating state without removing content. Breakdown rows use stable keys rather than the current group-plus-index key at [`DashboardView()`](webview-ui/src/components/dashboard/DashboardView.tsx:776).

Add [`AnimatedNumber()`](webview-ui/src/components/dashboard/AnimatedNumber.tsx:1) and use it in [`DashboardSummary()`](webview-ui/src/components/dashboard/DashboardSummary.tsx:36), breakdown numeric cells, and session numeric cells. Animation is presentation-only; reducer state always stores the exact latest value. Reduced-motion users receive immediate values. Accessibility announcements are rate-limited to avoid speaking every batch.

Use the existing [`react-virtuoso`](webview-ui/src/components/history/HistoryView.tsx:7) dependency in [`SessionList()`](webview-ui/src/components/dashboard/SessionList.tsx:191). Do not add another virtualization package. Host cursor paging bounds returned data. Only the first page participates in live insertion/upsert; navigating older pages is an explicit user action and uses snapshot-style page replacement within the session region, not a dashboard reload.

## 1.5 Error model

Extend the existing handler error-code convention from [`UsageStatsHandlerErrorCode`](src/core/webview/usageStatsMessageHandler.ts:25):

| Planned code family                                                             | Meaning                                       | Frontend action                                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| [`STATS_STREAM/subscribe/001`](src/core/webview/usageStatsMessageHandler.ts:25) | Invalid subscription/query/page payload       | Keep prior data, show non-recoverable inline error for the requested filter. |
| [`STATS_STREAM/subscribe/002`](src/core/webview/usageStatsMessageHandler.ts:25) | Service unavailable                           | Keep prior data if present; initial view shows error.                        |
| [`STATS_STREAM/query/001`](src/core/webview/usageStatsMessageHandler.ts:25)     | Snapshot or page query failed                 | Retry with capped exponential delay only while visible.                      |
| [`STATS_STREAM/sequence/001`](src/core/webview/usageStatsMessageHandler.ts:25)  | Sequence gap or invalid cursor                | Request one authoritative snapshot.                                          |
| [`STATS_STREAM/projection/001`](src/services/stats/UsageStatsService.ts:90)     | Projection inconsistent with canonical events | Pause deltas, rebuild in bounded batches, then reset generation.             |
| [`STATS_STREAM/post/001`](src/services/stats/UsageStatsStreamCoordinator.ts:1)  | Webview disposed or message delivery failed   | Dispose subscription silently; never affect the running task.                |

Errors sent to the webview contain a stable code and safe message only. Host logs may include stack detail, but must not include prompts, response bodies, API keys, or workspace paths.

---

# 2. Architecture Decisions

## 2.1 Exactly three design options

### Option A, The Standard / The Right Way, durable indexed projections plus delta subscription

**Design:** Replace dashboard history scans with a transactional indexed local database, persisted rollups, cursor-paged sessions, monotonic event sequences, and query-scoped delta messages.

| Dimension | Assessment                                                                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effort    | High. Storage migration, projection code, protocol types, lifecycle coordinator, reducer, paging, and tests are required.                                                                                         |
| Risk      | Medium. Migration and multi-window database behavior are the main risks. They are controlled with idempotent event identity, write transactions, generation resets, compatibility validation, and recovery tests. |
| Outcome   | Meets all three user requirements. Active updates are event-sized, no automatic full-page reload occurs, and work remains bounded as session count grows.                                                         |

**Decision:** Recommended and selected.

### Option B, The Practical / The Pragmatic Way, push committed events and reduce in memory

**Design:** Keep the current NDJSON store. Add the committed sanitized event to the same-window callback and have the webview increment its current snapshot. Cross-window invalidation reads only newly appended segment tails. Keep the existing initial full snapshot and full session list.

| Dimension | Assessment                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effort    | Medium. Protocol and reducers are needed, but no database migration is required.                                                                                                                                                                  |
| Risk      | Medium-high. Tail cursors, segment rotation, clear generations, parent-session correction, and cross-window races reproduce database responsibilities. Initial load, all-time filter changes, and session memory still degrade with history size. |
| Outcome   | Removes most visible active-session flicker and reduces repeated refreshes, but fails the strict no-degradation requirement because baseline aggregation and the full session list remain linear.                                                 |

### Option C, The Staging / The Incremental Way, retain invalidation and perform stale-while-revalidate snapshots

**Design:** Stop setting loading after the first render, debounce invalidations, fetch the existing full snapshot and session array in the background, then swap them atomically. Also teach the heatmap to refetch on invalidation.

| Dimension | Assessment                                                                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effort    | Low. Mostly UI state separation and listener changes.                                                                                                                             |
| Risk      | Low implementation risk, high product risk. Large queries and messages still grow, and repeated CPU work can block the extension host.                                            |
| Outcome   | Removes the obvious spinner/flicker and is suitable only for short-term verification. It does not provide true streaming numbers and does not satisfy no performance degradation. |

## 2.2 Adopted patterns and stack

1. **CQRS-style local read model.** Canonical usage events remain the write record; dashboard rollups and session rows are query projections.
2. **Transactional outbox equivalent without a second queue.** The event sequence and its projections commit in one database transaction. The coordinator reads by sequence after notification.
3. **Snapshot plus ordered delta protocol.** Snapshot establishes authority; deltas optimize the steady state; generation and sequence make recovery deterministic.
4. **Stale-while-revalidate UI.** Existing values remain mounted during background replacement.
5. **Cursor pagination and virtualization.** Server-side result bounds control memory; virtualization controls DOM work.
6. **Demand-driven subscription.** Work exists only while the dashboard is active and visible.
7. **No new webview dependency.** Reuse [`react-virtuoso`](webview-ui/src/components/history/HistoryView.tsx:7).
8. **Runtime database validation gate.** Validate the built-in [`node:sqlite`](src/package.json:14) API against [official Node.js documentation](https://nodejs.org/api/sqlite.html) before coding. Do not silently add a native dependency.

## 2.3 Risks and edge cases

| Risk or edge case                                    | Required handling                                                                                                                                                   | Verification evidence                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in SQLite unavailable in the extension runtime | Fail the implementation prerequisite. Present a dependency ADR to the VP; do not fall back silently.                                                                | Activation smoke test logs database initialization and executes a transaction in the actual extension host.                             |
| Two VS Code windows append concurrently              | Use database transactions, busy timeout, write-ahead logging where supported, idempotent event identity, and retry only recognized busy errors with bounded jitter. | Two service instances append overlapping event identities; exactly one row per identity and contiguous committed sequence observations. |
| Migration interrupted                                | Commit batches and checkpoint the last legacy event. Restart resumes without duplicates.                                                                            | Kill/restart simulation after each migration batch boundary.                                                                            |
| Legacy parent chain incomplete or cyclic             | Use optional root identity, cycle guard, and a stable fallback to the event task identity. Later correction rebuilds affected projections and changes generation.   | Parent-before-child, child-before-parent, missing parent, and cycle fixtures.                                                           |
| Clear while a delta is in flight                     | Clear changes generation. Any old-generation delta is rejected; reset snapshot wins.                                                                                | Interleaved clear/delta reducer test.                                                                                                   |
| Duplicate or out-of-order message                    | Ignore duplicates; detect forward gaps; issue one resync.                                                                                                           | Reducer sequence matrix test.                                                                                                           |
| Dashboard unmounts during post                       | Coordinator catches disposed-view failure and releases subscription.                                                                                                | Host unit test with rejected [`postMessageToWebview()`](src/core/webview/ClineProvider.ts:330).                                         |
| Dashboard hidden for a long period                   | Do not queue unbounded deltas. Retain only cursor metadata; resume drains within limits or sends a snapshot.                                                        | Resume after more than one batch and after generation change.                                                                           |
| Midnight or daylight-saving boundary                 | Replace the affected rolling snapshots at timezone calendar boundary.                                                                                               | Fake-time tests for normal midnight, spring-forward, and fall-back.                                                                     |
| Event is outside selected range                      | Advance sequence but emit no numeric contribution for that query.                                                                                                   | Query-filtered delta test.                                                                                                              |
| User changes filter while old result is in flight    | Subscription epoch rejects prior snapshot/delta.                                                                                                                    | Rapid range and group change test.                                                                                                      |
| Cache ratio changes                                  | New epoch and authoritative replacement; never add a delta computed with a different ratio.                                                                         | Ratio-switch reducer and handler test.                                                                                                  |
| Session receives another call                        | Upsert numeric values in place and do not reorder an existing visible row. New root session may insert at top.                                                      | Stable DOM key and row-order UI test.                                                                                                   |
| Expanded detail receives another call                | Mark detail stale. Refresh only that detail on user expansion or send a bounded detail upsert if explicitly subscribed. Never refresh all sessions.                 | Expanded-row test.                                                                                                                      |
| Very hot event stream                                | Batch for 50–100 ms, cap by 100 events/64 KiB, and schedule subsequent drains. UI applies at most one reducer commit per animation frame.                           | Burst test with 10,000 generated commits and message-size assertions.                                                                   |
| Projection corruption                                | Stop deltas, rebuild from canonical events in batches, increment generation, and atomically reset subscribers.                                                      | Corruption/rebuild integration test.                                                                                                    |

## 2.4 Performance budget

| Metric                           |                                                                              Target |
| -------------------------------- | ----------------------------------------------------------------------------------: |
| Normal host work per append      | One indexed transaction plus one bounded unseen-sequence query. No full event read. |
| Automatic host-to-webview update |                                                   At most 64 KiB per delta message. |
| Delta batching latency           |              50–100 ms under activity; flush immediately by 100 events or size cap. |
| Webview reducer commits          |                                                    At most one per animation frame. |
| Session response                 |                                             Default 50, hard maximum 100 summaries. |
| Session DOM                      |                    Virtualized visible rows plus overscan, not all stored sessions. |
| Active subscription memory       |            Constant descriptor/cursors plus one bounded batch and one bounded page. |
| Initial query scaling            |         Based on rollup buckets and page size, not accumulated event/session count. |
| Background update UX             |                           Zero page-level loading transitions after first snapshot. |

Performance tests must compare fixtures with 1,000, 100,000, and 1,000,000 events while keeping the same requested bucket/page shape. The acceptance condition is that returned row count, message size, and webview retained page count remain fixed. Timing must be recorded as diagnostic evidence, not asserted with fragile machine-specific millisecond thresholds.

## 2.5 Dependency analysis

- [`UsageRecorder`](src/services/stats/UsageRecorder.ts:73) remains the task-facing hexagonal boundary. It must not know about webviews.
- [`UsageStatsService`](src/services/stats/UsageStatsService.ts:90) remains the domain facade and owns storage, projection query, notifications, and coordinator input.
- [`UsageStatsStreamCoordinator`](src/services/stats/UsageStatsStreamCoordinator.ts:1) depends on service query APIs and a narrow message sink, not on [`ClineProvider`](src/core/webview/ClineProvider.ts:1) directly. This keeps it unit-testable.
- [`usageStatsMessageHandler.ts`](src/core/webview/usageStatsMessageHandler.ts:1) validates boundary input and maps safe typed errors. It does not aggregate raw history.
- [`useDashboardStatsStream()`](webview-ui/src/components/dashboard/useDashboardStatsStream.ts:1) owns subscription lifecycle; [`dashboardStreamReducer()`](webview-ui/src/components/dashboard/dashboardStreamReducer.ts:1) owns deterministic state transitions; presentation components remain message-agnostic.
- The heatmap stops owning a second global message listener. [`UsageHeatmap()`](webview-ui/src/components/stats/UsageHeatmap.tsx:79) becomes a controlled presentation component for stream-provided daily values and range selection.
- The design adds no required webview package. Database API compatibility is the only technology gate.

---

# 3. Implementation Plan, Independent Sub-tasks

## Sub-task 1, define and validate the shared stream contract

**Exact files to modify:**

- [`packages/types/src/usage-stats.ts`](packages/types/src/usage-stats.ts)
- [`packages/types/src/vscode-extension-host.ts`](packages/types/src/vscode-extension-host.ts)
- [`packages/types/src/__tests__/usage-stats.spec.ts`](packages/types/src/__tests__/usage-stats.spec.ts)
- New [`packages/types/src/__tests__/dashboard-stats-stream.spec.ts`](packages/types/src/__tests__/dashboard-stats-stream.spec.ts)

**Implementation prerequisites:** Approve Option A message names, generation/sequence rules, cursor opacity, and 100-item hard limit. Preserve all existing message fields during migration.

**Work:** Add runtime schemas and inferred types for subscriptions, snapshots, deltas, pages, errors, and safe root-session identity. Add webview and extension message union members and payload fields. Do not use the generic untyped payload field.

**Verification and test protocol:** Existing package type tests plus the new protocol schema test cover valid and invalid messages, limits, signed deltas, optional backward-compatible event fields, and serialization round trips.

**Exact command:** [`cd packages/types; npx vitest run src/__tests__/usage-stats.spec.ts src/__tests__/dashboard-stats-stream.spec.ts`](packages/types/package.json:1)

## Sub-task 2, introduce the indexed canonical store and migration

**Exact files to create/modify:**

- New [`src/services/stats/UsageStatsDatabase.ts`](src/services/stats/UsageStatsDatabase.ts)
- New [`src/services/stats/UsageStatsMigration.ts`](src/services/stats/UsageStatsMigration.ts)
- [`src/services/stats/UsageEventStore.ts`](src/services/stats/UsageEventStore.ts)
- [`src/services/stats/UsageStatsService.ts`](src/services/stats/UsageStatsService.ts)
- [`src/services/stats/index.ts`](src/services/stats/index.ts)
- New [`src/services/stats/__tests__/UsageStatsDatabase.spec.ts`](src/services/stats/__tests__/UsageStatsDatabase.spec.ts)
- New [`src/services/stats/__tests__/UsageStatsMigration.spec.ts`](src/services/stats/__tests__/UsageStatsMigration.spec.ts)

**Implementation prerequisites:** First run a real extension-host compatibility spike for [`node:sqlite`](src/package.json:14), transactions, write-ahead logging, busy timeout, and packaging. If it fails, stop and return an ADR request. Do not modify or delete legacy segments.

**Work:** Create schema/version management, transactional idempotent append, monotonic sequence, rollups, session projections, indexed page queries, bounded batch reads, and restartable legacy migration. Keep the current service API working for non-dashboard callers during transition.

**Verification and test protocol:** New integration-style service tests use temporary directories and two database instances. Cover idempotency, concurrent windows, migration restart, corruption detection, projection atomicity, clear generation, and 1,000/100,000/1,000,000-event result-shape benchmarks.

**Exact command:** [`cd src; npx vitest run services/stats/__tests__/UsageStatsDatabase.spec.ts services/stats/__tests__/UsageStatsMigration.spec.ts`](src/package.json:1)

## Sub-task 3, expose reusable event contribution and projection query logic

**Exact files to create/modify:**

- [`src/services/stats/UsageAggregator.ts`](src/services/stats/UsageAggregator.ts)
- New [`src/services/stats/UsageStatsProjection.ts`](src/services/stats/UsageStatsProjection.ts)
- [`src/services/stats/__tests__/UsageAggregator.spec.ts`](src/services/stats/__tests__/UsageAggregator.spec.ts)
- New [`src/services/stats/__tests__/UsageStatsProjection.spec.ts`](src/services/stats/__tests__/UsageStatsProjection.spec.ts)

**Implementation prerequisites:** Sub-task 1 contracts and Sub-task 2 schema are complete. Cost recalculation and cache semantics remain single-source logic rather than duplicated SQL arithmetic.

**Work:** Extract a public pure contribution function from the private accumulation behavior in [`accumulateIntoBucket()`](src/services/stats/UsageAggregator.ts:433). Implement rollup snapshot assembly, exact edge-day correction, stable bucket-key serialization, and session page projection.

**Verification and test protocol:** Property-style tests prove that folding per-event deltas equals a full aggregate for the same event set across statuses, cost fallback, unknown semantics, cache ratio, timezones, and each supported group.

**Exact command:** [`cd src; npx vitest run services/stats/__tests__/UsageAggregator.spec.ts services/stats/__tests__/UsageStatsProjection.spec.ts`](src/package.json:1)

## Sub-task 4, implement the demand-driven host stream coordinator

**Exact files to create/modify:**

- New [`src/services/stats/UsageStatsStreamCoordinator.ts`](src/services/stats/UsageStatsStreamCoordinator.ts)
- New [`src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts`](src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts)
- [`src/services/stats/UsageStatsService.ts`](src/services/stats/UsageStatsService.ts)
- [`src/services/stats/UsageRecorder.ts`](src/services/stats/UsageRecorder.ts)
- [`src/core/task/Task.ts`](src/core/task/Task.ts)

**Implementation prerequisites:** Sub-tasks 1–3 are complete. Define a narrow message-sink interface so coordinator tests do not construct [`ClineProvider`](src/core/webview/ClineProvider.ts:1).

**Work:** Implement subscribe, replace, pause, resume, unsubscribe, bounded drain, coalescing, sequence advancement, rollover scheduling, reset, and disposal. Supply root-session identity at recording time. Notification only schedules indexed drains; it never carries uncommitted data.

**Verification and test protocol:** New unit tests cover no-subscriber idle behavior, local and external notification coalescing, query filtering, max batch/size, duplicate notifications, hidden resume, gap fallback, rollover, clear, message failure, and disposal.

**Exact command:** [`cd src; npx vitest run services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts services/stats/__tests__/UsageStatsService.spec.ts`](src/package.json:1)

## Sub-task 5, wire the VS Code message boundary and repair source routing

**Exact files to modify:**

- [`src/core/webview/usageStatsMessageHandler.ts`](src/core/webview/usageStatsMessageHandler.ts)
- [`src/core/webview/webviewMessageHandler.ts`](src/core/webview/webviewMessageHandler.ts)
- [`src/core/webview/ClineProvider.ts`](src/core/webview/ClineProvider.ts)
- [`src/core/webview/__tests__/usageStatsMessageHandler.spec.ts`](src/core/webview/__tests__/usageStatsMessageHandler.spec.ts)
- New [`src/core/webview/__tests__/usageStatsMessageRouting.spec.ts`](src/core/webview/__tests__/usageStatsMessageRouting.spec.ts)

**Implementation prerequisites:** Confirm the source routing gap described in section 1.2F against the branch that will receive implementation. Coordinator public API and shared schemas must be stable.

**Work:** Add handlers for subscribe, replace, page, resync, pause, resume, and unsubscribe. Validate every request, map typed errors, and dispose the coordinator with the provider. Restore explicit routing for existing usage-stat handlers and the new protocol. Keep [`usageStatsChanged`](packages/types/src/vscode-extension-host.ts:119) temporarily for compatibility, but the new dashboard must not use it.

**Verification and test protocol:** Existing handler tests cover old behavior. New routing tests send actual [`WebviewMessage`](packages/types/src/vscode-extension-host.ts:548) values through [`webviewMessageHandler()`](src/core/webview/webviewMessageHandler.ts:105), proving the branch-recovery wiring, request validation, response correlation, and coordinator disposal.

**Exact command:** [`cd src; npx vitest run core/webview/__tests__/usageStatsMessageHandler.spec.ts core/webview/__tests__/usageStatsMessageRouting.spec.ts`](src/package.json:1)

## Sub-task 6, implement the webview reducer and subscription lifecycle

**Exact files to create/modify:**

- New [`webview-ui/src/components/dashboard/dashboardStreamReducer.ts`](webview-ui/src/components/dashboard/dashboardStreamReducer.ts)
- New [`webview-ui/src/components/dashboard/useDashboardStatsStream.ts`](webview-ui/src/components/dashboard/useDashboardStatsStream.ts)
- New [`webview-ui/src/components/dashboard/__tests__/dashboardStreamReducer.spec.ts`](webview-ui/src/components/dashboard/__tests__/dashboardStreamReducer.spec.ts)
- New [`webview-ui/src/components/dashboard/__tests__/useDashboardStatsStream.spec.tsx`](webview-ui/src/components/dashboard/__tests__/useDashboardStatsStream.spec.tsx)

**Implementation prerequisites:** Sub-task 1 message contract and Sub-task 5 routing are complete. Decide how the existing host visibility action and browser visibility event are deduplicated.

**Work:** Add normalized state, initial snapshot, delta apply, sequence validation, epoch rejection, atomic reset, background resync, one-frame batch application, and mount/hide/unmount lifecycle messaging. The hook must never set page-level loading after a snapshot exists.

**Verification and test protocol:** Reducer tests cover the full ordering matrix. Hook tests use fake timers and mocked VS Code messaging to prove one subscription, replacement on filters, pause/resume, unsubscribe, stale-response rejection, one resync per gap, and no post-unmount state update.

**Exact command:** [`cd webview-ui; npx vitest run src/components/dashboard/__tests__/dashboardStreamReducer.spec.ts src/components/dashboard/__tests__/useDashboardStatsStream.spec.tsx`](webview-ui/package.json:1)

## Sub-task 7, convert dashboard presentation to stable streaming updates

**Exact files to create/modify:**

- [`webview-ui/src/components/dashboard/DashboardView.tsx`](webview-ui/src/components/dashboard/DashboardView.tsx)
- [`webview-ui/src/components/dashboard/DashboardSummary.tsx`](webview-ui/src/components/dashboard/DashboardSummary.tsx)
- [`webview-ui/src/components/dashboard/SessionList.tsx`](webview-ui/src/components/dashboard/SessionList.tsx)
- [`webview-ui/src/components/stats/UsageHeatmap.tsx`](webview-ui/src/components/stats/UsageHeatmap.tsx)
- New [`webview-ui/src/components/dashboard/AnimatedNumber.tsx`](webview-ui/src/components/dashboard/AnimatedNumber.tsx)
- [`webview-ui/src/components/dashboard/__tests__/DashboardView.spec.tsx`](webview-ui/src/components/dashboard/__tests__/DashboardView.spec.tsx)
- [`webview-ui/src/components/dashboard/__tests__/DashboardSummary.spec.tsx`](webview-ui/src/components/dashboard/__tests__/DashboardSummary.spec.tsx)
- [`webview-ui/src/components/stats/__tests__/UsageHeatmap.spec.tsx`](webview-ui/src/components/stats/__tests__/UsageHeatmap.spec.tsx)
- New [`webview-ui/src/components/dashboard/__tests__/AnimatedNumber.spec.tsx`](webview-ui/src/components/dashboard/__tests__/AnimatedNumber.spec.tsx)

**Implementation prerequisites:** Sub-task 6 hook API is stable. Keep the current visual design and do not introduce broad dashboard redesign work.

**Work:** Replace direct message listeners and refresh debounce with the hook. Keep old content during background work. Make heatmap controlled, add stable bucket keys, animate numeric values, use existing virtualization for sessions, and implement bounded cursor paging. Preserve manual refresh as an explicit background resync.

**Verification and test protocol:** UI tests prove no loading view appears after the initial snapshot, only changed number nodes update, heatmap range changes replace the subscription, all 30/60/120/360-day ranges work, session updates retain row order and expansion, reduced motion disables animation, and at most one bounded page is rendered.

**Exact command:** [`cd webview-ui; npx vitest run src/components/dashboard/__tests__/DashboardView.spec.tsx src/components/dashboard/__tests__/DashboardSummary.spec.tsx src/components/dashboard/__tests__/AnimatedNumber.spec.tsx src/components/stats/__tests__/UsageHeatmap.spec.tsx`](webview-ui/package.json:1)

## Sub-task 8, add the cross-boundary regression and performance harness

**Exact files to create/modify:**

- New [`src/core/webview/__tests__/dashboardStatsStreaming.integration.spec.ts`](src/core/webview/__tests__/dashboardStatsStreaming.integration.spec.ts)
- New [`src/services/stats/__tests__/dashboardStatsPerformance.spec.ts`](src/services/stats/__tests__/dashboardStatsPerformance.spec.ts)
- New [`webview-ui/src/components/dashboard/__tests__/DashboardView.streaming.spec.tsx`](webview-ui/src/components/dashboard/__tests__/DashboardView.streaming.spec.tsx)

**Implementation prerequisites:** Sub-tasks 1–7 complete. The performance test must use generated privacy-safe event fixtures and must not write large fixtures into the repository.

**Work:** Exercise append → projection → coordinator → typed message and separately typed message → reducer → DOM. Record query shape, result count, serialized bytes, retained page count, and elapsed diagnostics at increasing history sizes. Include clear, gap, cross-window, rollover, tab-away/back, and burst scenarios.

**Verification and test protocol:** The backend integration suite proves boundary payloads and recovery. The webview suite proves absence of full reload/flicker. The performance suite proves bounded result/message/memory shape as history grows.

**Exact backend command:** [`cd src; npx vitest run core/webview/__tests__/dashboardStatsStreaming.integration.spec.ts services/stats/__tests__/dashboardStatsPerformance.spec.ts`](src/package.json:1)

**Exact webview command:** [`cd webview-ui; npx vitest run src/components/dashboard/__tests__/DashboardView.streaming.spec.tsx`](webview-ui/package.json:1)

## 3.1 Delegation order and boundaries

1. Delegate Sub-task 1 first because every boundary depends on its contract.
2. Delegate Sub-tasks 2 and 3 after the contract; they may proceed in parallel only after agreeing on the projection interfaces.
3. Delegate Sub-task 4 after database and contribution APIs compile.
4. Delegate Sub-task 5 after the coordinator API is stable. Treat the source-routing repair as a blocking acceptance criterion.
5. Delegate Sub-task 6 after protocol and routing compile; it can proceed independently from presentation work.
6. Delegate Sub-task 7 after the hook tests pass.
7. Delegate Sub-task 8 last as the cross-domain gate.

No sub-task may delete legacy statistics, change retention limits, or add a database package without VP and user-approved scope. No changeset is required under [`AGENTS.md`](../../../AGENTS.md).

## 3.2 Final acceptance checklist

- A new same-window event changes visible totals, the active breakdown bucket, today’s heatmap cell, and the active session summary without displaying [`dashboard-loading`](webview-ui/src/components/dashboard/DashboardView.tsx:681) or [`dashboard-sessions-loading`](webview-ui/src/components/dashboard/DashboardView.tsx:818).
- A cross-window event follows the same delta path after watcher notification.
- Ten thousand rapid commits are delivered in bounded batches; no message exceeds 64 KiB and no unbounded queue forms.
- Switching from dashboard to chat disposes the subscription. Returning creates or resumes an authoritative epoch without relying on missed messages.
- 30, 60, 120, and 360-day heatmap filters stream today’s values and roll over correctly at timezone midnight.
- Today, 7-day, 30-day, custom, and all-time main filters reject stale epochs and retain content during replacement.
- Clear, migration rebuild, and generation mismatch atomically reset values without a blank page.
- Session queries return at most 100 rows, the DOM is virtualized, and stored session count does not change webview page memory.
- Existing export, clear nonce, session detail, cost semantics, privacy constraints, and recording best-effort behavior remain covered.
- Source routing tests prove that built extension source reaches every old and new usage-stat handler.
