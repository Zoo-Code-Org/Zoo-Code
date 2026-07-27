# Debug Technical Review: MiMo Parallel Tool Call Policy

## Task Summary

Technical review of Option A implementation (MiMo v2.5 Pro parallel tool-call corruption fix) across 7 files. Reviewed for correctness against the architect's specification, edge cases, regression risk, type safety, and test coverage. **No code was modified.**

## Verdict

**APPROVE WITH CONCERNS.** The implementation faithfully realizes Option A's core invariants and is safe to ship behind the existing telemetry. However, there are several edge-case gaps and one conservative-default policy decision with broad regression implications that VP must explicitly accept before merge.

---

## 1. Correctness vs Architect Specification

### Acceptance criteria audit (spec §2.6)

| #   | Criterion                                                                           | Status                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | MiMo Task request resolves to `maxCallsPerTurn=1`                                   | ✅ Pass                   | [`resolveToolCallPolicy()`](src/api/index.ts:166) Case 1 returns `maxCallsPerTurn: 1` for `supportsParallelToolCalls: false` (set in [`packages/types/src/providers/mimo.ts`](packages/types/src/providers/mimo.ts:40)). Wired at all 4 Task paths: [`Task.ts:1614`](src/core/task/Task.ts:1614), [`Task.ts:4016`](src/core/task/Task.ts:4016), [`Task.ts:4256`](src/core/task/Task.ts:4256), [`Task.ts:4420`](src/core/task/Task.ts:4420). |
| 2   | OpenAI/Anthropic capable models retain parallel behavior                            | ⚠️ **CONDITIONAL**        | Only if their `ModelInfo` declares `supportsParallelToolCalls: true` with a known `parallelToolCallsRequestControl`. See **Finding R1** — unknown/absent capabilities now resolve to conservative `single`, which silently disables parallelism for any model not explicitly annotated.                                                                                                                                                     |
| 3   | MiMo endpoint rejecting `parallel_tool_calls` still completes via local enforcement | ✅ Pass                   | [`mimo.ts:146`](src/api/providers/mimo.ts:146) `isParallelToolCallsRejected` + retry-once-without-field fallback. Local max-one gate is independent.                                                                                                                                                                                                                                                                                        |
| 4   | No object-valued `cwd` reaches `ExecuteCommandTool.execute`                         | ✅ Pass                   | [`NativeToolCallParser.ts:976-987`](src/core/assistant-message/NativeToolCallParser.ts:976) throws `invalid_argument_shape` before `nativeArgs` construction.                                                                                                                                                                                                                                                                               |
| 5   | No nested command reinterpreted as directory or executed                            | ✅ Pass                   | Rejection, not repair — matches spec.                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | Every retained call ID receives exactly one result                                  | ✅ Pass                   | Ghosts are dropped only _before_ retention; named/malformed calls flow through existing error paths; max-one rejection pushes exactly one `tool_result` via [`pushToolResultToUserContent`](src/core/assistant-message/presentAssistantMessage.ts:717) which dedups by ID.                                                                                                                                                                  |
| 7   | Valid sibling executes at most once                                                 | ✅ Pass                   | Max-one gate rejects _all_ candidates when ≥2 valid calls (neither executes); a single valid candidate executes once in normal serial flow.                                                                                                                                                                                                                                                                                                 |
| 8   | Unnamed, argument-free ghost absent from history + redacted telemetry               | ✅ Pass                   | [`Task.ts:2919-2965`](src/core/task/Task.ts:2919) splices the partial block and discards streaming state; [`emitGhostDropTelemetry`](src/core/assistant-message/ToolCallRetentionPolicy.ts:239) sends counts/metadata only.                                                                                                                                                                                                                 |
| 9   | Named empty `{}` call remains visible as typed error                                | ✅ Pass                   | [`classifyStreamedCall`](src/core/assistant-message/ToolCallRetentionPolicy.ts:80) returns `retain` for named `{}`; existing parser/preflight error path produces the result. Test at [`ToolCallRetentionPolicy.spec.ts:63`](src/core/assistant-message/__tests__/ToolCallRetentionPolicy.spec.ts:63).                                                                                                                                      |
| 10  | `cwd: null` contract consistent                                                     | ✅ Pass (Option 2 chosen) | `null` normalized to `undefined` at both partial ([`NativeToolCallParser.ts:625-630`](src/core/assistant-message/NativeToolCallParser.ts:625)) and finalize ([`NativeToolCallParser.ts:1004`](src/core/assistant-message/NativeToolCallParser.ts:1004)) stages.                                                                                                                                                                             |

