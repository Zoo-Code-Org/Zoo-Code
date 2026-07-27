# Architect Task Report: Error Interception PR Fix Plan

## Overview

This plan addresses all eight requirements in the authoritative [`requirement-checklist.md`](docs/260726_0004_session_pr-review-fixes/requirement-checklist.md). The recommended design keeps errors visible to the user, gives the model a bounded and sanitized recovery instruction, preserves exactly-once tool-result semantics, and avoids asking the user to approve repeated malformed calls that the system can safely reject.

The central defect is not merely weak wording. A valid JSON object with missing required fields, including an empty object, is stored by [`NativeToolCallParser.parseToolCall()`](src/core/assistant-message/NativeToolCallParser.ts:700) in the same string side channel as a JSON syntax failure. [`presentAssistantMessage()`](src/core/assistant-message/presentAssistantMessage.ts:78) consequently labels both cases as invalid JSON. The template then tells the model that it concatenated JSON objects even when the observed failure was a valid sibling call plus an empty sibling call. Because the guidance does not identify the rejected sibling, the successful sibling, or the correct continuation action, the model repeats the same mistake until the user is asked to intervene.

The fix should therefore use a typed parser-failure descriptor, exact structural classification, synchronized occurrence state, occurrence-aware instructions, and a real parser-to-task integration test. Static wording changes alone are not sufficient.

## Task Summary

- Mapped REQ-001 through REQ-008 to concrete components, contracts, and acceptance criteria.
- Traced the provider-to-parser-to-dispatcher-to-model recovery path and the separate user-visible error path.
- Compared exactly three implementation options and selected the standard typed-failure architecture.
- Divided implementation into narrow tasks with exact file scope, prerequisites, focused tests, and commands.
- Defined conflict-minimizing implementation order and final release gates.

## Actions Taken

- Inspected parser failure capture in [`NativeToolCallParser`](src/core/assistant-message/NativeToolCallParser.ts:53).
- Inspected dispatch, validation, structural fingerprints, and malformed-call handling in [`presentAssistantMessage()`](src/core/assistant-message/presentAssistantMessage.ts:78).
- Inspected classification in [`classifyError()`](src/core/tools/error-interception/ErrorClassifier.ts:166), patterns in [`ERROR_PATTERNS`](src/core/tools/error-interception/errorPatterns.ts:48), and rendering in [`transformErrorToMessage()`](src/core/tools/error-interception/MessageTransformer.ts:277).
- Inspected task-scoped state in [`TaskErrorState`](src/core/tools/error-interception/TaskErrorState.ts:1) and [`ToolErrorInterceptor`](src/core/tools/error-interception/ToolErrorInterceptor.ts:1).
- Inspected real deduplication in [`Task.pushToolResultToUserContent()`](src/core/task/Task.ts:389).
- Inspected current focused tests and the lint baseline in [`eslint-suppressions.json`](src/eslint-suppressions.json:617).
- Analyzed the supplied diagnostic, which showed a valid tool call accompanied by an empty sibling call and repeated unchanged guidance through occurrence 10.

# 1. Technical Specification

## 1.1 Goals and Core Constraints

1. Preserve clear error visibility. A rejected call must still be reported through the existing user-visible error channel. Model sanitization must not hide the original failure from the user or diagnostics.
2. Keep the model moving. Guidance must identify the failed invocation shape, state whether a valid sibling was retained, prohibit repetition of the bad shape, and provide a concrete continuation action.
3. Never execute malformed input. The middleware may reject or skip the malformed invocation, but it must not synthesize arguments, copy arguments from another call, or silently execute repaired input.
4. Preserve provider protocol integrity. Every provider tool-call identifier receives at most one retained tool result through [`Task.pushToolResultToUserContent()`](src/core/task/Task.ts:389).
5. Use exact structural classification before text heuristics. Known metadata flags must never fall through to [`UNCLASSIFIED`](src/core/tools/error-interception/types.ts:23).
6. Keep model payloads bounded and non-sensitive. Raw commands, absolute paths, argument bodies, secrets, task identifiers, and raw parser messages must not enter [`GuidancePayload`](src/core/tools/error-interception/types.ts:111).
7. Scope retry semantics to the failed invocation. A non-retryable malformed sibling means “discard this invocation shape and continue the task,” not “stop the task.”
8. Reset all counters that contribute to guidance when a structural fingerprint changes.
9. Add no dependencies. Existing TypeScript, Vitest, ESLint, and task-state patterns are sufficient.
10. Do not increase any count or add any path in [`eslint-suppressions.json`](src/eslint-suppressions.json).

## 1.2 Frontend ↔ Backend Communication Boundaries

In this feature, the external/model-facing protocol acts as the frontend boundary and the VS Code extension core acts as the backend/system boundary. The webview user channel is a parallel observer of the same failure.

### Inbound and Recovery Data Flow

1. Provider/model emits native call arguments.
   ↓
2. [`NativeToolCallParser.parseToolCall()`](src/core/assistant-message/NativeToolCallParser.ts:700) parses JSON and validates the tool-specific argument shape.
   ↓
3. On failure, [`NativeToolCallParser.consumeParseError()`](src/core/assistant-message/NativeToolCallParser.ts:89) is replaced in production routing by a structured, consume-once failure descriptor.
   ↓
4. [`presentAssistantMessage()`](src/core/assistant-message/presentAssistantMessage.ts:78) derives sanitized turn context, including whether a distinct valid sibling exists, without copying argument values.
   ↓
5. [`classifyError()`](src/core/tools/error-interception/ErrorClassifier.ts:166) selects an exact category and pattern from structural metadata.
   ↓
6. [`transformErrorToMessage()`](src/core/tools/error-interception/MessageTransformer.ts:277) renders occurrence-aware model guidance within the existing UTF-8 byte limit.
   ↓
