# Ask Light Gate Verification: Architecture vs User Intent

## Task Summary

Light Gate per-phase intent check verifying that the architect's plan at [`225948_architect-report.md`](docs/260726_0004_session_pr-review-fixes/225948_architect-report.md) faithfully addresses all 8 requirements from [`requirement-checklist.md`](docs/260726_0004_session_pr-review-fixes/requirement-checklist.md) and aligns with the user's original Phase 1 intent.

## User's Original Intent (Phase 1)

1. Fix all 7 PR review items to a high level of completeness ("완성도 높은 수준으로 수정")
2. Error messages must be clear, but the AI model should own the error and guide itself to the correct path without stopping ("에러메시지는 명확히 출력하되, AI모델이 이것을 안고, 멈추지 않고 제대로 된 길로 가이드해야하는데")
3. The user had to click "Proceed anyway" 10+ times because the model kept generating empty tool calls alongside real ones — this must stop

---

## Requirement-by-Requirement Verification

### REQ-001: Remove local dev scripts from PR

- **Addressed?** Yes. Component A, Task 1 (lines 258-279, 430-447).
- **Approach aligned?** Yes. Root-anchored `.gitignore` rules for the 4 files, removal via Recycle Bin (not permanent deletion), verification via `git check-ignore`.
- **Gaps?** None.

### REQ-002: Synchronize TaskErrorState fingerprint reset with ToolErrorInterceptor

- **Addressed?** Yes. Component C, Task 6 (lines 319-334, 538-555).
- **Approach aligned?** Yes. Coordinated reset entry point via [`ToolErrorInterceptor.resetTaskState()`](src/core/tools/error-interception/ToolErrorInterceptor.ts:1), atomic from production caller's perspective, category circuit closure included.
- **Gaps?** None.

### REQ-003: Sanitize paramName in MessageTransformer

- **Addressed?** Yes. Component D, Task 5 (lines 335-352, 518-536).
- **Approach aligned?** Yes. Shared safe-identifier validator at both extraction and rendering boundaries (defense in depth), max 128 chars, rejects whitespace/quotes/brackets/markup/shell characters, generic fallback on failure (not escaped partial preservation).
- **Gaps?** None.

### REQ-004: Fix unknown tool classification

- **Addressed?** Yes. Component B, Task 4 (lines 281-318, 492-516).
- **Approach aligned?** Yes. Explicit categories (`TOOL_NOT_FOUND`, `MODE_RESTRICTION`, `FILE_RESTRICTION`), exact patterns before heuristics, fixes the dispatcher's unknown-tool branch from `typeMismatch` to `unknownTool` metadata.
- **Gaps?** None.

### REQ-005: Do not add new entries to eslint-suppressions.json

- **Addressed?** Yes. Component E, Task 10 (lines 353-376, 629-647).
- **Approach aligned?** Yes. Uses typed fixtures/`unknown`/type guards instead of `as any`, fixes lint locally, compares final diff against merge base, rejects any added path or increased count.
- **Gaps?** None.

### REQ-006: Remove AI session notes from PR

- **Addressed?** Yes. Component A, Task 2 (lines 258-279, 448-466).
- **Approach aligned?** Yes. Removes [`074338_code-light-report.md`](docs/260726_0003_session_error-hiding-fix/074338_code-light-report.md) via Recycle Bin, narrow session-artifact ignore rule (`/docs/*_session_*/`) that does not broadly ignore all of `docs/`.
- **Gaps?** None. The plan correctly preserves maintained docs outside the timestamped pattern.

### REQ-007: Add integration test with real parser + real Task dedup

- **Addressed?** Yes. Component E, Task 9 (lines 362-376, 611-627).
- **Approach aligned?** Yes. Creates [`presentAssistantMessage-parser-dedup.integration.spec.ts`](src/core/assistant-message/__tests__/presentAssistantMessage-parser-dedup.integration.spec.ts) with real [`NativeToolCallParser.parseToolCall()`](src/core/assistant-message/NativeToolCallParser.ts:700), real [`NativeToolCallParser.consumeParseFailure()`](src/core/assistant-message/NativeToolCallParser.ts:89), real [`Task.pushToolResultToUserContent()`](src/core/task/Task.ts:389). Mocks only external boundaries.
- **Gaps?** None. Five required integration scenarios cover all critical paths.

### REQ-008: Improve error guidance recovery effectiveness (USER'S MOST EMPHASIZED CONCERN)

- **Addressed?** Yes. Component B Task 7 + Task 8 (lines 131-165, 281-318, 557-610).
- **Approach aligned?** Yes, strongly aligned. The plan:
    - Removes the unconditional concatenated-JSON claim that misidentified the user's actual failure pattern (empty sibling, not concatenation)
    - Introduces occurrence-aware templates: occurrence 1 = specific structural fact + concrete continuation action; occurrence 2 = stronger non-repeat; occurrence 3+ = `change_strategy` + suppress proceed gate
    - Provides concrete continuation actions ("continue from the valid sibling result and do not resend it")
    - Distinguishes invocation-scoped retry (`Retryable: false` for the bad sibling) from task-level continuation (task does NOT stop)
    - Bypasses "Proceed anyway" for safely rejected malformed siblings at occurrence 3+
- **Gaps?** None. The escalation at occurrence 3 (not 10) means the user would never reach the 10+ click scenario again.

---

## Special Attention Items

### 1. REQ-008 Guidance Effectiveness (User's Most Emphasized Concern)

