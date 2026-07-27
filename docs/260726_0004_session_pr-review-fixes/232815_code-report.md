# Code Task Report: Typed Parser Failure Descriptors

## Task Summary

Introduced typed parser failure descriptors in `NativeToolCallParser` to replace the conflated string side channel that caused `presentAssistantMessage()` to label all parser failures as "invalid JSON", even when the actual failure was a valid sibling call plus an empty sibling call.

## Actions Taken

### 1. Added discriminated union for parser failure kinds

Added [`ParserFailureKind`](src/core/assistant-message/NativeToolCallParser.ts:48) with three variants:

- `json_syntax` — arguments string could not be parsed as JSON
- `missing_required_arguments` — valid JSON but one or more required fields absent (including empty object)
- `invalid_argument_shape` — valid JSON with wrong structural shape (e.g. primitive, array, or object with present-but-mismatched fields)

### 2. Added typed failure descriptor

Added [`NativeToolParseFailure`](src/core/assistant-message/NativeToolCallParser.ts:61) interface with:

- `kind: ParserFailureKind`
- `toolName?: string`
- `missingParameters?: string[]` — known missing required field names
- `emptyArguments?: boolean` — true if input was `{}` or `""`

The descriptor contains NO raw argument bodies, paths, commands, task IDs, or secrets.

### 3. Added `consumeParseFailure()` method

Added [`consumeParseFailure()`](src/core/assistant-message/NativeToolCallParser.ts:140) with atomic consume-and-delete lifecycle matching the existing `consumeParseError()`.

### 4. Added `REQUIRED_PARAMETERS` lookup table

Added a static [`REQUIRED_PARAMETERS`](src/core/assistant-message/NativeToolCallParser.ts:119) map derived from `NativeToolArgs`, listing required field names for each native tool. Used to classify `missing_required_arguments` failures with precise field names.

### 5. Added `classifyParseFailure()` helper

Added [`classifyParseFailure()`](src/core/assistant-message/NativeToolCallParser.ts:1213) that inspects caught errors:

- Tagged structural failure objects (thrown with `__parserFailureKind`) are unpacked into typed descriptors
- All other errors (SyntaxError from `JSON.parse`) are classified as `json_syntax`

### 6. Modified `parseToolCall()` validation logic

Replaced the single `throw new Error(...)` at the nativeArgs validation point with precise classification:

- If `args` is not a plain object (primitive, array, null) → `invalid_argument_shape`
- If required fields are missing → `missing_required_arguments` with `missingParameters` and `emptyArguments`
- If all required fields present but shape didn't match → `invalid_argument_shape`

### 7. Modified catch block

The catch block now stores both:

- The legacy string error in `parseErrors` (for `consumeParseError()` compatibility)
- The typed descriptor in `parseFailures` (for `consumeParseFailure()`)

### 8. Kept `consumeParseError()` as compatibility wrapper

The existing `consumeParseError()` method is retained and marked `@deprecated`. It still returns the string representation for human diagnostics. Existing callers in `presentAssistantMessage.ts` and the error interception test suite continue to work unchanged.

### 9. MCP boundary pinned

`parseDynamicMcpTool()` was NOT modified — it keeps legacy string behavior as specified.

## Result

✅ Success — all 23 parser tests pass (14 existing + 9 new), and all 19 error interception tests pass.

### Test coverage added:

1. **Invalid JSON syntax** → `kind: 'json_syntax'`
2. **Empty object `{}`** → `kind: 'missing_required_arguments'`, `emptyArguments: true`, `missingParameters` populated
3. **Empty string `""`** → `kind: 'missing_required_arguments'`, `emptyArguments: true`
4. **Missing one required field** → `kind: 'missing_required_arguments'`, `emptyArguments: false`, `missingParameters: ["content"]`
5. **Primitive shape (string)** → `kind: 'invalid_argument_shape'`
6. **Array shape** → `kind: 'invalid_argument_shape'`
7. **Successful parse** → `consumeParseFailure()` returns `undefined`
8. **Second consume** → returns `undefined` (atomic consume-and-delete)
9. **No failure recorded** → returns `undefined` for unknown tool call ID
10. **No sensitive data leak** — descriptor serialization verified to not contain raw paths, API keys, or argument bodies
11. **`consumeParseError()` compatibility** — still returns string, still atomic

### Test command:

```
cd src && npx vitest run core/assistant-message/__tests__/NativeToolCallParser.spec.ts
```

## Issues Discovered

None. The implementation is self-contained within `NativeToolCallParser.ts` and its test file. No external callers were modified.

## Next Step Recommendations

- **Task 8** (`presentAssistantMessage.ts`): Update the dispatcher to call `consumeParseFailure()` instead of `consumeParseError()`, and route the typed `kind` to the error interception classifier for precise guidance.
- **Tasks 4-7** (error interception middleware): Use `NativeToolParseFailure.kind` as a structural metadata flag in `ErrorClassifier` to select exact patterns instead of falling through to `UNCLASSIFIED`.

## Affected File List

- `src/core/assistant-message/NativeToolCallParser.ts` — added types, methods, and modified catch block
- `src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts` — added 9 new test cases for failure descriptors