7. [`Task.pushToolResultToUserContent()`](src/core/task/Task.ts:389) retains at most one result for the failed call identifier.
   ↓
8. The next provider/model turn continues from the valid sibling result or emits one corrected call.

### User-Visible Error Flow

1. The same classified failure is sent to the existing raw error or [`Task.say()`](src/core/task/Task.ts:1687) path.
   ↓
2. The user sees a clear tool name, failure kind, and concise reason.
   ↓
3. Raw diagnostic detail remains available only to local diagnostics or logs, not to the model-facing payload.

### Dual-Channel Invariant

- User channel: clear, actionable, and allowed to contain local diagnostic detail that is safe for the user.
- Model channel: deterministic, bounded, sanitized, and limited to structural facts required for recovery.
- A model-facing transformation must never replace or suppress the user-visible error emission.

## 1.3 Proposed Type Bindings

### Parser Failure Contract

Add an internal discriminated descriptor near [`NativeToolCallParser`](src/core/assistant-message/NativeToolCallParser.ts:53):

| Proposed declaration                                                                                  | Required fields                                                       | Constraint                                                          |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`ParserFailureKind`](src/core/assistant-message/NativeToolCallParser.ts:53)                          | `json_syntax`, `missing_required_arguments`, `invalid_argument_shape` | Closed union. Do not use arbitrary parser text as a discriminator.  |
| [`NativeToolParseFailure`](src/core/assistant-message/NativeToolCallParser.ts:53)                     | `kind`, `toolName`, `missingParameters`, `emptyArguments`             | No raw argument body, path, command, task ID, or secret.            |
| [`NativeToolCallParser.consumeParseFailure()`](src/core/assistant-message/NativeToolCallParser.ts:89) | `toolCallId` → descriptor or undefined                                | Atomic consume-and-delete, matching current side-channel lifecycle. |

Compatibility constraint: if [`NativeToolCallParser.consumeParseError()`](src/core/assistant-message/NativeToolCallParser.ts:89) has callers outside this path, retain it as a temporary wrapper for human diagnostics. New production classification must use the typed descriptor.

The parser must distinguish these cases:

| Input shape                                        | Failure kind                 | Model claim allowed                                                                                   |
| -------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Invalid JSON syntax                                | `json_syntax`                | Arguments were not valid JSON. Do not claim concatenation unless a dedicated parser signal proves it. |
| Valid empty object for a tool with required fields | `missing_required_arguments` | Required fields are missing.                                                                          |
| Valid JSON with wrong structural shape             | `invalid_argument_shape`     | The argument object does not match the tool schema.                                                   |

### Sanitized Interception Facts

Extend the safe-fact allowlist in [`ErrorClassifier`](src/core/tools/error-interception/ErrorClassifier.ts:56) only with structural values:

- `parseFailureKind`
- `emptyArguments`
- `missingRequiredParameters`
- `validSiblingPresent`
- `validSiblingAlreadyProcessed`
- `unknownTool`
- `modeRestriction`
- `fileRestriction`
- `recoveryDisposition`

The dispatcher derives sibling facts by inspecting same-turn tool blocks with a distinct call identifier. It must not forward sibling identifiers or argument values. If processing order cannot prove that a sibling already completed, guidance must say it was retained or is present, not that it executed successfully.

### Recovery Disposition

Use a closed internal disposition near [`GuidancePayload`](src/core/tools/error-interception/types.ts:111):

| Disposition         | Invocation action                    | Task action                                              |
| ------------------- | ------------------------------------ | -------------------------------------------------------- |
| `correct_once`      | Emit one corrected call.             | Continue.                                                |
| `discard_duplicate` | Do not resend the malformed sibling. | Continue from the retained sibling.                      |
| `change_strategy`   | Do not repeat the same fingerprint.  | Continue with a different action or tool.                |
| `await_user`        | No automatic retry.                  | Reserved for genuine policy or authorization boundaries. |

Keep the current [`GuidancePayload`](src/core/tools/error-interception/types.ts:111) fields for compatibility. Define [`retryable`](src/core/tools/error-interception/types.ts:119) as invocation-scoped. Render the task continuation explicitly in [`next`](src/core/tools/error-interception/types.ts:118), so `Retryable: false` cannot be mistaken for a task-level halt.

## 1.4 Model Guidance Format

Retain the existing `<error_details>` envelope and 1,024-byte default enforced by [`fitDetailsWithinByteLimit()`](src/core/tools/error-interception/MessageTransformer.ts:225). Change content rules as follows:

1. `What` states the observed structural fact only.
2. `Why` identifies the rejected invocation and whether a valid sibling exists.
3. The first `Next` item is one executable continuation action.
4. A second `Next` item may state a non-repeat constraint. Do not include generic advice unrelated to the observed shape.
5. `Retryable` applies to this invocation only.
6. `Occurrence` is synchronized across all state owners.
7. At occurrence 2, stop repeating the same prose and issue a stronger non-repeat instruction.
8. At occurrence 3 or later, use `change_strategy`, suppress the user “Proceed anyway” gate for this safely rejected malformed invocation, and direct the model to continue from retained results or choose a different action.

### First Empty-Sibling Failure

- What: this response contained a valid call and a second call with an empty argument object.
- Why: the empty sibling was rejected; the valid sibling remains available.
- Next 1: continue from the valid sibling result and do not resend it.
- Next 2: if another search is needed later, emit exactly one call with all required fields.
- Retryable: false for the empty sibling invocation.

### Repeated Identical Empty-Sibling Failure

- What: the same empty sibling shape was emitted again.
- Why: retrying the same fingerprint cannot add new information.
- Next 1: emit no duplicate call now; continue from the retained result.
- At occurrence 3 or later: change strategy before another tool call. Do not request user approval merely to repeat the rejected shape.

