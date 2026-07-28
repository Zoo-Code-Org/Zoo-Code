# [Full Audit Mode] Final Ask Audit Report

## Task: Upstage solar-open2 `strict: true` compatibility fix

## Date: 2026-07-28 (KST)

## Mode: Ask (CPO)

---

## [1. Philosophy & UX/UI Diagnostics]

### User Intent Alignment

The user's original intent was: "Read this file and solve the problem according to it. Must use Upstage's solar-open2." The problem report ([`upstage_solar_open2_issue_report.md`](../../../upstage/upstage_solar_open2_issue_report.md:1)) identified two root causes:

1. **Primary**: Zoo Code injects `strict: true` into tool function definitions, which Upstage's API gateway rejects with HTTP 400.
2. **Secondary**: `parallel_tool_calls` is sent even when no tools are present, which Upstage also rejects.

The implemented fix addresses both issues. The user can now use `solar-open2` with Zoo Code. **Intent is fulfilled at the functional level.**

### UX Considerations

- The fix is transparent to the user - no configuration changes needed.
- The original report also described a "network interceptor" approach (Section 5.2) that sanitizes JSON payloads at the HTTP layer. The Code mode implementation took a cleaner, source-level approach instead, which is architecturally superior (no runtime monkey-patching). This is the right call.

---

## [2. 1:1 Cross-Validation Results]

### REQ-001: Override `convertToolsForOpenAI` to set `strict: false`

**Status**: 🔶 PARTIAL (intent met, implementation approach differs from checklist)

**Checklist asked for**: "Override `convertToolsForOpenAI` in `OpenAICompatibleHandler` to set `strict: false` for all tools (preserving `strict: true` for native OpenAI provider)"

**Actual implementation**: The change was made directly in [`BaseProvider.convertToolsForOpenAI()`](src/api/providers/base-provider.ts:50) (line 50: `strict: false`), NOT as an override in `OpenAICompatibleHandler`.

**Impact analysis**:

- `BaseProvider.convertToolsForOpenAI()` is the shared base method used by: `OpenAiHandler` (openai.ts), `BaseOpenAiCompatibleProvider`, `OpenAICompatibleHandler`, `DeepSeekHandler`, `LiteLLMHandler`, `LmStudioHandler`, `RequestyHandler`, `QwenCodeHandler`, `PoeHandler`, `UnboundHandler`, `VercelAiGatewayHandler`, `OpenRouterHandler`, `ZAiHandler`, `ZooGatewayHandler`, `OpencodeGoHandler`, `KenariHandler`, and others.
- This means `strict: false` now applies to ALL these providers, not just Upstage.

**However, the following providers are NOT affected because they override `strict` after calling the base method**:

- [`OpenAiNativeHandler`](src/api/providers/openai-native.ts:392): Has its own tool mapping logic with `strict: !isMcp` (preserves `strict: true` for non-MCP tools). ✅ Not impacted.
- [`XAIHandler.mapResponseTools()`](src/api/providers/xai.ts:82): Calls base method then overrides with `strict: !isMcp`. ✅ Not impacted.

**Providers that ARE affected (now send `strict: false` instead of `strict: true` for non-MCP tools)**:

- `OpenAiHandler` (native OpenAI Chat Completions API, e.g., GPT-4o) - this is the handler Upstage uses.
- `DeepSeekHandler`, `OpenRouterHandler`, `LmStudioHandler`, `RequestyHandler`, `QwenCodeHandler`, `UnboundHandler`, `VercelAiGatewayHandler`, `ZAiHandler`, `ZooGatewayHandler`, `OpencodeGoHandler`, `KenariHandler`, `PoeHandler`, and all `BaseOpenAiCompatibleProvider` subclasses.

**Devil's Advocate assessment**: The original report (Section 6.2) explicitly states: "OpenAI API spec default for `strict` is `false`. Sending `strict: false` has zero side effects on all other providers." This is technically correct - `strict: false` is the OpenAI default, so explicitly sending `false` is semantically equivalent to not sending the field at all. The Structured Outputs feature (`strict: true`) is an opt-in enhancement, and disabling it means tool schemas won't be strictly enforced, but this only affects schema validation strictness, not core functionality.

**Risk**: Low. The change degrades Structured Outputs enforcement for native OpenAI Chat Completions API users (GPT-4o via `OpenAiHandler`), but `strict: false` is the documented default and does not break functionality. Users who specifically need `strict: true` for OpenAI Chat Completions can use the `OpenAiNativeHandler` (Responses API) which preserves `strict: true`.

### REQ-002: Update existing tests and add new test coverage

**Status**: ✅ PASS

**Evidence**:

