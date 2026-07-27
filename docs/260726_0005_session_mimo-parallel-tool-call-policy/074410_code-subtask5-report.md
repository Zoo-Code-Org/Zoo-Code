# Code Sub-task 5 Report: Observability and Rollout Controls

## Task Summary

Added telemetry events for the tool-call policy system so maintainers can monitor MiMo behavior. Two new telemetry events (`TOOL_CALL_POLICY_RESOLUTION` and `TOOL_CALL_ENFORCEMENT`) were added to the existing telemetry infrastructure, and events are emitted at three key points: policy resolution, ghost quarantine, and max-one enforcement rejection. All events emit only metadata and counts — no raw commands, paths, file contents, tool arguments, or API keys.

## Actions Taken

### 1. Added telemetry event names to the enum

**File:** [`packages/types/src/telemetry.ts`](packages/types/src/telemetry.ts:77)

Added two new entries to the `TelemetryEventName` enum:

- `TOOL_CALL_POLICY_RESOLUTION = "Tool Call Policy Resolution"`
- `TOOL_CALL_ENFORCEMENT = "Tool Call Enforcement"`

### 2. Added typed schema entries for the new events

**File:** [`packages/types/src/telemetry.ts`](packages/types/src/telemetry.ts:220)

Added two new variants to the `rooCodeTelemetryEventSchema` discriminated union with typed properties:

- `TOOL_CALL_POLICY_RESOLUTION`: `provider`, `model`, `policySource`, `maxCallsPerTurn`, `enforcement`, `parallelToolCallsRequested`, `parallelToolCallsSent?`
- `TOOL_CALL_ENFORCEMENT`: `provider`, `model`, `policySource`, `maxCallsPerTurn`, `enforcement`, `callCount`, `ghostDroppedCount`, `errorResultCount`, `parallelToolCallsRequested`, `parallelToolCallsSent?`

### 3. Added convenience capture methods to TelemetryService

**File:** [`packages/telemetry/src/TelemetryService.ts`](packages/telemetry/src/TelemetryService.ts:259)

Added two methods:

- `captureToolCallPolicyResolution(taskId, properties)` — emits after policy resolution
- `captureToolCallEnforcement(taskId, properties)` — emits when local enforcement acts

### 4. Added telemetry helper functions in ToolCallRetentionPolicy.ts

**File:** [`src/core/assistant-message/ToolCallRetentionPolicy.ts`](src/core/assistant-message/ToolCallRetentionPolicy.ts:199)

Added two helper functions:

- `emitGhostDropTelemetry(input)` — emits enforcement telemetry for ghost quarantine drops
- `emitMaxOneEnforcementTelemetry(input)` — emits enforcement telemetry for max-one rejections

Both functions check `TelemetryService.hasInstance()` before emitting, and emit ONLY counts and metadata.

### 5. Emitted policy-resolution event in Task.ts

**File:** [`src/core/task/Task.ts`](src/core/task/Task.ts:4408)

After resolving the tool-call policy at the main API call site, emits a `TOOL_CALL_POLICY_RESOLUTION` event with provider, model, policy source, max calls per turn, enforcement mode, and what was requested/sent.

### 6. Emitted ghost-drop telemetry at three quarantine sites in Task.ts

**File:** [`src/core/task/Task.ts`](src/core/task/Task.ts:2938)

Emitted `TOOL_CALL_ENFORCEMENT` events at all three ghost quarantine sites:

1. Streaming `tool_call_end` handler (line ~2938)
2. Legacy `tool_call` handler (line ~3030)
3. `finalizeRawChunks` handler (line ~3430)

Each emission resolves the policy inline (since `toolCallPolicy` is not in scope at those points) and sends only counts and metadata.

### 7. Emitted max-one enforcement telemetry in presentAssistantMessage.ts

