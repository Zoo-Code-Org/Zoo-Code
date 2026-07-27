# Code Task Report

## Task Summary

Fix PR D CI test failures in the `feature/local-usage-stats` branch for the Code QA `platform-unit-test` job. The initial assumption was a `@roo-code/cloud` RetryQueue failure caused by a `vscode` import chain, but the actual failures were in the `src` (zoo-code) package tests.

## Actions Taken

1. Switched to `feature/local-usage-stats` and reproduced the CI command locally.
2. Identified that the CI `platform-unit-test` command is:
    ```
    pnpm turbo run test:coverage --filter="!@roo-code/core" --log-order grouped --output-logs new-only
    ```
3. Confirmed `@roo-code/cloud` tests pass locally (247 passed). The logged `Cannot find module 'vscode'` message comes from `packages/cloud/src/importVscode.ts` graceful fallback and is not a failure.
4. Reproduced `src` package failures in `src/api/providers` (12 tests) and `src/core/task-persistence` (4 tests).
5. Fixed provider `totalCost` regressions in streaming usage chunks by wiring `calculateApiCostOpenAI`/`calculateApiCostAnthropic` into:
    - `src/api/providers/kenari.ts`
    - `src/api/providers/mistral.ts`
    - `src/api/providers/moonshot.ts`
    - `src/api/providers/openai.ts`
    - `src/api/providers/anthropic-vertex.ts`
6. Fixed `TaskOrganizationStore` bugs and one test inconsistency:
    - `packages/types/src/task-organization.ts`: `createEmptyTaskOrganizationState` now accepts an optional `now` timestamp (defaults to `0`) so stores with a custom `now` function can produce deterministic empty states.
    - `src/core/task-persistence/TaskOrganizationStore.ts`: empty states created on missing/corrupt files now use `this.now()`.
    - `src/core/task-persistence/TaskOrganizationStore.ts`: future schema versions (`schemaVersion > 1`) are detected and preserved before Zod validation, preventing quarantine of forward-compatible data.
    - `src/core/task-persistence/TaskOrganizationStore.ts`: `resolveUnit` for a plain `task` target now expands to the full auto-group closure when the task belongs to a parent/child group, so dragging a child moves the whole group.
    - `src/core/task-persistence/__tests__/TaskOrganizationStore.spec.ts`: corrected the concurrent-mutation test to use the same base revision for all callers and assert only one succeeds (the others receive `TASK_ORG/CONFLICT/002`).
7. Ran the full `src` test suite: 432 test files passed, 7180 tests passed.
8. Ran `packages/cloud` test suite: 11 test files passed, 247 tests passed.

## Result

Success. All CI-relevant test failures in `src` are resolved. The non-core test suite should now pass.

## Issues Discovered

- The CI failure was not in `@roo-code/cloud` RetryQueue; the cloud tests were already passing. The real failures were in `src` due to:
    - Missing `totalCost` field in provider usage chunks after the stats feature added expectations.
    - Bugs in the ported `TaskOrganizationStore` (empty-state timestamp, future-schema quarantine, auto-group closure resolution).
    - A test bug in the concurrent-mutation case that used incrementing expected revisions while asserting only one mutation succeeds.

## Next Step Recommendations

- Push the branch and verify the Code QA workflow passes in CI.
- Review whether the `anthropic-vertex` `message_delta` usage chunk should also carry `totalCost` (currently left off to match existing test expectations).

## Affected File List

- `packages/types/src/task-organization.ts`
- `src/core/task-persistence/TaskOrganizationStore.ts`
- `src/core/task-persistence/__tests__/TaskOrganizationStore.spec.ts`
- `src/api/providers/kenari.ts`
- `src/api/providers/mistral.ts`
- `src/api/providers/moonshot.ts`
- `src/api/providers/openai.ts`
- `src/api/providers/anthropic-vertex.ts`