### True JSON Syntax Failure

- What: arguments were not valid JSON.
- Why: report only a parser-proven syntax class. Never assert concatenation from a generic exception.
- Next 1: emit one call with one valid JSON object matching the tool schema.
- Retryable: true once; escalate to `change_strategy` on the repeated fingerprint.

## 1.5 State and Fingerprint Contract

[`TaskErrorState`](src/core/tools/error-interception/TaskErrorState.ts:1) and [`ToolErrorInterceptor`](src/core/tools/error-interception/ToolErrorInterceptor.ts:1) currently own independent category counters. [`presentAssistantMessage()`](src/core/assistant-message/presentAssistantMessage.ts:78) resets only the former when a structural fingerprint changes, while [`ToolErrorInterceptor.transformError()`](src/core/tools/error-interception/ToolErrorInterceptor.ts:342) increments the latter. This causes local repeat text and model payload occurrence values to diverge.

Adopt one coordinated reset entry point:

- Preferred ownership: [`ToolErrorInterceptor.resetTaskState()`](src/core/tools/error-interception/ToolErrorInterceptor.ts:1) resets its category counter and the corresponding [`TaskErrorState`](src/core/tools/error-interception/TaskErrorState.ts:1) category for the same task.
- Production dispatcher code calls only the coordinated entry point.
- A category-specific reset of `SHELL_INTEGRATION` must also close its category-specific circuit. A full reset still clears all counts and circuits.
- The first failure after a fingerprint change must render occurrence 1 in both the structural preflight message and `<error_details>`.

## 1.6 Error Handling Rules

- Exact metadata patterns for unknown tool, mode restriction, and file restriction run before heuristic patterns.
- Unknown tools use an explicit unknown-tool category and never [`PARAM_TYPE_MISMATCH`](src/core/tools/error-interception/types.ts:21).
- Mode and file restrictions are non-retryable in the same mode/path configuration, but task-level continuation remains allowed.
- [`UNCLASSIFIED`](src/core/tools/error-interception/types.ts:23) remains fail-open only for genuinely unknown signals.
- Parameter names are optional hints. If validation fails, render the generic safe template rather than an escaped or partially preserved attacker-controlled value.
- The parser side channel is consume-once. A second consume for the same call identifier returns undefined.
- A duplicate tool result is rejected by [`Task.pushToolResultToUserContent()`](src/core/task/Task.ts:389) without modifying the retained first result.

# 2. Architecture Decisions

## 2.1 Exactly Three Design Options

### Option A, The Standard / The Right Way: Typed Failure Shape + Occurrence-Aware Recovery

Design:

- Replace string-only production routing with [`NativeToolParseFailure`](src/core/assistant-message/NativeToolCallParser.ts:53).
- Distinguish syntax, missing-required-field, and invalid-shape failures.
- Add exact restriction and unknown-tool patterns.
- Derive safe sibling facts in [`presentAssistantMessage()`](src/core/assistant-message/presentAssistantMessage.ts:78).
- Synchronize category resets.
- Render occurrence-aware actions and bypass “Proceed anyway” for safely rejected malformed sibling calls.

Trade-offs:

| Effort                                                                             | Risk                                                                                                                          | Outcome                                                                                                                  |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Medium. Touches parser, dispatcher, interception types/patterns, state, and tests. | Low after integration coverage. Main risk is temporary contract mismatch between parser and dispatcher during implementation. | Correct root-cause classification, deterministic recovery, clear continuation semantics, and testable protocol behavior. |

Decision: **Recommended.** This is the only option that directly explains the diagnostic without guessing and preserves safety and protocol integrity.

### Option B, The Practical / The Pragmatic Way: Existing String Side Channel + Targeted Metadata Flags

Design:

- Keep [`NativeToolCallParser.consumeParseError()`](src/core/assistant-message/NativeToolCallParser.ts:89).
- Infer missing-required-fields from known exception prefixes.
- Add `emptyArguments` and sibling flags in [`presentAssistantMessage()`](src/core/assistant-message/presentAssistantMessage.ts:78).
- Rewrite templates and add exact classifier patterns.

Trade-offs:

| Effort         | Risk                                                                                                     | Outcome                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Low to medium. | Medium. Classification depends on human-readable exception wording and can regress when messages change. | Faster implementation and improved diagnostic behavior, but parser semantics remain ambiguous and brittle. |

Decision: Not recommended for the final PR because it leaves the root contract defect in place.

### Option C, The Staging / The Incremental Way: Quarantined Automatic Suppression/Repair Experiment

Design:

- Detect a valid call plus empty sibling.
- Silently suppress execution of the empty sibling while emitting its protocol-required error result.
- Optionally experiment with argument repair in a disabled test-only branch.

Trade-offs:

| Effort                                | Risk                                                                                                                                                          | Outcome                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Low for suppression, high for repair. | High. Argument repair can execute unintended operations, hide model defects, or violate provider protocol. Silent suppression alone does not teach the model. | Useful only to confirm the sibling-detection hypothesis. Unsafe as a production repair strategy. |

Decision: Reject automatic argument synthesis. Safe non-execution of malformed calls already belongs in the standard design, but the system must still emit a clear error result and corrective guidance.

## 2.2 Adopted Patterns and Stack

- Discriminated union for parser failure types.
- Exact-first, heuristic-second error classification.
- Task-scoped state through existing weakly held task state.
- Consume-once parser error side channel.
- Exactly-once tool-result insertion by call identifier.
- Defense-in-depth validation at both fact extraction and message rendering boundaries.
- Existing Vitest and ESLint tooling from [`src/package.json`](src/package.json:441).
- No new external dependency and no new technology adoption.