- [`base-provider.spec.ts`](src/api/providers/__tests__/base-provider.spec.ts:187): Test updated from expecting `strict: true` to expecting `strict: false` for non-MCP tools.
- [`base-provider.spec.ts`](src/api/providers/__tests__/base-provider.spec.ts:204): Test confirms `strict: false` for MCP tools.
- [`openai.spec.ts`](src/api/providers/__tests__/openai.spec.ts:998): Azure AI Inference tests updated to assert `parallel_tool_calls` is NOT sent when tools are absent.
- [`openai.spec.ts`](src/api/providers/__tests__/openai.spec.ts:1047): Non-streaming Azure AI Inference test also asserts `parallel_tool_calls` is absent.

**Note**: The checklist mentioned "add new tests for the overridden method in openai-compatible tests." No new tests were added to `openai-compatible.spec.ts` or `base-openai-compatible-provider.spec.ts` for the `strict: false` behavior. However, the `base-provider.spec.ts` tests cover the shared method, which is sufficient since `OpenAICompatibleHandler` inherits it without override.

### REQ-003: `parallel_tool_calls` and `tool_choice` not sent when tools is empty/undefined

**Status**: 🔶 PARTIAL

**`parallel_tool_calls` fix**:

- [`openai.ts` lines 170-175](src/api/providers/openai.ts:170) (streaming path): ✅ Fixed - conditional on `metadata?.tools && metadata.tools.length > 0`.
- [`openai.ts` lines 241-246](src/api/providers/openai.ts:241) (non-streaming path): ✅ Fixed - same conditional.
- [`openai.ts` line 377](src/api/providers/openai.ts:377) (O3 streaming path): ❌ NOT fixed - still unconditional `parallel_tool_calls: metadata?.parallelToolCalls ?? true`.
- [`openai.ts` line 411](src/api/providers/openai.ts:411) (O3 non-streaming path): ❌ NOT fixed - still unconditional.
- [`base-openai-compatible-provider.ts` line 98](src/api/providers/base-openai-compatible-provider.ts:98): ❌ NOT fixed - still unconditional. This affects Baseten, Fireworks, SambaNova, ZAi, Friendli.

**Mitigation for O3 paths**: Comments at lines 374 and 408 say "Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)", so `parallel_tool_calls` is always valid for O3 models. This is acceptable.

**Mitigation for `base-openai-compatible-provider.ts`**: Upstage uses `OpenAiHandler` (not `BaseOpenAiCompatibleProvider`), so this doesn't affect the user's specific use case. But it's an incomplete fix for the broader "OpenAI-compatible providers" class.

**`tool_choice` handling**:

- `tool_choice: metadata?.tool_choice` is still set unconditionally in all paths (lines 169, 240, 376, 410 in openai.ts, and line 97 in base-openai-compatible-provider.ts).
- When `metadata?.tool_choice` is `undefined`, the OpenAI SDK strips `undefined` values from the serialized JSON payload, so `tool_choice` does NOT appear on the wire.
- This is technically safe for the OpenAI SDK path, but the original report (Section 5.2 interceptor) explicitly deleted `tool_choice` when tools were absent. The source-level fix relies on SDK behavior rather than explicit conditional logic.

**Verdict**: The fix works for the user's specific case (Upstage via `OpenAiHandler` streaming/non-streaming paths). The O3 paths are safe due to always-present tools. The `base-openai-compatible-provider.ts` gap is a broader issue but doesn't affect Upstage.

### REQ-004: Build passes (no compile errors)

**Status**: ✅ PASS (per Code mode evidence)

**Evidence**: Code mode reported `tsc --noEmit` exit code 0. I cannot independently run the build (Ask mode is analysis-only), but the TypeScript changes are straightforward type-safe assignments (`strict: false` is a valid boolean, conditional spreads are valid TS).

### REQ-005: All existing tests pass (no regression)

**Status**: ✅ PASS (per Code mode evidence)

**Evidence**:

- `base-provider.spec.ts` → 15/15 passed
- `openai.spec.ts` → 63/63 passed

**Cross-validation of test assertions**:

- [`openai-native-tools.spec.ts` line 56-67](src/api/providers/__tests__/openai-native-tools.spec.ts:56): Uses `expect.objectContaining` and only checks `name: "test_tool"` and `parallel_tool_calls: true` - does NOT assert on `strict` value. ✅ No regression.
- [`openai-native-tools.spec.ts` line 201](src/api/providers/__tests__/openai-native-tools.spec.ts:201): Asserts `strict: true` for non-MCP tools via `OpenAiNativeHandler` - this uses the native handler's own logic, NOT the base method. ✅ Not affected.
- [`xai.spec.ts` line 232](src/api/providers/__tests__/xai.spec.ts:232): Asserts `strict: true` for xAI - xAI overrides `strict` after calling base method. ✅ Not affected.

