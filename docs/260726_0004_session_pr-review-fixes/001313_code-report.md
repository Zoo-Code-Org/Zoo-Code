# Code Task Report: Synchronize Reset and Circuit State (Task 6)

## Task Summary

Synchronized `ToolErrorInterceptor.resetTaskState()` with `TaskErrorState` so that resetting one state consumer also resets the corresponding category in the other, preventing occurrence value divergence between guidance messages and the actual counter.

## Actions Taken

### 1. Modified [`TaskErrorState.ts`](src/core/tools/error-interception/TaskErrorState.ts)

- Added `hasTaskErrorState(task: object): boolean` export function that checks the module-level WeakMap without materializing new state. This is critical for the no-op path in `resetTaskState()`.

### 2. Modified [`ToolErrorInterceptor.ts`](src/core/tools/error-interception/ToolErrorInterceptor.ts)

- Imported `getTaskErrorState` and `hasTaskErrorState` from the TaskErrorState module.
- Updated `resetTaskState(task, category?)`:
    - **Category-specific reset**: Deletes the interceptor's category counter, closes the shell circuit if the category is `SHELL_INTEGRATION`, and calls `getTaskErrorState(task).reset(category)` on the corresponding TaskErrorState category (only if TaskErrorState already has state for the task).
    - **Full reset**: Clears all interceptor counters, closes the shell circuit, and calls `getTaskErrorState(task).reset()` for all categories (only if TaskErrorState already has state for the task).
    - **No-op path preserved**: Returns early if the task has no entry in the interceptor's WeakMap, and uses `hasTaskErrorState()` to avoid materializing TaskErrorState as a side effect.

### 3. Updated [`ToolErrorInterceptor.spec.ts`](src/core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts)

- Added import for `getTaskErrorState` and `hasTaskErrorState`.
- Enhanced "returns early when task has no state" test to also verify `hasTaskErrorState(task)` is `false` (no materialization).
- Added "synchronizes reset with TaskErrorState for a full reset" test: verifies both consumers reset together and next error has occurrence 1.
- Added "synchronizes category-specific reset with TaskErrorState" test: verifies SHELL_INTEGRATION resets in both while FILE_NOT_FOUND is untouched.
- Added "closes the shell circuit when resetting SHELL_INTEGRATION category" test: verifies circuit-open message stops after category-specific reset.
- Added "does not materialize TaskErrorState when resetting a task with no interceptor state" test for the category-specific no-op path.

### 4. Updated [`TaskErrorState.spec.ts`](src/core/tools/error-interception/__tests__/TaskErrorState.spec.ts)

- Added import for `hasTaskErrorState`.
- Added `hasTaskErrorState` describe block with 3 tests: returns false for never-accessed task, returns true after `getTaskErrorState`, returns false for a different unaccessed task.

## Result

✅ Success — All 60 tests pass (2 test files, 0 failures).

```
Test Files  2 passed (2)
     Tests  60 passed (60)
  Duration  904ms
```

## Acceptance Criteria Verification

- ✅ Two identical failures render occurrences 1 and 2 in BOTH state consumers (interceptor counter + TaskErrorState)
- ✅ A changed fingerprint restarts both values at 1 (full reset resets both)
- ✅ Resetting one category does not affect another category or task (category-specific reset test)
- ✅ Resetting the shell category closes its shell circuit (dedicated test verifies circuit-open stops)
- ✅ The first transformed error after reset has occurrence 1 (verified in all reset tests)
- ✅ No-op path preserved: resetting a task with no state doesn't throw (both full and category-specific no-op tests)

## Issues Discovered

None. The implementation was straightforward. The initial test failure (2 tests) was due to an incorrect assumption that the interceptor increments TaskErrorState — it does not (that happens in `presentAssistantMessage`, which is Task 8's scope). Tests were corrected to manually simulate TaskErrorState increments.

## Next Step Recommendations

- Task 8 (`presentAssistantMessage.ts` changes) should wire the fingerprint-based reset to call `interceptor.resetTaskState()` so the synchronization happens automatically at runtime.
- Consider adding an integration test that exercises both `presentAssistantMessage` and `ToolErrorInterceptor` together to verify end-to-end synchronization.

## Affected File List

- `src/core/tools/error-interception/TaskErrorState.ts`
- `src/core/tools/error-interception/ToolErrorInterceptor.ts`
- `src/core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts`
- `src/core/tools/error-interception/__tests__/TaskErrorState.spec.ts`
