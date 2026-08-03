# Environment Feedback Report

## Mode: code

## Date: 260803

## Issue: Source TypeScript check exposed legacy stream test type narrowing gaps

### Problem Description

- What happened: Running the source workspace TypeScript check after adding compatibility stream unions reported three test compile errors. Existing tests access `dashboardStatsStreamSnapshot.sessions` directly, but the property can now contain either a legacy session snapshot or a new task snapshot.
- When it occurred: Post-implementation static verification for the Dashboard Tasks projection and IPC contract sub-task.
- Error message: `TS2339: Property 'sessions' does not exist on type ...`, in `dashboard-preset-change-bug.spec.ts` and `UsageStatsStreamCoordinator.spec.ts`.

### Root Cause Analysis

- Why it happened: The approved additive IPC migration introduces a task/session union so both payload versions are valid during Sub-task 4 migration. The affected legacy tests have no discriminating type guard before reading the legacy-only `sessions` field.

### Workaround/Solution

- How I solved it: The pre-existing legacy test access was narrowed with an `"sessions" in snapshot` guard. The new task-stream tests also require a matching `"tasks" in snapshot` or `"taskUpsert" in delta` guard before task-only fields are accessed; that narrow test-only correction is pending.
- What I tried: `corepack pnpm --dir src exec tsc --noEmit` and `corepack pnpm --dir src run check-types`.

### Ideal Environment

- What would be ideal: A checked-in transition type guard for Dashboard stream snapshots, allowing legacy and task consumers to narrow payloads consistently during the migration.

### Additional Notes

- This is a compile-time migration compatibility finding. The three focused task/session test suites previously passed.
- The latest check reports task-union narrowing diagnostics at lines 248, 274, 275, 297, and 314 of `UsageStatsStreamCoordinator.spec.ts`; no production source diagnostics were reported.
- A follow-up targeted file read initially failed because the tool rejected `anchor_line: 0`; subsequent reads must use a positive 1-based anchor line.
