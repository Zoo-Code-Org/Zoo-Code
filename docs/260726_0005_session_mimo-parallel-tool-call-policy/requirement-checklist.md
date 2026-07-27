# Requirement Checklist

## Task: MiMo v2.5 Pro Parallel Tool Call Policy Fix (Option A)

## Date: 260726

## Branch: fix/mimo-parallel-tool-call-policy

## Session: 260726_0005_session_mimo-parallel-tool-call-policy

## Architect Report: docs/260726_0004_session_pr-review-fixes/052538_architect-research-parallel-toolcall.md

### Scope: Option A — Full Implementation (6 Sub-tasks)

---

## Sub-task 1: Model-level tool-call capability + policy resolution

- [ ] [REQ-001] Define `ToolCallGenerationPolicy`, `ModelToolCallCapabilities`, `ResolvedToolCallPolicy` types in `packages/types/src/model.ts`
- [ ] [REQ-002] Define MiMo capability as `supportsParallelToolCalls: false` in `packages/types/src/providers/mimo.ts`
- [ ] [REQ-003] Create pure policy resolver in `src/api/index.ts` that resolves capability → policy
- [ ] [REQ-004] Replace all 4 hardcoded `parallelToolCalls: true` in `src/core/task/Task.ts` with resolver output
- [ ] [REQ-005] Unit tests: MiMo→single, OpenAI/Anthropic→parallel, unknown→conservative

## Sub-task 2: MiMo provider request controls with endpoint fallback

- [ ] [REQ-006] MiMo adapter honors `metadata.tool_choice` in `src/api/providers/mimo.ts`
- [ ] [REQ-007] Send `parallel_tool_calls: false` when policy=single and endpoint permits
- [ ] [REQ-008] Fallback: retry once without the field if endpoint rejects it
- [ ] [REQ-009] Provider unit tests assert false/true/omitted-field behavior

## Sub-task 3: Pre-retention ghost quarantine + local max-one enforcement

- [ ] [REQ-010] Quarantine provably empty raw calls (no name + no non-whitespace args) before history
- [ ] [REQ-011] Under single-call policy: select at most one structurally valid call for execution
- [ ] [REQ-012] Named/non-empty siblings retained as protocol-visible error results
- [ ] [REQ-013] No valid sibling executed twice; all retained IDs get exactly one result
- [ ] [REQ-014] StreamedCallDisposition type: retain, drop-provably-empty, retain-as-error

## Sub-task 4: execute_command argument normalization + nullable cwd

- [ ] [REQ-015] Validate decoded runtime types before constructing typed nativeArgs
- [ ] [REQ-016] Resolve nullable cwd contract: either omit from required OR normalize null→undefined
- [ ] [REQ-017] Object-valued cwd remains a typed parser/preflight failure, never an executable value
- [ ] [REQ-018] Test cases: string, omitted, null, empty string, array, object with command/path, primitive non-string

## Sub-task 5: Observability and rollout controls

- [ ] [REQ-019] Record provider, model, policy source, call count, disposition, structural fingerprint
- [ ] [REQ-020] No raw command/path/file content/tool arguments/API key in telemetry
- [ ] [REQ-021] Rollout flag for MiMo single-call enforcement (default-safe=single)

## Sub-task 6: End-to-end regression validation

- [ ] [REQ-022] MiMo returns/retains no more than one executable call
- [ ] [REQ-023] OpenAI/Anthropic parallel-capable fixtures still retain multiple independent calls
- [ ] [REQ-024] Tool history remains valid after malformed sibling
- [ ] [REQ-025] Full quality gate: pnpm lint + pnpm check-types + pnpm test pass

## Cross-cutting Invariants (from architect report section 1.5)

- [ ] [REQ-026] A call may be silently dropped only before insertion into assistantMessageContent and history
- [ ] [REQ-027] drop-provably-empty requires: unique ID + no resolved name + no non-whitespace arg fragment
- [ ] [REQ-028] A named call or call with any argument bytes is retained and receives a result
- [ ] [REQ-029] No field is repaired from a nested command-like object
- [ ] [REQ-030] Provider-specific behavior preserved for OpenAI and Anthropic
