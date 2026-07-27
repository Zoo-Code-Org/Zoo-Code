# Code Light Task Report

## Task Summary

One-line metadata fix: change `typeMismatch: true` to `unknownTool: true` in the unknown-tool path at [`presentAssistantMessage.ts:1252`](src/core/assistant-message/presentAssistantMessage.ts:1252), plus a new test covering the custom-tool-registry-miss path.

## Actions Taken

1. Read [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts) lines 1225-1274 to confirm the bug at line 1252.
2. Read [`errorPatterns.ts`](src/core/tools/error-interception/errorPatterns.ts) to confirm the `TOOL_NOT_FOUND` pattern matches on `metadata.unknownTool`, not `metadata.typeMismatch`.
3. Changed `metadata: { typeMismatch: true }` → `metadata: { unknownTool: true }` at line 1252.
4. Added a new test case `"emits unknownTool metadata (not typeMismatch) when tool passes validateToolUse but is not in custom registry"` in the `"unknown tool handling"` describe block of [`presentAssistantMessage-error-interception.spec.ts`](src/core/assistant-message/__tests__/presentAssistantMessage-error-interception.spec.ts:705).
5. Ran `cd src; npx vitest run core/assistant-message/__tests__/presentAssistantMessage-error-interception.spec.ts` — all 27 tests passed.

## Result

✅ Success — fix applied, test added, all tests pass.

## Issues Discovered

None.

## Next Step Recommendations

- The `typeMismatch: true` at line 1203 (custom tool parameter parse failure) is a different path and is intentionally correct — no change needed there.

## Affected File List

- [`src/core/assistant-message/presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts:1252) (1 line changed)
- [`src/core/assistant-message/__tests__/presentAssistantMessage-error-interception.spec.ts`](src/core/assistant-message/__tests__/presentAssistantMessage-error-interception.spec.ts:705) (1 test added)