**Correctness conclusion:** 9/10 fully pass; #2 is conditional on annotation coverage (see R1).

---

## 2. Edge Cases

### 2.1 Ghost quarantine

- ✅ **Stream-not-ended**: ghosts can only drop after `streamEnded: true` — prevents dropping a call whose name arrives in a later delta. Tested at [`ToolCallRetentionPolicy.spec.ts:52`](src/core/assistant-message/__tests__/ToolCallRetentionPolicy.spec.ts:52).
- ✅ **Parse failure present**: `parseFailure` short-circuits to `retain-as-error` even with no name/args, so a structurally-classified failure is never silently dropped.
- ✅ **Splice re-indexing**: after removing the ghost's partial block, [`Task.ts:2933-2937`](src/core/task/Task.ts:2933) decrements all subsequent `streamingToolCallIndices` entries — correct.
- ⚠️ **E1 — Ghost drop loses `userMessageContentReady` semantics**: when a ghost is dropped via `continue` ([`Task.ts:2965`](src/core/task/Task.ts:2965), [`Task.ts:3455`](src/core/task/Task.ts:3455)), `userMessageContentReady` is not reset and `presentAssistantMessageSafe()` is not called. This is intentional per the comment ("nothing to present for a ghost"), but if the ghost was the _only_ streamed block in the turn, the turn-end logic relies on the surrounding "finalize remaining blocks" loop ([`Task.ts:3391-3399`](src/core/task/Task.ts:3391)) to mark blocks complete. For a pure-ghost turn (no content blocks at all), verify the task loop still terminates rather than waiting on a block that was spliced out. The comment at [`Task.ts:3393`](src/core/task/Task.ts:3393) suggests this is handled, but there is no dedicated test for a turn consisting solely of ghost calls.
- ⚠️ **E2 — Duplicate `tool_call_start` with later ghost**: the duplicate-start guard at [`Task.ts:2831`](src/core/task/Task.ts:2831) ignores the second start. If the _first_ registration later becomes a ghost, the splice path is fine; but if a duplicate-start ID never enters `streamingToolCallIndices`, `ghostIndex` is `undefined` and only `discardStreamingToolCall` runs — safe, no crash. Acceptable.

### 2.2 Max-one enforcement

- ✅ **Two valid side-effecting calls**: neither executes; both get error results — matches spec §2.4 "First call is malformed, second call is valid" and "Two valid read-only calls".
- ✅ **Single valid candidate**: executes normally (`executableCallId` set, `rejectedCallIds` empty).
- ✅ **Zero valid candidates**: no-op; existing malformed-call handling owns the error path.
- ⚠️ **E3 — Policy re-resolution per block**: [`presentAssistantMessage.ts:635`](src/core/assistant-message/presentAssistantMessage.ts:635) calls `resolveToolCallPolicy` and rebuilds `allCalls` for _every_ non-partial block. This is O(n²) in calls-per-turn and, more importantly, means the selection is recomputed as blocks transition from partial to complete. The comment at [`presentAssistantMessage.ts:727-735`](src/core/assistant-message/presentAssistantMessage.ts:727) acknowledges the reasoning (serial order + rejection list covers both), and the logic holds _because_ `selectExecutableCall` under `maxCallsPerTurn: 1` either (a) rejects all valid candidates or (b) selects exactly one and rejects none. In case (b), the selected call executes when its block is processed; other _invalid_ blocks are handled upstream. The invariant is preserved, but a brief comment explaining why per-block recomputation cannot double-execute (namely: `hasToolResult` dedup + the fact that only one candidate can be non-rejected) would harden maintainability.
- ⚠️ **E4 — `isPartial` inclusion in `allCalls`**: [`allCalls` includes partial blocks](src/core/assistant-message/presentAssistantMessage.ts:644) (`isPartial: b.partial`). `selectExecutableCall` correctly filters them out of candidacy, so a still-streaming sibling does not affect the current block's selection. Correct, but note that when the sibling later completes, the gate re-runs and both become candidates — at which point _both_ are rejected. This is the intended strict behavior.

---

## 3. Regression Risk

### 🔴 R1 — Conservative default flips unknown models to single-call (BROAD IMPACT)

[`resolveToolCallPolicy`](src/api/index.ts:199) Case 3 returns `generation: "single", maxCallsPerTurn: 1` for **any model without explicit `toolCallCapabilities`**. The spec's Case 2 requires _both_ `supportsParallelToolCalls: true` _and_ a known request control for parallel. This means:

- Any OpenAI/Anthropic model whose `ModelInfo` lacks the new annotation silently loses parallel tool calls (behavior changes from `parallelToolCalls: true` hardcoded → `false`).
- This directly conflicts with acceptance criterion #2 unless **every** parallel-capable model in the registry is annotated.