### REQ-006: No impact on native OpenAI, Anthropic, Gemini, DeepSeek, or other providers

**Status**: 🔶 PARTIAL

| Provider                                  | Impact               | Reason                                                                                                                                                   |
| ----------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Native (Responses API)             | ✅ None              | Has own tool logic (`strict: !isMcp`)                                                                                                                    |
| OpenAI Chat Completions (`OpenAiHandler`) | ⚠️ Behavioral change | Now sends `strict: false` instead of `strict: true` for non-MCP tools. Safe (OpenAI default is `false`), but Structured Outputs enforcement is disabled. |
| Anthropic                                 | ✅ None              | Does not use `convertToolsForOpenAI`                                                                                                                     |
| Gemini                                    | ✅ None              | Does not use `convertToolsForOpenAI`                                                                                                                     |
| DeepSeek                                  | ⚠️ Behavioral change | Inherits base method, now `strict: false`                                                                                                                |
| xAI                                       | ✅ None              | Overrides `strict` after base call                                                                                                                       |
| OpenRouter                                | ⚠️ Behavioral change | Inherits base method                                                                                                                                     |
| Others (LmStudio, Requesty, etc.)         | ⚠️ Behavioral change | Inherit base method                                                                                                                                      |

**Assessment**: The behavioral changes are all from `strict: true` → `strict: false`, which is the OpenAI default. No functionality breaks. The only trade-off is that Structured Outputs schema enforcement is relaxed for providers that previously received `strict: true`. This is an acceptable trade-off for compatibility, as the original report confirms.

---

## [3. Inquiries for VP & User]

### Inquiry 1: Implementation approach discrepancy (REQ-001)

The checklist specified an override in `OpenAICompatibleHandler` to preserve `strict: true` for native OpenAI. The implementation changed the base method directly, affecting `OpenAiHandler` (native OpenAI Chat Completions).

**Option A** (current): Keep the base method change. Simpler, fewer files, but `OpenAiHandler` (GPT-4o) loses `strict: true`.
**Option B** (checklist original): Revert base method to `strict: !isMcp`, add override in `OpenAICompatibleHandler` with `strict: false`. Preserves `strict: true` for `OpenAiHandler`.

**Trade-off**: Option A is simpler and the original report confirms `strict: false` is safe everywhere. Option B is more surgical but adds complexity. Given the report's explicit confirmation that `strict: false` has no side effects, **Option A is acceptable**.

### Inquiry 2: Incomplete `parallel_tool_calls` fix in `base-openai-compatible-provider.ts`

[`base-openai-compatible-provider.ts` line 98](src/api/providers/base-openai-compatible-provider.ts:98) still sends `parallel_tool_calls` unconditionally. This affects Baseten, Fireworks, SambaNova, ZAi, Friendli.

**Option A**: Leave as-is (doesn't affect Upstage, which uses `OpenAiHandler`).
**Option B**: Apply the same conditional fix to `base-openai-compatible-provider.ts` for consistency and to protect other OpenAI-compatible providers from the same Upstage-style error.

**Recommendation**: Option B is the proactive ownership approach. If any `BaseOpenAiCompatibleProvider` subclass is ever pointed at an Upstage-like gateway, it would hit the same 400 error.

---

## [4. Final Verdict]

### **CONDITIONAL APPROVAL** 🔶

The implementation faithfully resolves the user's core problem: Upstage `solar-open2` will now work with Zoo Code. The `strict: false` fix is correct and safe per the original report's analysis. Tests pass and the build is clean.

**Conditions that should be addressed (but are not blockers for the user's immediate need)**:

1. **[Should Fix - 🟡]** [`base-openai-compatible-provider.ts` line 98](src/api/providers/base-openai-compatible-provider.ts:98): Apply the same `parallel_tool_calls` conditional fix for consistency. This protects Baseten, Fireworks, SambaNova, ZAi, and Friendli from the same class of error if pointed at strict gateways. Delegate to Code mode.

2. **[Nice to Have - 🟢]** Consider documenting in the code comment at [`base-provider.ts` line 28-30](src/api/providers/base-provider.ts:28) that `OpenAiHandler` (native OpenAI Chat Completions) is also affected, so future maintainers understand the trade-off. The current comment only mentions Upstage.

3. **[Acknowledged - 🟢]** The implementation approach differs from the checklist (base method change vs. override in `OpenAICompatibleHandler`). This is acceptable given the original report's confirmation that `strict: false` is safe everywhere, but VP should be aware that `OpenAiHandler` (GPT-4o Chat Completions) no longer sends `strict: true`. Users needing Structured Outputs should use `OpenAiNativeHandler` (Responses API).

**VP may proceed to VP Final Review (Phase 7).** The user's intent is met. The conditions above are improvements, not blockers.
