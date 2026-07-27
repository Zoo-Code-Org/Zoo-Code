# Final Ask Audit — Error Interception Middleware PR Fixes

## Phase 6 Comprehensive Final Validation

- **Auditor:** Ask mode (CPO / Final Validator)
- **Branch:** `feat/error-interception-middleware`
- **Date:** 2026-07-26 18:11 KST
- **Report Folder:** `docs/260726_0004_session_pr-review-fixes/`

---

## [1. Philosophy & UX/UI Diagnostics]

### User Intent Alignment

The user's core concern (REQ-008) was that the error interception middleware fails to **effectively guide AI models to recover from errors** — models repeatedly hit the same errors (e.g., `INVALID_JSON_ARGUMENTS` occurrence=10+), forcing the user to click "Proceed anyway" manually. The user wants guidance that is **specific enough to break the loop** and **reduces manual intervention**.

The implementation addresses this root cause through three coordinated mechanisms:

1. **Typed parser failure descriptors** ([`NativeToolParseFailure`](src/core/assistant-message/NativeToolCallParser.ts:61)) — replaces the conflated string side channel that labeled all parser failures as "invalid JSON" with a discriminated union (`json_syntax` / `missing_required_arguments` / `invalid_argument_shape`). This means an empty `{}` sibling is now correctly classified as "missing required arguments" instead of "invalid JSON", giving the model actionable structural information.

2. **Occurrence-aware escalation** ([`selectOccurrenceTemplate()`](src/core/tools/error-interception/MessageTransformer.ts:170) + [`selectRecoveryDisposition()`](src/core/tools/error-interception/MessageTransformer.ts:190)) — guidance escalates from occurrence 1 (specific corrective action) → occurrence 2 ("emitted again" + non-repeat instruction) → occurrence 3+ ("change strategy" + `change_strategy` disposition). This directly addresses the occurrence=10+ stuck loop.

3. **"Proceed anyway" gate bypass** — all malformed sibling paths push `tool_result` directly via [`cline.pushToolResultToUserContent()`](src/core/assistant-message/presentAssistantMessage.ts:611) without routing through the `repetitionCheck.askUser` gate. The integration test (scenario 5) explicitly asserts `task.ask` was never called across 3 repeated malformed calls.

### Usability Assessment

From an end-user perspective:

- **Error visibility preserved:** Every malformed path emits to BOTH channels — `cline.say("error", ...)` for the user UI and `pushToolResultToUserContent()` for the model. The dual-channel invariant is honored at lines 607-616, 836-845, 918-927, and 1254-1267.
- **Guidance specificity improved:** Instead of generic "ONE AT A TIME" messaging, the model now receives structural facts: which parameter is missing, whether a valid sibling was retained, and a concrete next action ("continue from the retained result and do not resend it").
- **No raw argument leakage:** The integration test (scenario 4) explicitly asserts the malformed JSON string `extra}` does not appear in the guidance payload.

---

## [2. 1:1 Cross-Validation Results]

### Per-Requirement Verification

