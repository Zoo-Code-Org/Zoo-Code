# Debug Systemic Task Report

## Task Summary

Investigated the reported timeout in [`subtasks.test.ts`](../../apps/vscode-e2e/src/suite/subtasks.test.ts:694), including fixture routing, native tool-call parsing, guided parser-error interception, parent/child task state, branch ancestry, and local E2E behavior.

## Result

**Status: Resolved on the current PR head, no new source patch justified.**

The current `feat/error-interception-middleware` head already inherits upstream commit `116acfdb6c8cce6a45b80526e212e736cefd2f0c`, which fixes the relevant parent/child fixture collision. The reported failure could not be reproduced on the current branch:

- Exact test passed once, approximately 10.3 seconds.
- Complete [`subtasks.test.ts`](../../apps/vscode-e2e/src/suite/subtasks.test.ts) suite passed twice, 9 of 9 tests each run.
- No local `Failed to parse tool call arguments`, `404 No fixture matched`, or wrong cross-profile fixture response occurred.
- Local branch head and `myk1yt/feat/error-interception-middleware` both resolve to `cc4008dd8d53e5ebb2b2286ad7cc0066508a022e`.
- No fixture or parser source differs from the remote branch.

## System Map

```text
E2E test
  apps/vscode-e2e/src/suite/subtasks.test.ts
      |
      | sends parent prompt, cancels child, answers resumed child
      v
VS Code extension task lifecycle
  src/core/task/Task.ts
      | startSubtask() / resumeAfterDelegation()
      | streams provider tool-call deltas
      v
OpenRouter provider adapter
  src/api/providers/openrouter.ts
      | emits tool_call_partial and finish events
      v
Native tool parser
  src/core/assistant-message/NativeToolCallParser.ts
      | reconstructs arguments
      | stores typed parse-failure metadata
      v
Assistant presentation and interception
  src/core/assistant-message/presentAssistantMessage.ts
      | executes valid tools or injects guided error tool_result
      v
Next OpenRouter-compatible request
      |
      v
LLMock fixture matcher
  apps/vscode-e2e/src/fixtures/subtasks.ts
      | marker, sequence, tool-result, and request-content predicates
      v
Mocked streamed response -> Task state transition -> test event assertions
```

### Shared State and Boundaries

- **Task stack and history:** parent and child task IDs, persisted messages, cancellation state, and delegation results are maintained by [`Task`](../../src/core/task/Task.ts:167).
- **Native parser state:** streamed call fragments and parse failures are held in static maps in [`NativeToolCallParser`](../../src/core/assistant-message/NativeToolCallParser.ts:79).
- **Mock request journal and fixture sequence:** E2E traffic is matched by [`addSubtaskFixtures()`](../../apps/vscode-e2e/src/fixtures/subtasks.ts:109).
- **Boundary crossings:** VS Code extension API, provider streaming protocol, parser-to-presentation handoff, parent/child persistence, HTTP mock matching, and filesystem-backed task history.
- **Asynchronous points:** stream consumption, cancellation, task-stack reopening, persisted history reload, fixture response streaming, event handlers, and polling through [`waitFor()`](../../apps/vscode-e2e/src/suite/utils.ts:8).

## Data Flow Trace

1. [`subtasks.test.ts`](../../apps/vscode-e2e/src/suite/subtasks.test.ts:694) starts a parent prompt containing the parent marker and an embedded child prompt.
2. The parent calls `new_task`; [`Task.startSubtask()`](../../src/core/task/Task.ts:2322) creates the child and pauses the parent.
3. The child emits a follow-up question, then the test cancels the active request.
4. The task stack rehydrates the interrupted child and emits `resume_task`.
5. The test sends `81`; the resumed child calls `attempt_completion`.
6. [`Task.resumeAfterDelegation()`](../../src/core/task/Task.ts:2348) injects the child result into the parent context.
7. The mock parent-resume fixture matches the stable injected text `completed.\n\nResult:` through [`requestContains()`](../../apps/vscode-e2e/src/fixtures/subtasks.ts:53).
8. The parent completes, and [`waitUntilCompleted()`](../../apps/vscode-e2e/src/suite/utils.ts:59) observes the expected parent task ID.

The historical collision occurred because the parent request contains the child marker inside its delegated prompt. A child fixture that matched only that nested marker could therefore serve a parent request. Commit `116acfdb6` added parent-marker exclusions and stable parent-resume result matching.

## Hypotheses Tested

### H1. Extra `mode: "ask"` breaks `attempt_completion` parsing

**Evidence against:** [`NativeToolCallParser.parseToolCall()`](../../src/core/assistant-message/NativeToolCallParser.ts:790) constructs `attempt_completion` arguments when `result` is present and ignores unrelated extra properties. The extra `mode` property alone does not invalidate the call.

**Disposition:** Rejected.

### H2. Guided error-interception text changed the fixture request and caused unmatched traffic

**Evidence for:** Parser failure metadata is consumed by [`presentAssistantMessage()`](../../src/core/assistant-message/presentAssistantMessage.ts:79), which can inject a guided error `tool_result` into the next provider request. That changes the serialized request seen by fixture predicates.

**Evidence against:** The current exact and full-suite runs produced no parser failure or fixture 404. Guided interception is a possible propagation mechanism, but it is not the initiating defect demonstrated on the current head.

**Disposition:** Possible cascading factor in the historical log, not the current root cause.

### H3. `[object Object]` proves malformed `attempt_completion` arguments

**Evidence against:** [`NativeToolCallParser`](../../src/core/assistant-message/NativeToolCallParser.ts:1218) classifies failures as plain tagged objects. Converting a non-`Error` object with `String(error)` naturally produces `[object Object]`. The log text loses the failure category and does not identify which argument was malformed.

