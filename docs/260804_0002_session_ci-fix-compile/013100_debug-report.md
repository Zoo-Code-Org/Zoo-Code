# Debug Task Report: CI Test Failure Fixes for PR #1134 and PR #1136

## Task Summary

Fixed CI test failures on PR #1134 (b16-stats-ui-v2) and addressed a CodeRabbit-identified critical bug on PR #1136 (b07-shell-integration-v2).

## Actions Taken

### PR #1134 (b16-stats-ui-v2) — platform-unit-test failure

1. Retrieved CI failure logs via `gh pr checks 1134` and `gh run view --log-failed`.
2. Identified the failing test: `core/task/__tests__/Task.usage-stats.spec.ts:572` — "passes rootTaskId and parentTaskId to the recorder when a sub-task stream fails".
3. Checked out local branch `temp/pr/b16-stats-ui-v2`.
4. Root cause analysis: In [`Task.ts`](src/core/task/Task.ts:3218), two `UsageRecordingContext` objects (lines 3218 and 3363) were constructed with `taskId` and `parentTaskId` but **missing `rootTaskId`**. When a sub-task stream failed, `ctx.rootTaskId` was `undefined` instead of the parent task's ID.
5. Fix: Added `rootTaskId: this.rootTaskId` to both `ctx` objects.
6. Verified locally: `npx vitest run core/task/__tests__/Task.usage-stats.spec.ts` — 18/18 tests passed.
7. Committed and pushed to `myk1yt/pr/b16-stats-ui-v2`.

### PR #1136 (b07-shell-integration-v2) — CodeRabbit critical finding

1. Checked PR #1136 CI status: all unit tests pass, only `codecov/patch` fails (coverage warning, not a test failure).
2. Reviewed CodeRabbit inline review comments as instructed by VP.
3. Found 1 critical issue: **Temporal Dead Zone bug** in [`Terminal.ts`](src/integrations/terminal/Terminal.ts:311).
    - `onAbort()` (line 312) references `timer` and `ref`, but both are `const` declarations at lines 327-328.
    - If `abortController.signal.aborted` is already `true` at line 320, `onAbort()` is called synchronously before those bindings initialize, causing a `ReferenceError` instead of the intended `AbortError` rejection.
    - Downstream: `runCommand` checks `error.name === "AbortError"` — a `ReferenceError` fails this check, so a cancelled wait is misreported as a shell-integration timeout.
4. Fix: Moved `ref` and `timer` declarations before `onAbort`, changed `timer` from `const` to `let`, and added a truthiness guard on `clearTimeout(timer)`.
5. Verified: `npx tsc --noEmit` clean, `npx vitest run integrations/terminal` — 389/389 tests passed.
6. Committed and pushed to `myk1yt/pr/b07-shell-integration-v2`.

## Result

- **PR #1134**: ✅ Fixed and pushed (commit `9e4a32703`)
- **PR #1136**: ✅ Fixed and pushed (commit `d5a219a9e`)

## Issues Discovered

- PR #1136's `codecov/patch` failure is a coverage warning (not a test failure). Several files have low coverage (e.g., `ClineProvider.ts` at 13.88%, `ExecuteCommandTool.ts` at 58.01%). This is a pre-existing issue, not introduced by this fix.

## Next Step Recommendations

- Monitor CI runs on both PRs after push to confirm all checks pass.
- Consider addressing the `codecov/patch` coverage gaps on PR #1136 in a separate task if required for merge.

## Affected File List

- `src/core/task/Task.ts` (PR #1134 — added `rootTaskId` to 2 `UsageRecordingContext` objects)
- `src/integrations/terminal/Terminal.ts` (PR #1136 — fixed temporal dead zone in abort handler)