| REQ                                         | Status                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **REQ-001** Remove dev scripts + .gitignore | ✅ Implemented and verified | [`.gitignore`](.gitignore:59-63) contains root-anchored ignores for `ci-fix-commit.ps1`, `commit-and-push.ps1`, `commit-message.txt`, `resolve_conflicts.py`. Debug review confirms `git status` shows `D` for all four.                                                                                                                                                                                                                                                                                                                                                                                                         |
| **REQ-002** Fingerprint reset sync          | ✅ Implemented and verified | [`ToolErrorInterceptor.resetTaskState()`](src/core/tools/error-interception/ToolErrorInterceptor.ts:114) coordinates both state consumers: deletes `categoryCounts` entry (L119), closes shell circuit for `SHELL_INTEGRATION` (L122-124), and resets `TaskErrorState` category via `getTaskErrorState(task).reset(category)` (L128-130). Call site at [`presentAssistantMessage.ts:797`](src/core/assistant-message/presentAssistantMessage.ts:797) fires both `taskErrorState.reset("PARAM_TYPE_MISMATCH")` AND `interceptor.resetTaskState(cline, "PARAM_TYPE_MISMATCH")` on fingerprint change. No-op path preserved (L116). |
| **REQ-003** paramName sanitization          | ✅ Implemented and verified | Defense-in-depth at both boundaries: **Extraction** — [`isValidIdentifier()`](src/core/tools/error-interception/ErrorClassifier.ts:20) with regex `/^[a-zA-Z_][\w.]*$/`, 128-char cap, blocklist for `[\n\r"'><\[\]{}()                                                                                                                                                                                                                                                                                                                                                                                                          | ;\`\\]`. [`sanitizeFacts()`](src/core/tools/error-interception/ErrorClassifier.ts:179) deletes unsafe `parameterName` from metadata. **Rendering** — [`MessageTransformer.buildPayload()`](src/core/tools/error-interception/MessageTransformer.ts:240) re-validates with `isValidIdentifier(paramName)`before interpolation; on failure, omits the name and falls back to generic template (does NOT escape/partially preserve). Parameter-name interpolation only at occurrence 1 (L240,`occ <= 1`). |
| **REQ-004** Unknown tool classification     | 🔶 Partially implemented    | See detailed analysis below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **REQ-005** eslint-suppressions.json        | ✅ Implemented and verified | Search for `presentAssistantMessage-error-interception` and `presentAssistantMessage.ts` in [`eslint-suppressions.json`](src/eslint-suppressions.json) returns 0 results — both entries were removed (30 `no-explicit-any` + 9 `no-explicit-any`). No new entries added.                                                                                                                                                                                                                                                                                                                                                         |
| **REQ-006** Remove AI session notes         | ✅ Implemented and verified | [`.gitignore`](.gitignore:65-66) contains `/docs/*_session_*/` narrow rule. Debug review confirms `D docs/260726_0003_session_error-hiding-fix/074338_code-light-report.md`. Non-session docs paths are not matched.                                                                                                                                                                                                                                                                                                                                                                                                             |
| **REQ-007** Integration test                | ✅ Implemented and verified | [`presentAssistantMessage-parser-dedup.integration.spec.ts`](src/core/assistant-message/__tests__/presentAssistantMessage-parser-dedup.integration.spec.ts) (643 lines) covers all 5 required scenarios. Mocks ONLY external boundaries (Task model, validateToolUse, MCP, telemetry, i18n, SearchFilesTool). [`NativeToolCallParser`](src/core/assistant-message/NativeToolCallParser.ts) and `Task.pushToolResultToUserContent` dedup remain REAL (comment at L13-16).                                                                                                                                                         |
| **REQ-008** Guidance effectiveness          | ✅ Implemented and verified | See detailed analysis below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### REQ-004 Detailed Analysis — Partially Implemented

**What was correctly implemented:**

1. Three new exact-match patterns added BEFORE `UNCLASSIFIED` catch-all in [`errorPatterns.ts`](src/core/tools/error-interception/errorPatterns.ts):
    - `EI/TOOL_NOT_FOUND/001` (priority 95) — matches `unknownTool: true`
    - `EI/MODE_RESTRICTION/001` (priority 94) — matches `modeRestriction: true`
    - `EI/FILE_RESTRICTION/001` (priority 93) — matches `fileRestriction: true`

2. Three parser failure patterns added:
    - `EI/PARSER_FAILURE_JSON_SYNTAX/001` (priority 92)
    - `EI/PARSER_FAILURE_MISSING_ARGS/001` (priority 91)
    - `EI/PARSER_FAILURE_INVALID_SHAPE/001` (priority 90)

3. The `validateToolUse` catch block at [`presentAssistantMessage.ts:894-903`](src/core/assistant-message/presentAssistantMessage.ts:894) correctly classifies validation errors:
    - `"not allowed in"` → `modeRestriction: true`
    - `"Unknown tool"` → `unknownTool: true`
    - `"File restriction"`/`"FileRestriction"` → `fileRestriction: true`
    - else → `typeMismatch: true` (generic fallback ONLY for real type issues)

**What was NOT fully implemented — the deviation:**

At [`presentAssistantMessage.ts:1246-1252`](src/core/assistant-message/presentAssistantMessage.ts:1246), there is a **separate unknown-tool code path** (the "not a custom tool" branch at L1240) that still emits `metadata: { typeMismatch: true }` instead of `metadata: { unknownTool: true }`:

```typescript
// Line 1240-1252
// Not a custom tool - handle as unknown tool error
const errorMessage = `Unknown tool "${block.name}". This tool does not exist. Please use one of the available tools.`
// ...
const guided = interceptor.transformError(cline, {
	source: "validation",
	stage: "preflight",
	taskId: cline.taskId,
	toolCallId,
	toolName: block.name,
	metadata: { typeMismatch: true }, // ← SHOULD BE { unknownTool: true }
})
```

This means when a tool name is not found in the custom tool registry AND is not a recognized native tool, the interceptor receives `typeMismatch: true` instead of `unknownTool: true`. The `EI/TOOL_NOT_FOUND/001` pattern (which matches `unknownTool: true`) will NOT match this signal. Instead, it falls through to the broad `PARAM_TYPE_MISMATCH` fallback, which is exactly the misclassification REQ-004 was meant to fix.

