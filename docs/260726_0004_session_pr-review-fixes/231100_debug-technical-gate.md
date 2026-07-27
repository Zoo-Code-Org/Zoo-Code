# Debug Technical Feasibility Gate: Error Interception Middleware Fix Plan

## Task Summary

Read-only verification of the five key technical questions posed against the architecture plan at [`225948_architect-report.md`](225948_architect-report.md). Each question was answered by direct inspection of the referenced source files. No files were modified.

**Verdict: FEASIBLE.** All five architectural premises are confirmed against actual code. Three material risks and two minor blockers (both with known resolutions) are documented below. The plan can proceed to code delegation, provided the risks are addressed in the relevant tasks.

---

## Question 1: Can `NativeToolCallParser.parseToolCall()` distinguish JSON syntax errors from post-parse schema failures?

**Answer: YES — the distinction is implementable, and the current conflation the architect identified is real.**

Evidence from [`NativeToolCallParser.parseToolCall()`](../../../src/core/assistant-message/NativeToolCallParser.ts:700):

- [`NativeToolCallParser.ts:730`](../../../src/core/assistant-message/NativeToolCallParser.ts:730) — `const args = toolCall.arguments === "" ? {} : JSON.parse(toolCall.arguments)`. A JSON syntax failure throws here.
- [`NativeToolCallParser.ts:1034-1040`](../../../src/core/assistant-message/NativeToolCallParser.ts:1034) — when no `nativeArgs` could be constructed (missing required fields, empty object, wrong shape), the code explicitly throws `Invalid arguments for tool '${resolvedName}'... Received: ${JSON.stringify(args)}`. This is a **post-parse schema failure**, not a syntax failure.
- [`NativeToolCallParser.ts:1061-1076`](../../../src/core/assistant-message/NativeToolCallParser.ts:1061) — the single `catch (error)` block captures BOTH classes and stores them identically via `NativeToolCallParser.parseErrors.set(toolCall.id, errorMessage)` at line 1073.

The architect's central claim is accurate: an empty `{}` for `search_files` (required `path`+`regex`) reaches the line-1034 throw, is caught at 1061, and lands in the same string side channel as a genuine `JSON.parse` failure. The dispatcher at [`presentAssistantMessage.ts:521-522`](../../../src/core/assistant-message/presentAssistantMessage.ts:521) then treats any non-undefined `consumeParseError` result as "invalid JSON."

**Implementation feasibility of the typed descriptor:**

- The two throw sites are already structurally separated (line 730 throw vs. line 1035 throw). A discriminated `ParserFailureKind` can be produced by either (a) wrapping `JSON.parse` in its own try/catch and tagging `json_syntax`, or (b) throwing typed error subclasses from each site. Approach (a) is the lower-risk minimal change.
- The side-channel map `parseErrors: Map<string, string>` at [`NativeToolCallParser.ts:83`](../../../src/core/assistant-message/NativeToolCallParser.ts:83) can be widened to `Map<string, NativeToolParseFailure>` without changing its lifecycle (consume-once at lines 89-95, existence probe at 101-103).
- **Missing-field names are recoverable without raw exception text.** Each `case` in the switch (e.g. `search_files` at lines 902-910) already encodes the required fields via the `args.X !== undefined` guards. The descriptor can be populated from the same per-tool knowledge the switch already has — no new schema registry is required. This matches the architect's Task 3 design and is implementable without a dependency addition.

