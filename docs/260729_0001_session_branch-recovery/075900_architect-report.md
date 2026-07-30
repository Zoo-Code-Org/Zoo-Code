# Architect Task Report

## Task Summary

Investigated the dashboard usage-stat refresh path across React, VS Code webview messages, the extension host, the statistics service, aggregation, and local event storage. Produced a concrete streaming architecture that removes automatic full-page replacement and bounds steady-state work as usage history grows.

## Actions Taken

- Traced the initial dashboard snapshot and session-list request paths.
- Traced same-window usage commits from [`UsageRecorder.finalizeUsageEvent()`](../../src/services/stats/UsageRecorder.ts:94) to the payload-free [`usageStatsChanged`](../../packages/types/src/vscode-extension-host.ts:119) message.
- Traced cross-window change notification through [`UsageStatsService.setupFileWatcher()`](../../src/services/stats/UsageStatsService.ts:327).
- Confirmed that [`DashboardView()`](../../webview-ui/src/components/dashboard/DashboardView.tsx:41) turns invalidations into two complete queries and sets destructive loading states.
- Confirmed that [`UsageHeatmap()`](../../webview-ui/src/components/stats/UsageHeatmap.tsx:79) owns a separate one-shot request and does not update on usage invalidation.
- Analyzed storage, aggregation, session grouping, title derivation, message size, webview state, and DOM scaling.
- Compared exactly three designs and selected an indexed projection plus ordered snapshot/delta subscription.
- Defined Frontend ↔ Backend messages, generation/sequence recovery, filter lifecycle, bounded batching, cursor paging, virtualization, error codes, migration constraints, and acceptance budgets.
- Split implementation into eight file-bounded tasks, each with prerequisites, test ownership, and an exact command.

## Result

Success. The architecture plan was created at [`dashboard-streaming-architecture.md`](dashboard-streaming-architecture.md). Automated structure verification confirmed:

- current data flow analysis is present,
- proposed streaming architecture is present,
- performance budget is present,
- all three mandatory options are present,
- eight implementation sub-tasks are present,
- the document contains 471 lines.

The recommended design is the durable indexed read model plus demand-driven, query-scoped snapshot/delta stream. It is the only option among the three that satisfies no visible automatic reload, counter-like numeric updates, and bounded behavior as session history grows.

## Issues Discovered

1. The current push mechanism is only invalidation. It carries no event or delta data, so the dashboard must issue full queries.
2. Automatic updates set page and session loading state, which removes mounted content and produces visible flicker.
3. Current statistics requests aggregate the entire event array through [`UsageAggregator.query()`](../../src/services/stats/UsageAggregator.ts:73).
4. Current session requests group all matching events, read titles, return all summaries, retain all summaries, and render all rows.
5. The heatmap can become stale during live updates.
6. The current source copy of [`webviewMessageHandler.ts`](../../src/core/webview/webviewMessageHandler.ts:1) contains no usage-stat handler imports or routing cases, while direct handler tests exist. The plan treats source routing verification/repair as a blocking implementation step.
7. The built-in [`node:sqlite`](../../src/package.json:14) API could not be confirmed through the available external search. A real extension-host compatibility spike against official documentation is a prerequisite before implementation. No database dependency should be added without an ADR.

## Next Step Recommendations

1. VP/Ask should audit and approve Option A, including the SQLite compatibility gate, 100-session page cap, 64 KiB delta cap, and migration strategy.
2. Delegate the shared protocol task first.
3. Run the runtime database compatibility spike before storage implementation.
4. Keep the routing repair and routing integration test in the critical path.
5. Complete the cross-boundary and scaling harness before accepting the feature.

## Affected File List

- [`dashboard-streaming-architecture.md`](dashboard-streaming-architecture.md)
- [`075900_architect-report.md`](075900_architect-report.md)

No product source code was modified.
