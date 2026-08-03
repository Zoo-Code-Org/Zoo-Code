# Code Light Task Report: Bug #7 - ExtensionStateContext stale closure

## Task Summary
Fixed stale closure bug in `mutateTaskOrganization` where rapid calls captured the same `baseRevision` from React state closure before re-render, causing duplicate/stale revision values sent to the extension.

## Actions Taken
1. Read `webview-ui/src/context/ExtensionStateContext.tsx` in worktree
2. Identified stale closure: `state.taskOrganization?.revision` captured in `useCallback` with dependency `[state.taskOrganization?.revision]` — each rapid call reads the same pre-re-render value
3. Added `taskOrgRevisionRef = useRef<number>(0)` alongside existing `pendingTaskOrgMutations` ref
4. Added `useEffect` that syncs `taskOrgRevisionRef.current = state.taskOrganization?.revision ?? 0` whenever the revision changes
5. Changed `mutateTaskOrganization` to read from `taskOrgRevisionRef.current` instead of the closure-captured `state.taskOrganization?.revision`
6. Changed `useCallback` dependency array from `[state.taskOrganization?.revision]` to `[]` since the ref always has the latest value

## Result
✅ Success — surgical fix applied to single file

## Issues Discovered
- Worktree lacks `node_modules` so full TypeScript type-checking cannot be run; the 2 pre-existing TS2688 errors (missing `node` and `vitest/globals` type defs) are unrelated to this change
- No runtime test possible in worktree environment without dependencies installed

## Next Step Recommendations
- VP should verify build in full workspace after merge
- Consider running vitest for any existing ExtensionStateContext tests

## Affected File List
- `webview-ui/src/context/ExtensionStateContext.tsx` (lines 206, 528-548, 549-556)
