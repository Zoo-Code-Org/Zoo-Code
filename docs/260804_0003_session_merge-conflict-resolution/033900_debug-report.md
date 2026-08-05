# Debug Task Report: Fix PR #1130 e2e-mock failure

## Task Summary

Fix the `e2e-mock` CI failure on PR #1130 (b12-mimo-enforcement-v2). The failing test was "abandoning an interrupted subtask severs the parent-child link" in the "Roo Code Subtasks" suite, timing out after 30s.

## Actions Taken

### 1. CI Failure Log Analysis

- Retrieved CI failure log via `gh run view 30968571322 --repo Zoo-Code-Org/Zoo-Code --log-failed`
- Identified 1 failing test out of 81 (80 passing):
    - **Test**: "abandoning an interrupted subtask severs the parent-child link"
    - **Suite**: "Roo Code Subtasks"
    - **Error**: `Error: Timeout after 30s` at `out/suite/utils.js:27:24`

### 2. Root Cause Analysis

- **CI log timeline** (02:14:50.948 - 02:15:20.948):
    - Parent task `019fcfb3-bd3f` created (abandon test)
    - 180ms later: "Failed to parse tool call arguments: [object Object]"
    - Tool call had `name: "attempt_completion"`, `id: "call_interrupt_parent_completion_003"` (from interrupt parent completion fixture), but `arguments: {"mode":"ask","message":"SUBTASK_CHILD_ABANDON_SEVER:..."}` (from abandon parent fixture)
    - This is a mixed fixture response — tool name/ID from one fixture, arguments from another
    - After parse failure, retries got "404 No fixture matched" until 30s timeout

- **Flakiness confirmation**: The ONLY change between the passing commit (`6b18c09ee`) and the failing commit (`9218429c9`) was `codecov.yml`. No code changes. This confirms the test is flaky.

- **Root cause**: The abandon parent fixture used `userMessage: new RegExp(SUBTASK_ABANDON_PARENT_MARKER)` + `sequenceIndex: 0` for matching. The `sequenceIndex` counter is shared globally across all e2e tests (via `DEFAULT_TEST_ID` in LLMock). When a prior test's delayed mock stream interleaves with the current test's fixture matching, the `sequenceIndex` guard can fail, causing the wrong fixture to match and return a mixed tool-call response (name from one fixture, arguments from another).

### 3. Fix Applied

File: [`apps/vscode-e2e/src/fixtures/subtasks.ts`](apps/vscode-e2e/src/fixtures/subtasks.ts:567)

Replaced the `userMessage` + `sequenceIndex: 0` match with a `predicate` match using:

- `lastUserMessageContains(req, SUBTASK_ABANDON_PARENT_MARKER)` — scopes the match to the last user message (mirrors LLMock's `userMessage` matcher semantics)
- `!requestContains(req, [SUBTASK_RESULT_INJECTION])` — excludes parent-resume turns (which carry the injected child result prefix `completed.\n\nResult:`)

This mirrors the pattern used by the regular parent fixtures (lines 187-191) and the fast parent fixtures (lines 164-171), eliminating the fragile `sequenceIndex` dependency.

### 4. Verification

- TypeScript compilation: `npx tsc --noEmit` — passed (exit code 0)
- ESLint: `npx eslint src/fixtures/subtasks.ts --max-warnings=0` — passed (exit code 0)
- Note: Full e2e test verification requires VS Code extension host and LLMock server, which cannot run in this debug environment. The fix follows the exact same pattern as the existing passing parent fixtures.

## Result

- **Success**: Fix committed as `cd1ae7a5f` and pushed to `myk1yt/pr/b12-mimo-enforcement-v2`
- Commit message: `fix(e2e-mock): replace sequenceIndex with predicate match for abandon parent fixture`

## Issues Discovered

- The `sequenceIndex` counter in LLMock is shared across all tests via `DEFAULT_TEST_ID`. This makes `sequenceIndex: 0` fixtures fragile when prior tests' delayed streams or fixture matching state can interfere. The predicate-based matching pattern (using `lastUserMessageContains` + `SUBTASK_RESULT_INJECTION` exclusion) is more robust and should be used consistently for all parent fixtures.

## Next Step Recommendations

- Consider auditing other `sequenceIndex: 0` fixtures in the subtasks fixture file (fast parent at line 127, interrupt parent at line 479, api-hang parent at line 248, xprofile parent at line 327) and converting them to predicate-based matches for consistency and robustness.
- The LLMock library could benefit from per-test `sequenceIndex` counters (via `x-test-id` header) to prevent cross-test counter contamination.

## Affected File List

- `apps/vscode-e2e/src/fixtures/subtasks.ts`
