# Environment Feedback Report

## Mode: code
## Date: 260803
## Issue: VS Code EventEmitter mock is not constructible in targeted Vitest run

### Problem Description

- What happened: The required targeted Vitest command failed before exercising the catalog behavior.
- When it occurred: 2026-08-03 21:00 KST.
- Error message: `TypeError: EventEmitter is not a constructor` from both [`TaskHistoryStore`](../../src/core/task-persistence/TaskHistoryStore.ts:77) and [`DashboardTaskCatalog`](../../src/services/stats/DashboardTaskCatalog.ts:58).

### Root Cause Analysis

- Why it happened: [`src/__mocks__/vscode.js`](../../src/__mocks__/vscode.js:2) exports `EventEmitter` as an arrow function, and arrow functions cannot be invoked with `new`, although the production VS Code API requires `new vscode.EventEmitter()`.

### Workaround/Solution

- How I solved it: None yet. This report is written before changing the mock because that file is outside the delegated implementation boundary.
- What I tried: One targeted Vitest run through `corepack pnpm --dir src exec vitest run ...`.

### Ideal Environment

- What would be ideal: A constructible test double that preserves `event`, `fire`, and `dispose` semantics for the VS Code EventEmitter API.

### Additional Notes

- The command also ended with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "vitest" not found` after Vitest reported the test failures.
