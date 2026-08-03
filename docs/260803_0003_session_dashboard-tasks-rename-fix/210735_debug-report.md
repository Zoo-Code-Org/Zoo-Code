# Debug Task Report

## Task Summary
Fix three test failures blocking Sub-task 1 (DashboardTaskCatalog + TaskHistoryStore `onDidChange`): a parser error in the DashboardTaskCatalog spec, an `invalidate()` cache-refresh regression in TaskHistoryStore, and a workaround for the broken `EventEmitter` export in the workspace vscode mock.

## Actions Taken

### Issue 1 — DashboardTaskCatalog.spec.ts parser error
- Root cause: the local `EventEmitter` test double in `src/services/stats/__tests__/DashboardTaskCatalog.spec.ts` had a `fire()` method missing its closing `}` before `dispose()`, producing a transform parse error.
- Fix: added the missing `}` to close `fire()` before `dispose()` (lines 17-22).

### Issue 2 — invalidate() regression in TaskHistoryStore
- Root cause: `invalidate()` at `src/core/task-persistence/TaskHistoryStore.ts:470` called bare `historyItemsEqual(existing, item)`, but the helper is a **private class method** declared at line 823 (`private historyItemsEqual(...)`). Vitest/esbuild transpiles without type-checking, so the unresolved identifier threw a ReferenceError at runtime inside the `try` block. The `catch {}` at line 477 swallowed it and fell through to `cache.delete(taskId)`, leaving the cache entry absent after invalidation. Both refresh tests (spec lines ~478 and ~545) then observed `store.get(id) === undefined`.
- Fix: changed the bare call to `this.historyItemsEqual(existing, item)` at `src/core/task-persistence/TaskHistoryStore.ts:470`. This restores the exact invalidation cache-refresh behavior (re-read from disk, compare, update cache only when changed, fire `onDidChange`).

### Issue 3 — vscode.js mock EventEmitter (workaround, no mock edit)
- `src/__mocks__/vscode.js:2` exports `EventEmitter` as a non-constructible arrow function. Per delegation constraints this file was NOT modified.
- Workaround: both spec files already declare `vi.mock("vscode", () => { class EventEmitter<T> { ... } return { EventEmitter } })` with a local constructible class, which shadows the broken workspace mock during the test run. Issue 1's syntax fix restored this shadowing for the DashboardTaskCatalog spec; the TaskHistoryStore spec already had the correct local class. No reliance on the workspace mock remains.

## Result
Success. Verification run from `src`:
```
npx vitest run core/task-persistence/__tests__/TaskHistoryStore.spec.ts services/stats/__tests__/DashboardTaskCatalog.spec.ts
```
- Test Files: 2 passed (2)
- Tests: 44 passed (44)
- Exit code: 0

Exact pass/fail count: **44 passed, 0 failed** (38 in TaskHistoryStore.spec.ts + 6 in DashboardTaskCatalog.spec.ts).

## Issues Discovered
- The `catch {}` in `invalidate()` silently converts any read-compare error into a cache eviction. This masked the ReferenceError and made the regression present as "cache entry absent" rather than an explicit error. Consider logging inside that catch (e.g., `TASK_HISTORY_STORE/invalidate/001`) for future traceability — flagged as an advisory, not changed in this scope.

## Test Environment Issues
- None. The vitest run executed cleanly from the `src` workspace. An initial attempt to pipe output through PowerShell's `Select-Object` failed because the terminal defaulted to cmd.exe; re-ran without the pipe with no other environment changes required.

## Next Step Recommendations
- VP may proceed with the remaining Dashboard tasks rename-fix sub-tasks. If desired, add an error-log line inside the `invalidate()` catch for observability (advisory only).

## Affected File List
- `src/services/stats/__tests__/DashboardTaskCatalog.spec.ts` — fixed EventEmitter mock syntax (missing `}`)
- `src/core/task-persistence/TaskHistoryStore.ts` — fixed `invalidate()` to call `this.historyItemsEqual` (line 470)
- `src/core/task-persistence/__tests__/TaskHistoryStore.spec.ts` — no changes needed (local EventEmitter mock already correct)
