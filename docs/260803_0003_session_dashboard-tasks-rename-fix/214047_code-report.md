# Code Task Report

## Task Summary

Implemented the approved direct task-level SQLite usage projection and focused task-ID queries, while keeping the legacy root-session projection intact.

## Actions Taken

- Added the `task_usage_metadata` projection table and the indexed direct task-event read path in [UsageStatsDatabase.ts](../../src/services/stats/UsageStatsDatabase.ts).
- Added chunked direct-task summary reads and focused event reads through [`queryTaskUsageByTaskIds()`](../../src/services/stats/UsageStatsDatabase.ts:2011) and [`queryEventsByTaskIds()`](../../src/services/stats/UsageStatsDatabase.ts:2054). Each query chunks at 900 IDs, returns zero-value summaries for IDs without usage, and preserves global event sequence ordering after chunked reads.
- Updated [`appendInternal()`](../../src/services/stats/UsageStatsDatabase.ts:1514) and [`bulkAppend()`](../../src/services/stats/UsageStatsDatabase.ts:1737) to write the direct event task projection only after an idempotent event insert succeeds, without removing the root-session projection update.
- Updated [`rebuildRollupsFromEvents()`](../../src/services/stats/UsageStatsDatabase.ts:1063) and [`clearGeneration()`](../../src/services/stats/UsageStatsDatabase.ts:2545) to rebuild and clear the direct-task projection. Rebuild uses explicit `totalTokens` when present and falls back to input plus output tokens, matching append semantics.
- Added regression coverage in [UsageStatsDatabase.spec.ts](../../src/services/stats/__tests__/UsageStatsDatabase.spec.ts) for schema/index creation, idempotent direct-task writes, root-session compatibility, indexed focused reads, 901-ID chunking, projection clearing, rebuild totals, and deterministic same-timestamp sequence ties.

## Result

**Success.**

- Targeted Vitest verification passed: **58 passed, 0 failed**, across 19 suites.
  - Command: `cd src && npx vitest run services/stats/__tests__/UsageStatsDatabase.spec.ts --pool=forks --maxWorkers=1 --reporter=json --outputFile=vitest-usage-stats-result.json`
  - The JSON report was written to [vitest-usage-stats-result.json](../../src/vitest-usage-stats-result.json) and confirmed the exact result count.
- ESLint verification passed with zero warnings:
  - Command: `corepack pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 services/stats/UsageStatsDatabase.ts services/stats/__tests__/UsageStatsDatabase.spec.ts`

## Issues Discovered

- Before the final verification, the rebuild path calculated total tokens from input plus output only, while append paths honored explicit total tokens. This caused the new rebuild regression test to report `0` rather than `300` tokens. The root cause was semantic drift between [`rebuildRollupsFromEvents()`](../../src/services/stats/UsageStatsDatabase.ts:1063) and the append paths. It is corrected by using `usage.totalTokens?.value ?? inputTokens + outputTokens` during rebuild.
- The terminal runner intermittently lost Vitest’s completion state and final output after the process exited. The JSON reporter produced a machine-readable, independently verified result. Details are recorded in [213925_code-vitest-terminal-output-feedback.md](213925_code-vitest-terminal-output-feedback.md).
- The verification command created [vitest-usage-stats-result.json](../../src/vitest-usage-stats-result.json) as a temporary test-result artifact. It was retained because this mode must not delete files.

## Next Step Recommendations

- The task is ready for VP review and integration with the task projection and IPC work that consumes the new focused APIs.

## Affected File List

- [UsageStatsDatabase.ts](../../src/services/stats/UsageStatsDatabase.ts)
- [UsageStatsDatabase.spec.ts](../../src/services/stats/__tests__/UsageStatsDatabase.spec.ts)
- [214047_code-report.md](214047_code-report.md)
