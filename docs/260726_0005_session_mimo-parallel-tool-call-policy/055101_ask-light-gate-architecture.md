# Ask Light Gate Report: Architecture Intent Verification

## Task Summary

Light Gate verification of the architect research report for MiMo v2.5 Pro parallel tool call policy fix (Option A) against the user's original intent ("이걸 읽고 이 문제를 해결해줘" / "Read this and solve this problem").

## Verification Scope

- **Architect Report**: [`052538_architect-research-parallel-toolcall.md`](../260726_0004_session_pr-review-fixes/052538_architect-research-parallel-toolcall.md)
- **Requirement Checklist**: [`requirement-checklist.md`](requirement-checklist.md)
- **User Intent**: Solve the MiMo malformed parallel tool call problem; user approved Option A (6 sub-tasks), branch `fix/mimo-parallel-tool-call-policy`

---

## [1. Intent Alignment Verification]

### Root Cause → Solution Mapping

The architect identified two root causes:

| Root Cause                                                       | Option A Fix                                                       | Sub-task                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------- |
| Task layer hardcodes `parallelToolCalls: true` for all providers | Replace with capability-driven policy resolver                     | Sub-task 1 (REQ-003, REQ-004) |
| MiMo adapter ignores both `parallelToolCalls` and `tool_choice`  | Wire adapter to honor metadata + send `parallel_tool_calls: false` | Sub-task 2 (REQ-006, REQ-007) |

**Verdict**: Option A directly addresses both root causes. The defense-in-depth design (provider prevention + local max-one enforcement + structural validation) ensures the problem is solved at the source, not just contained downstream.

### User Intent Coverage

The user's request was "solve this problem" — broad but clear: fix MiMo's malformed parallel tool calls. The solution covers:

- ✅ **Prevention**: Capability-driven single-call policy for MiMo (Sub-tasks 1-2)
- ✅ **Containment**: Local max-one retention gate as fallback (Sub-task 3)
- ✅ **Hardening**: Argument type validation, object-valued `cwd` rejection (Sub-task 4)
- ✅ **Observability**: Telemetry for policy source, call count, disposition (Sub-task 5)
- ✅ **Validation**: End-to-end regression across providers (Sub-task 6)

No gap between "solve this problem" and the proposed solution scope.

---

## [2. Sub-task Scoping and Ordering Verification]

### Dependency Chain

```
Sub-task 1 (types + resolver)
  ↓ metadata contract
Sub-task 2 (MiMo adapter wiring)
  ↓ maxCallsPerTurn exposed
Sub-task 3 (local max-one enforcement)
  ↓ (parallel, independent)
Sub-task 4 (argument normalization)
  ↓ depends on 1-4
Sub-task 5 (observability)
  ↓ depends on 1-5
Sub-task 6 (E2E regression)
```

**Verdict**: Ordering is correct. Each sub-task's prerequisites are satisfied by preceding sub-tasks. Sub-task 4 is correctly noted as independently executable but related to the same corruption pathway.

### Scoping Check

- Sub-task 1: Correctly limited to types + resolver + replacing 4 hardcoded paths. Does not touch stream parsing or dispatch. ✅
- Sub-task 2: Correctly limited to MiMo adapter + endpoint fallback. Does not add parser repair. ✅
- Sub-task 3: Correctly limited to pre-retention quarantine + max-one selection. Preserves valid siblings as errors. ✅
- Sub-task 4: Correctly limited to argument normalization + nullable `cwd` contract. Prohibits object-to-path repair. ✅
- Sub-task 5: Correctly limited to telemetry + rollout flag. Privacy constraints explicit. ✅
- Sub-task 6: Correctly limited to regression validation. Prefers package-local tests over e2e. ✅

---

## [3. Requirement Checklist vs. Architect Spec (1:1 Cross-Validation)]

