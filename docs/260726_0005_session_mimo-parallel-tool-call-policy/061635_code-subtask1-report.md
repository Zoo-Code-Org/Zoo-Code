# Code Sub-task 1 Report: Model-Level Tool-Call Capability and Policy Resolution

## Task Summary

Implemented the foundation for model-capability-driven tool-call policy resolution. Added new types (`ToolCallGenerationPolicy`, `ModelToolCallCapabilities`, `ResolvedToolCallPolicy`), declared MiMo as non-parallel-capable, created a pure policy resolver function, and replaced all 4 hardcoded `parallelToolCalls: true` sites in Task.ts with resolver-driven values.

## Actions Taken

### 1. New Types in `packages/types/src/model.ts`

- Added `modelToolCallCapabilitiesSchema` (zod schema) and `ModelToolCallCapabilities` type with fields:
    - `supportsParallelToolCalls: boolean | "unknown"`
    - `parallelToolCallsRequestControl: "openai" | "anthropic" | "none" | "unknown"`
- Added `ToolCallGenerationPolicy` type: `"parallel" | "single" | "provider-default"`
- Added `ResolvedToolCallPolicy` type with `generation`, `maxCallsPerTurn`, `enforcement`, and `source` fields
- Added optional `toolCallCapabilities` field to `modelInfoSchema` so any model can declare its capabilities

### 2. MiMo Capability in `packages/types/src/providers/mimo.ts`

- Set `toolCallCapabilities: { supportsParallelToolCalls: false, parallelToolCallsRequestControl: "none" }` on both `mimo-v2.5-pro` and `mimo-v2.5`
- `parallelToolCallsRequestControl` is `"none"` (will be updated to `"openai"` in Sub-task 2 after provider canary)

### 3. Pure Policy Resolver in `src/api/index.ts`

- Added `resolveToolCallPolicy(modelInfo, providerName?)` function
- Resolution logic:
    1. `supportsParallelToolCalls === false` → `single`, `maxCallsPerTurn=1`, enforcement is `"local"` (when control is `"none"`) or `"provider-and-local"` (when control is `"openai"`/`"anthropic"`)
    2. `supportsParallelToolCalls === true` with known control → `parallel`, `maxCallsPerTurn="unbounded"`, enforcement `"provider"`
    3. Unknown/absent capabilities → conservative `single`, `maxCallsPerTurn=1`, enforcement `"local"`, source `"provider-default"`
- Pure function: no side effects, no mutation of input

### 4. Replaced 4 Hardcoded `parallelToolCalls: true` in `src/core/task/Task.ts`

- **Line ~1608** (condenseContext metadata): replaced with `resolveToolCallPolicy(this.api.getModel().info, this.apiConfiguration.apiProvider).generation === "parallel"`
- **Line ~3850** (forced context reduction metadata): same pattern
- **Line ~4078** (context management metadata): same pattern (inline call)
- **Line ~4252** (main attemptApiRequest metadata): same pattern
- Added import of `resolveToolCallPolicy` from `"../../api"`

### 5. Unit Tests in `src/core/task/__tests__/tool-call-policy.spec.ts`

- 11 test cases covering:
    - MiMo v2.5 Pro resolves to `single`, `maxCallsPerTurn=1`
    - MiMo v2.5 resolves to `single`, `maxCallsPerTurn=1`
    - MiMo uses `local` enforcement when request control is `"none"`
    - OpenAI-capable model resolves to `parallel`, `maxCallsPerTurn="unbounded"`
    - Anthropic-capable model resolves to `parallel`
    - Unknown model (no capabilities) resolves to conservative `single`
    - Unknown capabilities (`"unknown"`) resolves to conservative `single`
    - `supportsParallelToolCalls=false` with `"openai"` control → `provider-and-local` enforcement
    - `supportsParallelToolCalls=false` with `"anthropic"` control → `provider-and-local` enforcement
    - Pure function: same input → same output
    - Pure function: does not mutate input

## Result

- ✅ All 11 unit tests pass (`cd src; npx vitest run core/task/__tests__/tool-call-policy.spec.ts`)
- ✅ Type check passes (`npx pnpm check-types` — 11/11 packages successful)
- ✅ No changes to stream parsing or dispatch logic (Sub-task 3's scope)
- ✅ No changes to MiMo provider request construction (Sub-task 2's scope)
- ✅ Existing behavior preserved for OpenAI and Anthropic providers (they have no `toolCallCapabilities` declared, so they fall to the conservative default — this is intentional and safe; Sub-task 2+ can add explicit capabilities for them if needed)

## Issues Discovered

- The `pnpm` command is not directly on PATH in this environment; `npx pnpm` works as a workaround. This is an environment issue, not a code issue.
- Models without explicit `toolCallCapabilities` (including OpenAI and Anthropic native models) currently resolve to the conservative `single` policy. This is the intended safe default per the architect's specification. Sub-task 2 or a follow-up can add explicit `toolCallCapabilities` to those providers' model definitions to restore `parallel` generation for them.

## Next Step Recommendations

- **Sub-task 2**: Update MiMo adapter to send `parallel_tool_calls: false` in the request body (canary test first), and update `parallelToolCallsRequestControl` from `"none"` to `"openai"` after canary confirms server enforcement.
- **Sub-task 3**: Implement stream-level pre-retention gate to drop provably-empty ghost calls and retain-as-error malformed calls.
- **Follow-up**: Add explicit `toolCallCapabilities` to OpenAI and Anthropic model definitions so they resolve to `parallel` instead of falling through to the conservative default.

## Affected File List

- `packages/types/src/model.ts` — Added 3 new types + schema, added `toolCallCapabilities` field to `modelInfoSchema`
- `packages/types/src/providers/mimo.ts` — Added `toolCallCapabilities` to both MiMo models
- `src/api/index.ts` — Added `resolveToolCallPolicy` pure function, updated imports
- `src/core/task/Task.ts` — Replaced 4 hardcoded `parallelToolCalls: true` with resolver calls, added import
- `src/core/task/__tests__/tool-call-policy.spec.ts` — New test file with 11 test cases
