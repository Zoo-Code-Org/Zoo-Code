# Code Mode Task Report

## Task Summary

Closed exact classification gaps in the error-interception module by adding 6 new `ErrorCategory` values, matching patterns, safe-fact allowlist entries, category titles, and comprehensive tests. Previously, `unknownTool`, `modeRestriction`, and `fileRestriction` metadata from `presentAssistantMessage.ts` had no matching patterns and fell through to `UNCLASSIFIED` (or were misclassified as `PARAM_TYPE_MISMATCH` via the broad `typeMismatch: true` fallback). Parser failure kinds from Task 3 (`json_syntax`, `missing_required_arguments`, `invalid_argument_shape`) also had no dedicated patterns.

## Actions Taken

### 1. [`types.ts`](src/core/tools/error-interception/types.ts) — Added 6 new ErrorCategory values

Added to the `ErrorCategory` union (alphabetically ordered):

- `FILE_RESTRICTION` — for file-restricted tool access
- `MODE_RESTRICTION` — for mode-restricted tool access
- `PARSER_FAILURE_INVALID_SHAPE` — for invalid argument shape
- `PARSER_FAILURE_JSON_SYNTAX` — for genuine JSON syntax failures
- `PARSER_FAILURE_MISSING_ARGS` — for missing required arguments
- `TOOL_NOT_FOUND` — for unknown/invalid tool names

### 2. [`errorPatterns.ts`](src/core/tools/error-interception/errorPatterns.ts) — Added 6 new exact-match patterns

Inserted BEFORE the broad `PARAM_MISSING` (priority 90) and `PARAM_TYPE_MISMATCH/001` (priority 85) fallbacks so exact metadata flags take precedence:

| Pattern ID                            | Category                       | Priority | Matches                                                                   |
| ------------------------------------- | ------------------------------ | -------- | ------------------------------------------------------------------------- |
| `EI/TOOL_NOT_FOUND/001`               | `TOOL_NOT_FOUND`               | 95       | `source=validation, stage=preflight, unknownTool=true`                    |
| `EI/MODE_RESTRICTION/001`             | `MODE_RESTRICTION`             | 94       | `source=validation, stage=preflight, modeRestriction=true`                |
| `EI/FILE_RESTRICTION/001`             | `FILE_RESTRICTION`             | 93       | `source=validation, stage=preflight, fileRestriction=true`                |
| `EI/PARSER_FAILURE_JSON_SYNTAX/001`   | `PARSER_FAILURE_JSON_SYNTAX`   | 92       | `source=parser, stage=parse, parseFailureKind=json_syntax`                |
| `EI/PARSER_FAILURE_MISSING_ARGS/001`  | `PARSER_FAILURE_MISSING_ARGS`  | 91       | `source=parser, stage=parse, parseFailureKind=missing_required_arguments` |
| `EI/PARSER_FAILURE_INVALID_SHAPE/001` | `PARSER_FAILURE_INVALID_SHAPE` | 90       | `source=parser, stage=parse, parseFailureKind=invalid_argument_shape`     |

All new patterns use `requiresToolContext: true` (except none — all require tool context since they are tool-bound signals). Retry policies: `do-not-retry` for restriction/not-found categories, `correct-and-retry` for parser failures.

### 3. [`ErrorClassifier.ts`](src/core/tools/error-interception/ErrorClassifier.ts) — Extended safe-fact allowlist

Added 7 new safe structural fact keys to `SAFE_FACT_KEYS`:

- `emptyArguments`
- `fileRestriction`
- `missingRequiredParameters`
- `modeRestriction`
- `parseFailureKind`
- `unknownTool`
- `validSiblingPresent`

The classifier's exact-first, heuristic-second ordering was already correct — no changes needed to the iteration logic. The new patterns are checked before the broad fallbacks, so known metadata flags never fall through to `UNCLASSIFIED`.

### 4. [`MessageTransformer.ts`](src/core/tools/error-interception/MessageTransformer.ts) — Added CATEGORY_TITLES entries

Added user-friendly titles for all 6 new categories (required for type-checking since `CATEGORY_TITLES` is `Record<ErrorCategory, string>`):

- `FILE_RESTRICTION: "File Access Blocked"`
- `MODE_RESTRICTION: "Mode Restriction"`
- `PARSER_FAILURE_INVALID_SHAPE: "Invalid Argument Shape"`
- `PARSER_FAILURE_JSON_SYNTAX: "JSON Syntax Error"`
- `PARSER_FAILURE_MISSING_ARGS: "Missing Required Arguments"`
- `TOOL_NOT_FOUND: "Unknown Tool"`

