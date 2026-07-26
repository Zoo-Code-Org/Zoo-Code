# Debug Task Report: feature/local-usage-stats Contamination Cleanup

## Task Summary
Remove contamination from the local `feature/local-usage-stats` branch. The branch was supposed to be Dashboard/stats-only but had absorbed SHELL, ERROR-interception, MiMo, STRICT, and upstream-merge commits during the 260729 branch-recovery session. Goal: produce a clean branch containing only the user's dashboard/stats work plus their latest dashboard streaming fix, on top of current `main`.

## Root Cause Analysis

### Branch topology (verified via `git merge-base` / `git cherry`)
- Local `feature/local-usage-stats` (tip `6e08422f1`) and remote `myk1yt/feature/local-usage-stats` (tip `9968e390d`) shared merge-base `d5a8c4a3c`. They had **diverged**: 100 local-only commits vs 42 remote-only commits.
- The remote's 42 commits were **pure stats/dashboard work** but were built on a **stale base** — the remote was 24 commits behind `main` (its `@types/node` was still `20.19.43`).
- Of the 100 local-only commits:
  - 16 were upstream commits already present in `main` (the `9c10c6c62`..`9762e0e0f` Release/refactor batch, confirmed via `git cherry main`).
  - The rest were SHELL (`feat(terminal)`), ERROR (`feat(error-interception)`), MiMo (`feat: wire MiMo`, ghost-quarantine), STRICT (`strict tool schema`), plus the clean stats block.
- The clean stats block (`f7382fb43`..`788f11aaa`) was **patch-equivalent** to the remote's 42 commits.
- The only stats work **unique to local** (not in remote, not in main) was the tail: `6e08422f1 feat(stats): distribute dashboard streaming code`.

### Key discovery: `6e08422f1` was itself contaminated
The commit `6e08422f1` (the "latest dashboard fix" to keep) was authored on the contaminated HEAD. When cherry-picked onto a clean base, it re-introduced:
- **SHELL**: `TerminalShellSelection` import, `terminalShellOptions` response type, `requestTerminalShellOptions`/`setTerminalShellSelection`/`requestCustomShellPath` message types.
- **MiMo**: the entire Ghost-quarantine block in `Task.ts` (`classifyStreamedCall`, `isProvablyEmptyGhost`, `resolveToolCallPolicy`, `emitGhostDropTelemetry`).

A naive cherry-pick would have defeated the cleanup. The fix therefore required **surgical decontamination** during conflict resolution.

### Second discovery: base had to be current `main`, not the remote tip
Initial approach (build on remote tip) failed `pnpm check-types` with:
`services/stats/UsageStatsDatabase.ts(1,30): error TS2307: Cannot find module 'node:sqlite'`.
Cause: `UsageStatsDatabase.ts` uses the Node 22 experimental builtin `node:sqlite`. The remote tip pins `@types/node@20.19.43` (no `sqlite.d.ts`), while `main` and the contaminated HEAD use `@types/node@22.20.1`. The remote's stats commits were valid on their old base but the streaming commit required the Node-22 type baseline. Resolution: **rebase the stats commits onto current `main`** instead of building on the stale remote tip.

## Actions Taken

1. **Recon & classification**: Used `git merge-base`, `git cherry`, `git log --not`, and `git ls-tree` to prove local/remote divergence and classify all 100 local commits into contamination vs. keepers.
2. **Backups created**: `feature/local-usage-stats-backup` (original tip) — later supplemented by renaming the original branch to `feature/local-usage-stats-contaminated-backup`. Pre-existing `backup/feature/local-usage-stats` left untouched.
3. **Built clean branch** in a temp git worktree (`.clean-wt`) to avoid the untracked-file checkout blocker:
   - Started from remote tip, cherry-picked `6e08422f1`.
   - Resolved 3 conflicted files, **keeping only the dashboard-streaming parts and dropping shell/mimo contamination**:
     - `packages/types/src/vscode-extension-host.ts`: kept streaming response/request types; dropped all terminal-shell types; removed a BOM.
     - `src/core/task/Task.ts`: dropped the entire MiMo ghost-quarantine block (3 regions); kept the clean `finalizeStreamingToolCall` logic.
     - `src/core/webview/webviewMessageHandler.ts`: kept the streaming handler imports and case-blocks (verified the cherry-picked `usageStatsMessageHandler.ts` exports them).
   - Result: streaming commit `e0aa7f809` (decontaminated).
4. **Rebased onto `main`** (42 stats + 1 streaming): resolved 2 further `webviewMessageHandler.ts` conflicts by merging the streaming cases with `main`'s newer `await provider.showTaskWithId(...)` form. Final streaming commit: `3372af827`.
5. **Verified decontamination**: zero references to `TerminalShellSelection`, `classifyStreamedCall`, `resolveToolCallPolicy`, `emitGhostDropTelemetry`, `terminalShellOptions`, `isProvablyEmptyGhost` in `src/`, `packages/`, `webview-ui/`.
6. **Swapped branches**: original → `feature/local-usage-stats-contaminated-backup`; clean → `feature/local-usage-stats`. Removed temp worktree. Moved untracked blocker docs aside and restored them (their content was already tracked/identical), and recycled junk temp logs.

