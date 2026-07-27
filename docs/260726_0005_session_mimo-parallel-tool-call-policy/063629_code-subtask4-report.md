# Code Sub-task 4 Report: Tighten execute_command Argument Normalization and Resolve Nullable cwd

## Task Summary

Tightened runtime type validation in `NativeToolCallParser` for `execute_command` arguments and resolved the inconsistent nullable `cwd` contract across the schema, validator, parser, and tool execution layer. Object-valued `cwd` (the MiMo malformed tool call pattern) is now a typed parse failure, never an executable value.

## Actions Taken

### 1. NativeToolCallParser.ts — Runtime Type Validation (`parseToolCall`)

- **`command`**: Must be a non-empty string. Empty string or non-string → `invalid_argument_shape` parse failure.
- **`cwd`**: Must be `undefined`, `null`, or `string`. Objects, arrays, numbers, booleans → `invalid_argument_shape` parse failure. `null` is normalized to `undefined` before constructing `nativeArgs`.
- **`timeout`**: Must be `undefined`, `null`, or `number`. Non-number primitives → `invalid_argument_shape` parse failure. `null` is normalized to `undefined`.
- All three validations throw tagged failure objects with `__parserFailureKind: "invalid_argument_shape"`, which the existing `classifyParseFailure` method converts to typed `NativeToolParseFailure` descriptors.

### 2. NativeToolCallParser.ts — Partial Streaming Normalization (`createPartialToolUse`)

- Updated the `execute_command` case in `createPartialToolUse` to normalize `null` → `undefined` and filter out non-string `cwd` / non-number `timeout` values during streaming partial updates. This prevents `null` from reaching downstream code during incremental streaming.

### 3. execute_command.ts Schema — Nullable cwd Contract Resolution

- Removed `cwd` and `timeout` from the `required` array. Only `command` is required.
- Changed `cwd` type from `["string", "null"]` to `"string"` (optional).
- Changed `timeout` type from `["number", "null"]` to `"number"` (optional).
- Updated description text and examples to reflect the new contract (omit `cwd`/`timeout` instead of passing `null`).

### 4. StructuralValidator.ts — Defense-in-Depth for null cwd

- Updated `validateCwdParameter` to accept `null` as valid (in addition to `undefined` and `string`). The parser normalizes `null` → `undefined` before validation, but this ensures the validator is consistent if called independently.
- Updated JSDoc to document the null acceptance behavior.

### 5. ExecuteCommandTool.ts — Type Cleanup

- Changed `ExecuteCommandParams.timeout` from `number | null` to `number` since the parser now normalizes `null` → `undefined`.
- The tool already handled omitted `cwd` gracefully (`!customCwd` → falls back to `task.cwd`), so no behavioral change was needed.

### 6. NativeToolArgs Type (src/shared/tools.ts)

- Changed `execute_command` type from `{ command: string; cwd?: string; timeout?: number | null }` to `{ command: string; cwd?: string; timeout?: number }` to match the new contract.

### 7. Test Cases Added

Added 12 new test cases to `NativeToolCallParser.spec.ts` covering all required scenarios:

| Test Case                                     | Expected Result                          |
| --------------------------------------------- | ---------------------------------------- |
| `cwd` as string                               | Valid — parsed with correct values       |
| `cwd` omitted                                 | Valid — `cwd` is `undefined`             |
| `cwd` as `null`                               | Valid — normalized to `undefined`        |
| `cwd` as empty string                         | Valid — preserved as `""`                |
| `cwd` as array                                | Parse failure (`invalid_argument_shape`) |
| `cwd` as object with `command` key            | Parse failure (NOT executed)             |
| `cwd` as object with `path` key               | Parse failure                            |
| `cwd` as number                               | Parse failure                            |
| `command` as empty string                     | Parse failure                            |
| `command` as object                           | Parse failure                            |
| `timeout` as string                           | Parse failure                            |
| No raw cwd value leaked in failure descriptor | Verified no sensitive data in descriptor |

## Result

✅ **Success** — All 35 tests in `NativeToolCallParser.spec.ts` pass (23 existing + 12 new).
✅ All 27 tests in `presentAssistantMessage-error-interception.spec.ts` pass (no regressions).
✅ TypeScript type check (`tsc --noEmit`) passes with zero errors.

## Issues Discovered

None. The existing error-interception infrastructure (`StructuralValidator`, `ToolErrorInterceptor`) was already designed to handle `CWD_OBJECT_MISUSE` signals. The parser-level validation now prevents object-valued `cwd` from ever reaching the execution layer, providing a second layer of defense.

## Next Step Recommendations

- Sub-task 5 and 6 of the 6-sub-task plan can proceed independently.
- Consider adding an integration test that simulates a MiMo-style malformed tool call (object-valued `cwd`) end-to-end through `presentAssistantMessage` to verify the full pipeline (parser → interceptor → guided error) produces the correct user-facing guidance.

## Affected File List

- `src/core/assistant-message/NativeToolCallParser.ts` — runtime type validation in `parseToolCall` and normalization in `createPartialToolUse`
- `src/core/prompts/tools/native-tools/execute_command.ts` — schema: `cwd`/`timeout` optional, `null` removed from types
- `src/core/tools/error-interception/StructuralValidator.ts` — `validateCwdParameter` accepts `null` as defense-in-depth
- `src/core/tools/ExecuteCommandTool.ts` — `ExecuteCommandParams.timeout` type narrowed from `number | null` to `number`
- `src/shared/tools.ts` — `NativeToolArgs.execute_command` type: `timeout?: number | null` → `timeout?: number`
- `src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts` — 12 new test cases for cwd/command/timeout variants