No external documentation search was required because the plan uses existing repository contracts and no new API or dependency.

## 2.3 Component-Grouped Requirement Plan

### Component A: Repository and PR Hygiene, REQ-001 and REQ-006

Modify [`/.gitignore`](.gitignore):

- Add root-anchored ignores for [`ci-fix-commit.ps1`](ci-fix-commit.ps1), [`commit-and-push.ps1`](commit-and-push.ps1), [`commit-message.txt`](commit-message.txt), and [`resolve_conflicts.py`](resolve_conflicts.py).
- Add a narrow session-artifact rule for timestamped session directories under [`docs/`](docs), such as `/docs/*_session_*/`.
- Do not ignore all of [`docs/`](docs), maintained reports outside the timestamped pattern, or general PowerShell/Python files.

Remove from the PR/worktree through the Recycle Bin, not permanent deletion:

- [`ci-fix-commit.ps1`](ci-fix-commit.ps1)
- [`commit-and-push.ps1`](commit-and-push.ps1)
- [`commit-message.txt`](commit-message.txt)
- [`resolve_conflicts.py`](resolve_conflicts.py)
- [`074338_code-light-report.md`](docs/260726_0003_session_error-hiding-fix/074338_code-light-report.md)

Acceptance:

- None of the five artifacts remains in the PR diff.
- New files at the same exact root names or timestamped session paths are ignored.
- A normal maintained document such as [`README.md`](docs/README.md) is not broadly ignored.
- The current requested architect report remains available for VP review during this session even though future session artifacts match the local ignore rule.

### Component B: Parser and Dispatcher Recovery Contract, REQ-004, REQ-007, and REQ-008

Modify [`NativeToolCallParser.ts`](src/core/assistant-message/NativeToolCallParser.ts):

- Store a typed failure descriptor instead of treating every exception as invalid JSON.
- Record missing required parameter names from the parser’s known tool contract, not from raw exception text.
- Mark an empty object explicitly.
- Preserve atomic consumption.
- Do not retain the raw argument body in the model-facing descriptor.

Modify [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts):

- Route `json_syntax` to invalid-JSON guidance.
- Route `missing_required_arguments` to parameter-missing guidance.
- Route `invalid_argument_shape` to type/shape guidance.
- Derive valid-sibling structural facts from the same assistant turn.
- Change the final unknown-tool branch from `typeMismatch` metadata to `unknownTool` metadata.
- Keep one error result for the malformed call identifier and do not mark the malformed call as successfully executed.
- Do not ask the user to “Proceed anyway” for a safely rejected malformed sibling. Continue the task using retained valid results.
- Preserve the raw user-visible error path.

Modify [`types.ts`](src/core/tools/error-interception/types.ts), [`errorPatterns.ts`](src/core/tools/error-interception/errorPatterns.ts), and [`MessageTransformer.ts`](src/core/tools/error-interception/MessageTransformer.ts):

- Add semantically explicit categories for unknown tool, mode restriction, and file restriction. Preferred names are `TOOL_NOT_FOUND`, `MODE_RESTRICTION`, and `FILE_RESTRICTION`.
- Add exact metadata patterns before broad type-mismatch fallbacks.
- Add safe recovery facts and occurrence-aware templates.
- Keep restriction guidance non-retryable for the current invocation/configuration while telling the model how to continue.
- Replace the current unconditional concatenated-JSON claim with syntax-class-specific wording.

Acceptance:

- An empty object is never described as invalid JSON.
- A genuine syntax failure is never described as a missing field.
- Unknown tool, mode restriction, and file restriction never classify as [`UNCLASSIFIED`](src/core/tools/error-interception/types.ts:23).
- A valid sibling plus malformed sibling produces one result per call identifier, retains the valid sibling, rejects the malformed sibling, and tells the model not to resend the valid call.
- Repeated identical malformed siblings escalate guidance without opening a user “Proceed anyway” gate.
- Model payload stays within the existing byte limit and contains no raw arguments.

### Component C: State Lifecycle, REQ-002

Modify [`ToolErrorInterceptor.ts`](src/core/tools/error-interception/ToolErrorInterceptor.ts), [`TaskErrorState.ts`](src/core/tools/error-interception/TaskErrorState.ts), and the fingerprint branch in [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts):

- Make reset coordination atomic from the production caller’s perspective.
- Reset both category occurrences when the fingerprint changes.
- Reset category circuit state with the category count.
- Retain category isolation and task isolation.

Acceptance:

- Two identical failures render occurrences 1 and 2 in both state consumers.
- A changed fingerprint restarts both values at 1.
- Resetting one category does not affect another category or task.
- Resetting the shell category closes its shell circuit.

### Component D: Model-Facing Input Safety, REQ-003

Modify [`ErrorClassifier.ts`](src/core/tools/error-interception/ErrorClassifier.ts) and [`MessageTransformer.ts`](src/core/tools/error-interception/MessageTransformer.ts):

- Introduce one shared safe-identifier validator.
- Accept only identifier-like names beginning with an ASCII letter or underscore and followed by ASCII letters, digits, underscores, or dots.
- Enforce a maximum length of 128 characters.
- Reject whitespace, line breaks, quotes, brackets, markup, shell characters, and instruction-like text.
- Validate metadata-derived and regex-derived names.
- Revalidate before interpolation in [`buildPayload()`](src/core/tools/error-interception/MessageTransformer.ts:107) as defense in depth.
- If invalid, omit the parameter-specific sentence and use the generic category template.

Acceptance:

- Normal names such as `path`, `file_pattern`, and `options.timeout` remain useful.
- Payloads containing newline instructions, quotes, angle brackets, or overlength names never appear in `What` or `Next`.
- Rejected names do not get escaped and partially preserved; they are omitted.

