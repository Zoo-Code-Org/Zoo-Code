# Code Task Report

## Task Summary

Implemented Sub-task 4 of the approved History-first Dashboard Tasks migration. The extension host now derives Dashboard task membership, ordering, hierarchy, and zero-usage rows from the History catalog, enriches those rows with SQLite usage data, emits task-compatible stream payloads, and exposes additive task page/detail IPC without removing legacy session routes.

## Actions Taken

- Added History source readiness and deterministic rebuild support in [`DashboardTaskCatalog`](../../src/services/stats/DashboardTaskCatalog.ts:56), then made [`UsageStatsService.initialize()`](../../src/services/stats/UsageStatsService.ts:142) wait for that source before it creates [`UsageStatsStreamCoordinator`](../../src/services/stats/UsageStatsStreamCoordinator.ts:84).
- Passed the provider-owned catalog from [`ClineProvider`](../../src/core/webview/ClineProvider.ts:166) into [`UsageStatsService`](../../src/services/stats/UsageStatsService.ts:96), and disposed service, catalog, and History store in dependency order.
- Added History-first task page/detail and reusable stream-summary projections in [`DashboardTaskProjection`](../../src/services/stats/DashboardTaskProjection.ts:43). SQLite now supplies metrics and selected-subtree events only; it does not create Dashboard task rows.
- Updated [`UsageStatsStreamCoordinator`](../../src/services/stats/UsageStatsStreamCoordinator.ts:84) to send task snapshots when a catalog is configured, upsert the event task plus visible ancestors, coalesce catalog mutations into replacement snapshots, and retain zero-valued History rows after a generation reset. Catalog-less callers retain legacy session stream behavior.
- Added `getDashboardTaskPage` and `getDashboardTaskDetail` to [`WebviewMessage`](../../packages/types/src/vscode-extension-host.ts:542), implemented handlers in [`usageStatsMessageHandler`](../../src/core/webview/usageStatsMessageHandler.ts:1), and kept legacy session routes in [`webviewMessageHandler`](../../src/core/webview/webviewMessageHandler.ts:579).
- Added focused coverage in [`UsageStatsService.spec.ts`](../../src/services/stats/__tests__/UsageStatsService.spec.ts:79), [`UsageStatsStreamCoordinator.spec.ts`](../../src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts:192), [`usageStatsMessageHandler.spec.ts`](../../src/core/webview/__tests__/usageStatsMessageHandler.spec.ts:179), and [`usageStatsMessageRouting.spec.ts`](../../src/core/webview/__tests__/usageStatsMessageRouting.spec.ts:169). The stream tests explicitly narrow task/session wire unions before accessing variant-only properties.
- Inspected the working tree. [`git diff --check`](../../.gitconfig) exited successfully with no whitespace errors. The observed CRLF notices are workspace line-ending warnings only. The apparent [`eslint-suppressions.json`](../../src/eslint-suppressions.json) full-file diff was formatting-only and was normalized back to no diff.

## Result

**Implementation complete. Verification is partial because the routing test cannot produce a terminal result in this environment.**

Passed verification:

- `node_modules\\.bin\\tsc.cmd --noEmit --pretty false`, run from [`src`](../../src), exited `0`.
- `corepack pnpm --dir src exec vitest run services/stats/__tests__/UsageStatsService.spec.ts --reporter=json --outputFile=vitest-usage-stats-service-result.json` passed **53/53** tests. Evidence: [`vitest-usage-stats-service-result.json`](../../src/vitest-usage-stats-service-result.json).
- `corepack pnpm --dir src exec vitest run services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts --reporter=json --outputFile=vitest-usage-stats-stream-result.json` passed **36/36** tests. Evidence: [`vitest-usage-stats-stream-result.json`](../../src/vitest-usage-stats-stream-result.json).
- `corepack pnpm --dir src exec vitest run core/webview/__tests__/usageStatsMessageHandler.spec.ts` passed **58/58** tests.
- `corepack pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/webview/ClineProvider.ts services/stats/UsageStatsService.ts services/stats/UsageStatsStreamCoordinator.ts core/webview/usageStatsMessageHandler.ts core/webview/webviewMessageHandler.ts` exited `0`.
- `corepack pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts` exited `0`.