**Impact assessment:**

- The `validateToolUse` catch block (L894-903) handles the primary unknown-tool detection path and is correctly fixed.
- The L1240 path is a secondary fallback for tools that pass `validateToolUse` but are not found in the custom tool registry. This is a narrower edge case but still a fail-open path that REQ-004 explicitly aimed to close.
- The debug technical review (L60-64) only verified the `validateToolUse` catch block path, not the L1240 path.

**Severity:** 🟡 Should Fix — This is a residual fail-open path. It does not break the primary flow but leaves a gap in the exact classification coverage that REQ-004 was designed to close.

### REQ-008 Detailed Analysis — Implemented and Verified

**Occurrence-aware escalation (1→2→3+):**

| Occurrence | Template                                                 | Disposition                             | Behavior                                                                         |
| ---------- | -------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| 1          | `first` (pattern-specific or base)                       | `correct_once`                          | Specific corrective action with parameter name (if valid)                        |
| 2          | `repeated` — "The same failure shape was emitted again." | `discard_duplicate` or pattern-specific | Non-repeat instruction + "continue from retained result"                         |
| 3+         | `stuck` — "The same failure shape keeps being emitted."  | `change_strategy`                       | "Change strategy before the next tool call; do not repeat the same fingerprint." |

Verified at:

- [`deriveOccurrenceTemplate()`](src/core/tools/error-interception/MessageTransformer.ts:141) — supplies escalating defaults
- [`selectOccurrenceTemplate()`](src/core/tools/error-interception/MessageTransformer.ts:170) — picks `first`/`repeated`/`stuck`
- [`selectRecoveryDisposition()`](src/core/tools/error-interception/MessageTransformer.ts:190) — escalates to `change_strategy` at occ≥3

**"Proceed anyway" bypass verification:**

All four malformed sibling paths push `tool_result` directly via `cline.pushToolResultToUserContent()` WITHOUT routing through the `repetitionCheck.askUser` gate:

| Path                                | Line       | Direct push? | User error emitted?                   |
| ----------------------------------- | ---------- | ------------ | ------------------------------------- |
| Missing nativeArgs (parser failure) | L611-616   | ✅ Yes       | ✅ `cline.say("error", ...)` at L610  |
| Structural misuse                   | L840-845   | ✅ Yes       | ✅ `cline.say("error", ...)` at L839  |
| Validation error                    | L922-927   | ✅ Yes       | ✅ `cline.say("error", ...)` at L921  |
| Unknown tool (L1240 path)           | L1262-1267 | ✅ Yes       | ✅ `cline.say("error", ...)` at L1254 |

The `repetitionCheck.askUser` gate (L940-962) is only reached for tools that pass all validation and parser checks — i.e., genuinely repeated _valid_ tool calls, not malformed siblings.

**Integration test scenario 5** explicitly verifies this: across 3 repeated malformed calls, `task.toolRepetitionDetector.check` was never called and `task.ask` was never invoked. At occurrence 3, the guidance contains "change strategy" language.

**Sibling facts derivation:**

[`presentAssistantMessage.ts:537-543`](src/core/assistant-message/presentAssistantMessage.ts:537) computes `validSiblingPresent` from same-turn `tool_use` blocks with distinct IDs, without forwarding sibling identifiers or argument values. This is safe and correct.

### Error Visibility Verification

The dual-channel invariant ("both must happen") is honored at every malformed path:

| Path               | User channel (`cline.say`)                          | Model channel (`pushToolResultToUserContent`)    |
| ------------------ | --------------------------------------------------- | ------------------------------------------------ |
| Missing nativeArgs | L610: `missingArgsUserMessage`                      | L611-616: `missingArgsBase + missingArgsGuide`   |
| Structural misuse  | L839: `structuralUserMessage`                       | L840-845: `structuralBase + structuralGuide`     |
| Validation error   | L921: `validationUserMessage`                       | L922-927: `validationBase + validationGuide`     |
| Unknown tool       | L1254-1258: `guided or t("tools:unknownToolError")` | L1262-1267: `unknownToolBase + unknownToolGuide` |

Pending native-protocol guides are consumed (read + cleared) at every `tool_result` emission point (L602, L650, L831, L913, L1260) so they cannot leak into later turns.

### Quality Gates