### Component E: Lint and Test Quality, REQ-005 and REQ-007

Modify tests without changing [`eslint-suppressions.json`](src/eslint-suppressions.json):

- Use typed fixture interfaces, `unknown`, type guards, and typed Vitest mocks.
- Do not add `as any` to new or touched tests.
- If touched production/test code exposes an existing lint violation, fix it locally rather than increasing suppression counts.
- Compare the final [`eslint-suppressions.json`](src/eslint-suppressions.json) diff against the merge base. Allowed outcome is no diff or decreased counts only.

Create [`presentAssistantMessage-parser-dedup.integration.spec.ts`](src/core/assistant-message/__tests__/presentAssistantMessage-parser-dedup.integration.spec.ts):

- Keep [`NativeToolCallParser.parseToolCall()`](src/core/assistant-message/NativeToolCallParser.ts:700) real.
- Keep [`NativeToolCallParser.consumeParseFailure()`](src/core/assistant-message/NativeToolCallParser.ts:89) real.
- Keep [`Task.pushToolResultToUserContent()`](src/core/task/Task.ts:389) real by invoking the prototype method against a minimal typed task fixture or constructing the narrowest valid Task test harness.
- Mock only external provider, UI, filesystem, and tool-execution boundaries required to make the test deterministic.

Required integration scenarios:

1. Genuine malformed JSON is classified as syntax failure and consumed once.
2. A valid empty object for `search_files` is classified as missing required arguments, not syntax failure.
3. A valid `search_files` call plus an empty sibling with a different call identifier retains one result for each identifier and rejects a duplicate push for the malformed identifier.
4. Guidance says the valid sibling was retained, does not claim concatenation, does not expose raw input, and instructs continuation without resending the successful call.
5. Repeated identical malformed siblings escalate without invoking the user proceed gate.

## 2.4 Dependencies Between Requirements

```text
REQ-001 ────────────── independent repository cleanup
REQ-006 ────────────── independent report cleanup, shares .gitignore edit with REQ-001

REQ-003 ────────────── safe fact boundary required before richer REQ-008 facts

REQ-004 parser kinds ─┐
REQ-002 state reset ──┼─> REQ-008 occurrence-aware recovery ─> REQ-007 real integration test
REQ-004 exact patterns┘

REQ-005 applies as a non-regression gate to every code and test task
```

Conflict notes:

- REQ-001 and REQ-006 both modify [`.gitignore`](.gitignore), so one owner should implement them sequentially in the same hygiene phase.
- REQ-002 and REQ-008 both touch [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts). Complete the state API first, then make one dispatcher integration edit.
- REQ-003, REQ-004, and REQ-008 touch the interception module. Land types and safety helpers before patterns and templates.
- REQ-007 must be last among behavior tasks because it pins the final cross-component contract.

## 2.5 Risks and Edge Cases

| Risk or edge case                                                    | Required handling                                                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid sibling appears after malformed sibling in stream order.       | Say a valid sibling is present/retained, not already executed. Defer “successful” wording until a real result exists.                               |
| Two malformed calls share a tool name but have distinct identifiers. | Emit one result for each identifier. Dedup only by identifier, not tool name.                                                                       |
| Provider reuses the same identifier.                                 | Retain the first result; reject later pushes through [`Task.pushToolResultToUserContent()`](src/core/task/Task.ts:389).                             |
| Empty string arguments.                                              | Parse as an empty object only if current provider compatibility requires it, then classify missing fields, not syntax failure.                      |
| Valid JSON array or primitive.                                       | Classify invalid argument shape. Do not cast to an object.                                                                                          |
| Unknown dynamic MCP tool.                                            | Preserve the dedicated MCP missing behavior when applicable; use core unknown-tool classification only when the dynamic registry also has no match. |
| Restriction text changes or localization changes.                    | Prefer structured metadata from validation exceptions. Keep text matching as conservative fallback only.                                            |
| Malicious parameter name in metadata.                                | Shared validation plus render-time validation; generic fallback on failure.                                                                         |
| Occurrence counter changes but fingerprint does not.                 | Escalate deterministically at 2 and 3. Do not repeat unchanged prose indefinitely.                                                                  |
| Fingerprint changes only by raw sensitive input.                     | Fingerprints use category, variant, tool name, and safe parameter identifier only. Never include argument values.                                   |
| Guidance truncation.                                                 | Preserve category, occurrence, retry scope, and first continuation action before secondary explanation.                                             |
| User visibility regresses while model guidance improves.             | Add an assertion on the user error channel in dispatcher integration tests.                                                                         |
| Session ignore rule hides maintained docs.                           | Use only the timestamped `_session_` directory pattern, never a blanket docs ignore.                                                                |

## 2.6 Dependency Analysis

- No package additions.
- No provider API changes.
- No webview state contract changes.
- Internal parser and interception contracts change together.
- The only cross-module public behavior change is more accurate tool-result guidance and bypass of an unnecessary user confirmation gate for rejected malformed invocations.
- Existing successful tool execution paths remain unchanged.

# 3. Implementation Plan (Sub-tasks)

The VP should delegate each task independently to code mode. Do not forward the full diagnostic. Provide only the requirement, exact files, contract, and acceptance checks listed below.

## Task 1: Remove Root Local Helper Artifacts, REQ-001

Exact paths:

- Modify [`.gitignore`](.gitignore).
- Remove [`ci-fix-commit.ps1`](ci-fix-commit.ps1), [`commit-and-push.ps1`](commit-and-push.ps1), [`commit-message.txt`](commit-message.txt), and [`resolve_conflicts.py`](resolve_conflicts.py) through the Recycle Bin.

Prerequisites:

