# Ask Re-Audit Report: REQ-004 Fix Verification

## Task Summary

Re-audit of the one-line metadata fix at [`presentAssistantMessage.ts:1252`](src/core/assistant-message/presentAssistantMessage.ts:1252), changing `typeMismatch: true` → `unknownTool: true` in the custom-tool-registry-miss path. Previous audit issued CONDITIONAL APPROVAL 🔶 for this residual gap.

## Verification Results

### 1. Fix at L1252 — CONFIRMED ✅

[`presentAssistantMessage.ts:1252`](src/core/assistant-message/presentAssistantMessage.ts:1252) now reads:

```typescript
metadata: { unknownTool: true },
```

The previous `metadata: { typeMismatch: true }` has been replaced. This is the "Not a custom tool - handle as unknown tool error" branch (L1240-1268), which fires when a tool passes `validateToolUse()` but is not found in the custom tool registry.

### 2. New Test Case — CONFIRMED ✅

Test at [`presentAssistantMessage-error-interception.spec.ts:705-737`](src/core/assistant-message/__tests__/presentAssistantMessage-error-interception.spec.ts:705):

```
"emits unknownTool metadata (not typeMismatch) when tool passes validateToolUse but is not in custom registry"
```

The test asserts:

- `toolResult` is defined with `is_error: true`
- Content contains `"TOOL_NOT_FOUND"` (the correct EI pattern)
- Content does NOT contain `"PARAM_TYPE_MISMATCH"` (the old misclassification)
- `consecutiveMistakeCount` incremented to 1
- `recordToolError` called with `"tool_not_in_registry"` and `"Unknown tool"`
- `didAlreadyUseTool` is `false` (stream not interrupted)
- User-visible `say("error")` call contains `"Unknown Tool"`

This directly exercises the L1240 code path and verifies the interceptor routes to `EI/TOOL_NOT_FOUND/001` instead of the `PARAM_TYPE_MISMATCH` fallback.

### 3. REQ-004 Full Re-Audit — All Three Paths Verified ✅

#### Path A: `validateToolUse()` catch block (L884-911)

The catch block classifies the error message into the correct metadata flag:

- `"not allowed in"` → `{ modeRestriction: true }` (L896)
- `"Unknown tool"` → `{ unknownTool: true }` (L898)
- `"File restriction"` / `"FileRestriction"` → `{ fileRestriction: true }` (L900)
- Fallback → `{ typeMismatch: true }` (L902, for genuine type issues only)

**Tests covering this path:**

- L544: `"classifies 'not allowed in' as modeRestriction"` ✅
- L577: `"classifies 'Unknown tool' as unknownTool"` ✅
- L609: `"classifies 'File restriction' as fileRestriction"` ✅

#### Path B: Custom-tool-registry miss (L1240-1268) — THE FIXED PATH

Now emits `{ unknownTool: true }` at L1252.

**Test covering this path:**

- L705: `"emits unknownTool metadata (not typeMismatch) when tool passes validateToolUse but is not in custom registry"` ✅

#### Path C: Error pattern matching ([`errorPatterns.ts`](src/core/tools/error-interception/errorPatterns.ts))

Three dedicated patterns exist above the `UNCLASSIFIED` catch-all:

- `EI/TOOL_NOT_FOUND/001` (priority 95) — matches `metadataIs(signal, "unknownTool", true)` (L108-128)
- `EI/MODE_RESTRICTION/001` (priority 94) — matches `metadataIs(signal, "modeRestriction", true)` (L133-153)
- `EI/FILE_RESTRICTION/001` (priority 93) — matches `metadataIs(signal, "fileRestriction", true)` (L158-178)

All three patterns require `source === "validation"` and `stage === "preflight"`, which both code paths (A and B) correctly set.

### 4. Test Execution

VP reports all 27 tests pass in `presentAssistantMessage-error-interception.spec.ts`.

## Devil's Advocate — Residual Concerns

1. **🟢 Path B test does not mock `validateToolUse`**: The L705 test relies on the tool name `"tool_not_in_registry"` naturally passing `validateToolUse` (since it's not a real validation failure) and then falling through to the L1240 branch. This is correct behavior — the test validates the real code path, not a mocked one. No issue.

2. **🟢 No integration test for end-to-end interceptor routing on Path B**: The L705 test checks the `toolResult.content` contains `"TOOL_NOT_FOUND"`, which confirms the interceptor's `transformError` returned the correct guided payload. This is sufficient coverage at the unit level.

3. **🟢 Custom tool param validation (L1197-1204)**: Still uses `metadata: { typeMismatch: true }` for Zod parse failures. This was noted in the previous audit as defensible (a Zod parse failure IS a type/shape mismatch). No change needed.

## Final Verdict

**PASS** ✅

The one-line fix at L1252 closes the last residual gap identified in the previous CONDITIONAL APPROVAL. All three REQ-004 classification paths now emit the correct metadata flags, and the error pattern matcher routes them to the correct EI categories above the `UNCLASSIFIED` catch-all. The new test case at L705 directly verifies the fixed path. VP may proceed to VP Final Review (Phase 7).
