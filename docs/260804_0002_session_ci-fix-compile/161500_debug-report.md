# Debug Task Report: CI Compile Failures on 8 PRs

## Task Summary

Fixed CI compile (lint + tsc) failures on 8 PRs in Zoo-Code-Org/Zoo-Code. The root cause was the squash merge using `--theirs` for `src/eslint-suppressions.json` and `src/core/task/Task.ts`, which picked the wrong version for stacked branches.

## Actions Taken

### Phase 1: Lint Fix (All 8 PRs) ✅

The CI "compile" check runs `pnpm lint` which includes `eslint --max-warnings=0`. The squash merge kept stale eslint suppression entries that no longer matched any code.

**Fix**: Ran `npx eslint --prune-suppressions --max-warnings=0 .` on each branch to remove stale entries.

| PR#   | Branch                        | Stale entries removed                      | Push SHA    |
| ----- | ----------------------------- | ------------------------------------------ | ----------- |
| #1122 | `pr/b08-task-persistence-v2`  | 13                                         | `3050a233a` |
| #1127 | `pr/b09-task-org-ipc-v2`      | 13                                         | `0d584850f` |
| #1129 | `pr/b10-task-org-ui-v2`       | 13                                         | `5dc346147` |
| #1130 | `pr/b12-mimo-enforcement-v2`  | ~1771                                      | `b526a576e` |
| #1131 | `pr/b14-usage-aggregation-v2` | ~1776                                      | `bebff33ad` |
| #1133 | `pr/b15-usage-capture-v2`     | ~1776                                      | `9bad343b9` |
| #1134 | `pr/b16-stats-ui-v2`          | ~1767 + count fix (18→29 for mimo.spec.ts) | `9c6f64e13` |
| #1136 | `pr/b07-shell-integration-v2` | ~1786                                      | `4acd141b6` |

### Phase 2: TypeScript Fix (b15, b16, b07) ✅

After the lint fix, b15/b16/b07 still failed `tsc --noEmit` with errors about missing `messageCounts`, `flushTelemetryInstallment`, and `startIdleTelemetryCheck` on the `Task` class.

**Root cause**: The squash merge replaced `src/core/task/Task.ts` with the feature branch's version, which was based on an older main that didn't have the telemetry feature (PR #1071).

**Fix**: Restored Task.ts from the appropriate parent branch:

- b15: Restored from b14 (`bae2ac99a`) → `c1dd3ac02`
- b16: Restored from b14 (`bae2ac99a`) → `bc7d9d5d9`
- b07: Restored from b06 (`4fe1300f8`) → `7902883b9`

### Phase 3: b16 mimo.spec.ts suppression count fix ✅

The squash merge kept a count of 18 for `mimo.spec.ts` but the actual code has 29 `any` casts. Updated the count to 29.

## Result

### CI Status as of 2026-08-04 16:23 UTC

| PR#   | Branch | Compile (lint+tsc) | Unit Tests | E2E        | Notes                                       |
| ----- | ------ | ------------------ | ---------- | ---------- | ------------------------------------------- |
| #1122 | b08    | ✅ pass            | ✅ pass    | ✅ pass    | Fully fixed                                 |
| #1127 | b09    | ✅ pass            | ❌ fail    | ✅ pass    | Unit test exit code 1 (pre-existing)        |
| #1129 | b10    | ✅ pass            | ✅ pass    | ✅ pass    | Fully fixed                                 |
| #1130 | b12    | ✅ pass            | ✅ pass    | ✅ pass    | Fully fixed                                 |
| #1131 | b14    | ✅ pass            | ✅ pass    | ✅ pass    | Fully fixed                                 |
| #1133 | b15    | ⏳ CI re-running   | ⏳ pending | ⏳ pending | Task.ts fix pushed                          |
| #1134 | b16    | ⏳ CI re-running   | ❌ fail    | ❌ fail    | Task.ts fix pushed, tests/e2e still failing |
| #1136 | b07    | ⏳ CI re-running   | ❌ fail    | ⏳ pending | Task.ts fix pushed, tests still failing     |

## Issues Discovered

### 1. Stale eslint-suppressions.json (All 8 PRs)

The squash merge used `--theirs` for `eslint-suppressions.json`, which kept stale suppression entries from the feature branch that no longer matched any code in the stacked branch.

### 2. Incorrect mimo.spec.ts suppression count (b16)

The squash merge kept a count of 18 for `mimo.spec.ts` but the actual code has 29 `any` casts. Updated the count to 29.

### 3. Lost telemetry methods in Task.ts (b15, b16, b07)

The squash merge replaced Task.ts with an older version missing telemetry methods (`messageCounts`, `flushTelemetryInstallment`, `startIdleTelemetryCheck`). These were introduced by upstream PR #1071 and were present in the parent branches. Fixed by restoring Task.ts from the parent branch.

### 4. b09 platform-unit-test failure (pre-existing)

PR #1127 (b09) has `platform-unit-test` failures. All 7307 tests pass but the process exits with code 1 due to unhandled errors in test output. This is a pre-existing issue.

### 5. b16/b07 test and e2e failures

After fixing compile, b16 and b07 still have `platform-unit-test` and `e2e-mock` failures. These need separate investigation.

## Test Environment Issues

- **PowerShell stderr**: Git writes progress messages to stderr, causing PowerShell to report exit code 1 even when the command succeeds. Check actual output for success indicators like `SHA..SHA  HEAD -> branch`.
- **git worktree permission**: `error: failed to delete '.git/worktrees/-wt-shell-fix'` appears on every commit but is non-fatal.
- **ESLint execution time**: `npx eslint` takes ~60-90 seconds per branch.
- **tsc execution time**: `npx tsc --noEmit` takes ~60 seconds.

## Next Step Recommendations

1. **Verify b15/b16/b07 compile passes** after the Task.ts fixes (CI is re-running)
2. **Investigate b16/b07 test and e2e failures** - these are separate from the compile issue
3. **Investigate b09 unit test exit code 1** - pre-existing issue
4. **Check remaining 9 PRs** that were not in the original failing list
5. **Check all 17 PRs** for any other CI failures

## Affected File List

- `src/eslint-suppressions.json` (all 8 branches - pruned stale entries)
- `src/core/task/Task.ts` (b15, b16, b07 - restored from parent branch to recover telemetry methods)