**File:** [`src/core/assistant-message/presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts:664)

When the max-one enforcement rejects a call (multiple valid candidates under single-call policy), emits a `TOOL_CALL_ENFORCEMENT` event with the rejection count.

### 8. Updated test mocks to include new telemetry methods

Updated 5 test files to add `hasInstance`, `captureToolCallPolicyResolution`, and `captureToolCallEnforcement` to the TelemetryService mock:

- `presentAssistantMessage-parser-dedup.integration.spec.ts`
- `presentAssistantMessage-error-interception.spec.ts`
- `presentAssistantMessage-unknown-tool.spec.ts`
- `presentAssistantMessage-images.spec.ts`
- `presentAssistantMessage-custom-tool.spec.ts`

### 9. Created telemetry unit tests

**File:** [`src/core/assistant-message/__tests__/ToolCallRetentionPolicy-telemetry.spec.ts`](src/core/assistant-message/__tests__/ToolCallRetentionPolicy-telemetry.spec.ts:1)

8 tests covering:

- `emitGhostDropTelemetry` calls `captureToolCallEnforcement` with correct counts
- `emitMaxOneEnforcementTelemetry` calls `captureToolCallEnforcement` with rejection counts
- Privacy verification: no `callId`, `toolName`, `arguments`, `command`, `cwd`, `path`, `fileContent`, `apiKey`, or `token` fields
- Cardinality bounds: only allowed metadata keys are present
- Skips emission when `TelemetryService.hasInstance()` returns false

## Result

**Success.** All telemetry events are defined, typed, emitted at the correct points, and verified by unit tests.

### Verification evidence

- `packages/types` type check: exit code 0
- `packages/telemetry` type check: exit code 0
- `src` type check (`tsc --noEmit`): exit code 0
- `ToolCallRetentionPolicy-telemetry.spec.ts`: 8/8 tests passed
- `ToolCallRetentionPolicy.spec.ts`: 19/19 tests passed
- `PostHogTelemetryClient.test.ts`: 31/31 tests passed
- `tool-call-policy.spec.ts`: 9/9 tests passed
- `presentAssistantMessage-parser-dedup.integration.spec.ts`: 11/11 tests passed
- `presentAssistantMessage-error-interception.spec.ts`: all tests passed
- `presentAssistantMessage-images.spec.ts`: all tests passed
- `presentAssistantMessage-custom-tool.spec.ts`: all tests passed

### Pre-existing failure (NOT caused by this sub-task)

`presentAssistantMessage-unknown-tool.spec.ts` has 1 failing test that expects `"Tool Call Format Error"` but the code produces `"Unknown Tool"` guided error details. Verified via `git stash` that this test fails both with and without my changes — it is a pre-existing failure from sub-task 3/4, not introduced by this telemetry work.

## Privacy Constraints (Verified)

All telemetry events emit ONLY the following fields:

- `taskId` (string)
- `provider` (string, e.g. "mimo", "openai")
- `model` (string, model ID)
- `policySource` (string, e.g. "model-capability")
- `maxCallsPerTurn` (number | "unbounded")
- `enforcement` (string, e.g. "provider", "local", "provider-and-local")
- `callCount` (number)
- `ghostDroppedCount` (number)
- `errorResultCount` (number)
- `parallelToolCallsRequested` (boolean)
- `parallelToolCallsSent` (boolean | undefined)

**NEVER emitted:**

- Raw command strings
- File paths or file contents
- API keys or tokens
- Tool argument values
- Tool call IDs
- Tool names

## Rollout Flag

The architect report mentions an optional rollout flag for MiMo single-call enforcement. The current implementation uses model-capability-driven policy resolution (Sub-task 1), which already defaults to single-call for MiMo. No separate feature flag was needed because:

1. The safe default is already single-call (conservative policy for unknown models).
2. MiMo models are explicitly marked as non-parallel-capable in the model registry.
3. Adding a flag would add complexity without changing behavior, since the default is already safe.

If maintainers later need staged deployment, a flag can be added to `resolveToolCallPolicy` to override the capability-based resolution.

## Issues Discovered

1. The `presentAssistantMessage-unknown-tool.spec.ts` test has a pre-existing failure (expecting `"Tool Call Format Error"` but getting `"Unknown Tool"` guided error). This is from sub-task 3/4, not this sub-task.
2. The ghost quarantine sites in `Task.ts` are in the stream-processing loop, which is before `toolCallPolicy` is defined at line 4408. The telemetry calls resolve the policy inline using `resolveToolCallPolicy()` to avoid scope issues.

## Next Step Recommendations

1. VP should proceed to Sub-task 6 (end-to-end regression validation).
2. Consider fixing the pre-existing `presentAssistantMessage-unknown-tool.spec.ts` test failure in a separate bug fix.
3. After Sub-task 6, run `pnpm lint` and `pnpm check-types` as the final quality gate.

## Affected File List

- `packages/types/src/telemetry.ts` — added 2 event names + 2 schema variants
- `packages/telemetry/src/TelemetryService.ts` — added 2 capture methods
- `src/core/assistant-message/ToolCallRetentionPolicy.ts` — added 2 telemetry helper functions + import
- `src/core/assistant-message/presentAssistantMessage.ts` — added max-one enforcement telemetry + import
- `src/core/task/Task.ts` — added policy-resolution telemetry + 3 ghost-drop telemetry calls + import
- `src/core/assistant-message/__tests__/ToolCallRetentionPolicy-telemetry.spec.ts` — new test file (8 tests)
- `src/core/assistant-message/__tests__/presentAssistantMessage-parser-dedup.integration.spec.ts` — updated mock
- `src/core/assistant-message/__tests__/presentAssistantMessage-error-interception.spec.ts` — updated mock
- `src/core/assistant-message/__tests__/presentAssistantMessage-unknown-tool.spec.ts` — updated mock
- `src/core/assistant-message/__tests__/presentAssistantMessage-images.spec.ts` — updated mock
- `src/core/assistant-message/__tests__/presentAssistantMessage-custom-tool.spec.ts` — updated mock
