# Debug Technical Gate: MiMo Parallel Tool Call Policy

## Task Summary

Technical feasibility check for Option A (model-capability-driven single-call generation) as specified in the architect report `docs/260726_0004_session_pr-review-fixes/052538_architect-research-parallel-toolcall.md`. This report verifies whether the proposed changes can be implemented without breaking existing contracts.

## Actions Taken

1. Read the architect report sections 1.2, 1.4, 1.5, 2.5.
2. Inspected `packages/types/src/model.ts` for type extension feasibility.
3. Inspected `src/api/providers/mimo.ts` for request-contract feasibility.
4. Inspected `src/core/assistant-message/NativeToolCallParser.ts` for ghost-quarantine feasibility.
5. Inspected `src/core/task/Task.ts` for hardcoded `parallelToolCalls: true` replacement feasibility.
6. Checked downstream consumers, existing tests, and export surfaces for dependency conflicts.

## Feasibility Findings

### 1. Type System Feasibility: `packages/types/src/model.ts`

**Verdict: FEASIBLE**

- The file exports `modelInfoSchema` (Zod) and `ModelInfo` (inferred type). All provider model registries use `satisfies Record<string, ModelInfo>`, which enforces shape compatibility at compile time.
- Adding new optional fields to `modelInfoSchema` (e.g., `supportsParallelToolCalls`, `parallelToolCallsRequestControl`) is a backward-compatible Zod change. Existing model definitions in `packages/types/src/providers/*.ts` will continue to satisfy `Record<string, ModelInfo>` because the new fields are optional.
- No existing type named `ToolCallGenerationPolicy`, `ModelToolCallCapabilities`, or `ResolvedToolCallPolicy` exists in `packages/types/src/`. A global search for these identifiers returned zero results.
- The new types can be added as standalone exports or as optional fields on `ModelInfo`. The architect's proposed interface-based approach (`ModelToolCallCapabilities`, `ResolvedToolCallPolicy`) is compatible with the existing Zod-inference pattern.
- Downstream consumers: `ModelInfo` is consumed in ~78 locations across `src/` and `packages/types/src/`. Adding optional fields does not break any of them. Existing tests that construct `ModelInfo` literals (e.g., `src/api/transform/__tests__/reasoning.spec.ts`, `src/api/transform/__tests__/model-params.spec.ts`) will continue to compile because the new fields are optional.

### 2. Provider Adapter Feasibility: `src/api/providers/mimo.ts`

**Verdict: FEASIBLE**

- `MimoHandler.createMessage` currently builds `params: Record<string, any>` and sends only `tools` when present. It does not send `tool_choice` or `parallel_tool_calls`.
- The method signature already accepts `metadata?: ApiHandlerCreateMessageMetadata`, which includes `tool_choice` and `parallelToolCalls`. The handler simply ignores them.
- Adding `params.tool_choice = metadata?.tool_choice` and `params.parallel_tool_calls = metadata?.parallelToolCalls` (or omitting when undefined) is a localized change that does not affect the OpenAI-compatible request contract. The `params` object is already cast to `any` before submission, so no type constraint prevents adding these fields.
- Existing test `src/api/providers/__tests__/mimo.spec.ts` line 382 explicitly asserts `params.parallel_tool_calls` and `params.tool_choice` are `undefined`. This test codifies the current gap and will need to be updated to assert the new behavior (e.g., `false` when policy is single, omitted when no policy). Updating this test is a required part of Sub-task 2, not a breaking conflict.
- MiMo extends `OpenAiHandler`, which already supports `parallel_tool_calls` in its own request paths. Adding the same field to MiMo is consistent with the inherited pattern.

### 3. Parser Feasibility: `NativeToolCallParser.ts`

**Verdict: FEASIBLE**

- The parser maintains two static tracking maps: `streamingToolCalls` (keyed by call ID) and `rawChunkTracker` (keyed by stream index). The stream consumer (`Task.ts`) calls `NativeToolCallParser.processRawChunk()` for each incoming `tool_call_partial` chunk, then `finalizeStreamingToolCall()` on `tool_call_end`.
- A "ghost" call in the proposed design is one where: (a) a `tool_call_start` was emitted (so `rawChunkTracker` has an entry), (b) the call never received a usable `name`, and (c) the accumulated `argumentsAccumulator` is empty or whitespace at `tool_call_end` / `finalizeRawChunks`.
- The parser can detect this state in `finalizeStreamingToolCall()` or in a new pre-retention gate. If `toolCall.name` is empty and `argumentsAccumulator.trim()` is empty, the parser can return a disposition of `drop-provably-empty` instead of constructing a `ToolUse`.
- Because `Task.ts` currently adds partial tool uses to `assistantMessageContent` on `tool_call_start` and replaces them on `tool_call_end`, a ghost can be quarantined by:
    1. Not pushing the partial block to `assistantMessageContent` when the call is provably empty, OR
    2. Removing the block before the stream finishes.
- The cleaner approach is to defer `assistantMessageContent.push()` until the first meaningful delta or until `finalizeStreamingToolCall` confirms the call is non-ghost. This requires a small change in `Task.ts` (the stream consumer) rather than in `NativeToolCallParser` itself.
- The existing `NativeToolParseFailure` / `consumeParseFailure` mechanism already handles malformed named calls. The ghost-quarantine logic is orthogonal: it drops calls that never had a name or arguments, while retaining named-but-malformed calls as errors.
- No existing tests in `src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts` cover ghost calls. New tests will be needed.

### 4. Task Integration Feasibility: `Task.ts`

**Verdict: FEASIBLE**