**VP must verify**: do the OpenAI and Anthropic model registries declare `supportsParallelToolCalls: true` + request control for all parallel-capable models? If not, this is a **release-blocking regression** that changes behavior for providers unrelated to MiMo. The architect's spec (§1.5) listed `source: "provider-default"` as an option, and criterion #2 says capable models "retain current parallel behavior **unless configured otherwise**" — the current default _is_ a configuration change for unannotated models.

### 🟡 R2 — `providerName` parameter is dead

[`resolveToolCallPolicy(modelInfo, providerName?)`](src/api/index.ts:166) accepts `providerName` but never reads it. All four Task call sites pass `this.apiConfiguration.apiProvider`. This is harmless (pure function, no side effects) but misleading — future maintainers may assume provider-specific branches exist. Either use it (e.g., provider-level overrides) or remove it.

### 🟡 R3 — MiMo `parallelToolCallsRequestControl: "none"` vs Sub-task 2 intent

[`packages/types/src/providers/mimo.ts:42`](packages/types/src/providers/mimo.ts:42) sets `parallelToolCallsRequestControl: "none"` with a comment saying it "will be updated to 'openai' in Sub-task 2 after a provider canary confirms." Sub-task 2 _did_ implement the wire send ([`mimo.ts:135`](src/api/providers/mimo.ts:135)) gated on `metadata.parallelToolCalls !== undefined`, with a rejection fallback. But because the capability is `"none"`, [`resolveToolCallPolicy`](src/api/index.ts:171) returns `enforcement: "local"` (not `"provider-and-local"`). The wire field is still sent (metadata drives it), so behavior is correct; the telemetry `enforcement` value will just read `"local"` until the canary confirms and the annotation flips. **Acceptable as a staged rollout, but the pending canary must be tracked** — otherwise the conservative `"none"` becomes permanent by inertia.

### 🟢 R4 — Legacy `tool_call` chunk path

The legacy branch ([`Task.ts:3018-3066`](src/core/task/Task.ts:3024)) applies the same ghost classification before `parseToolCall`. Consistent with the streaming path. No regression.

---

## 4. Type Safety

- ✅ `StreamedCallDisposition` is a proper discriminated union on `kind` — narrowing works in tests and at call sites.
- ✅ `ModelToolCallCapabilities` uses a Zod schema ([`modelToolCallCapabilitiesSchema`](packages/types/src/model.ts:81)) with `z.infer` — runtime-validated at the types boundary.
- ⚠️ **T1 — `(finalToolUse as any).id = event.id`** at [`Task.ts:2976`](src/core/task/Task.ts:2976) and [`Task.ts:3466`](src/core/task/Task.ts:3466), and `(existingToolUse as any).id` at [`Task.ts:3000`](src/core/task/Task.ts:3000). These `as any` casts pre-date this change (native protocol ID attachment), but the new code adds more of them. Not a new risk introduced here, yet worth noting: `ToolUse.id` should be a typed optional field rather than an `any`-cast attachment.
- ⚠️ **T2 — `(cline as unknown as { apiConfiguration?: ... })`** at [`presentAssistantMessage.ts:637`](src/core/assistant-message/presentAssistantMessage.ts:637) and [`presentAssistantMessage.ts:677`](src/core/assistant-message/presentAssistantMessage.ts:677). This double-cast through `unknown` is an unsafe escape hatch to reach `apiConfiguration.apiProvider`. If the property shape changes, this fails silently at runtime (returns `undefined` → provider becomes `"unknown"`). Recommend surfacing a typed accessor on the `cline` interface.
- ✅ Telemetry inputs are strongly typed interfaces ([`GhostDropTelemetryInput`](src/core/assistant-message/ToolCallRetentionPolicy.ts:203), [`MaxOneEnforcementTelemetryInput`](src/core/assistant-message/ToolCallRetentionPolicy.ts:261)) — no raw user data fields exist to leak.

---

## 5. Test Coverage

Test files present:

- [`ToolCallRetentionPolicy.spec.ts`](src/core/assistant-message/__tests__/ToolCallRetentionPolicy.spec.ts) — unit tests for `classifyStreamedCall` (ghost/named/args/parse-failure/stream-open cases) and `selectExecutableCall`.
- [`ToolCallRetentionPolicy-telemetry.spec.ts`](src/core/assistant-message/__tests__/ToolCallRetentionPolicy-telemetry.spec.ts) — telemetry redaction.
- Existing `NativeToolCallParser.spec.ts`, `presentAssistantMessage-error-interception.spec.ts`, `presentAssistantMessage-parser-dedup.integration.spec.ts` updated per sub-task reports.