**Disposition:** Rejected as proof. It is an observability weakness.

### H4. Parent requests were routed to child fixtures because parent prompts embed child markers

**Evidence for:** The data shape permits this collision, and upstream commit `116acfdb6` is explicitly titled “Flaky mocked e2e subtasks test when parent resume is served the child fixture.” Current child predicates exclude the parent marker, while parent resume uses stable injected-result content.

**Evidence against:** None for the historical pre-fix behavior. Current runs pass because the guard is present.

**Disposition:** Confirmed historical root cause.

### H5. Current PR head still lacks the fixture collision fix

**Evidence against:** Commit `116acfdb6` is contained by the active branch, its remote, and `upstream/main`. The current fixture has no local or remote diff.

**Disposition:** Rejected.

### H6. The failure is still order-dependent in the complete subtask suite

**Evidence against:** The complete 9-test suite passed twice after correcting the launch environment.

**Disposition:** Not reproduced on the current head.

## Root Cause Assessment

### Historical failure

**Root cause:** Overlapping LLMock fixture predicates allowed a parent-resume request, which embeds the child marker, to be served by a child fixture. The wrong response then corrupted the expected parent/child progression. Subsequent guided parser-error content changed the request again, after which no remaining fixture matched and the test reached the 30-second timeout in [`waitFor()`](../../apps/vscode-e2e/src/suite/utils.ts:8).

**Confidence: MEDIUM-HIGH.** The code shape and upstream fix align directly with the failure class. Confidence is not HIGH because the exact historical CI check SHA and request journal were unavailable.

### Current branch

**Root cause status:** Already fixed by inherited upstream commit `116acfdb6`. No active source defect was reproduced at head `cc4008dd8d53e5ebb2b2286ad7cc0066508a022e`.

**Confidence: HIGH.** Branch ancestry, source comparison, one targeted pass, and two full-suite passes agree.

## Fix or Recommendation

No additional fixture or parser edit should be applied to the current branch. A duplicate change would add noise without a failing regression case.

Recommended VP action:

1. Treat upstream commit `116acfdb6` as the substantive fixture fix already present in PR #1009.
2. Re-run the PR E2E check on current head `cc4008dd8d53e5ebb2b2286ad7cc0066508a022e` if the visible failure belongs to an older check run.
3. If the same failure recurs on that exact head, preserve the LLMock request journal and check-run SHA. Then investigate cross-test request isolation rather than changing `attempt_completion` acceptance.
4. Independently improve parser-failure logging later so tagged failures retain category, tool name, and missing parameters instead of rendering as `[object Object]`. This is an observability improvement, not required to resolve the current timeout.

The requested commit message and force push were not executed. This mode prohibits commit and push operations, and there is no justified source change to commit.

## Reverse-Dependency Map

Potentially affected if fixture matching is changed again:

- [`subtasks.ts`](../../apps/vscode-e2e/src/fixtures/subtasks.ts) -> all mocked subtask E2E scenarios.
- [`subtasks.test.ts`](../../apps/vscode-e2e/src/suite/subtasks.test.ts) -> task-stack, cancellation, profile-switch, resume, and abandonment assertions.
- [`runTest.ts`](../../apps/vscode-e2e/src/runTest.ts) -> static fixture registration and targeted E2E execution.
- [`Task.ts`](../../src/core/task/Task.ts) -> provider streaming, task-stack transitions, persistence, and delegation resume.
- [`NativeToolCallParser.ts`](../../src/core/assistant-message/NativeToolCallParser.ts) -> every native streamed tool call.
- [`presentAssistantMessage.ts`](../../src/core/assistant-message/presentAssistantMessage.ts) -> parser-error interception and tool-result injection.
- [`openrouter.ts`](../../src/api/providers/openrouter.ts) -> streamed tool-call delta and finish-event conversion.
- [`history-resume-delegation.spec.ts`](../../src/__tests__/history-resume-delegation.spec.ts) -> lower-level contract for delegated completion result injection.

## Test Environment Repair

The initial local VS Code launch failure was environmental, not a source failure. The shell inherited `ELECTRON_RUN_AS_NODE=1` and `VSCODE_ESM_ENTRYPOINT=vs/workbench/api/node/extensionHostProcess`, causing the downloaded VS Code executable to interpret the temporary workspace path as a Node module. Clearing those inherited variables restored E2E execution.

Details are recorded in [`184514_debug-systemic-environment-feedback.md`](184514_debug-systemic-environment-feedback.md).

## Issues Discovered

- Tagged parser failures lose actionable detail when stringified as `[object Object]`.
- Historical GitHub E2E check metadata was not available through the retrieved combined status, so the original failing run could not be tied conclusively to a pre-fix SHA.
- Native semantic search was unavailable because the local embedding index was in an error state; targeted source searches were used instead.

## Actions Taken

- Mapped fixture, parser, interception, provider, task-state, and test timeout paths.
- Compared local fixture source with the remote branch.
- Traced the robust fixture predicates to upstream commit `116acfdb6`.
- Verified that the active PR branch contains that commit.
- Ran the exact affected E2E test once.
- Ran the full 9-test subtask suite twice.
- Corrected the E2E launch environment and documented the environment failure.
- Declined to add an unsupported duplicate source patch.

## Affected File List

- Added this report: [`190600_debug-systemic-report.md`](190600_debug-systemic-report.md)
- Updated environment record during investigation: [`184514_debug-systemic-environment-feedback.md`](184514_debug-systemic-environment-feedback.md)
- No application, fixture, parser, or test source files were modified.
