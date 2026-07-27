# Code Task Report: Default Policy for Known-Parallel Providers

## Task Summary

Fix `resolveToolCallPolicy()` in `src/api/index.ts` to preserve existing parallel tool-call behavior for OpenAI-compatible and Anthropic providers when models lack explicit `toolCallCapabilities`. Also fix the unsafe `as unknown as` cast in `presentAssistantMessage.ts` and add regression tests.

## Actions Taken

### R1: Fix `resolveToolCallPolicy()` default fallback (src/api/index.ts)

**Root cause:** Case 3 (unknown/absent capabilities) unconditionally returned `single, maxCallsPerTurn=1` regardless of provider. This broke parallel tool calls for all OpenAI/Anthropic models not explicitly annotated with `toolCallCapabilities`.

**Fix:** Replaced the blanket conservative default with provider-aware fallback logic:

- Added `OPENAI_COMPATIBLE_PARALLEL_PROVIDERS` set containing all OpenAI-compatible provider identifiers (openai, openai-native, openai-codex, openrouter, deepseek, qwen-code, moonshot, kimi-code, mistral, requesty, unbound, xai, litellm, sambanova, zai, fireworks, friendli, vercel-ai-gateway, opencode-go, kenari, zoo-gateway, minimax, baseten, poe).
- Added `ANTHROPIC_PARALLEL_PROVIDERS` set containing Anthropic-family providers (anthropic, bedrock, vertex).
- Case 3 now checks `providerName` against these sets: known-parallel providers get `parallel, unbounded, provider` enforcement; unknown/mimo providers still get the conservative `single, 1, local` default.
- Updated the JSDoc to document the new resolution logic.

### R2: `providerName` parameter now used (resolved)

The `providerName` parameter was previously passed at all 4 call sites but unused inside the function. It is now actively used in the Case 3 fallback logic.

### T2: Fix unsafe cast in presentAssistantMessage.ts

**Root cause:** Two `cline as unknown as { apiConfiguration?: { apiProvider?: string } }` casts were used to access `cline.apiConfiguration?.apiProvider`, even though `cline` is typed as `Task` which has a public `apiConfiguration: ProviderSettings` property.

**Fix:** Replaced both unsafe casts with direct property access:

- Line 637: `(cline as unknown as { apiConfiguration?: { apiProvider?: string } }).apiConfiguration?.apiProvider` → `cline.apiConfiguration?.apiProvider`
- Line 677: Same pattern replaced in the `emitMaxOneEnforcementTelemetry` call.

### C2: Regression tests (src/core/task/**tests**/tool-call-policy.spec.ts)

Updated the "Unknown models" describe block to "Models without explicit toolCallCapabilities" and added/updated tests:

- OpenAI model without capabilities → `parallel` (new)
- Anthropic model without capabilities → `parallel` (new)
- Bedrock (Anthropic-family) without capabilities → `parallel` (new)
- OpenRouter without capabilities → `parallel` (new)
- Unknown provider (mimo) without capabilities → `single` (new)
- Unknown provider string without capabilities → `single` (new)
- OpenAI with `"unknown"` capabilities → `parallel` (updated, provider fallback)
- Unknown provider with `"unknown"` capabilities → `single` (new)
- Absent `providerName` → `single` (new)

## Result

✅ Success — all 18 tests pass.

```
cd src; npx vitest run core/task/__tests__/tool-call-policy.spec.ts
Test Files  1 passed (1)
     Tests  18 passed (18)
```

## Issues Discovered

None. The fix is backward-compatible: models with explicit `toolCallCapabilities` are unaffected (Cases 1 and 2 unchanged). Only the fallback path (Case 3) changed.

## Next Step Recommendations

- Consider adding `toolCallCapabilities` to model definitions for providers currently relying on the fallback (e.g. openrouter, deepseek) to make their parallel support explicit rather than implicit.
- The `OPENAI_COMPATIBLE_PARALLEL_PROVIDERS` set should be reviewed if new providers are added to `providerIdentifiers` in the future.

## Affected File List

- `src/api/index.ts` — modified `resolveToolCallPolicy()` fallback logic + added provider sets
- `src/core/assistant-message/presentAssistantMessage.ts` — removed 2 unsafe casts
- `src/core/task/__tests__/tool-call-policy.spec.ts` — updated and expanded regression tests