## Result: SUCCESS

- **`feature/local-usage-stats`** (tip `3372af827c1447e4cf65f1859111c02eb0f6f954`) is now a clean, stats-only branch: **42 commits on top of `main` (`569b43df9`)**, from `5b1b186f4 feat(stats): define usage event and message contracts` through `3372af827 feat(stats): distribute dashboard streaming code`.
- **No SHELL/ERROR/MIMO-feature/STRICT commits or symbols remain.** (The only `mimo`-named matches are `packages/types/src/providers/mimo.ts`, which is pre-existing in `main`, and its pricing-update diff from the legitimate stats commit `86f0a70eb` that keeps the dashboard's MiMo cost figures accurate.)

### Verification evidence
| Check | Result |
|---|---|
| `git log feature/local-usage-stats --not main` contamination scan | No terminal/shell/error-interception/mimo-feature/strict/task-dnd commits |
| Symbol grep for mimo/shell markers | 0 matches |
| `pnpm check-types` (turbo, 14 packages) | **11 successful, exit 0** |
| Backend stats: `UsageAggregator.spec` + `UsageStatsStreamCoordinator.spec` | **114 passed** |
| Backend wiring: `usageStatsMessageHandler.spec` + `usageStatsMessageRouting.spec` | **72 passed** |
| Webview: `src/components/dashboard/` | **120 passed (7 files)** |

## Test Environment Issues (fixed / worked around)

1. **pnpm not on PATH in non-interactive shell.** `pnpm` was not a recognized command. Fixed by invoking the full path `$env:APPDATA\npm\pnpm.cmd` (pnpm 10.8.1, matching `packageManager`).
2. **`node:sqlite` + vitest hang under Node 24 (environment mismatch).** The project pins Node `22.23.1` (`.nvmrc`/engines) but the shell runs Node `v24.16.0`. The sqlite-dependent specs (`UsageStatsDatabase`, `UsageStatsMigration`, `UsageStatsProjection`) caused vitest worker processes to enter a busy-loop (one process consumed 521s CPU). I confirmed via direct `node --import tsx` that `UsageStatsDatabase` constructs/operates/closes correctly under Node 24, so the hang is a **vitest + Node 24 + experimental `node:sqlite` module-loading incompatibility**, not a defect in the cleaned code. Workaround: verified the non-sqlite stats specs via vitest (114 passed) and the sqlite code path via a direct tsx smoke test. **Recommendation: run the full stats suite under Node 22.23.1 (the project's pinned version) to execute the sqlite specs.** No Node version manager is installed on this machine.

## Issues Discovered (for VP awareness)

1. **The remote `myk1yt/feature/local-usage-stats` is stale** (24 commits behind `main`, `@types/node@20`). If the user intends to push the cleaned branch, it will require a **force-push** (`git push --force-with-lease myk1yt feature/local-usage-stats`) because the history was rewritten (rebase + decontamination). Per protocol I did NOT push — that decision belongs to VP/user.
2. **`6e08422f1`-style "distribute code" commits carry hidden contamination** when authored on a dirty HEAD. Future branch-recovery/split work should author feature commits on a clean base to avoid re-tangling.
3. **Backup branches retained** (not deleted, per data-safety): `feature/local-usage-stats-contaminated-backup` (original 100-commit state) and `feature/local-usage-stats-backup`. These can be removed later once the user confirms the clean branch is correct.

## Next Step Recommendations

1. VP/user: review the clean branch and, if satisfied, **force-push** to update the remote (`git push --force-with-lease myk1yt feature/local-usage-stats`).
2. Run the sqlite-dependent stats specs (`UsageStatsDatabase/Migration/Projection`) under **Node 22.23.1** to complete test coverage of the streaming persistence layer.
3. After confirmation, delete the two backup branches to reduce clutter.

## Affected File List

**Git refs (no source files were hand-edited outside the merge-conflict resolutions):**
- `feature/local-usage-stats` — now points to `3372af827` (clean)
- `feature/local-usage-stats-contaminated-backup` — preserves original `6e08422f1`
- `feature/local-usage-stats-backup` — preserves original tip

**Files modified during conflict resolution (within the clean branch's commits):**
- `packages/types/src/vscode-extension-host.ts` — kept streaming types, dropped shell types, removed BOM
- `src/core/task/Task.ts` — dropped MiMo ghost-quarantine, kept streaming finalize logic
- `src/core/webview/webviewMessageHandler.ts` — kept streaming handler imports/cases, merged with main's awaited `showTaskWithId`

**Housekeeping (not part of the branch):**
- Recycled junk temp logs (`src-test-log.txt`, `src-test-log-tail.txt`, `turbo-noncore-log.txt`) and the temp `.clean-wt` worktree (all via Recycle Bin).
