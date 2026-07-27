# Code Sub-task 3 Report: Pre-Retention Ghost Quarantine and Local Max-One Enforcement

## Task Summary

Implemented pre-retention ghost quarantine (silently drop unnamed + empty-argument calls before history insertion) and local max-one enforcement (under single-call policy, at most one valid call executes per turn) to prevent MiMo's malformed parallel tool calls from corrupting protocol history or executing ambiguous side effects.

## Actions Taken

### 1. Created `ToolCallRetentionPolicy.ts` — Pure Policy Module

**File:** [`src/core/assistant-message/ToolCallRetentionPolicy.ts`](src/core/assistant-message/ToolCallRetentionPolicy.ts)

Created a new pure, side-effect-free module containing:

- **`StreamedCallDisposition`** discriminated union with three kinds:
    - `retain` — structurally valid call, may proceed to execution
    - `drop-provably-empty` — transport ghost (no name, no args), silently dropped before history
    - `retain-as-error` — named or has argument bytes but malformed, receives error `tool_result`

- **`classifyStreamedCall()`** — pure function that classifies a streamed call based on:
    - Whether the stream has ended
    - Whether a tool name was resolved (non-whitespace)
    - Whether any argument bytes were accumulated (non-whitespace)
    - Whether a `NativeToolParseFailure` was already recorded

    Drop criteria (ALL must hold): stream ended + no name + no arguments. A named call with `{}` is NOT a ghost. A call with any argument bytes is NOT a ghost.

- **`isProvablyEmptyGhost()`** — predicate for ghost disposition.

- **`selectExecutableCall()`** — pure function for max-one enforcement:
    - Under `maxCallsPerTurn === 1`: collects all non-partial calls with `hasNativeArgs === true`. If 0 candidates: no execution. If 1 candidate: it may execute. If 2+ candidates: **neither auto-executes** — all receive error results.
    - Under `"unbounded"`: no local enforcement (first valid call proceeds).

### 2. Added Ghost Quarantine Accessors to `NativeToolCallParser`

**File:** [`src/core/assistant-message/NativeToolCallParser.ts`](src/core/assistant-message/NativeToolCallParser.ts)

Added two new static methods:

- **`getStreamingToolCallState(id)`** — non-destructive snapshot of streaming state (id, name, argumentsAccumulator). Used by the ghost quarantine to inspect whether a call has a resolved name and/or argument bytes BEFORE `finalizeStreamingToolCall()` deletes the state.

- **`discardStreamingToolCall(id)`** — removes streaming state without finalizing. This is the ONLY safe way to remove a call before history insertion. Once a `tool_use` block is pushed into `assistantMessageContent`, it MUST receive exactly one matching `tool_result`.

### 3. Injected Ghost Quarantine into `Task.ts` Stream Processing

**File:** [`src/core/task/Task.ts`](src/core/task/Task.ts)

Added ghost quarantine at three stream-processing sites:

1. **`tool_call_end` event handler** (streaming path, ~line 2892): Before calling `finalizeStreamingToolCall()`, capture the streaming state via `getStreamingToolCallState()`. Classify via `classifyStreamedCall()`. If the call is a ghost (`drop-provably-empty`), remove its partial block from `assistantMessageContent` via `splice()`, re-index remaining `streamingToolCallIndices`, discard streaming state via `discardStreamingToolCall()`, and `continue` without calling `presentAssistantMessageSafe()`. The ghost never enters history and never receives a `tool_result`.

2. **`finalizeRawChunks()` loop** (end-of-stream finalization, ~line 3360): Same ghost quarantine logic applied to any remaining streaming calls that weren't explicitly ended.

3. **Legacy `tool_call` chunk handler** (~line 2994): Classify the complete tool call before pushing to `assistantMessageContent`. If it's a ghost, `break` without pushing.

**Key invariant:** Ghost quarantine happens BEFORE `assistantMessageContent.push()` and history serialization. Once a `tool_use` block is in `assistantMessageContent`, it always receives a `tool_result`.

### 4. Implemented Max-One Enforcement in `presentAssistantMessage.ts`