- Confirm no maintained automation references these exact root files.
- Use root-anchored ignore rules only.

Verification and test protocol:

- No unit suite applies to repository hygiene.
- Run [`git check-ignore --no-index -v ci-fix-commit.ps1 commit-and-push.ps1 commit-message.txt resolve_conflicts.py`](.gitignore).
- Run [`git status --short`](.gitignore) and confirm the intended four removals plus one ignore-file modification only for this task.

## Task 2: Remove Session Report Artifact and Scope Session Ignore, REQ-006

Exact paths:

- Modify [`.gitignore`](.gitignore).
- Remove [`074338_code-light-report.md`](docs/260726_0003_session_error-hiding-fix/074338_code-light-report.md) through the Recycle Bin.

Prerequisites:

- Ask audit must confirm the protected-doc removal scope before execution.
- Task 1 should own or finish the shared [`.gitignore`](.gitignore) edit first to prevent line conflicts.

Verification and test protocol:

- No unit suite applies.
- Run [`git check-ignore --no-index -v docs/260726_0003_session_error-hiding-fix/074338_code-light-report.md`](.gitignore).
- Create no replacement report outside the immutable current report folder.
- Confirm a non-session path under [`docs/`](docs) is not matched by the new rule.

## Task 3: Introduce Typed Parser Failure Descriptors, REQ-004 and REQ-008 Foundation

Exact paths:

- Modify [`NativeToolCallParser.ts`](src/core/assistant-message/NativeToolCallParser.ts).
- Modify [`NativeToolCallParser.spec.ts`](src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts).

Prerequisites:

- Preserve current successful parsing behavior and consume-once lifecycle.
- Do not include raw arguments in the descriptor.

Implementation:

- Add [`ParserFailureKind`](src/core/assistant-message/NativeToolCallParser.ts:53), [`NativeToolParseFailure`](src/core/assistant-message/NativeToolCallParser.ts:53), and [`NativeToolCallParser.consumeParseFailure()`](src/core/assistant-message/NativeToolCallParser.ts:89).
- Separate JSON parsing errors from post-parse schema/shape errors.
- Return known missing field names from the existing per-tool construction branches.
- Keep a compatibility wrapper only if a real caller requires it.

Verification and test protocol:

- Extend the existing parser unit suite at [`NativeToolCallParser.spec.ts`](src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts).
- Run [`cd src && npx vitest run core/assistant-message/__tests__/NativeToolCallParser.spec.ts`](src/package.json:441).
- Cover invalid syntax, empty object, missing one required field, primitive/array shape, successful parse, and second-consume undefined.

## Task 4: Close Exact Classification Gaps, REQ-004

Exact paths:

- Modify [`types.ts`](src/core/tools/error-interception/types.ts).
- Modify [`errorPatterns.ts`](src/core/tools/error-interception/errorPatterns.ts).
- Modify [`ErrorClassifier.ts`](src/core/tools/error-interception/ErrorClassifier.ts).
- Modify [`ErrorClassifier.spec.ts`](src/core/tools/error-interception/__tests__/ErrorClassifier.spec.ts).

Prerequisites:

- Task 3 establishes parser failure kinds.
- Preserve exact-first and heuristic-second ordering.

Implementation:

- Add explicit categories and patterns for unknown tool, mode restriction, file restriction, and parser failure kinds.
- Add safe structural facts to the allowlist.
- Ensure known metadata flags cannot fall through to [`UNCLASSIFIED`](src/core/tools/error-interception/types.ts:23).

Verification and test protocol:

- Run [`cd src && npx vitest run core/tools/error-interception/__tests__/ErrorClassifier.spec.ts`](src/package.json:441).
- Assert exact category, pattern identifier, retry policy, confidence, and sanitized facts for every new signal.
- Assert ordinary successful output remains unclassified/pass-through.

## Task 5: Sanitize Parameter Names at Both Trust Boundaries, REQ-003

Exact paths:

- Modify [`ErrorClassifier.ts`](src/core/tools/error-interception/ErrorClassifier.ts).
- Modify [`MessageTransformer.ts`](src/core/tools/error-interception/MessageTransformer.ts).
- Modify [`ErrorClassifier.spec.ts`](src/core/tools/error-interception/__tests__/ErrorClassifier.spec.ts).
- Modify [`MessageTransformer.spec.ts`](src/core/tools/error-interception/__tests__/MessageTransformer.spec.ts).

Prerequisites:

- Task 4 should finish shared classifier edits first.
- One shared validator must be used by extraction and rendering.

Verification and test protocol:

- Run [`cd src && npx vitest run core/tools/error-interception/__tests__/ErrorClassifier.spec.ts core/tools/error-interception/__tests__/MessageTransformer.spec.ts`](src/package.json:441).
- Include valid identifiers, dotted names, newline injection, quoted instructions, markup, whitespace, brackets, shell characters, empty strings, and 129-character input.
- Assert unsafe values are absent from the complete rendered message.

## Task 6: Synchronize Reset and Circuit State, REQ-002

Exact paths:

- Modify [`ToolErrorInterceptor.ts`](src/core/tools/error-interception/ToolErrorInterceptor.ts).
- Modify [`TaskErrorState.ts`](src/core/tools/error-interception/TaskErrorState.ts) only if a small API adjustment is required.
- Modify [`ToolErrorInterceptor.spec.ts`](src/core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts).
- Modify [`TaskErrorState.spec.ts`](src/core/tools/error-interception/__tests__/TaskErrorState.spec.ts).

Prerequisites:

- Do not edit the dispatcher in this task. Expose the coordinated reset API first.

Verification and test protocol:

