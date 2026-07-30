# Debug Task Report: fix/mimo-parallel-tool-call-policy Contamination Analysis & Cleanup Runbook

## Task Summary

Analyze contamination on local branch `fix/mimo-parallel-tool-call-policy`, classify commits (MIMO-native vs contamination), define a cleanup strategy, predict conflicts, and produce an execution runbook. Analysis/planning only — no git mutation performed (Debug mode constraint).

---

## 1. Root Cause Analysis

### 1.1 Branch state (verified)

- Workspace repo root: `C:/Users/k1yt/OneDrive/Projects/ZooCode` (single git repo; the `ZooCode/` subfolder is not a nested repo for this purpose).
- Current checkout: `feature/task-dnd-ux` (the contaminated branch is **not** checked out — safe for analysis).
- `upstream/main` = `569b43df991b5c56ee21cac5514eff36dd40d217` ("refactor(api): centralize service-tier primitives (#1040)", 2026-07-30).
- `myk1yt/fix/mimo-parallel-tool-call-policy` — confirmed **absent** on the fork (`git branch -r --list` returned nothing). No remote backup exists.
- Merge-base of branch vs upstream/main: `d5a8c4a3c` ("feat: implement Claude Opus 5 support (#1010)"), i.e. the branch forked from main before `d27153a25`.

### 1.2 How the contamination happened

`git log fix/mimo-parallel-tool-call-policy --not upstream/main` shows **47 commits**. The MIMO feature was stacked on top of two other feature branches instead of directly on `upstream/main`:

