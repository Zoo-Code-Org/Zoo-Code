# Code Mode Task Report

## Task Summary

Fixed Upstage solar-open2 `strict: true` compatibility issue by disabling strict mode for all tools and making `parallel_tool_calls` conditional on tools being present.

## Actions Taken

### Fix 1: `src/api/providers/base-provider.ts`

- Changed `strict: !isMcp` to `strict: false` on line 48.
- Updated the JSDoc comment (lines 25-29) to explain why `strict` is always `false` (Upstage solar-open2 rejects `strict: true` with HTTP 400; OpenAI's own default is `false`, so this is safe for all providers).

### Fix 2: `src/api/providers/openai.ts`

- **Streaming path (line 170)**: Made `parallel_tool_calls` conditional — only sent when `metadata.tools` is non-empty.
- **Non-streaming path (line 236)**: Same conditional change applied.

### Fix 3: Test updates

- `src/api/providers/__tests__/base-provider.spec.ts`: Updated the test expecting `strict: true` for non-MCP tools to expect `strict: false`.
- `src/api/providers/__tests__/openai.spec.ts`: Updated two Azure AI Inference Service tests that expected `parallel_tool_calls: true` — removed the expectation and added assertions that `parallel_tool_calls` is NOT present when no tools are supplied.

## Result

✅ Success

### Verification Evidence

1. `cd src && npx vitest run api/providers/__tests__/base-provider.spec.ts` → 15/15 passed
2. `cd src && npx vitest run api/providers/__tests__/openai.spec.ts` → 63/63 passed
3. `cd src && npx tsc --noEmit` → exit code 0 (no type errors)

## Issues Discovered

None beyond what was identified in the VP's root cause analysis.

## Next Step Recommendations

- VP should verify with a live Upstage solar-open2 API call to confirm the 400 error is resolved.
- Consider adding a provider capability flag for `strict` mode support if any provider specifically requires `strict: true` in the future (currently safe since OpenAI default is `false`).

## Affected File List

- `src/api/providers/base-provider.ts`
- `src/api/providers/openai.ts`
- `src/api/providers/__tests__/base-provider.spec.ts`
- `src/api/providers/__tests__/openai.spec.ts`