Blocked verification:

- The required [`usageStatsMessageRouting.spec.ts`](../../src/core/webview/__tests__/usageStatsMessageRouting.spec.ts:169) command, including a retry using `--pool=forks --maxWorkers=1 --no-file-parallelism --reporter=verbose`, reaches Vite SSR resolution warnings for literal `file://${cachedpath}/` and `file://${tempfile}/` URLs, then does not return a test result. The specified combined four-suite command is therefore also unverified because it includes this routing suite.
- This behavior predates this sub-task and no production workaround was added. See [`225535_code-routing-vitest-environment-feedback.md`](225535_code-routing-vitest-environment-feedback.md).

## Issues Discovered

- The compatibility wire contract intentionally permits legacy session or new task snapshots/deltas. Task-focused coordinator tests originally accessed task-only properties without discriminating the union. The tests now use `"tasks" in snapshot` and `"taskUpsert" in delta`; the direct TypeScript check passes. See [`220234_code-tsc-environment-feedback.md`](220234_code-tsc-environment-feedback.md).
- The working tree contains unrelated pre-existing changes and temporary test-result artifacts. No unrelated production code was modified for this sub-task. The JSON reports are retained because this mode does not delete files.
- A shell-separator error during read-only Git inspection is documented in [`231011_code-git-command-shell-environment-feedback.md`](231011_code-git-command-shell-environment-feedback.md). It changed no repository content.

## Next Step Recommendations

- VP should treat the routing and combined-suite checks as environment-blocked, not passing, until the Vite placeholder URL resolution issue is repaired or an approved isolated-routing execution path returns a final result.
- Once that environment blocker is resolved, rerun the required combined command before integration:
  `corepack pnpm --dir src exec vitest run services/stats/__tests__/UsageStatsService.spec.ts services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts core/webview/__tests__/usageStatsMessageHandler.spec.ts core/webview/__tests__/usageStatsMessageRouting.spec.ts`.

## Affected File List

- [`packages/types/src/vscode-extension-host.ts`](../../packages/types/src/vscode-extension-host.ts)
- [`src/core/webview/ClineProvider.ts`](../../src/core/webview/ClineProvider.ts)
- [`src/core/webview/usageStatsMessageHandler.ts`](../../src/core/webview/usageStatsMessageHandler.ts)
- [`src/core/webview/webviewMessageHandler.ts`](../../src/core/webview/webviewMessageHandler.ts)
- [`src/services/stats/DashboardTaskCatalog.ts`](../../src/services/stats/DashboardTaskCatalog.ts)
- [`src/services/stats/DashboardTaskProjection.ts`](../../src/services/stats/DashboardTaskProjection.ts)
- [`src/services/stats/UsageStatsService.ts`](../../src/services/stats/UsageStatsService.ts)
- [`src/services/stats/UsageStatsStreamCoordinator.ts`](../../src/services/stats/UsageStatsStreamCoordinator.ts)
- [`src/services/stats/__tests__/UsageStatsService.spec.ts`](../../src/services/stats/__tests__/UsageStatsService.spec.ts)
- [`src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts`](../../src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts)
- [`src/core/webview/__tests__/usageStatsMessageHandler.spec.ts`](../../src/core/webview/__tests__/usageStatsMessageHandler.spec.ts)
- [`src/core/webview/__tests__/usageStatsMessageRouting.spec.ts`](../../src/core/webview/__tests__/usageStatsMessageRouting.spec.ts)
- [`packages/types/src/__tests__/dashboard-stats-stream.spec.ts`](../../packages/types/src/__tests__/dashboard-stats-stream.spec.ts)
- [`231409_code-report.md`](231409_code-report.md)