| Architect Section               | Checklist Items   | Match       |
| ------------------------------- | ----------------- | ----------- |
| Sub-task 1 (§3.1)               | REQ-001 ~ REQ-005 | ✅ Complete |
| Sub-task 2 (§3.2)               | REQ-006 ~ REQ-009 | ✅ Complete |
| Sub-task 3 (§3.3)               | REQ-010 ~ REQ-014 | ✅ Complete |
| Sub-task 4 (§3.4)               | REQ-015 ~ REQ-018 | ✅ Complete |
| Sub-task 5 (§3.5)               | REQ-019 ~ REQ-021 | ✅ Complete |
| Sub-task 6 (§3.6)               | REQ-022 ~ REQ-025 | ✅ Complete |
| Cross-cutting Invariants (§1.5) | REQ-026 ~ REQ-030 | ✅ Complete |

### Key Type Definitions Captured

- `ToolCallGenerationPolicy` ("parallel" | "single" | "provider-default") → REQ-001 ✅
- `ModelToolCallCapabilities` (supportsParallelToolCalls, requestControl) → REQ-001 ✅
- `ResolvedToolCallPolicy` (generation, maxCallsPerTurn, enforcement, source) → REQ-001 ✅
- `StreamedCallDisposition` (retain, drop-provably-empty, retain-as-error) → REQ-014 ✅

### Edge Cases from §2.4 Covered

- Provider rejects `parallel_tool_calls` → REQ-008 (fallback retry) ✅
- Provider ignores the field → REQ-011 (local max-one gate) ✅
- First call malformed, second valid → REQ-011 (select first structurally valid) ✅
- Two valid read-only calls → REQ-011 (execute one, reject other) ✅
- Empty `{}` vs empty ghost → REQ-010, REQ-012 (distinction captured) ✅
- `cwd: null` contract → REQ-016 ✅

### Minor Observation (Non-blocking)

The architect's Sub-task 2 prerequisite mentions "canary credentials for pay-as-you-go and token-plan endpoints." The checklist captures the canary _behavior_ (REQ-007: send field when permitted; REQ-008: fallback if rejected) but does not explicitly list canary credential acquisition as a prerequisite step. This is a process note for VP delegation, not a spec gap — the technical requirements are fully covered.

---

## [4. Implementation Completeness Verification]

### What is present

- All 6 sub-tasks from the architect report are represented as checklist sections ✅
- All type definitions from §1.5 are captured as requirements ✅
- All edge cases from §2.4 are covered by specific requirements ✅
- All 10 audit acceptance criteria from §2.6 map to checklist items ✅
- Test commands and verification protocols are preserved in the architect report ✅

### What is missing

- Nothing material is missing from the checklist relative to the architect spec ✅

### What is unnecessary

- Nothing in the checklist exceeds or contradicts the architect spec ✅

---

## [5. User Impact Verification]

### What changes will the user see?

- MiMo v2.5 Pro will generate at most one tool call per model turn, eliminating the corrupted parallel call shape
- No more object-valued `cwd` reaching command execution
- Malformed calls receive typed error results instead of silent execution
- OpenAI and Anthropic models retain their current parallel tool call behavior

### Has the user experience improved?

- Yes. The root cause (malformed parallel generation) is prevented at the source, not just caught downstream
- Defense-in-depth ensures containment even if the provider ignores the policy field

### Unexpected side effects?

- None identified. The solution is scoped to MiMo-specific capability resolution and does not alter behavior for capable providers

---

## Final Verdict

**[Verdict]**: PASS ✅

**[Reason]**: Option A faithfully addresses both root causes (hardcoded `parallelToolCalls: true` and MiMo adapter ignoring policy metadata) through a defense-in-depth design: provider-level prevention, local max-one enforcement, and structural hardening. The 6 sub-tasks are correctly scoped with proper dependency ordering. The requirement checklist (REQ-001 ~ REQ-030) is a complete 1:1 mapping of the architect's specification, including all type definitions, edge cases, and cross-cutting invariants. No gap exists between the user's intent ("solve this problem") and the proposed solution. VP may proceed to delegate Sub-tasks 1 and 2 to Code mode.

---

## Affected File List

- `docs/260726_0005_session_mimo-parallel-tool-call-policy/055101_ask-light-gate-architecture.md` (this report)