- Four hardcoded `parallelToolCalls: true` paths exist:
    1. `Task.ts` line 1621: `summarizeConversation` metadata.
    2. `Task.ts` line 3863: forced context-reduction `manageContext` metadata.
    3. `Task.ts` line 4089: `attemptApiRequest` context-management metadata.
    4. `Task.ts` line 4262: main `attemptApiRequest` metadata.
- All four paths construct `ApiHandlerCreateMessageMetadata` and pass it to either `summarizeConversation()`, `manageContext()`, or `this.api.createMessage()`.
- Replacing `parallelToolCalls: true` with a resolver output (e.g., `parallelToolCalls: resolveToolCallPolicy(this.api.getModel().id, this.apiConfiguration)`) is a mechanical change. The resolver can be a pure function that reads `ModelInfo` (or a new capability map) and returns `true` or `false`.
- The resolver does not need to modify `Task.ts`'s streaming logic, tool dispatch, or history serialization. It only affects the metadata object passed to the provider adapter.
- OpenAI and Anthropic providers will continue to receive `parallelToolCalls: true` when the resolver returns `true`, preserving existing parallel behavior. Only MiMo (and any future model marked single-call) will receive `false`.
- No existing unit tests in `src/core/task/__tests__/` assert `parallelToolCalls` values. New tests should be added for the resolver.

### 5. Dependency Conflicts

**Verdict: NO BREAKING CONFLICTS IDENTIFIED**

- **Type exports**: `packages/types/src/index.ts` re-exports `* from "./model.js"`. Adding new types to `model.ts` automatically exports them without touching `index.ts`.
- **Provider index**: `packages/types/src/providers/index.ts` already exports `* from "./mimo.js"`. Adding fields to `mimoModels` entries does not require index changes.
- **Test contracts**: The only test that codifies the current gap is `src/api/providers/__tests__/mimo.spec.ts` line 382. This test must be updated as part of Sub-task 2; it is not an external breaking contract.
- **Downstream consumers**: `ModelInfo` is consumed in many places, but only as a read-only shape. Adding optional fields is non-breaking. `ApiHandlerCreateMessageMetadata` is consumed by all provider adapters; the new fields are already present in the interface.
- **No existing resolver or policy module**: A search for `resolveToolCallPolicy`, `toolCallPolicy`, `maxCallsPerTurn`, `modelToolCallCapabilities` returned zero results. The proposed resolver is a new module with no legacy baggage.

## Risks and Edge Cases

1. **MiMo endpoint may reject `parallel_tool_calls`**: The architect correctly flags this as medium confidence. The provider adapter should implement a canary or fallback (omit the field if the endpoint returns a validation error). This is a runtime concern, not a type-system concern.
2. **Ghost call with buffered deltas but no name**: The current `processRawChunk` buffers deltas in `tracked.deltaBuffer` before a name is seen. If a ghost call has buffered deltas but no name, the "no non-whitespace argument bytes" criterion must include buffered deltas. The feasibility is unchanged, but the implementation must check `deltaBuffer.join("").trim()` in addition to `argumentsAccumulator`.
3. **`cwd: null` contract mismatch**: The `execute_command` tool schema requires `cwd` and permits `null`, but `StructuralValidator.validateCwdParameter` flags `null` as a mismatch. This is an adjacent issue noted by the architect (section 2.4). It does not block Option A, but Sub-task 4 must resolve the contract before adding any repair logic.
4. **Partial block timing**: If `Task.ts` pushes a partial `tool_use` block to `assistantMessageContent` before the ghost is detected, the block will be visible to the user and must be removed. The cleaner design (defer push until non-ghost confirmation) avoids this, but requires careful handling of `streamingToolCallIndices` and `presentAssistantMessageSafe`.

## Issues Discovered

1. `src/api/providers/__tests__/mimo.spec.ts` line 382 codifies the current bug by asserting `parallel_tool_calls` and `tool_choice` are absent. This test must be updated, not preserved.
2. `Task.ts` uses `this.api.getModel().info` to build tools (line 4209) but does not currently use model info to resolve `parallelToolCalls`. The integration point is available but unused.
3. The `execute_command` schema (`src/core/prompts/tools/native-tools/execute_command.ts`) requires `cwd` and permits `null`, while `StructuralValidator` rejects `null`. This inconsistency is adjacent to the main bug and should be fixed in Sub-task 4.

## Next Step Recommendations

1. Proceed with Sub-task 1 (type additions and policy resolver). The type system is ready.
2. Proceed with Sub-task 2 (MiMo adapter wiring). Update the codifying test in `mimo.spec.ts`.
3. Proceed with Sub-task 3 (ghost quarantine). Implement the pre-retention gate in `Task.ts` stream processing, deferring `assistantMessageContent.push` until the call is confirmed non-ghost.
4. Resolve the `cwd: null` contract mismatch in Sub-task 4 before implementing any repair behavior.
5. Add a canary integration test for MiMo endpoint acceptance of `parallel_tool_calls: false` before making server-side enforcement mandatory.

## Affected File List

- `packages/types/src/model.ts` (add capability types)
- `packages/types/src/providers/mimo.ts` (add MiMo capability flags)
- `src/api/providers/mimo.ts` (honor metadata fields)
- `src/api/providers/__tests__/mimo.spec.ts` (update codifying test)
- `src/core/task/Task.ts` (replace 4 hardcoded paths, add ghost gate)
- `src/core/assistant-message/NativeToolCallParser.ts` (optional disposition helper)
- `src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts` (add ghost tests)
- `src/core/task/__tests__/tool-call-policy.spec.ts` (new resolver tests)
- `src/core/prompts/tools/native-tools/execute_command.ts` (resolve `cwd: null` contract)
- `src/core/tools/error-interception/StructuralValidator.ts` (align `cwd: null` handling)

Report created: `docs/260726_0005_session_mimo-parallel-tool-call-policy/205659_debug-technical-gate.md`