**Coverage gaps:**

- 🟡 **C1 — No integration test for a pure-ghost turn** (see E1). The ghost unit tests cover classification, but the Task-level splice + loop-termination path for a turn containing _only_ ghost calls is not asserted end-to-end.
- 🟡 **C2 — No test asserting OpenAI/Anthropic models still resolve parallel** (acceptance #2 / R1). If such a test existed, the R1 annotation-coverage question would already be answered. This is the single most important missing test.
- 🟡 **C3 — MiMo `parallel_tool_calls` rejection-fallback** ([`mimo.ts:146-150`](src/api/providers/mimo.ts:146)) — confirm `mimo.spec.ts` covers the retry-without-field branch and the `isParallelToolCallsRejected` true/false paths (including the `status === 400 && "unrecognized"` heuristic, which could false-positive on unrelated 400s). The heuristic matches the spec's "Do not treat arbitrary provider errors as evidence that the field is unsupported" loosely — a 400 containing "unrecognized" for a _different_ field would trigger an unnecessary (but harmless) retry.
- ✅ Max-one multi-call rejection, single-candidate, and unbounded paths appear covered in `ToolCallRetentionPolicy.spec.ts`.

---

## 6. Issues Discovered (Summary)

| ID  | Severity            | Issue                                                                                                                                       |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 🔴 High (potential) | Conservative default (`single`) applies to ALL unannotated models; may disable OpenAI/Anthropic parallelism if registries aren't annotated. |
| R2  | 🟡 Low              | `providerName` param of `resolveToolCallPolicy` is unused.                                                                                  |
| R3  | 🟡 Low              | MiMo `parallelToolCallsRequestControl: "none"` pending canary; telemetry reads `enforcement: "local"` until flipped.                        |
| T1  | 🟡 Low              | `as any` casts for `ToolUse.id` attachment (pre-existing pattern, extended).                                                                |
| T2  | 🟡 Low              | Unsafe `as unknown as` cast to reach `apiConfiguration.apiProvider` in `presentAssistantMessage.ts`.                                        |
| E1  | 🟡 Low              | Pure-ghost turn loop-termination not covered by a dedicated test.                                                                           |
| E3  | 🟢 Info             | Per-block policy re-resolution is O(n²) and subtly depends on rejection-list invariant; add clarifying comment.                             |
| C2  | 🟡 Low              | Missing test asserting capable models retain parallel (would resolve R1).                                                                   |

**No critical correctness defects found.** The core ghost-quarantine and max-one invariants are correctly implemented and match the architect's specification.

---

## 7. Next Step Recommendations

1. **(Blocking question for VP/CPO)** Verify whether OpenAI and Anthropic model registries declare `toolCallCapabilities` for all parallel-capable models. If not, either (a) annotate them, or (b) change Case 3 default to preserve prior `parallel` behavior for the known parallel providers and only force `single` for explicitly-marked models. This resolves R1 and closes acceptance criterion #2.
2. Add a regression test: "OpenAI/Anthropic capable model resolves `generation: 'parallel'`" (closes C2).
3. Add an integration test for a pure-ghost assistant turn to confirm task-loop termination (closes C1/E1).
4. Track the MiMo endpoint canary; flip `parallelToolCallsRequestControl` to `"openai"` on confirmation (closes R3).
5. Non-blocking cleanup: remove or use the `providerName` param (R2); replace the `as unknown as` cast with a typed accessor (T2); add the E3 clarifying comment.

## Affected File List (Reviewed)

- [`src/core/assistant-message/ToolCallRetentionPolicy.ts`](src/core/assistant-message/ToolCallRetentionPolicy.ts) (NEW)
- [`src/core/task/Task.ts`](src/core/task/Task.ts)
- [`src/core/assistant-message/presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts)
- [`src/api/providers/mimo.ts`](src/api/providers/mimo.ts)
- [`src/core/assistant-message/NativeToolCallParser.ts`](src/core/assistant-message/NativeToolCallParser.ts)
- [`packages/types/src/model.ts`](packages/types/src/model.ts)
- [`packages/types/src/providers/mimo.ts`](packages/types/src/providers/mimo.ts)
- [`src/api/index.ts`](src/api/index.ts) (`resolveToolCallPolicy`)
- [`packages/telemetry/src/TelemetryService.ts`](packages/telemetry/src/TelemetryService.ts) (`captureToolCallEnforcement` — confirmed exists)

## Test Environment Issues

None encountered. This was a static review; no tests were executed and no environment setup was required.
