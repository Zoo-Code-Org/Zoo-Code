# Code Task Report: Strict Toggle UI + Reasoning Effort Fix in OpenAICompatible.tsx

## Task Summary

Added a buffered strict tool schemas toggle to the OpenAI Compatible provider settings UI, fixed the unsafe reasoning effort type cast, and expanded the reasoning effort capability list to include `max`.

## Actions Taken

### 1. Added strict tool schemas toggle (`openAiToolStrictMode`)

In [`OpenAICompatible.tsx`](webview-ui/src/components/settings/providers/OpenAICompatible.tsx:165), added a `Checkbox` bound to `apiConfiguration?.openAiToolStrictMode ?? false` (defaults unchecked), placed between the streaming toggle and the max-tokens toggle. Uses the same `handleInputChange("openAiToolStrictMode", noTransform)` pattern as other checkboxes, which calls `setApiConfigurationField` on the buffered `apiConfiguration` prop. This follows the Settings View Pattern from AGENTS.md: inputs bind to the local `cachedState` (passed as `apiConfiguration`), not live `useExtensionState()`.

### 2. Fixed reasoning effort type cast

Replaced the unsafe narrow cast `value as ReasoningEffort` with `value as ReasoningEffortExtended` at line 279. The import was updated from `type ReasoningEffort` to `type ReasoningEffortExtended` from `@roo-code/types`. The `ReasoningEffortExtended` type includes `"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`, which is the correct wire-level superset.

### 3. Expanded reasoning effort capability list

Updated the `supportsReasoningEffort` array passed to `ThinkingBudget` from `["low", "medium", "high", "xhigh"]` to `["low", "medium", "high", "xhigh", "max"]`, matching the OpenAI-compatible superset documented in the architect report.

### 4. Added i18n translations

In [`settings.json`](webview-ui/src/i18n/locales/en/settings.json:1061), added two new keys under `modelInfo`:

- `strictToolSchemas`: "Strict tool schemas"
- `strictToolSchemasDescription`: "Enables strict mode for function tool schemas, ensuring tool outputs match the schema exactly. Some providers may not support strict mode. MCP tools are always kept non-strict regardless of this setting."

The existing `reasoningEffort.xhigh` ("Extra High") and `reasoningEffort.max` ("Max") translations at lines 717-718 were already present, so no changes were needed there.

## Result

**Success.** All changes compile and pass tests.

- `npx tsc --noEmit` in `webview-ui/`: exit code 0, no errors.
- `npx vitest run src/components/settings/__tests__/ApiOptions.spec.tsx`: 21 tests passed.
- `npx vitest run src/components/settings/__tests__/ThinkingBudget.spec.tsx`: 25 tests passed.

## Issues Discovered

No additional issues found. The `ReasoningEffortExtended` type was already exported from `@roo-code/types` and the `openAiToolStrictMode` field was already present in `packages/types/src/provider-settings.ts` (Task C-1).

## Next Step Recommendations

- Sub-task 3 (base-provider.ts converter policy) and Sub-task 4 (openai.ts handler wiring) are the next implementation tasks per the architect plan.
- Translation locale files under `webview-ui/src/i18n/locales/*/settings.json` should be updated by the translation workflow for the two new English keys.

## Affected File List

- `webview-ui/src/components/settings/providers/OpenAICompatible.tsx`
- `webview-ui/src/i18n/locales/en/settings.json`
