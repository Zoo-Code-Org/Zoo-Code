# Debug Task Report — E2E Test Failure: "Should handle apply_diff errors gracefully"

## Task Summary

Investigate why the E2E test `Should handle apply_diff errors gracefully` in [`apps/vscode-e2e/src/suite/tools/apply-diff.test.ts`](apps/vscode-e2e/src/suite/tools/apply-diff.test.ts:337) consistently times out after 60s on CI for PR #1009 (`feat/error-interception-middleware`).

## Root Cause (Confidence: HIGH)

**Format mismatch between the mock fixture expectation and the error-interceptor's emitted payload.**

The E2E test flow is:

1. Test sends user message `APPLY_DIFF_ERROR_SMOKE`.
2. Mock AI (aimock) matches it via [`apps/vscode-e2e/fixtures/apply-diff.json:46-58`](apps/vscode-e2e/fixtures/apply-diff.json:46) and returns a tool call to `apply_diff` with an invalid SEARCH block (`This content does not exist`) against [`error-handling.txt`](apps/vscode-e2e/src/suite/tools/apply-diff.test.ts:57) (which contains only `Original content`).
3. The real extension runs `apply_diff`, fails with "no sufficiently similar match found".
4. The new error-interception middleware (the subject of PR #1009) classifies it as `DIFF_MATCH_FAILED` / pattern `EI/DIFF_MATCH_FAILED/001` and emits a guided error.
5. The guided error goes back to the mock AI as the `tool` role message keyed by `tool_call_id = "call_apply_diff_error_001"`.
6. aimock must now match a _second_ fixture — [`apps/vscode-e2e/src/fixtures/apply-diff.ts:32-37`](apps/vscode-e2e/src/fixtures/apply-diff.ts:32) — to reply with `attempt_completion`.
7. **That second fixture never matches, so the mock AI never returns `attempt_completion`.** The extension keeps waiting; the test's `waitUntilCompleted` hits the 60 000 ms timeout.

### The exact mismatch

The fixture predicate at [`apps/vscode-e2e/src/fixtures/apply-diff.ts:34`](apps/vscode-e2e/src/fixtures/apply-diff.ts:34) requires the tool-result string to contain **both** JSON-shaped substrings:

```ts
expected: ['"category":"DIFF_MATCH_FAILED"', '"pattern_id":"EI/DIFF_MATCH_FAILED/001"']
```

It uses [`toolResultContains`](apps/vscode-e2e/src/fixtures/tool-result.ts:9) → `expected.every(text => content.includes(text))`.

But the interceptor's [`MessageTransformer.formatPayloadAsDetails()`](src/core/tools/error-interception/MessageTransformer.ts:303) emits an `<error_details>` block, not JSON:

```
<error_details>
Type: guided_tool_error
Category: DIFF_MATCH_FAILED
What: ...
Why: ...
Next:
1. ...
Retryable: true
Disposition: correct_once
Pattern: EI/DIFF_MATCH_FAILED/001
Occurrence: 1
</error_details>
```

The literal substrings `"category":"DIFF_MATCH_FAILED"` and `"pattern_id":"EI/DIFF_MATCH_FAILED/001"` (quoted, colon, no space) **never appear** in that output. The actual lines are `Category: DIFF_MATCH_FAILED` and `Pattern: EI/DIFF_MATCH_FAILED/001` (no quotes, space after colon, capitalized keys).

The unit test for the same transformer at [`ToolErrorInterceptor.spec.ts:202-223`](src/core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts:202) asserts exactly this `<error_details>` shape (`expect(result).toContain("Category: DIFF_MATCH_FAILED")`, `"Pattern: EI/DIFF_MATCH_FAILED/001"`), confirming that the production format is the human-readable details block, not JSON.

### Why it loops forever instead of failing fast

- aimock only returns a fixture response when a predicate matches; otherwise it falls through to a default that does not include `attempt_completion`. The extension therefore never sees a terminal tool call, so `waitUntilCompleted` never resolves.
- The interceptor's `Occurrence` counter increments per category, but the mock AI never issues another `apply_diff` call (it is waiting on a fixture match), so the circuit-breaker / "stuck" escalation paths in [`MessageTransformer.deriveOccurrenceTemplate`](src/core/tools/error-interception/MessageTransformer.ts:141) are never exercised from this test.
- The test only fails at the outer 60 s Mocha timeout, masking the real cause as a generic timeout.

### Secondary issue (would surface after fixing the primary one)

The fixture's canned `attempt_completion` text is:

> "The apply_diff operation on `apply-diff-tool-fixture/error-handling.txt` was rejected - the search content **did not match** any content in the file, so it was not modified."

The test asserts [`message.text?.includes("did not match")`](apps/vscode-e2e/src/suite/tools/apply-diff.test.ts:378). That substring is present in the fixture text, so once the predicate matches, the assertion should pass. No change needed there.

## Causal Chain (Impact Analysis)

```
apply-diff.test.ts ("Should handle apply_diff errors gracefully")
  └─> api.startNewTask(text="APPLY_DIFF_ERROR_SMOKE")
        └─> OpenRouter provider → aimock HTTP server
              └─> fixture match #1 (apply-diff.json:46) → tool_call apply_diff(id=call_apply_diff_error_001)
                    └─> Extension runs apply_diff on error-handling.txt
                          └─> applyDiffTool fails ("no sufficiently similar match found")
                                └─> pushToolResult(...) — intercepted
                                      └─> ToolErrorInterceptor.decoratedPushToolResult
                                            └─> isErrorResult() → true (matches "no sufficiently similar match")
                                            └─> classifyError() → DIFF_MATCH_FAILED / EI/DIFF_MATCH_FAILED/001
                                            └─> transformErrorToMessage() → <error_details> block (NOT JSON)
                                └─> tool result (role:"tool", tool_call_id=call_apply_diff_error_001) sent back to aimock
              └─> fixture match #2 (apply-diff.ts:32) — PREDICATE FAILS
                    expected: '"category":"DIFF_MATCH_FAILED"'  ← absent (output has 'Category: DIFF_MATCH_FAILED')
                    expected: '"pattern_id":"EI/DIFF_MATCH_FAILED/001"' ← absent (output has 'Pattern: EI/DIFF_MATCH_FAILED/001')
              └─> No matching fixture → aimock returns generic/empty response
                    └─> No attempt_completion → task never completes → 60 s timeout
```

### Reverse-dependency map for the fix

Changing either side affects:

| Changed file                                                                                                                          | Affects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/vscode-e2e/src/fixtures/apply-diff.ts`](apps/vscode-e2e/src/fixtures/apply-diff.ts:34) (the `expected` array)                  | Only the E2E mock; no production impact. **Recommended fix location.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [`src/core/tools/error-interception/MessageTransformer.ts`](src/core/tools/error-interception/MessageTransformer.ts:303) (serializer) | Every consumer of guided error output: chat UI rendering, model prompts, all unit tests in [`__tests__/MessageTransformer.spec.ts`](src/core/tools/error-interception/__tests__/MessageTransformer.spec.ts), [`ToolErrorInterceptor.spec.ts`](src/core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts), and downstream parsers that regex `^Category: (.+)$` (see [`extractCategoryFromGuided`](src/core/tools/error-interception/MessageTransformer.ts:60)). Changing the wire format here is high-blast-radius and not justified for a test fixture mismatch. |

## Recommended Fix (Path A — surgical)

Update the `expected` array in [`apps/vscode-e2e/src/fixtures/apply-diff.ts:34`](apps/vscode-e2e/src/fixtures/apply-diff.ts:34) to match the real emitted format:

```ts
expected: ["Category: DIFF_MATCH_FAILED", "Pattern: EI/DIFF_MATCH_FAILED/001"]
```

(Or, more robustly, match on the `<error_details>` envelope plus `Category:` line.) This aligns the mock with the production serializer that is already covered by unit tests.

Do **not** change the production format to JSON to satisfy the fixture — the `<error_details>` shape is intentional (human-readable, AI-parseable, byte-budgeted) and heavily asserted elsewhere.

## Test Environment Issues

None encountered. The mock server ([`bedrock-mock-server.ts`](apps/vscode-e2e/src/bedrock-mock-server.ts)) is unrelated to this test (the test uses the OpenRouter/aimock path, not Bedrock); no code was modified.

## Verification Results

- Read the full E2E test, fixture JSON, fixture TS handler, the `toolResultContains` predicate, the production `ToolErrorInterceptor` and `MessageTransformer`, and the production unit tests.
- The format claim is directly asserted by the existing unit test at [`ToolErrorInterceptor.spec.ts:202-223`](src/core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts:202) — the production code emits `Category: DIFF_MATCH_FAILED` and `Pattern: EI/DIFF_MATCH_FAILED/001`, which do not contain the fixture's expected quoted-JSON substrings.
- No code was changed (read-only investigation, per task constraints).

## Next Step Recommendations for VP

1. Apply the one-line fixture fix in [`apps/vscode-e2e/src/fixtures/apply-diff.ts:34`](apps/vscode-e2e/src/fixtures/apply-diff.ts:34) (Code mode).
2. Audit the other fixture `expected` arrays in the same file (lines 16, 22, 28, 40) — they check `"path":...` and `"operation":"modified"`, which are JSON-shaped because they match the _tool-call arguments_ echoed by the assistant message, not the intercepted error result. They are not affected by this bug, but a quick grep for `"category":"` and `"pattern_id":"` across [`apps/vscode-e2e/src/fixtures/`](apps/vscode-e2e/src/fixtures) would catch any sibling fixtures that copied the wrong expectation.
3. Consider adding a small E2E-side helper (e.g., `toolResultMatchesGuidedError(req, toolCallId, category, patternId)`) that parses the `<error_details>` envelope instead of relying on raw substring matching, to prevent recurrence when the guided-error format evolves.

## Affected File List

- [`apps/vscode-e2e/src/fixtures/apply-diff.ts`](apps/vscode-e2e/src/fixtures/apply-diff.ts) — requires the fix (line 34).
- [`apps/vscode-e2e/src/suite/tools/apply-diff.test.ts`](apps/vscode-e2e/src/suite/tools/apply-diff.test.ts) — no change needed; assertions already consistent with the fixture's canned completion text.
- [`apps/vscode-e2e/fixtures/apply-diff.json`](apps/vscode-e2e/fixtures/apply-diff.json) — no change needed; first-stage fixture works.
- [`src/core/tools/error-interception/MessageTransformer.ts`](src/core/tools/error-interception/MessageTransformer.ts) — no change; production format is correct and unit-tested.
- [`src/core/tools/error-interception/ToolErrorInterceptor.ts`](src/core/tools/error-interception/ToolErrorInterceptor.ts) — no change.