- Run [`cd src && npx vitest run core/tools/error-interception/__tests__/TaskErrorState.spec.ts core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts`](src/package.json:441).
- Test category reset, full reset, task isolation, category isolation, and shell circuit closure.
- Assert the first transformed error after reset has occurrence 1.

## Task 7: Implement Occurrence-Aware Recovery Rendering, REQ-008

Exact paths:

- Modify [`errorPatterns.ts`](src/core/tools/error-interception/errorPatterns.ts).
- Modify [`MessageTransformer.ts`](src/core/tools/error-interception/MessageTransformer.ts).
- Modify [`MessageTransformer.spec.ts`](src/core/tools/error-interception/__tests__/MessageTransformer.spec.ts).

Prerequisites:

- Tasks 4, 5, and 6 complete category, safety, and occurrence contracts.

Implementation:

- Render distinct first, repeated, and stuck-loop actions.
- Make first `Next` item executable and task-continuing.
- Remove the unconditional concatenated-JSON claim.
- Keep the payload within 1,024 UTF-8 bytes after adding recovery context.

Verification and test protocol:

- Run [`cd src && npx vitest run core/tools/error-interception/__tests__/MessageTransformer.spec.ts`](src/package.json:441).
- Snapshot or assert exact semantic lines for occurrences 1, 2, and 3.
- Assert invocation-scoped non-retry wording does not tell the model to stop the task.
- Run the existing all-pattern byte-limit test.

## Task 8: Wire Parser, State, Sibling Facts, and User Visibility in Dispatcher, REQ-002, REQ-004, and REQ-008

Exact paths:

- Modify [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts).
- Modify [`presentAssistantMessage-error-interception.spec.ts`](src/core/assistant-message/__tests__/presentAssistantMessage-error-interception.spec.ts).

Prerequisites:

- Tasks 3, 4, 6, and 7 must be complete.
- Keep this as the only task that integrates the new APIs into the large dispatcher file.

Implementation:

- Consume typed parser failures.
- Correct unknown-tool metadata.
- Derive safe sibling facts.
- Call the coordinated reset API on fingerprint changes.
- Keep exactly one error result per failed identifier.
- Emit the clear user-visible error once.
- Skip the user proceed gate for safely rejected malformed siblings while allowing normal authorization/restriction gates to remain.

Verification and test protocol:

- Run [`cd src && npx vitest run core/assistant-message/__tests__/presentAssistantMessage-error-interception.spec.ts`](src/package.json:441).
- Update mocked unit tests to validate dispatcher branches, but do not treat them as the REQ-007 integration proof.
- Assert user-visible and model-visible channels separately.

## Task 9: Add Real Parser-to-Task Integration Coverage, REQ-007

Exact paths:

- Create [`presentAssistantMessage-parser-dedup.integration.spec.ts`](src/core/assistant-message/__tests__/presentAssistantMessage-parser-dedup.integration.spec.ts).
- Modify no production file unless the test exposes a real contract defect.

Prerequisites:

- Tasks 3 through 8 complete.
- Real parser consumption and real task dedup must not be mocked.

Verification and test protocol:

- Run [`cd src && npx vitest run core/assistant-message/__tests__/presentAssistantMessage-parser-dedup.integration.spec.ts`](src/package.json:441).
- Then run [`cd src && npx vitest run core/assistant-message/__tests__/NativeToolCallParser.spec.ts core/assistant-message/__tests__/presentAssistantMessage-error-interception.spec.ts core/assistant-message/__tests__/presentAssistantMessage-parser-dedup.integration.spec.ts core/task/__tests__/Task.spec.ts`](src/package.json:441).
- Prove consume-once semantics, one retained result per identifier, duplicate rejection, correct sibling guidance, no raw-argument leakage, and no proceed prompt.

## Task 10: Lint Baseline and Final Validation, REQ-005

Exact paths:

- Review all touched TypeScript and test paths.
- Do not modify [`eslint-suppressions.json`](src/eslint-suppressions.json) except to reduce an existing count if local cleanup legitimately permits it.

Prerequisites:

- All implementation tasks complete.

Verification and test protocol:

- Run [`cd src && pnpm lint`](src/package.json:441).
- Run [`cd src && pnpm check-types`](src/package.json:441).
- Run [`cd src && pnpm bundle`](src/package.json:441).
- Run [`cd src && npx vitest run core/tools/error-interception/__tests__ core/assistant-message/__tests__/NativeToolCallParser.spec.ts core/assistant-message/__tests__/presentAssistantMessage-error-interception.spec.ts core/assistant-message/__tests__/presentAssistantMessage-parser-dedup.integration.spec.ts core/task/__tests__/Task.spec.ts`](src/package.json:441).
- Inspect the diff for [`eslint-suppressions.json`](src/eslint-suppressions.json). Reject any added path or increased count.
- Search touched tests for new explicit `any` annotations and replace them with typed fixtures or `unknown` plus guards.

## 3.1 Conflict-Minimizing Order

1. Task 1, root artifact cleanup.
2. Task 2, session artifact cleanup and final shared ignore rule.
3. Task 3, parser failure contract.
4. Task 4, categories and exact patterns.
5. Task 5, parameter-name safety.
6. Task 6, coordinated state reset API.
7. Task 7, recovery rendering.
8. Task 8, one consolidated dispatcher integration edit.
9. Task 9, cross-boundary integration test.
10. Task 10, lint, types, bundle, and focused regression suite.

Tasks 1 and 2 may proceed independently of Tasks 3 through 7, but they should not edit [`.gitignore`](.gitignore) concurrently. Tasks 3, 4, 5, 6, and 7 should be completed sequentially because they share internal contracts. Task 8 waits until those contracts stabilize, minimizing repeated edits to the 1,000-plus-line dispatcher.

## 3.2 Requirement Coverage Matrix

