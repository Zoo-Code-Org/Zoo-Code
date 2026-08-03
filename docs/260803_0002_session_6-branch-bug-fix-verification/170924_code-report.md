# Code Task Report
## Task Summary
Fixed the optimistic-lock timing and root-task group-resolution defects in [`TaskOrganizationStore.ts`](../src/core/task-persistence/TaskOrganizationStore.ts), and added focused regression coverage in [`TaskOrganizationStore.spec.ts`](../src/core/task-persistence/__tests__/TaskOrganizationStore.spec.ts).

## Actions Taken
- Moved the mutation revision capture into the [`withLock()`](../src/core/task-persistence/TaskOrganizationStore.ts:825) callback in [`mutate()`](../src/core/task-persistence/TaskOrganizationStore.ts:171), so it is sampled only after serialization begins.
- Updated [`resolveUnit()`](../src/core/task-persistence/TaskOrganizationStore.ts:588) to resolve any known task through [`resolveTaskClosure()`](../src/core/task-persistence/TaskOrganizationStore.ts:610). This includes roots with descendants as well as child tasks.
- Added a regression test confirming that dragging a root task moves the root and child together.
- Updated the concurrent-mutation regression test to require all serialized calls with sequential expected revisions to succeed at revisions 1 through 5.
- Re-read both modified source and test sections to confirm placement and assertions.

## Result
Partial, source and test inspection confirmed.

- Bug #5 is fixed: [`revisionAtCallTime`](../src/core/task-persistence/TaskOrganizationStore.ts:176) is read inside the lock callback, before the revision comparison at [`TaskOrganizationStore.ts`](../src/core/task-persistence/TaskOrganizationStore.ts:191).
- Bug #6 is fixed: a known root task now enters [`resolveTaskClosure()`](../src/core/task-persistence/TaskOrganizationStore.ts:595), producing a complete parent-child move unit.
- Tests could not execute because the worktree environment has no `pnpm` executable and no locally resolvable `vitest/config`. Both failures occurred before test cases ran and are documented in [`170635_code-environment-feedback.md`](170635_code-environment-feedback.md) and [`170715_code-vitest-environment-feedback.md`](170715_code-vitest-environment-feedback.md).

## Issues Discovered
- Focused test execution is blocked by missing package-manager and project dependencies in the assigned worktree. No dependency installation was attempted because it is outside the delegated source-fix scope.

## Next Step Recommendations
- Restore the worktree's dependencies and make pnpm available, then run `pnpm --filter roo-cline test core/task-persistence/__tests__/TaskOrganizationStore.spec.ts` from the worktree root.

## Affected File List
- [`src/core/task-persistence/TaskOrganizationStore.ts`](../src/core/task-persistence/TaskOrganizationStore.ts)
- [`src/core/task-persistence/__tests__/TaskOrganizationStore.spec.ts`](../src/core/task-persistence/__tests__/TaskOrganizationStore.spec.ts)
- [`170635_code-environment-feedback.md`](170635_code-environment-feedback.md)
- [`170715_code-vitest-environment-feedback.md`](170715_code-vitest-environment-feedback.md)
