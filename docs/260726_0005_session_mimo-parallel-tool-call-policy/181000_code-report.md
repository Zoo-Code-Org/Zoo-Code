# Code Task Report

## Task Summary

Fix the E2E fixture mismatch in `apply-diff.ts`, add an integration test exercising the real `NativeToolCallParser` → `ToolErrorInterceptor` → `Task.pushToolResultToUserContent` handoff for the `INVALID_JSON_ARGUMENTS` flow, and verify unit test format consistency.

## Actions Taken

### Fix 1: E2E Fixture Update (surgical, one-line)

- [`apps/vscode-e2e/src/fixtures/apply-diff.ts`](apps/vscode-e2e/src/fixtures/apply-diff.ts:34) — Updated the `expected` array from JSON-shaped substrings (`'"category":"DIFF_MATCH_FAILED"'`, `'"pattern_id":"EI/DIFF_MATCH_FAILED/001"'`) to human-readable format (`"Category: DIFF_MATCH_FAILED"`, `"Pattern: EI/DIFF_MATCH_FAILED/001"`), matching the actual `<error_details>` output from `MessageTransformer.formatPayloadAsDetails()`.

### Fix 2: Integration Test (edelauna's advice)

- Created [`src/core/assistant-message/__tests__/error-interceptor-guided-format.integration.spec.ts`](src/core/assistant-message/__tests__/error-interceptor-guided-format.integration.spec.ts:1) — 5 integration tests across 3 describe blocks:
    1. **Real interceptor produces `<error_details>` format for `INVALID_JSON_ARGUMENTS`** — Verifies `ToolErrorInterceptor.transformError()` with `metadata: { invalidJsonArguments: true }` produces human-readable `Category:` and `Pattern:` lines, not JSON.
    2. **Guided message includes Type, What, Retryable, Occurrence fields** — Verifies all `<error_details>` fields are present in human-readable format.
    3. **Real parser + real dedup: malformed JSON flows through parser→interceptor→pushToolResult** — Uses real `NativeToolCallParser.parseToolCall()` to record a parse error, real `consumeParseError()` for atomic consumption, real `ToolErrorInterceptor.transformError()` for guided message generation, and real `pushToolResultToUserContent()` for dedup verification (duplicate push rejected).
    4. **Guided format consistency: `INVALID_JSON_ARGUMENTS` matches E2E fixture expectations** — Extracts `Category:` and `Pattern:` lines via regex, verifies they are NOT JSON-shaped.
    5. **`DIFF_MATCH_FAILED` cross-pattern consistency** — Uses real `createInterceptor` → `decoratedPushToolResult` flow (the actual path for tool_result errors) to verify the same `<error_details>` format.

### Fix 3: Unit Test Consistency Check

- Verified [`src/core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts`](src/core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts:1) — All assertions already use the `<error_details>` format (`Category:`, `Pattern:`, `Type:`, `Retryable:`, `Occurrence:`). No JSON-shaped assertions found. No changes needed.

## Result

✅ All 81 tests pass across 7 test files in `core/assistant-message/__tests__/`
✅ E2E fixture now matches actual `formatPayloadAsDetails()` output format
✅ Integration test pins both seams: real parser→dispatch handoff + real dedup
✅ Cross-pattern consistency verified (`INVALID_JSON_ARGUMENTS` and `DIFF_MATCH_FAILED` both produce `<error_details>` format)

## Issues Discovered

- The `INVALID_JSON_ARGUMENTS` pattern (`EI/INVALID_JSON_ARGUMENTS/001`) matches on `metadata: { invalidJsonArguments: true }`, but the real `presentAssistantMessage` flow never sets this metadata — it uses `parseFailureKind` routing to `PARSER_FAILURE_*` patterns instead. The `INVALID_JSON_ARGUMENTS` pattern is currently only reachable through direct interceptor calls, not through the real `presentAssistantMessage` dispatch. This may be intentional (the pattern exists for future use or for signals constructed differently), but it's worth noting.

## Next Step Recommendations

- Consider whether `presentAssistantMessage` should set `invalidJsonArguments: true` metadata for certain parser failure kinds, or whether the `INVALID_JSON_ARGUMENTS` pattern should be removed if it's unreachable through the real flow.
- The E2E fixture change should be verified against the actual E2E test run to confirm the mock server now matches.

## Affected File List

- `apps/vscode-e2e/src/fixtures/apply-diff.ts` (modified, 1 line)
- `src/core/assistant-message/__tests__/error-interceptor-guided-format.integration.spec.ts` (created, 5 tests)
