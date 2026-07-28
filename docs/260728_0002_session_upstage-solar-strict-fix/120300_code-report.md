# Code Task Report: Add openAiToolStrictMode to provider-settings types

## Task Summary

Added the `openAiToolStrictMode?: boolean` field to the OpenAI Compatible provider schema in `packages/types/src/provider-settings.ts`, along with tests verifying optionality, default behavior, and backward compatibility.

## Actions Taken

1. Read the architect report (`docs/260728_0002_session_upstage-solar-strict-fix/114950_architect-report.md`) sections 1 and 3 for the full specification.
2. Read `packages/types/src/provider-settings.ts` to locate the `openAiSchema` (line 231) which defines the OpenAI Compatible (`apiProvider: "openai"`) profile.
3. Added `openAiToolStrictMode: z.boolean().optional()` to `openAiSchema` with a comment documenting: profile-scoped, absent = false (backward compatible).
4. Read `packages/types/src/__tests__/provider-settings.test.ts` to understand existing test patterns.
5. Added a new `describe("openAiToolStrictMode")` block with 5 test cases:
    - Field is optional and absent by default
    - Accepts `true` when provided
    - Accepts `false` when provided
    - Does not break existing profile deserialization when absent
    - Only exists on the `openai` (OpenAI Compatible) provider profile, not on `anthropic`
6. Fixed TypeScript discriminated union type narrowing issue by adding `apiProvider` guards before accessing provider-specific fields.
7. Ran verification: `npx vitest run src/__tests__/provider-settings.test.ts` (21 tests passed) and `npx tsc --noEmit` (exit code 0).

## Result

**Success.** All 21 tests pass and TypeScript compilation succeeds with no errors.

## Issues Discovered

- The discriminated union type (`providerSettingsSchemaDiscriminated`) requires `apiProvider` narrowing before accessing provider-specific fields like `openAiToolStrictMode`. The initial test accessed these fields directly on the union type, causing TS2339 errors. Fixed by adding `if (result.apiProvider === "openai")` guards.

## Next Step Recommendations

- Task C-2: Add the UI toggle in `webview-ui/src/components/settings/providers/OpenAICompatible.tsx`
- Task C-3: Add i18n strings for the toggle label in `webview-ui/src/i18n/locales/en/settings.json`
- Task C-4: Wire the field through the handler in `src/api/providers/openai.ts` and `src/api/providers/base-provider.ts`

## Affected File List

- `packages/types/src/provider-settings.ts` (modified: added `openAiToolStrictMode` field to `openAiSchema`)
- `packages/types/src/__tests__/provider-settings.test.ts` (modified: added 5 test cases for the new field)
