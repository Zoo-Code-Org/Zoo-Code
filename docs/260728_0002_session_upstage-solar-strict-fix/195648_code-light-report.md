# Code Light Task Report

## Task Summary

Fix `parallel_tool_calls` being sent unconditionally in `base-openai-compatible-provider.ts`. Some OpenAI-compatible providers (e.g. Upstage solar-open2) reject this field when no tools are supplied.

## Actions Taken

1. Located the unconditional `parallel_tool_calls` assignment at [line 98](src/api/providers/base-openai-compatible-provider.ts:98) in `base-openai-compatible-provider.ts`
2. Replaced it with the same conditional spread pattern already used in [`openai.ts`](src/api/providers/openai.ts:170):
    ```typescript
    ...(metadata?.tools && metadata.tools.length > 0
        ? { parallel_tool_calls: metadata?.parallelToolCalls ?? true }
        : {}),
    ```
3. Added an explanatory comment matching the one in `openai.ts`
4. Ran unit tests: **15/15 passed** (`base-openai-compatible-provider.spec.ts`)
5. Ran TypeScript type check: **0 errors** (`tsc --noEmit`)

## Result

✅ Success

## Issues Discovered

None. The fix was straightforward and matched the existing pattern in `openai.ts` exactly.

## Next Step Recommendations

- The audit report may also flag similar patterns in other provider files (e.g. `openai-native.ts`). VP should check whether those need the same conditional treatment.
- Consider adding a test case that verifies `parallel_tool_calls` is NOT sent when tools array is empty, to prevent regression.

## Affected File List

- [`src/api/providers/base-openai-compatible-provider.ts`](src/api/providers/base-openai-compatible-provider.ts:96) (lines 96-101)
