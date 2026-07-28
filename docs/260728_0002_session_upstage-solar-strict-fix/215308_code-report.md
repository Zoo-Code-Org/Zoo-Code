# Code Task Report: Wire strict setting into openai.ts request paths

## Task Summary

Wired the profile-scoped `openAiToolStrictMode` setting into all four `convertToolsForOpenAI` call sites in `src/api/providers/openai.ts`, covering streaming, non-streaming, and O1/O3-family request paths.

## Actions Taken

1. Read the architect report (Sub-task 4 specification) to confirm the exact wiring requirement: pass `this.options.openAiToolStrictMode ?? false` to all four tool-conversion call sites.
2. Searched all `convertToolsForOpenAI` call sites across the provider directory. Found 4 call sites in `openai.ts` (lines 168, 239, 375, 409), plus calls in `openai-compatible.ts` (line 165) and `base-openai-compatible-provider.ts` (line 96).
3. Verified the `openAiToolStrictMode` field exists in `packages/types/src/provider-settings.ts` (line 242) and is carried through `ApiHandlerOptions` (which extends `ProviderSettings`).
4. Applied surgical edits to all 4 call sites in `openai.ts`, changing each from `this.convertToolsForOpenAI(metadata?.tools)` to `this.convertToolsForOpenAI(metadata?.tools, this.options.openAiToolStrictMode ?? false)`.
5. Verified `openai-compatible.ts` and `base-openai-compatible-provider.ts` call `convertToolsForOpenAI` without the `strictMode` argument, so they use the default `false`. No changes needed per architect spec.
6. Ran all three verification commands.

## Result

**Success.** All tests pass and TypeScript compiles cleanly.

### Verification Evidence

- `cd src && npx vitest run api/providers/__tests__/openai.spec.ts` — 63 tests passed (exit code 0)
- `cd src && npx vitest run api/providers/__tests__/base-provider.spec.ts` — 20 tests passed (exit code 0)
- `cd src && npx tsc --noEmit` — exit code 0, no type errors

## Issues Discovered

None. The implementation was straightforward. The C-3 `convertToolsForOpenAI` signature already accepts a positional `strictMode: boolean` parameter with a `false` default, so the wiring was a clean one-argument addition per call site.

## Next Step Recommendations

- Sub-task 5 (persistence and cross-boundary verification) can proceed to confirm round-trip profile persistence and handler rebuild behavior.
- Consider adding dedicated test cases in `openai.spec.ts` that assert `strict: true` is emitted for native tools when `openAiToolStrictMode: true` is set, and `strict: false` for MCP tools under the same setting. The existing tests pass but may not yet cover the strict-mode-enabled path explicitly.

## Affected File List

- `src/api/providers/openai.ts` (4 call sites modified)
