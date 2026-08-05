# Debug Task Report: CI Fix for PR #1127 and PR #1136

## Task Summary

Fix remaining CI failures on two PRs:

1. PR #1127 (b09-task-org-ipc-v2): platform-unit-test failures (ubuntu + windows)
2. PR #1136 (b07-shell-integration-v2): compile (lint) failure

## Actions Taken

### PR #1127 (b09-task-org-ipc-v2)

**Root Cause Analysis:**

- CI showed `platform-unit-test` failing with exit code 1 on both ubuntu and windows
- All 435 tests passed (4 skipped), but vitest reported "9 unhandled errors during the test run"
- The unhandled rejections were `EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending`
- Root cause: The `ClineProvider.taskHistory.spec.ts` test creates `ClineProvider` instances which now construct `TaskOrganizationStore` instances (added in this PR). The store's `initialize()` is fire-and-forget and starts a file watcher via `fsSync.watch()`. These async operations remain pending when the test worker shuts down, causing unhandled rejections.
- Additionally, the `safeWriteJson` mock only exported `safeWriteJson` but not `safeUpdateJson` (which `TaskOrganizationStore.save()` imports), causing a `TypeError` when `reconcile()` was called from the `onWrite` callback.

**Fix:**

1. Added `safeUpdateJson` to the `vi.mock("../../../utils/safeWriteJson")` factory in `ClineProvider.taskHistory.spec.ts`
2. Added `afterEach` hook to dispose the `TaskOrganizationStore` before the next test runs, preventing pending async operations from leaking

**File changed:** `src/core/webview/__tests__/ClineProvider.taskHistory.spec.ts`

### PR #1136 (b07-shell-integration-v2)

**Root Cause Analysis:**

- CI showed `compile` job failing with exit code 1
- The `compile` job runs `pnpm lint` and `pnpm check-types`
- The failure was in `zoo-code:lint` (eslint), not in check-types
- Error: `src/integrations/terminal/Terminal.ts` line 313: `'timer' is never reassigned. Use 'const' instead` (`prefer-const`)
- Root cause: A previous fix in this PR declared `let timer: NodeJS.Timeout | undefined` and assigned it later via `timer = setTimeout(...)`. ESLint's `prefer-const` rule correctly identified that `timer` is never reassigned after its initial assignment.

**Fix:**

- Changed `let timer` to `const timer` and moved the `setTimeout()` call to the declaration site
- Reordered the code so `timer` is defined before `onAbort` (which references it), eliminating the need for deferred assignment

**File changed:** `src/integrations/terminal/Terminal.ts`

## Result

- Both fixes verified locally (lint passes, tests pass)
- Both fixes pushed to fork `myk1yt` on the respective branches

## Issues Discovered

- The `safeWriteJson` mock pattern in `ClineProvider.taskHistory.spec.ts` was incomplete - only mocking `safeWriteJson` but not `safeUpdateJson`. This is a pre-existing test infrastructure issue that was exposed by the new `TaskOrganizationStore` which imports `safeUpdateJson`.
- The `TaskOrganizationStore` constructor starts async operations (file watcher, initialization) that need explicit cleanup in tests.

## Next Step Recommendations

- Monitor CI runs on both PRs to confirm the fixes resolve the failures
- Consider adding a lint step to the pre-commit hook to catch `prefer-const` violations before push

## Affected File List

- `src/core/webview/__tests__/ClineProvider.taskHistory.spec.ts`
- `src/integrations/terminal/Terminal.ts`