| Gate                         | Result            | Evidence                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests                        | ✅ 392/392 passed | Debug technical review L14: 9 files, 392/392 tests passed (10.84s)                                                                                                                                                                                                                                                                       |
| Lint                         | ✅ Clean          | Debug technical review L15: `npx eslint` clean (no output)                                                                                                                                                                                                                                                                               |
| Type check                   | ✅ Clean          | Debug technical review L16: `npx tsc --noEmit` clean                                                                                                                                                                                                                                                                                     |
| eslint-suppressions.json     | ✅ Decreases only | Removed `presentAssistantMessage-error-interception.spec.ts` (30 `no-explicit-any`) and `presentAssistantMessage.ts` (9 `no-explicit-any`). No new entries.                                                                                                                                                                              |
| No `as any` in touched files | ✅ Verified       | `search_files` for `as any` in `src/core/tools/error-interception/*.ts` → 0 results. In `src/core/assistant-message/presentAssistantMessage.ts` → 0 results. In `src/core/assistant-message/NativeToolCallParser.ts` → 0 results. Integration test uses `as unknown as Task` (not `as any`); comments explicitly document the avoidance. |

### Devil's Advocate — Additional Findings

1. **🟡 REQ-004 residual gap (L1252):** As detailed above, the L1240 unknown-tool path still emits `typeMismatch: true` instead of `unknownTool: true`. This is a one-line fix (`typeMismatch: true` → `unknownTool: true`) but it leaves a fail-open path that REQ-004 was designed to close.

2. **🟢 Custom tool param validation (L1203):** The custom tool parameter validation catch block at L1197-1204 also uses `metadata: { typeMismatch: true }`. This is arguably correct since a Zod parse failure IS a type/shape mismatch, not an unknown tool. However, it could benefit from a more specific `invalid_argument_shape` classification. Low priority — the current behavior is defensible.

3. **🟢 Integration test scenario 5 occurrence counter:** The test asserts `task.consecutiveMistakeCount` is 1 after each call (reset between calls via `resetForNextBlock`). This is correct because each call is a separate streaming block with a different ID. However, the test does not verify that the error-interception circuit's occurrence counter actually increments across calls. The `change strategy` assertion at L639 indirectly confirms escalation, but a direct assertion on the circuit state would be stronger. Low priority — the behavioral assertion is sufficient.

4. **🟢 `pnpm` not on PATH:** The debug review noted `pnpm` was unavailable and `npx` was used as a substitute. This is an environment issue, not a code issue. The commands are equivalent for the checks performed.

---

## [3. Inquiries for VP & User]

### Inquiry 1: REQ-004 L1252 residual gap

**Question:** The L1240 unknown-tool path in [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts:1252) still emits `metadata: { typeMismatch: true }` instead of `metadata: { unknownTool: true }`. This means the `EI/TOOL_NOT_FOUND/001` pattern will not match this signal, and it falls through to `PARAM_TYPE_MISMATCH` — the exact misclassification REQ-004 was meant to fix.

**Option A (Recommended):** Fix with a one-line change — `metadata: { typeMismatch: true }` → `metadata: { unknownTool: true }` at L1252. Delegate to Code mode. Low risk, high precision.

**Option B:** Defer to a follow-up PR. The primary unknown-tool detection path (validateToolUse catch block at L894-903) is correctly fixed. The L1240 path is a secondary fallback for tools that pass validateToolUse but are not in the custom tool registry — a narrower edge case.

**Trade-off:** Option A closes the gap completely but requires another code+test cycle. Option B ships faster but leaves a known fail-open path.

---

## [4. Final Verdict]

### **CONDITIONAL APPROVAL** 🔶

The implementation faithfully reflects user intent across 7 of 8 requirements, with strong evidence for the user's most emphasized concern (REQ-008 — guidance effectiveness). The occurrence-aware escalation, "Proceed anyway" bypass, dual-channel error visibility, and real parser+dedup integration test all directly address the user's reported pain point of models stuck in error loops requiring manual intervention.

**Conditions that must be met before VP Final Review (Phase 7):**

1. **🟡 REQ-004 L1252 fix:** Change `metadata: { typeMismatch: true }` to `metadata: { unknownTool: true }` at [`presentAssistantMessage.ts:1252`](src/core/assistant-message/presentAssistantMessage.ts:1252). This is a one-line fix that closes the residual fail-open path for unknown tools that pass `validateToolUse` but are not found in the custom tool registry. Delegate to Code mode (code-light is sufficient). Add or update a test case to cover this path.

**Items that are acceptable as-is (no blocking):**

- 🟢 Custom tool param validation (L1203) using `typeMismatch: true` — defensible since Zod parse failure IS a type mismatch.
- 🟢 Integration test scenario 5 could assert circuit state directly — behavioral assertion is sufficient.
- 🟢 `pnpm` environment issue — not a code defect.

Once condition 1 is resolved, VP may proceed to Phase 7 Final Review.
