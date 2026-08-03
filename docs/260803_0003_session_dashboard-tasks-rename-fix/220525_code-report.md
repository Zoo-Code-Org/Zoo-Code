# Code Task Report

## Task Summary

Implemented the History-first Dashboard Task projection and additive task IPC contracts for Sub-task 3, while retaining legacy session stream payload compatibility until Sub-task 4 performs producer and consumer migration.

## Actions Taken

- Added [DashboardTaskProjection.ts](../../src/services/stats/DashboardTaskProjection.ts) with catalog-owned paging, one deduplicated subtree usage lookup per page, direct-row subtree rollups, deterministic latest activity metadata, and known-zero-usage task detail support.
- Added task Zod contracts in [usage-stats.ts](../../packages/types/src/usage-stats.ts): task summary, page, upsert, API call, detail, snapshot, and delta.
- Extended [vscode-extension-host.ts](../../packages/types/src/vscode-extension-host.ts) with task page/detail message payloads and migration-safe task/session snapshot and delta unions.
- Added projection behavior coverage in [DashboardTaskProjection.spec.ts](../../src/services/stats/__tests__/DashboardTaskProjection.spec.ts) for catalog-only membership, one batch request, zero joins, hierarchy rollups, focused detail reads, and sequence ordering.
- Added task schema and JSON serialization coverage in [dashboard-stats-stream.spec.ts](../../packages/types/src/__tests__/dashboard-stats-stream.spec.ts).
- Updated legacy stream assertions in [dashboard-preset-change-bug.spec.ts](../../src/services/stats/__tests__/dashboard-preset-change-bug.spec.ts) and [UsageStatsStreamCoordinator.spec.ts](../../src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts) to narrow the approved session/task transition union before accessing legacy-only session fields.

## Result

Success. The projection keeps task membership, identity, hierarchy, ordering, titles, and timestamps owned by History. SQLite supplies only direct task usage. Missing usage yields explicit zero metrics rather than fabricated events, while known zero-usage detail responses retain their History title and timestamp.

Validation passed:

- Targeted task projection test: 5 tests passed.
- Task stream contract test: 81 tests passed.
- Existing session projection regression test: 41 tests passed.
- Legacy stream regression tests: 37 tests passed across 2 files.
- ESLint passed with zero warnings for all changed production and test files.
- TypeScript checks passed for both `packages/types` and `src`.

## Issues Discovered

- The first source TypeScript check correctly exposed three legacy test accesses that assumed a session-only stream snapshot after the compatibility union was introduced. The root cause was missing type narrowing, not a runtime contract error. The affected assertions now explicitly verify the legacy session shape before reading session fields.
- The terminal runner did not interpret a semicolon-separated PowerShell preflight command as a shell command separator. The issue was recorded in [215718_code-environment-feedback.md](215718_code-environment-feedback.md).
- The TypeScript migration finding and its resolution context were recorded in [220234_code-tsc-environment-feedback.md](220234_code-tsc-environment-feedback.md).

## Next Step Recommendations

- Sub-task 4 should migrate stream producers, service wiring, and message handlers to emit and consume the new task contracts, then remove the temporary session/task unions only after all callers move.
- Preserve the History-first authority boundary in downstream changes. Do not derive Dashboard task membership from SQLite usage rows.

## Affected File List

- [DashboardTaskProjection.ts](../../src/services/stats/DashboardTaskProjection.ts)
- [DashboardTaskProjection.spec.ts](../../src/services/stats/__tests__/DashboardTaskProjection.spec.ts)
- [usage-stats.ts](../../packages/types/src/usage-stats.ts)
- [vscode-extension-host.ts](../../packages/types/src/vscode-extension-host.ts)
- [dashboard-stats-stream.spec.ts](../../packages/types/src/__tests__/dashboard-stats-stream.spec.ts)
- [dashboard-preset-change-bug.spec.ts](../../src/services/stats/__tests__/dashboard-preset-change-bug.spec.ts)
- [UsageStatsStreamCoordinator.spec.ts](../../src/services/stats/__tests__/UsageStatsStreamCoordinator.spec.ts)
- [215718_code-environment-feedback.md](215718_code-environment-feedback.md)
- [220234_code-tsc-environment-feedback.md](220234_code-tsc-environment-feedback.md)