| Requirement | Primary tasks               | Proof                                                                      |
| ----------- | --------------------------- | -------------------------------------------------------------------------- |
| REQ-001     | Tasks 1 and 10              | Four artifacts removed, root-anchored ignore checks pass.                  |
| REQ-002     | Tasks 6 and 8               | Coordinated reset tests plus dispatcher fingerprint regression.            |
| REQ-003     | Task 5                      | Adversarial parameter-name tests at classifier and renderer boundaries.    |
| REQ-004     | Tasks 3, 4, and 8           | Parser-kind tests and exact classification for all three flags.            |
| REQ-005     | Every code task and Task 10 | Lint passes; no suppression path/count increase.                           |
| REQ-006     | Tasks 2 and 10              | Report removed and narrow session ignore verified.                         |
| REQ-007     | Task 9                      | Real parser consume plus real Task dedup integration test.                 |
| REQ-008     | Tasks 3, 7, 8, and 9        | Diagnostic-shaped scenario recovers without repeated proceed intervention. |

## 3.3 Final Acceptance Scenario

The implementation is complete only when this scenario passes:

1. The model emits one valid `search_files` call and one empty `search_files` sibling with a different identifier.
2. The valid call is retained and processed normally.
3. The empty sibling is classified as missing required arguments, not invalid JSON.
4. The user sees one clear error for the empty sibling.
5. The model receives one bounded error result for the empty sibling.
6. Guidance states that the valid sibling remains available, tells the model not to resend it, and instructs continuation.
7. A second push for the malformed sibling identifier returns false and does not alter the retained result.
8. Repeating the same malformed shape escalates to a strategy-change instruction without presenting “Proceed anyway.”
9. A changed structural fingerprint resets both occurrence displays to 1.
10. Lint, type checking, bundle, focused tests, and suppression-baseline checks pass.

## Result

**Success, architecture plan complete.** The recommended Option A addresses the parser-contract root cause, counter drift, classifier gaps, model-facing injection risk, exactly-once protocol behavior, user-visible error preservation, and repeated-guidance failure shown in the diagnostic. No production source code was modified by this architecture task.

## Issues Discovered

1. [`NativeToolCallParser`](src/core/assistant-message/NativeToolCallParser.ts:53) conflates JSON syntax errors with post-parse schema failures.
2. [`TaskErrorState`](src/core/tools/error-interception/TaskErrorState.ts:1) and [`ToolErrorInterceptor`](src/core/tools/error-interception/ToolErrorInterceptor.ts:1) can report different occurrence values after a fingerprint reset.
3. Known `unknownTool`, `modeRestriction`, and `fileRestriction` metadata lacks exact pattern coverage.
4. The final unknown-tool dispatcher branch emits type-mismatch metadata.
5. Parameter-name interpolation accepts values that are not safe identifiers.
6. Current invalid-JSON wording asserts a cause not proven by the parser.
7. The current focused dispatcher test mocks the exact parser and task-dedup seam required for REQ-007.
8. Category-specific shell reset does not clearly close the separate shell circuit and should be pinned by a regression test.

## Next Step Recommendations

- VP should delegate Tasks 1 through 10 in the stated order.
- Ask audit should validate the protected-doc removal and the semantic distinction between invocation retry and task continuation.
- Code tasks should receive compressed contracts from this report, not the full diagnostic history.
- VP should reject completion if any REQ lacks its listed proof or if [`eslint-suppressions.json`](src/eslint-suppressions.json) increases.

## Affected File List

### Repository Hygiene

- [`.gitignore`](.gitignore)
- [`ci-fix-commit.ps1`](ci-fix-commit.ps1)
- [`commit-and-push.ps1`](commit-and-push.ps1)
- [`commit-message.txt`](commit-message.txt)
- [`resolve_conflicts.py`](resolve_conflicts.py)
- [`074338_code-light-report.md`](docs/260726_0003_session_error-hiding-fix/074338_code-light-report.md)

### Production Code

- [`NativeToolCallParser.ts`](src/core/assistant-message/NativeToolCallParser.ts)
- [`presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts)
- [`types.ts`](src/core/tools/error-interception/types.ts)
- [`ErrorClassifier.ts`](src/core/tools/error-interception/ErrorClassifier.ts)
- [`errorPatterns.ts`](src/core/tools/error-interception/errorPatterns.ts)
- [`MessageTransformer.ts`](src/core/tools/error-interception/MessageTransformer.ts)
- [`TaskErrorState.ts`](src/core/tools/error-interception/TaskErrorState.ts)
- [`ToolErrorInterceptor.ts`](src/core/tools/error-interception/ToolErrorInterceptor.ts)

### Tests

- [`NativeToolCallParser.spec.ts`](src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts)
- [`presentAssistantMessage-error-interception.spec.ts`](src/core/assistant-message/__tests__/presentAssistantMessage-error-interception.spec.ts)
- [`presentAssistantMessage-parser-dedup.integration.spec.ts`](src/core/assistant-message/__tests__/presentAssistantMessage-parser-dedup.integration.spec.ts)
- [`ErrorClassifier.spec.ts`](src/core/tools/error-interception/__tests__/ErrorClassifier.spec.ts)
- [`MessageTransformer.spec.ts`](src/core/tools/error-interception/__tests__/MessageTransformer.spec.ts)
- [`TaskErrorState.spec.ts`](src/core/tools/error-interception/__tests__/TaskErrorState.spec.ts)
- [`ToolErrorInterceptor.spec.ts`](src/core/tools/error-interception/__tests__/ToolErrorInterceptor.spec.ts)
- [`Task.spec.ts`](src/core/task/__tests__/Task.spec.ts)

### Audit-Only Baseline

- [`eslint-suppressions.json`](src/eslint-suppressions.json)