The user's core pain: the model hit the same error 10+ times, the guidance was generic ("ONE AT A TIME"), and the user had to manually click "Proceed anyway" repeatedly.

The plan directly addresses this:

- **Root cause identified**: The parser conflates JSON syntax errors with post-parse schema failures (empty object = missing required fields, not invalid JSON). The old guidance told the model it "concatenated JSON objects" when the actual failure was a valid call + empty sibling. This misidentification caused the model to repeat the same mistake.
- **Concrete corrective action**: The plan's first-occurrence guidance says "continue from the valid sibling result and do not resend it" — this is a specific, executable action, not generic advice.
- **Escalation at occurrence 3**: The plan escalates to `change_strategy` and suppresses the proceed gate at occurrence 3, far earlier than the user's observed occurrence 10+. This means the loop breaks before the user is ever asked to intervene.
- **Task continuation preserved**: `Retryable: false` is invocation-scoped only. The `next` field explicitly renders task continuation, so the model knows to keep working, not stop.

**Verdict: Fully aligned with user intent.**

### 2. "Proceed Anyway" Bypass for Malformed Siblings

The user's desire: not be interrupted by the system asking to approve malformed calls that it can safely reject.

The plan's approach:

- Component B (line 299): "Do not ask the user to 'Proceed anyway' for a safely rejected malformed sibling. Continue the task using retained valid results."
- Section 1.4 (line 142): "At occurrence 3 or later, use `change_strategy`, suppress the user 'Proceed anyway' gate for this safely rejected malformed invocation, and direct the model to continue from retained results or choose a different action."
- Task 8 (line 603): "Skip the user proceed gate for safely rejected malformed siblings while allowing normal authorization/restriction gates to remain."

This precisely matches the user's intent: the nuisance "Proceed anyway" prompts for malformed tool calls are eliminated, while genuine authorization gates (file access, mode restrictions) are preserved.

**Verdict: Fully aligned with user intent.**

### 3. Clear Error Visibility ("에러메시지는 명확히 출력하되")

The user's desire: errors should be clearly visible to the user, but the model should be guided without stopping.

The plan's dual-channel design:

- Goal 1 (line 33): "Preserve clear error visibility. A rejected call must still be reported through the existing user-visible error channel. Model sanitization must not hide the original failure from the user or diagnostics."
- Dual-Channel Invariant (lines 74-78): User channel = clear, actionable, may contain local diagnostic detail. Model channel = deterministic, bounded, sanitized. "A model-facing transformation must never replace or suppress the user-visible error emission."
- User-Visible Error Flow (lines 66-72): User sees tool name, failure kind, and concise reason. Raw diagnostic detail remains available to local diagnostics.
- Integration test assertion (line 414): "User visibility regresses while model guidance improves" is listed as a risk with required handling — an assertion on the user error channel is added to dispatcher integration tests.

**Verdict: Fully aligned with user intent.** The plan does not sacrifice error visibility for guidance improvement — both channels are preserved and tested independently.

---

## LLM-as-Judge Verification

### Intent Alignment Verification

| User Intent Item                        | Plan Coverage                                                                   | Match |
| --------------------------------------- | ------------------------------------------------------------------------------- | ----- |
| Fix all 7 PR items to high completeness | REQ-001 through REQ-007, 10 tasks, acceptance criteria per task                 | ✅    |
| Clear error messages                    | Dual-channel design, Goal 1, user-visible error flow preserved                  | ✅    |
| Guide AI model without stopping         | Occurrence-aware guidance, invocation-scoped retry, task continuation in `next` | ✅    |
| Stop "Proceed anyway" 10+ clicks        | Bypass at occurrence 3+, specific sibling guidance, `change_strategy`           | ✅    |

### Implementation Completeness Verification

- **Missing?** No edge cases identified as unaddressed. The plan covers 12 risk/edge-case scenarios (section 2.5) including sibling ordering, identifier reuse, empty string arguments, valid JSON arrays, unknown MCP tools, localization changes, malicious parameter names, counter drift, fingerprint sensitivity, guidance truncation, user visibility regression, and session ignore scope.
- **Unnecessary?** No. All 10 tasks map to specific requirements. No placeholder or dead-code concerns.
- **Consistency?** Yes. The plan uses existing repository patterns (Vitest, ESLint, task-scoped state, consume-once side channel) and adds no new dependencies.

### User Impact Verification

- **What changes will the user see?** The user will no longer be asked to click "Proceed anyway" for malformed sibling tool calls. Error messages will remain visible but will correctly identify the failure type (missing arguments vs. invalid JSON). The model will receive specific, actionable guidance that breaks repetition loops.
- **Has the user experience improved?** Yes, significantly. The primary pain point (10+ manual interventions) is eliminated.
- **Unexpected side effects?** None identified. The plan preserves all existing successful tool execution paths, provider protocol integrity, and genuine authorization gates.

---

## Final Verdict

**[Verdict]**: PASS ✅

**[Reason]**: The architecture plan faithfully addresses all 8 requirements and aligns with the user's three core intents. REQ-008 (the user's most emphasized concern) is addressed through typed parser failure classification, occurrence-aware guidance with concrete continuation actions, and "Proceed anyway" bypass at occurrence 3 — far earlier than the user's observed occurrence 10+. Clear error visibility is preserved via a dual-channel design that never suppresses user-visible errors. The "Proceed anyway" bypass targets only safely rejected malformed siblings while preserving genuine authorization gates. No gaps or misalignments identified.
