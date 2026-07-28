# Code Task Report: C-3 — BaseProvider.convertToolsForOpenAI() strict/non-strict schema

## Task Summary

Modified `BaseProvider.convertToolsForOpenAI()` to accept an optional `strictMode` parameter (boolean, default false). When `strictMode` is true, non-MCP function tools get `strict: true` with hardened schemas via `convertToolSchemaForOpenAI()`. When false (default), non-MCP tools get `strict: false` with original best-effort schemas preserved. MCP tools are always `strict: false` with original parameters, regardless of the setting.

## Actions Taken

1. Read architect report section 3 (Sub-task 3) for Option A specification.
2. Inventoried all 23 call sites of `convertToolsForOpenAI` across the codebase to confirm the optional parameter with default `false` preserves backward compatibility for all existing callers (deepseek, openrouter, xai, lm-studio, etc.).
3. Modified `convertToolsForOpenAI()` in `src/api/providers/base-provider.ts`:
    - Added `strictMode: boolean = false` parameter.
    - Split into three branches: MCP tools (always strict false, original schema), non-MCP strict true (hardened schema), non-MCP strict false (original schema).
    - Fixed the semantic inconsistency: previously `strict: false` still applied `convertToolSchemaForOpenAI()` which hardened the schema (additionalProperties: false, all required). Now strict false preserves the original best-effort schema.
4. Updated test wrapper `testConvertToolsForOpenAI()` to accept and forward `strictMode`.
5. Rewrote the `convertToolsForOpenAI` test suite with a full matrix:
    - strictMode=false: non-MCP strict false + original schema preserved (no hardening, nullable types preserved)
    - strictMode=false: MCP strict false + original schema preserved
    - strictMode=true: non-MCP strict true + schema hardened (additionalProperties, required, nested objects/arrays)
    - strictMode=true: MCP always strict false + original schema preserved (nullable types preserved)
    - Non-function tools pass through unchanged
    - Undefined input returns undefined

## Result

**Success.** All verification passed:

- `cd src; npx vitest run api/providers/__tests__/base-provider.spec.ts` — 20/20 tests pass (1.00s)
- `cd src; npx tsc --noEmit` — exit code 0, no type errors

## Issues Discovered

1. **Semantic inconsistency fixed**: The previous implementation set `strict: false` but still applied `convertToolSchemaForOpenAI()`, which added `additionalProperties: false` and marked all properties as required. This was semantically incorrect — `strict: false` should mean best-effort schema, not a hardened one. This is now fixed: strict false preserves the original schema as-is.

2. **Backward compatibility**: All 23 existing callers call `convertToolsForOpenAI(tools)` without the second argument. The default `false` preserves their current behavior (strict false), but now with original schemas instead of hardened ones. This is the correct semantic change per the architect's Option A specification. Sub-task C-4 will wire the actual `openAiToolStrictMode` profile setting into the OpenAI handler call sites.

## Next Step Recommendations

- **C-4 (Sub-task 4)**: Wire `this.options.openAiToolStrictMode ?? false` into all four `convertToolsForOpenAI()` call sites in `src/api/providers/openai.ts` (normal streaming, normal non-streaming, O1/O3 streaming, O1/O3 non-streaming).
- **C-5 (Sub-task 5)**: Verify persistence round-trip and handler rebuild with the strict setting.

## Affected File List

- `src/api/providers/base-provider.ts` — modified `convertToolsForOpenAI()` signature and logic
- `src/api/providers/__tests__/base-provider.spec.ts` — updated test wrapper and rewrote test suite