| Layer                             | Commits                                                                                                                          | Origin                                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unified-shell-resolution          | `0ead76de7`, `71a85444f`, `8e6799525`, `3947666f0`                                                                               | `feature/unified-shell-resolution` branch                                                                                                                                        |
| Release/merge commits             | `9c10c6c62`, `a44903692`, `b78990fec`, `16bdb5183`, `9870649da`, `8a12b8f2a`, `6d366bd24`, `3b8f60119`, `971b786bd`, `582a10fad` | upstream PRs, but **locally re-created SHAs** (not ancestors of upstream/main — e.g. `3b8f60119` exists upstream as a different SHA; `9762e0e0f` exists upstream as `d27153a25`) |
| canonical-provider refactor stack | `629637468` … `bb2f7996e` (6 commits, #991/#1012/#1019/#1020/#1022)                                                              | same — already merged upstream with different SHAs                                                                                                                               |
| ripgrep fix                       | `9762e0e0f`                                                                                                                      | already upstream as `d27153a25` (#1024/#1032) — **duplicate content, different SHA**                                                                                             |
| error-interception feature        | `26ec8ae88` … `4e52024d1` (18 commits)                                                                                           | `feat/error-interception-middleware` branch (PR #1009 lineage)                                                                                                                   |
| **MIMO feature**                  | `ff9d40453` … `25fc2edff` (10 commits)                                                                                           | the only commits that belong on this branch                                                                                                                                      |

Resulting tree diff vs upstream/main: **218 files changed, +21,942/-5,126** — of which the error-interception layer alone is ~+7,442 lines (14 files under `src/core/tools/error-interception/`) plus docs session files and shell-resolution changes. None of that belongs in a MiMo tool-call-policy PR.

### 1.3 The tip is re-contaminated (critical finding)

The last 4 "cleanup" commits did **not** achieve a clean tree:

- `a16d104b3` removed error-interception files and docs.
- `96e34eca7` removed accidentally staged docs session files.
- `8d468d891` reverted `src/eslint-suppressions.json` to main baseline.
- `25fc2edff` ("fix BOM and restore main baseline") **re-added the entire error-interception tree (+6,739 lines incl. all 14 error-interception files, docs files, and +258 lines in `NativeToolCallParser.ts`)**. Its own stat shows it reintroduced everything `a16d104b3`/`96e34eca7` had just deleted. It looks like a bad commit composition (likely `git commit -a` or a stash-pop/stage accident), not an intentional revert.

Verified at branch tip: `src/core/tools/error-interception/` (14 files) and `docs/` session files are still present in the tree diff vs upstream/main. Only `src/eslint-suppressions.json` ended up byte-identical to main.

---

## 2. Commit Classification

### 2.1 MIMO-native (keep) — 6 feature/fix commits, in order

1. `ff9d40453` feat: add model-level tool-call capability and policy resolution
    - `packages/types/src/model.ts`, `packages/types/src/providers/mimo.ts`, `src/api/index.ts`, `src/core/task/Task.ts`, `src/core/task/__tests__/tool-call-policy.spec.ts` (+276/-5). Cleanly scoped.
2. `615dfbacc` feat: wire MiMo provider controls and tighten argument normalization
    - `src/api/providers/mimo.ts`, `NativeToolCallParser.ts`, `execute_command.ts` prompts, `shared/tools.ts`, **but also touches `src/core/tools/error-interception/StructuralValidator.ts` (10 lines)** — this hunk must be dropped (file won't exist on the cleaned branch).
3. `ead1d7ccd` feat: add ghost quarantine and max-one tool call enforcement
    - `ToolCallRetentionPolicy.ts` (new), `NativeToolCallParser.ts`, `presentAssistantMessage.ts`, `Task.ts`, tests (+1,206/-51). MIMO-scoped.
4. `1d48e24c6` feat: add tool-call policy telemetry events
    - `packages/telemetry`, `packages/types/src/telemetry.ts`, `ToolCallRetentionPolicy.ts`, `presentAssistantMessage.ts`, `Task.ts` (+545/-4). MIMO-scoped.
5. `2e4fd63b9` fix: resolve no-explicit-any lint errors in mimo and telemetry files — MIMO-scoped.
6. `6e406ecca` fix: preserve parallel behavior for known providers without explicit capabilities
    - `src/api/index.ts`, `presentAssistantMessage.ts`, `tool-call-policy.spec.ts` (+150/-13). MIMO-scoped.

### 2.2 Cleanup commits (do NOT cherry-pick)

- `a16d104b3`, `96e34eca7`, `8d468d891`, `25fc2edff` — these only undo contamination that will not exist on the rebuilt branch; `25fc2edff` actively re-adds contamination. All four must be dropped. Their net desired effect (clean tree) is achieved by construction via cherry-picking only §2.1.

### 2.3 Contamination (drop) — 37 commits

- unified-shell-resolution: `0ead76de7`, `71a85444f`, `8e6799525`, `3947666f0`
- error-interception: `26ec8ae88`, `2388b9c9f`, `ae83729c0`, `edb61c735`, `c82006502`, `9e430c2c8`, `d9da3fdb5`, `9bd90f403`, `6245ea269`, `1f8981c2f`, `a59ab2573`, `3108de5c8`, `866b97850`, `5f155fb28`, `e60c6d999`, `8330c6b96`, `cdc042f0e`, `d797f0b32`, `3013a09f7`, `4e52024d1`
- stale upstream duplicates (already in upstream/main under different SHAs): `9c10c6c62`, `a44903692`, `b78990fec`, `16bdb5183`, `9870649da`, `8a12b8f2a`, `6d366bd24`, `3b8f60119`, `971b786bd`, `582a10fad`, `629637468`, `e3516a5f3`, `5ea11fa44`, `48758603e`, `bb2f7996e`, `9762e0e0f`

---

## 3. Cleanup Strategy (decision)

**Chosen: cherry-pick rebuild onto upstream/main.** Interactive rebase was rejected because (a) the branch tip is re-contaminated, so "drop" alone still leaves a dirty tree; (b) 37 of 47 commits would be dropped, making a todo list error-prone; (c) cherry-picking 6 well-scoped commits is deterministic and each step is independently verifiable.

Executor: VP/Orchestrator (Debug mode is forbidden from git mutation). The runbook in §5 is written for that executor.

## 4. Conflict Prediction

Measured with `git merge-tree --write-tree upstream/main <commit>` (treats each commit as a head against current main — a conservative upper bound; cherry-pick conflicts will be equal or smaller):

Conflicting paths when replaying the MIMO stack onto `569b43df9`:

| File                                                                            | Why it conflicts                                                                                                                                                                                                      | Expected resolution                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/index.ts`                                                              | main's canonical-provider refactor stack (#1012/#1019/#1020/#1022) + `569b43df9` service-tier centralization rewrote provider registration; `ff9d40453`/`6e406ecca` add capability-resolution code in the same region | Keep main's canonical identifier structure; re-apply the `resolveToolCallPolicy` / capability lookup additions inside the new structure                                                                                                                                   |
| `src/core/task/Task.ts`                                                         | main's TaskRegistry/TaskScheduler work (#1014/#1031) vs MIMO max-one enforcement in `Task.ts` (`ff9d40453`, `ead1d7ccd`, `1d48e24c6`)                                                                                 | Take main's scheduler code; re-apply MIMO policy hooks at the call sites                                                                                                                                                                                                  |
| `src/core/tools/ExecuteCommandTool.ts` + `__tests__/executeCommandTool.spec.ts` | main's unified-shell-related edits vs `615dfbacc`'s 2-line normalization tweak                                                                                                                                        | Trivial: keep main, re-apply the 2-line hunk                                                                                                                                                                                                                              |
| `src/core/prompts/tools/native-tools/execute_command.ts`                        | same 2-line hunk vs main prompt edits                                                                                                                                                                                 | Trivial                                                                                                                                                                                                                                                                   |
| `src/core/webview/ClineProvider.ts`, `webviewMessageHandler.ts`                 | main refactor overlap (merge-tree artifact; MIMO commits barely touch these — likely only via stacked ancestors, so cherry-picks of §2.1 should skip them cleanly)                                                    | None expected during actual cherry-pick                                                                                                                                                                                                                                   |
| `src/__tests__/single-open-invariant.spec.ts`                                   | deleted/modified on both sides (main's test suite changes vs stacked-branch deletion)                                                                                                                                 | Not touched by §2.1 commits — no conflict expected in practice                                                                                                                                                                                                            |
| `src/eslint-suppressions.json`                                                  | BOM churn on the contaminated branch vs main baseline                                                                                                                                                                 | Avoided entirely by not picking the 4 cleanup commits                                                                                                                                                                                                                     |
| `webview-ui/playwright-ct.config.ts`, `zoo-hero-dark.png`                       | binary/config conflicts from stacked ancestors only                                                                                                                                                                   | Not touched by §2.1 — no conflict expected                                                                                                                                                                                                                                |
| `615dfbacc` → `src/core/tools/error-interception/StructuralValidator.ts`        | file absent on cleaned branch                                                                                                                                                                                         | Cherry-pick will conflict (modify/delete). **Resolution: skip this hunk** (`git restore --source=HEAD -- src/core/tools/error-interception` or just don't stage that path); the StructuralValidator normalization hunk belongs to the error-interception PR, not this one |

Net assessment: **real conflicts concentrate in `src/api/index.ts` and `src/core/task/Task.ts`** (main moved fast: 10+ PRs merged since the fork point, including the canonical-provider refactor series and TaskRegistry/TaskScheduler). Everything else is trivial or avoidable. The MIMO commits are small and well-scoped (+2,754 lines total across 6 commits, mostly additive), so conflict resolution is mechanical: keep main's refactored structure, re-insert the MIMO policy/capability logic.

Backup safety: before any mutation the executor creates `fix/mimo-parallel-tool-call-policy-backup-260730` pointing at `25fc2edff`. Since no fork copy exists, this local backup branch is the only recovery path until the cleaned branch is pushed.

---

## 5. Execution Runbook (for VP/Orchestrator)

```powershell
# 0. Preconditions
git fetch upstream
git rev-parse upstream/main   # expect 569b43df991b5c56ee21cac5514eff36dd40d217
git status --porcelain        # expect clean (currently on feature/task-dnd-ux; docs/ untracked is fine)

# 1. Backup (only recovery point — fork has no copy)
git branch fix/mimo-parallel-tool-call-policy-backup-260730 fix/mimo-parallel-tool-call-policy

# 2. Rebuild from upstream/main
git switch -C fix/mimo-parallel-tool-call-policy upstream/main

# 3. Cherry-pick the 6 MIMO commits, in order
git cherry-pick ff9d40453
git cherry-pick 615dfbacc   # expect modify/delete conflict on src/core/tools/error-interception/StructuralValidator.ts -> drop that hunk:
                            #   git rm -r --ignore-unmatch src/core/tools/error-interception
                            #   then resolve src/api/index.ts / ExecuteCommandTool hunks keeping main's canonical structure, then: git cherry-pick --continue
git cherry-pick ead1d7ccd   # likely Task.ts conflict -> keep main scheduler code + re-apply MIMO hooks
git cherry-pick 1d48e24c6
git cherry-pick 2e4fd63b9
git cherry-pick 6e406ecca   # src/api/index.ts conflict -> same rule

# 4. Do NOT cherry-pick: a16d104b3 96e34eca7 8d468d891 25fc2edff (cleanup commits; 25fc2edff re-adds contamination)

# 5. Verify the tree is clean of contamination
git diff --stat upstream/main HEAD -- src/core/tools/error-interception/ docs/   # expect EMPTY
git diff --name-only upstream/main HEAD | Select-String "error-interception|docs/" # expect no output
git log --oneline HEAD --not upstream/main   # expect exactly 6 commits

# 6. Build + test gate (per repo rules: run vitest from src workspace)
pnpm install
cd src; npx vitest run core/task/__tests__/tool-call-policy.spec.ts core/assistant-message/__tests__/ToolCallRetentionPolicy.spec.ts api/providers/__tests__/mimo.spec.ts; cd ..
pnpm -w run check-types   # or the repo's equivalent typecheck script

# 7. Push to fork (new branch on myk1yt)
git push -u myk1yt fix/mimo-parallel-tool-call-policy

# 8. Only after push + green CI: delete local backup (VP decision; use branch -D since it won't be merged)
#    git branch -D fix/mimo-parallel-tool-call-policy-backup-260730  (keep until PR merges — recommended)
```

Rollback path at any point before step 7: `git switch -C fix/mimo-parallel-tool-call-policy fix/mimo-parallel-tool-call-policy-backup-260730`.

---

## 6. Actions Taken (this task)

1. Verified repo root, remotes, current checkout, absence of fork branch, merge-base (`d5a8c4a3c`).
2. Enumerated all 47 branch-only commits and grouped them by origin layer.
3. Inspected `--stat` for all 10 MIMO-candidate commits; discovered `25fc2edff` re-adds the contamination that `a16d104b3`/`96e34eca7` removed (tip still contains `src/core/tools/error-interception/` + docs session files vs main).
4. Confirmed `9762e0e0f` content already exists upstream as `d27153a25`; confirmed the canonical-provider refactor stack is upstream under different SHAs (duplicates, not true ancestors).
5. Ran `git merge-tree --write-tree` against `ff9d40453` and `615dfbacc` to enumerate conflicting paths; mapped each to the upstream PR that caused it.
6. Selected cherry-pick rebuild over interactive rebase; wrote executor runbook with backup, per-commit conflict guidance, verification gates, and rollback.

## 7. Result

Success (analysis + plan only, per Debug constraints). Deliverable: this report + runbook. No repository state was mutated.

## 8. Issues Discovered

- **Tip re-contamination**: `25fc2edff` undoes its own sibling cleanups — the branch as it stands is NOT PR-ready even at the tree level (error-interception files still present vs main).
- **No remote backup**: fork lacks this branch entirely; a local backup branch before mutation is mandatory.
- **`615dfbacc` scope leak**: one hunk edits `error-interception/StructuralValidator.ts` — must be dropped during cherry-pick or it will resurrect a modify/delete conflict by design.
- **Process gap (root enabler)**: MIMO work was stacked on unmerged feature branches (error-interception, unified-shell-resolution), which is how 37 foreign commits entered the history. Recommend branching future feature work directly from `upstream/main`.

## 9. Next Step Recommendations

1. VP executes runbook §5 (steps 0–3), resolving conflicts per §4 table.
2. VP runs verification gates (steps 5–6) — note `docs/` is currently untracked on the user's working tree; the tree-diff checks must be run on the rebuilt branch.
3. VP pushes to `myk1yt` and opens the PR against upstream/main; only then consider deleting `fix/mimo-parallel-tool-call-policy-backup-260730`.
4. Separate decision needed (outside this task): whether error-interception and unified-shell-resolution branches need the same cherry-pick rebuild treatment — they share the same stacking pattern.

## 10. Affected File List

- Report: `docs/260730_0001_session_branch-cleanup/184700_debug-report.md` (this file)
- Branch under analysis (read-only): `fix/mimo-parallel-tool-call-policy`
- No source files modified.