### 5. [`ErrorClassifier.spec.ts`](src/core/tools/error-interception/__tests__/ErrorClassifier.spec.ts) — Updated tests

- Updated the expected category list assertion to include all 6 new categories
- Added 13 new test cases across 2 new describe blocks:
    - **"unknown tool / mode / file restriction classification"** (6 tests): Asserts exact category, pattern ID, confidence (`exact`), retry policy (`do-not-retry`), sanitized facts, and negative assertions that these are NOT classified as `PARAM_TYPE_MISMATCH`
    - **"parser failure classification"** (7 tests): Asserts exact category, pattern ID, confidence, retry policy (`correct-and-retry`), sanitized facts (`parseFailureKind`, `emptyArguments`, `missingRequiredParameters`, `validSiblingPresent`), negative assertions against `INVALID_JSON_ARGUMENTS`/`PARAM_MISSING`/`PARAM_TYPE_MISMATCH`, and a no-tool-context test confirming `UNCLASSIFIED`

## Result

✅ Success — All 155 tests across 5 error-interception test files pass.

### Verification commands run:

- `cd src; npx vitest run core/tools/error-interception/__tests__/ErrorClassifier.spec.ts` → 55 passed
- `cd src; npx vitest run core/tools/error-interception/__tests__/MessageTransformer.spec.ts` → 21 passed
- `cd src; npx vitest run core/tools/error-interception/` → 155 passed (5 test files)

### Key behavioral guarantees verified:

1. Ordinary successful output remains `UNCLASSIFIED`/pass-through (existing test "does not classify success text containing 'error'" still passes)
2. `unknownTool` metadata → `TOOL_NOT_FOUND` (not `PARAM_TYPE_MISMATCH`, not `UNCLASSIFIED`)
3. `modeRestriction` metadata → `MODE_RESTRICTION` (not `PARAM_TYPE_MISMATCH`, not `UNCLASSIFIED`)
4. `fileRestriction` metadata → `FILE_RESTRICTION` (not `PARAM_TYPE_MISMATCH`, not `UNCLASSIFIED`)
5. `parseFailureKind=json_syntax` → `PARSER_FAILURE_JSON_SYNTAX` (not `INVALID_JSON_ARGUMENTS`)
6. `parseFailureKind=missing_required_arguments` → `PARSER_FAILURE_MISSING_ARGS` (not `PARAM_MISSING`)
7. `parseFailureKind=invalid_argument_shape` → `PARSER_FAILURE_INVALID_SHAPE` (not `PARAM_TYPE_MISMATCH`)
8. Pattern registry ordering remains descending by priority

## Issues Discovered

None. The implementation was straightforward once the metadata flags from `presentAssistantMessage.ts` and the parser failure kinds from `NativeToolCallParser.ts` (Task 3) were understood.

One minor adjustment: `PARSER_FAILURE_INVALID_SHAPE` was initially assigned priority 89, which broke the descending-priority ordering invariant (the next pattern, `PARAM_MISSING`, has priority 90). Fixed by adjusting to priority 90 (equal to `PARAM_MISSING`, which is valid since `toBeLessThanOrEqual` allows equality).

## Next Step Recommendations

- **Task 8** (modify `presentAssistantMessage.ts`): The metadata flags (`unknownTool`, `modeRestriction`, `fileRestriction`) are already emitted by `presentAssistantMessage.ts` at line 843-851. The patterns added in this task will match them once the interceptor signal is forwarded. Verify that the interceptor actually receives these signals with the correct `source: "validation"` and `stage: "preflight"` values.
- **Parser failure wiring**: The `parseFailureKind` metadata is not yet emitted by `presentAssistantMessage.ts` to the interceptor. A future task should wire `consumeParseFailure()` output into the interceptor signal metadata so the `PARSER_FAILURE_*` patterns become reachable at runtime.

## Affected File List

- `src/core/tools/error-interception/types.ts`
- `src/core/tools/error-interception/errorPatterns.ts`
- `src/core/tools/error-interception/ErrorClassifier.ts`
- `src/core/tools/error-interception/MessageTransformer.ts`
- `src/core/tools/error-interception/__tests__/ErrorClassifier.spec.ts`
