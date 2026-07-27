# Code Sub-task 2 Report: Wire MiMo Provider Request Controls with Endpoint Fallback

## Task Summary

Wired the MiMo provider (`MimoHandler`) to honor `metadata.tool_choice` and `metadata.parallelToolCalls` in API request bodies, and added a fallback retry mechanism for endpoints that reject the `parallel_tool_calls` field.

## Actions Taken

### 1. Modified `src/api/providers/mimo.ts`

**a) Added `isParallelToolCallsRejected` helper function (lines 18-32)**

- Detects whether an API error is specifically caused by the endpoint rejecting the `parallel_tool_calls` field
- Checks for error messages containing "parallel_tool_calls" or "unrecognized" with HTTP 400 status
- Used by the fallback retry logic in `createMessage`

**b) Added `tool_choice` passthrough (in `createMessage`, after tools assignment)**

- When `metadata.tool_choice` is defined, passes it directly to the request params
- MiMo API is OpenAI-compatible, so `tool_choice` is accepted as-is

**c) Added `parallel_tool_calls` based on metadata (in `createMessage`)**

- When `metadata.parallelToolCalls === false`, sends `parallel_tool_calls: false`
- When `metadata.parallelToolCalls === true`, sends `parallel_tool_calls: true`
- When `undefined`, the field is omitted entirely

**d) Added fallback retry for rejected `parallel_tool_calls` (in `createMessage` catch block)**

- If the initial request fails and `isParallelToolCallsRejected(error)` returns true, retries once with `parallel_tool_calls` omitted from the params
- If the retry also fails or the error is unrelated, falls through to `handleProviderError` as before
- Uses destructuring to cleanly strip the field: `const { parallel_tool_calls: _omit, ...paramsWithoutParallel } = params`

### 2. Updated `src/api/providers/__tests__/mimo.spec.ts`

Replaced the old test at line 382 ("should not send parallel_tool_calls or tool_choice") which codified the bug, with 5 new tests:

1. **"should omit parallel_tool_calls when metadata.parallelToolCalls is undefined"** — verifies the field is absent when no metadata is provided (preserves the no-metadata default behavior)
2. **"should send parallel_tool_calls: false when metadata.parallelToolCalls is false"** — verifies `parallel_tool_calls: false` is sent
3. **"should send parallel_tool_calls: true when metadata.parallelToolCalls is true"** — verifies `parallel_tool_calls: true` is sent
4. **"should pass through tool_choice when provided in metadata"** — verifies `tool_choice: "auto"` is passed through
5. **"should retry without parallel_tool_calls when endpoint rejects the field"** — verifies the fallback: first call includes `parallel_tool_calls: false`, gets rejected with 400, retry omits the field, and the stream produces text from the retry response

## Result

✅ Success — All 51 tests pass (46 existing + 5 new).

```
Test Files  1 passed (1)
     Tests  51 passed (51)
  Duration  2.19s
```

## Issues Discovered

None. The implementation is self-contained within the MiMo provider and does not affect stream parsing or dispatch (Sub-task 3's scope).

## Next Step Recommendations

- **Sub-task 3**: Wire stream parsing / dispatch to handle single tool call enforcement (if needed beyond request-level controls)
- **Sub-task 6**: Add canary integration test against the real MiMo endpoint to verify the `parallel_tool_calls: false` field is accepted and the fallback works in production

## Affected File List

- `src/api/providers/mimo.ts` — Added `isParallelToolCallsRejected` helper, `tool_choice` passthrough, `parallel_tool_calls` sending, and fallback retry logic
- `src/api/providers/__tests__/mimo.spec.ts` — Replaced 1 outdated test with 5 new tests covering all metadata scenarios and fallback behavior
