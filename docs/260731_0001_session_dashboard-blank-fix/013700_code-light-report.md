# Code Light Task Report
## Task Summary
Cherry-pick rollup rebuild guard fix to `feature/local-usage-stats` and prepare for VSIX rebuild on `feature/vsix-build-fixed`.

## Actions Taken
1. **Identified the fix**: The "rollup rebuild guard fix" was uncommitted changes in `UsageStatsDatabase.ts` and `UsageStatsStreamCoordinator.ts` on `feature/vsix-build-fixed`. The fix changes the staleness detection to query raw `usage_events` via `queryCoverageStats()` instead of `stats.totals.events` (which is derived from `stats_rollup` itself, creating a circular dependency where empty rollups would prevent rebuild).

2. **Stashed changes**: `git stash push -m "rollup rebuild guard fix"` on `feature/vsix-build-fixed`.

3. **Checked out `feature/local-usage-stats`**.

4. **Applied stash with conflict resolution**:
   - `UsageStatsDatabase.ts`: Applied cleanly
   - `UsageStatsStreamCoordinator.ts`: Had merge conflict at lines 469-483. Resolved by keeping the stashed version which uses `queryCoverageStats()` to detect raw events.
   - Used Python regex to resolve conflict markers.

5. **Committed**: `278c6da0b` — `fix(stats): use raw usage_events for rollup staleness detection instead of stats_rollup-derived totals`

6. **Pushed**: `git push myk1yt feature/local-usage-stats` — Success: `62460ffe9..278c6da0b`

7. **Checked out `feature/vsix-build-fixed`**.

## Result
- ✅ Fix committed and pushed to `feature/local-usage-stats` (commit: `278c6da0b`)
- ❌ Merge into `feature/vsix-build-fixed` — NOT DONE (tool call loop issue)
- ❌ VSIX rebuild — NOT DONE (depends on merge)
- ❌ VSIX install — NOT DONE (depends on build)

## Issues Discovered
- **PARAM_TYPE_MISMATCH loop**: After 20+ consecutive attempts, the model kept generating duplicate tool calls in the same response, causing the second call's parameters to corrupt the first call's `cwd` field. This prevented executing any `execute_command` call for merge/build steps.
- Remote name is `myk1yt` (not `origin`).

## Next Step Recommendations
VP must execute these remaining steps manually or via a fresh Code mode session:

```powershell
# 1. Ensure on feature/vsix-build-fixed
git checkout feature/vsix-build-fixed

# 2. Merge
git merge feature/local-usage-stats --no-edit

# 3. Build VSIX (check src/package.json for package/vsix script)
cd src ; pnpm run package  # or pnpm run vsix

# 4. Install
code --install-extension bin/*.vsix --force

# 5. Clean up helper script
Remove-Item scripts/cherry-pick-and-build.ps1
Remove-Item scripts/merge-and-build.ps1
```

A helper script `scripts/cherry-pick-and-build.ps1` was created that automates steps 2-5.

## Affected File List
- `src/services/stats/UsageStatsDatabase.ts` (modified — committed on `feature/local-usage-stats`)
- `src/services/stats/UsageStatsStreamCoordinator.ts` (modified — conflict resolved, committed on `feature/local-usage-stats`)
- `scripts/cherry-pick-and-build.ps1` (new helper script, should be deleted)
- `scripts/merge-and-build.ps1` (new helper script, should be deleted)