**File:** [`src/core/assistant-message/presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts)

Added a max-one enforcement gate in the `tool_use` case, positioned AFTER the malformed-call check (which handles calls without `nativeArgs`) and BEFORE the tool execution begins:

1. Resolve the tool-call policy via `resolveToolCallPolicy()` using `cline.api.getModel().info` and `cline.apiConfiguration.apiProvider`.
2. If `maxCallsPerTurn === 1`, collect all `tool_use` blocks in `assistantMessageContent` and call `selectExecutableCall()`.
3. If the current call's ID is in `rejectedCallIds` (multiple valid candidates under single policy), emit a structured error `tool_result` with error code `POLICY/max-one-enforcement/001` and `break` — the call does not execute.
4. If the call is the single valid candidate or the only valid one, it proceeds normally to execution.

**Valid sibling preservation:** A valid sibling that already executed is not re-executed because `pushToolResultToUserContent()` deduplicates by `tool_use_id`. A valid sibling that never started may proceed once. If two valid side-effecting calls arrive, neither auto-executes — both get errors.

### 5. Wrote Tests

**File:** [`src/core/assistant-message/__tests__/ToolCallRetentionPolicy.spec.ts`](src/core/assistant-message/__tests__/ToolCallRetentionPolicy.spec.ts) (NEW)

19 unit tests covering:

- Ghost classification: unnamed + empty args → dropped; whitespace-only → dropped; undefined name → dropped; stream not ended → retained; named + `{}` → retained (not ghost); args without name → retained; parse failure present → retained-as-error
- `isProvablyEmptyGhost` predicate
- `selectExecutableCall`: single valid candidate → executes; two valid → both rejected; malformed first + valid second → valid executes; valid first + malformed second → valid executes; no valid candidates → none execute; partial calls ignored; unbounded policy → no enforcement; three valid → all rejected

**File:** [`src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts`](src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts) (UPDATED)

Added 6 tests for ghost quarantine accessors:

- `getStreamingToolCallState` returns undefined for untracked ID
- `getStreamingToolCallState` returns state snapshot for tracked ID
- `getStreamingToolCallState` is non-destructive
- `discardStreamingToolCall` removes entry and returns true
- `discardStreamingToolCall` returns false for untracked ID
- `discardStreamingToolCall` prevents `finalizeStreamingToolCall` from returning a tool use

**File:** [`src/core/assistant-message/__tests__/presentAssistantMessage-parser-dedup.integration.spec.ts`](src/core/assistant-message/__tests__/presentAssistantMessage-parser-dedup.integration.spec.ts) (UPDATED)

Added 6 integration test scenarios:

- Scenario 6: unnamed + empty arguments → no tool_result (ghost dropped)
- Scenario 7: named + `{}` → retained as error result (not ghost)
- Scenario 8: malformed first + valid second → valid second executes once
- Scenario 9: valid first + malformed second → one success + one error
- Scenario 10: two valid side-effecting calls under single policy → neither auto-executes, both get errors
- Scenario 11: all retained IDs have exactly one result (dedup prevents duplicates)

## Result

**Success.** All implementation and tests pass.

### Test Results

| Test Suite                                                 | Tests                    | Status      |
| ---------------------------------------------------------- | ------------------------ | ----------- |
| `ToolCallRetentionPolicy.spec.ts`                          | 19                       | ✅ All pass |
| `NativeToolCallParser.spec.ts`                             | 41 (35 existing + 6 new) | ✅ All pass |
| `presentAssistantMessage-parser-dedup.integration.spec.ts` | 11 (5 existing + 6 new)  | ✅ All pass |
| `tool-call-policy.spec.ts`                                 | 10                       | ✅ All pass |

### Pre-existing Failures (NOT caused by this sub-task)

Two tests in `presentAssistantMessage-custom-tool.spec.ts` and `presentAssistantMessage-unknown-tool.spec.ts` fail due to an expected error title mismatch ("Tool Call Format Error" vs actual "Unknown Tool" guided payload). Verified pre-existing by stashing all changes and re-running — the same 2 tests fail without my modifications.

### Type Check

`npx tsc --noEmit` passes with zero errors in all modified files.

## Issues Discovered

1. The `presentAssistantMessage-unknown-tool.spec.ts` and `presentAssistantMessage-custom-tool.spec.ts` tests have a pre-existing assertion mismatch where the test expects `StringContaining "Tool Call Format Error"` but the interceptor produces a `TOOL_NOT_FOUND` guided payload. This is unrelated to Sub-task 3 and should be addressed separately.

2. The max-one enforcement gate in `presentAssistantMessage.ts` resolves the tool-call policy on every `tool_use` block. This is acceptable for correctness (the policy is a pure function with no side effects), but if performance becomes a concern, the resolved policy could be cached per-turn on the Task instance.

## Next Step Recommendations

1. VP should proceed with Sub-task 5 (observability and rollout controls) to add telemetry for ghost drops and max-one enforcement rejections.
2. VP should proceed with Sub-task 6 (end-to-end regression validation) to verify the full flow with a MiMo provider fixture.
3. The pre-existing test failures in `presentAssistantMessage-unknown-tool.spec.ts` and `presentAssistantMessage-custom-tool.spec.ts` should be addressed in a separate delegation — they are not caused by this sub-task.

## Affected File List

- `src/core/assistant-message/ToolCallRetentionPolicy.ts` (NEW)
- `src/core/assistant-message/__tests__/ToolCallRetentionPolicy.spec.ts` (NEW)
- `src/core/assistant-message/NativeToolCallParser.ts` (MODIFIED — added `getStreamingToolCallState` and `discardStreamingToolCall`)
- `src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts` (MODIFIED — added 6 ghost quarantine accessor tests)
- `src/core/task/Task.ts` (MODIFIED — ghost quarantine at 3 stream-processing sites + import)
- `src/core/assistant-message/presentAssistantMessage.ts` (MODIFIED — max-one enforcement gate + import)
- `src/core/assistant-message/__tests__/presentAssistantMessage-parser-dedup.integration.spec.ts` (MODIFIED — added 6 integration scenarios)