**Risk R1 (LOW):** `parseDynamicMcpTool()` at [`NativeToolCallParser.ts:1084`](../../../src/core/assistant-message/NativeToolCallParser.ts:1084) has its own `JSON.parse` at line 1087. If the typed descriptor is only added to the core-tool branch, dynamic MCP tools will keep the legacy string behavior. The plan should explicitly state whether MCP dynamic tools are in scope for the typed descriptor (architect's risk table row "Unknown dynamic MCP tool" implies they keep dedicated MCP-missing behavior — acceptable, but the boundary must be pinned in Task 3 acceptance).

---

## Question 2: Does `Task.pushToolResultToUserContent()` already enforce exactly-once semantics per call identifier?

**Answer: YES — exactly-once per `tool_use_id` is fully enforced today.**

Evidence from [`Task.pushToolResultToUserContent()`](../../../src/core/task/Task.ts:389):

```text
389  public pushToolResultToUserContent(toolResult: Anthropic.ToolResultBlockParam): boolean {
390      const existingResult = this.userMessageContent.find(
391          (block): block is Anthropic.ToolResultBlockParam =>
392              block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
393      )
394      if (existingResult) {
395          console.warn(...Skipping duplicate...)
396          return false
397      }
398      this.userMessageContent.push(toolResult)
399      return true
400  }
```

- Dedup key is strictly `tool_use_id`, not tool name — matches the architect's edge-case requirement "two malformed calls share a tool name but have distinct identifiers."
- On duplicate, the retained first result is **not modified** and the method returns `false`. This matches the architect's acceptance item 7 in the Final Acceptance Scenario.
- The dispatcher already routes malformed-call error results through this method (e.g. [`presentAssistantMessage.ts:140`](../../../src/core/assistant-message/presentAssistantMessage.ts:140), `:493`, `:1210`), so the plan's "one error result per failed identifier" guarantee inherits an existing enforcement point rather than introducing a new one.

**No architectural change needed here.** The plan correctly treats this method as an invariant to preserve, not a defect to fix. Task 9's integration test can invoke the real prototype method against a minimal fixture as proposed.

**Risk R2 (LOW):** `pushToolResultToUserContent` is an instance method on a class with ~4,700 lines and heavy constructor dependencies. Task 9 proposes "invoking the prototype method against a minimal typed task fixture." This is viable (`Task.prototype.pushToolResultToUserContent.call({ userMessageContent: [] }, result)`), because the method touches only `this.userMessageContent`. The test author must ensure the fixture is typed narrowly (a `Pick<Task, "userMessageContent">` cast through `unknown`) to satisfy REQ-005's no-new-`as any` rule.

---

## Question 3: Are the proposed new categories (`TOOL_NOT_FOUND`, `MODE_RESTRICTION`, `FILE_RESTRICTION`) compatible with the existing `ErrorCategory` type union?

**Answer: YES — compatible, but two compile-time and one test-time touchpoints must be updated atomically with the union extension.**

Evidence from [`types.ts:12-23`](../../../src/core/tools/error-interception/types.ts:12): `ErrorCategory` is a closed string-literal union of 11 members. Adding three members is a pure type-widening change with no runtime representation cost. The state containers are already key-agnostic:

- [`TaskErrorState.perCategory`](../../../src/core/tools/error-interception/TaskErrorState.ts:35) is `Map<string, CategoryState>` — accepts any category string.
- [`InterceptorTaskState.categoryCounts`](../../../src/core/tools/error-interception/ToolErrorInterceptor.ts:14) is `Map<ErrorCategory, number>` — accepts any union member.

**Blocker B1 (compile-time, mechanical):** [`MessageTransformer.ts:18`](../../../src/core/tools/error-interception/MessageTransformer.ts:18) declares `const CATEGORY_TITLES: Record<ErrorCategory, string>`. This is an **exhaustive** mapped record. Extending the union without adding `TOOL_NOT_FOUND`, `MODE_RESTRICTION`, `FILE_RESTRICTION` titles will fail `pnpm check-types`. The architect's Task 4 file list includes `MessageTransformer.ts` only under Task 5/7 — **Task 4 must also touch `CATEGORY_TITLES`**, otherwise the build breaks between Task 4 and Task 5. Recommend VP explicitly add `MessageTransformer.ts` (CATEGORY_TITLES only) to Task 4's scope.

**Blocker B2 (test-time, mechanical):** [`ErrorClassifier.spec.ts:470-472`](../../../src/core/tools/error-interception/__tests__/ErrorClassifier.spec.ts:470) asserts an exact `expected: ErrorCategory[]` list ("contains all user-requested categories plus UNCLASSIFIED"). Extending the union will fail this assertion until the expected list is updated. The architect's Task 4 includes this spec file, so it is covered — flagging only so the code agent does not mistake the failure for a regression.

**Compatibility confirmation:** The dispatcher already produces the metadata flags the new categories will consume — [`presentAssistantMessage.ts:843-849`](../../../src/core/assistant-message/presentAssistantMessage.ts:843) sets `modeRestriction`, `unknownTool`, and `fileRestriction` in `validationMetadata`. So the classifier's new exact patterns will have real signals to match against from day one; there is no chicken-and-egg gap between Tasks 4 and 8. (Note: the architect's plan also corrects the final unknown-tool branch's metadata at [`presentAssistantMessage.ts:1205-1214`](../../../src/core/assistant-message/presentAssistantMessage.ts:1205) from type-mismatch to `unknownTool` in Task 8 — confirmed that branch currently emits a generic message and needs the metadata fix.)

---

## Question 4: Is the 1,024-byte UTF-8 limit in `fitDetailsWithinByteLimit()` sufficient for the enhanced occurrence-aware guidance?

**Answer: YES — sufficient with margin, but the truncation cascade order should be reviewed against the new "first Next item is sacred" rule.**

Evidence from [`fitDetailsWithinByteLimit()`](../../../src/core/tools/error-interception/MessageTransformer.ts:225):

- Fixed envelope overhead measured from [`formatPayloadAsDetails()`](../../../src/core/tools/error-interception/MessageTransformer.ts:177): `<error_details>\n` (16) + `Type: ...` (~25) + `Category: ...` (~30) + `What: ` (6) + `Why: ` (5) + `Next:\n` (6) + `Retryable: false\n` (17) + `Pattern: EI/XXXXXXXXXXXX/NNN\n` (~30) + `Occurrence: NN\n` (~15) + `</error_details>` (17) ≈ **170 bytes of fixed overhead**.
- The proposed occurrence-aware content (per section 1.4 of the plan): a `what` of ~110 bytes, a `why` of ~90 bytes, and two `next` items of ~90 bytes each ≈ **~380 bytes of variable content**.
- Total ~550 bytes — comfortably inside 1,024. Even the occurrence-3 `change_strategy` variant with stronger non-repeat prose stays under ~700 bytes.

**Risk R3 (MEDIUM — wording, not sizing):** The truncation cascade at lines 232-252 iterates `nextCount` from full down to 0, and for each `nextCount` tries `why` truncation (80/50/30) then `what` truncation (120/80/50/30). This means **the second Next item (the non-repeat constraint) is dropped before `why` is truncated**. The plan's section 1.4 rule 3-4 states the first Next item is the executable continuation and the second is the non-repeat constraint. Under pressure, the current cascade sacrifices the non-repeat constraint first — which is the architecturally preferred outcome (continuation action survives), but the plan should state this explicitly so Task 7's snapshot tests encode the intended priority: **continuation action > what > why > non-repeat constraint**. If the architect intended the non-repeat constraint to outrank `why` truncation, the cascade order needs a small change in Task 7.

No sizing change is needed; the 1,024-byte default in [`types.ts:127-128`](../../../src/core/tools/error-interception/types.ts:127) (`byteLimit` default) and `MODEL_PAYLOAD_BYTE_LIMIT` remains correct.

---

## Question 5: Can the coordinated reset API be implemented without breaking existing test contracts?

**Answer: YES — the seam exists and all three existing reset contracts remain satisfiable.**

Current structural facts:

1. **Two decoupled state owners confirmed.** [`ToolErrorInterceptor`](../../../src/core/tools/error-interception/ToolErrorInterceptor.ts:104) holds `categoryCounts` + `shellCircuitOpen` per task. [`TaskErrorState`](../../../src/core/tools/error-interception/TaskErrorState.ts:34) holds per-category `{occurrence, fingerprint, isOpen}`. `ToolErrorInterceptor.ts` has **zero imports** from `TaskErrorState.ts` today (verified by search — no matches), so there is no existing coordination.
2. **Counter drift confirmed.** [`presentAssistantMessage.ts:744-746`](../../../src/core/assistant-message/presentAssistantMessage.ts:744) resets only `TaskErrorState` on fingerprint change (`taskErrorState.reset("PARAM_TYPE_MISMATCH")`); the interceptor's own counter for the same category is untouched. The architect's issue #2 is real.
3. **The coordination seam is cheap.** [`getTaskErrorState(task)`](../../../src/core/tools/error-interception/TaskErrorState.ts:151) is an exported module-level accessor keyed by the same task object that `resetTaskState(task, ...)` already receives. Coordinated reset = one added import + one added call inside [`ToolErrorInterceptor.resetTaskState()`](../../../src/core/tools/error-interception/ToolErrorInterceptor.ts:104):
    - category branch: also call `getTaskErrorState(task).reset(category)`, and if `category === "SHELL_INTEGRATION"` also set `taskState.shellCircuitOpen = false`.
    - full branch: also call `getTaskErrorState(task).reset()`.
      No constructor or wiring change in `Task.ts` is needed. No import cycle: `TaskErrorState.ts` imports nothing from the interceptor module.

**Existing test contract compatibility (verified against [`ToolErrorInterceptor.spec.ts:347-420`](../../../src/core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts:347)):**

| Existing test                                          | Assertion                                                                                  | Compatible?                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "clears category counts and closes circuit" (line 348) | After full `resetTaskState(task)`, next shell error renders `Occurrence: 1`                | YES — coordinated full reset keeps this true.                                                                                                                                                                                                                                                                |
| "returns early when task has no state" (line 377)      | `expect(() => interceptor.resetTaskState(task)).not.toThrow()`                             | YES — but see Risk R4 below.                                                                                                                                                                                                                                                                                 |
| "resets only the specified category" (line 384)        | After category reset, SHELL restarts at occurrence 1, FILE_NOT_FOUND stays at occurrence 2 | YES — the test triggers only ONE shell error (below `SHELL_CIRCUIT_THRESHOLD`), so the circuit is never open; adding "close shellCircuitOpen on category reset" cannot change this test's outcome. Category isolation in `TaskErrorState.reset(category)` (line 105-111) preserves the FILE_NOT_FOUND count. |

**Risk R4 (LOW — semantic change in a no-op path):** The "returns early when task has no state" test currently passes because `resetTaskState` returns early when `this.state.perTask.get(task)` is undefined (line 105-106). If the coordinated version calls `getTaskErrorState(task).reset(...)` unconditionally, `getTaskErrorState` **creates** a `TaskErrorState` on demand — a subtle behavior change (state materialization on reset). The `.reset()` itself is still a no-throw no-op on an empty map, so the test still passes, but the cleaner implementation is to keep the early return and only coordinate when interceptor state exists, OR to use a non-creating lookup. Task 6 should specify which. Note that `TaskErrorState.spec.ts` (lines 96-121) tests `TaskErrorState.reset` in isolation and is unaffected.

---

## Risks Not Explicitly Covered by the Architect

| ID  | Severity             | Risk                                                                                                                                                                 | Recommended handling                                                                                                                                          |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | LOW                  | Dynamic MCP tool parse failures (`parseDynamicMcpTool`, line 1084) keep legacy string side channel if the typed descriptor is core-tools-only.                       | Pin the MCP boundary in Task 3 acceptance criteria; architect's risk table implies out-of-scope, make it explicit.                                            |
| R2  | LOW                  | Task 9's "minimal typed task fixture" for the real `Task.prototype.pushToolResultToUserContent` must avoid `as any` per REQ-005.                                     | Use a `Pick<Task, "userMessageContent">` cast through `unknown`, or a dedicated narrow interface.                                                             |
| R3  | MEDIUM               | Byte-limit truncation cascade drops the second Next item (non-repeat constraint) before truncating `why`. The plan's rule 3-4 priority should be encoded explicitly. | In Task 7, snapshot-test the intended priority order: continuation action > what > why > non-repeat constraint. Adjust cascade if the intended order differs. |
| R4  | LOW                  | Coordinated reset changes `resetTaskState` no-op semantics: `getTaskErrorState` materializes state on reset.                                                         | Keep the existing early return, or use a non-creating `TaskErrorState` lookup. Specify in Task 6.                                                             |
| B1  | BLOCKER (mechanical) | `CATEGORY_TITLES: Record<ErrorCategory, string>` is exhaustive; Task 4 breaks the build unless it also adds the three new titles.                                    | Add `MessageTransformer.ts` (CATEGORY_TITLES only) to Task 4 scope.                                                                                           |
| B2  | BLOCKER (mechanical) | `ErrorClassifier.spec.ts:470` asserts the exact category list; fails the moment the union widens.                                                                    | Already in Task 4's file scope — flag as expected-test-update, not a regression.                                                                              |

Both blockers are mechanical with known one-line resolutions and do not invalidate the architecture. They are sequencing hazards, not design flaws.

---

## Result

**FEASIBLE — proceed to code delegation.** All five architectural premises verified against source. The recommended Option A stands. Before delegating, VP should:

1. Amend Task 4 scope to include `CATEGORY_TITLES` in [`MessageTransformer.ts`](../../../src/core/tools/error-interception/MessageTransformer.ts:18) (B1).
2. Note in Task 4 that the `ErrorClassifier.spec.ts:470` expected-list update is anticipated (B2).
3. Pin the MCP dynamic-tool boundary in Task 3 acceptance (R1).
4. Specify the no-op-path semantics for coordinated reset in Task 6 (R4).
5. Encode the Next-item truncation priority in Task 7 acceptance (R3).

## Issues Discovered

1. Parser conflation at [`NativeToolCallParser.ts:1061-1076`](../../../src/core/assistant-message/NativeToolCallParser.ts:1061) confirmed — single catch for both `JSON.parse` (line 730) and schema throw (line 1035).
2. Exactly-once per `tool_use_id` at [`Task.ts:389-402`](../../../src/core/task/Task.ts:389) confirmed — no change needed.
3. `ErrorCategory` union extension requires atomic updates to `CATEGORY_TITLES` (B1) and the classifier spec's expected list (B2).
4. 1,024-byte budget has ~2x headroom for the proposed guidance; truncation priority needs explicit specification (R3).
5. Coordinated reset seam exists via [`getTaskErrorState(task)`](../../../src/core/tools/error-interception/TaskErrorState.ts:151); all three existing reset test contracts remain satisfiable (R4).
6. Counter drift between the two state owners confirmed at [`presentAssistantMessage.ts:744-746`](../../../src/core/assistant-message/presentAssistantMessage.ts:744).

## Next Step Recommendations

- VP: apply the five pre-delegation amendments above, then proceed with Tasks 1-10 in the architect's stated order.
- No re-architecture needed. No escalation needed.
- Code mode should receive the amended task contracts, not this full report.

## Affected File List (inspection only — none modified)

- [`src/core/assistant-message/NativeToolCallParser.ts`](../../../src/core/assistant-message/NativeToolCallParser.ts)
- [`src/core/assistant-message/presentAssistantMessage.ts`](../../../src/core/assistant-message/presentAssistantMessage.ts)
- [`src/core/task/Task.ts`](../../../src/core/task/Task.ts)
- [`src/core/tools/error-interception/types.ts`](../../../src/core/tools/error-interception/types.ts)
- [`src/core/tools/error-interception/MessageTransformer.ts`](../../../src/core/tools/error-interception/MessageTransformer.ts)
- [`src/core/tools/error-interception/TaskErrorState.ts`](../../../src/core/tools/error-interception/TaskErrorState.ts)
- [`src/core/tools/error-interception/ToolErrorInterceptor.ts`](../../../src/core/tools/error-interception/ToolErrorInterceptor.ts)
- [`src/core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts`](../../../src/core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts)
- [`src/core/tools/error-interception/__tests__/TaskErrorState.spec.ts`](../../../src/core/tools/error-interception/__tests__/TaskErrorState.spec.ts)
- [`src/core/tools/error-interception/__tests__/ErrorClassifier.spec.ts`](../../../src/core/tools/error-interception/__tests__/ErrorClassifier.spec.ts)
