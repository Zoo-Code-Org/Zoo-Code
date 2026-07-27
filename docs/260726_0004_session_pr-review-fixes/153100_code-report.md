# Code Task Report: Occurrence-Aware Recovery Rendering (Task 7)

## Task Summary

Implemented occurrence-aware recovery rendering for the error interception middleware. The model now receives distinct first-failure, repeated-failure, and stuck-loop guidance with escalating recovery dispositions, eliminating the "Proceed anyway" loop where the user had to manually intervene 10+ times.

## Actions Taken

### 1. Modified [`types.ts`](src/core/tools/error-interception/types.ts)

- Added `RecoveryDisposition` type: `"await_user" | "change_strategy" | "correct_once" | "discard_duplicate"`
- Added `OccurrenceTemplate` interface with `first`, `repeated`, and `stuck` branches
- Extended `ErrorPattern` with optional `occurrenceTemplates` and `recoveryDispositions` fields
- Added `recovery_disposition` field to `GuidancePayload`

### 2. Modified [`errorPatterns.ts`](src/core/tools/error-interception/errorPatterns.ts)

- Added occurrence-aware templates and recovery dispositions to 5 key patterns:
    - `EI/DUPLICATE_CALL/001` — `discard_duplicate` at occ 1-2, `change_strategy` at occ 3+
    - `EI/PARSER_FAILURE_JSON_SYNTAX/001` — `correct_once` at occ 1-2, `change_strategy` at occ 3+
    - `EI/PARSER_FAILURE_MISSING_ARGS/001` — `correct_once` at occ 1-2, `change_strategy` at occ 3+
    - `EI/PARSER_FAILURE_INVALID_SHAPE/001` — `correct_once` at occ 1-2, `change_strategy` at occ 3+
    - `EI/INVALID_JSON_ARGUMENTS/001` — `correct_once` at occ 1-2, `change_strategy` at occ 3+
- Fixed `INVALID_JSON_ARGUMENTS` template: removed the unconditional concatenated-JSON claim ("You concatenated multiple JSON objects"). Now states "Only a parser-proven syntax class is reported; concatenation is not asserted unless the parser proves it."
- Each occurrence branch has distinct `what`/`why`/`next` prose:
    - **Occurrence 1**: States the structural fact, identifies the rejected invocation, provides one executable continuation action
    - **Occurrence 2**: "The same [shape] was emitted again" — stops repeating occ 1 prose
    - **Occurrence 3+**: "The same [shape] keeps being emitted" — directs strategy change

### 3. Modified [`MessageTransformer.ts`](src/core/tools/error-interception/MessageTransformer.ts)

- Added `selectOccurrenceTemplate()` — selects the occurrence-appropriate template from explicit `occurrenceTemplates` or derives defaults from the base template
- Added `deriveOccurrenceTemplate()` — generates default escalation for patterns without explicit occurrence templates
- Added `selectRecoveryDisposition()` — selects disposition from explicit `recoveryDispositions` or infers from `retryPolicy`/`category`
- Rewrote `buildPayload()` to use occurrence-aware template selection
- Parameter name injection now only applies at occurrence 1 (focus shifts to non-repeat at occ 2+)
- Added `Disposition:` line to `formatPayloadAsDetails()` output
- Rewrote `fitDetailsWithinByteLimit()` with truncation priority:
    1. Category, Occurrence, Retryable, Disposition, Pattern — always preserved
    2. First continuation action (Next item 1) — preserved before secondary explanation
    3. Why — truncated before What
    4. What — truncated last among content fields
    5. Additional Next items — removed from the end first
- Updated `formatErrorDetails()` to accept optional `recoveryDisposition` parameter (default: `correct_once`)

### 4. Modified [`index.ts`](src/core/tools/error-interception/index.ts)

- Exported `RecoveryDisposition` and `OccurrenceTemplate` types

### 5. Modified [`MessageTransformer.spec.ts`](src/core/tools/error-interception/__tests__/MessageTransformer.spec.ts)

Added 18 new tests in the `occurrence-aware recovery rendering` describe block:

- Occurrence 1/2/3+ rendering for `PARSER_FAILURE_JSON_SYNTAX`, `PARSER_FAILURE_MISSING_ARGS`, `PARSER_FAILURE_INVALID_SHAPE`, `INVALID_JSON_ARGUMENTS`, `DUPLICATE_CALL`
- Exact semantic line assertions for What/Disposition at each occurrence level
- Non-retry wording does not tell the model to stop the task (asserts "continue" present, "stop the task" absent)
- `INVALID_JSON_ARGUMENTS` no longer asserts concatenation
- Patterns without explicit occurrence templates derive default escalation
- Truncation preserves category, occurrence, retry scope, disposition, and first continuation action
- All patterns stay within 1,024-byte limit at occurrences 1, 2, and 3
- First Next item is executable and task-continuing
- Occurrence 2+ does not inject parameter name (focus shifts to non-repeat)

## Result

**Success.** All 65 MessageTransformer tests pass. All 122 ErrorClassifier tests pass. All 60 ToolErrorInterceptor + TaskErrorState tests pass. TypeScript compilation clean for the error-interception module.

### Verification Commands Run

- `cd src; npx vitest run core/tools/error-interception/__tests__/MessageTransformer.spec.ts` — 65/65 passed
- `cd src; npx vitest run core/tools/error-interception/__tests__/ErrorClassifier.spec.ts` — 122/122 passed
- `cd src; npx vitest run core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts core/tools/error-interception/__tests__/TaskErrorState.spec.ts` — 60/60 passed
- `cd src; npx tsc --noEmit` — no errors in error-interception module

## Issues Discovered

1. The existing `formatErrorDetails()` call in [`ToolErrorInterceptor.ts`](src/core/tools/error-interception/ToolErrorInterceptor.ts:64) (circuit-open message) uses the old 8-parameter signature. The new `recoveryDisposition` parameter has a default value of `"correct_once"`, so the existing call compiles without changes. However, `"discard_duplicate"` would be semantically more appropriate for the circuit-open case. This is outside Task 7 scope (Task 8 owns dispatcher changes) and is noted for the VP.

2. The existing all-patterns byte-limit test (line 108-120) only checks occurrence 1. The new test "all patterns stay within byte limit at occurrence 1, 2, and 3" is more comprehensive and subsumes it.

## Next Step Recommendations

- VP should delegate Task 8 (dispatcher wiring) next, which will integrate these occurrence-aware templates into [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts).
- Task 8 should also update the `formatErrorDetails()` call in `ToolErrorInterceptor.ts` to pass `discard_duplicate` for the circuit-open case.
- The `recovery_disposition` field is now part of `GuidancePayload` — Task 8's dispatcher integration should verify the `Disposition:` line is correctly parsed by downstream consumers.

## Affected File List

- [`src/core/tools/error-interception/types.ts`](src/core/tools/error-interception/types.ts)
- [`src/core/tools/error-interception/errorPatterns.ts`](src/core/tools/error-interception/errorPatterns.ts)
- [`src/core/tools/error-interception/MessageTransformer.ts`](src/core/tools/error-interception/MessageTransformer.ts)
- [`src/core/tools/error-interception/index.ts`](src/core/tools/error-interception/index.ts)
- [`src/core/tools/error-interception/__tests__/MessageTransformer.spec.ts`](src/core/tools/error-interception/__tests__/MessageTransformer.spec.ts)
