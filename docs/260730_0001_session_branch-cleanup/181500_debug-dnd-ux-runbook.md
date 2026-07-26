# Debug Task Report + Cleanup Runbook — feature/task-dnd-ux 오염 분석 및 정리

> ⚠️ **Debug mode performed ANALYSIS ONLY. Every git mutation below is VP-ONLY.**
> Debug mode did NOT run any rebase / cherry-pick / branch / push. All findings are
> derived from read-only inspection (`git log`, `git show`, `git diff`, `git merge-base`,
> `git patch-id`).

---

## 1. Executive Summary

`feature/task-dnd-ux` (local tip `78ba8218e`) carries **102 commits** not in `main`, of which
**only 3 are DND-native**. The remaining 99 are contamination from SHELL, upstream-stale,
ERROR, MIMO, STRICT, and STATS/DASHBOARD work.

The fork remote `myk1yt/feature/task-dnd-ux` (tip `0453c3a70`) is **already clean**: a single
squashed commit containing the complete DND feature (frontend + backend store) on a clean base.

**Recommended strategy: adopt the remote squashed commit as the new base, then cherry-pick the
2 local workspace-contamination fixes on top.** This avoids a 102-commit rebase across a stale
upstream line that current `main` never merged.

| | Local `feature/task-dnd-ux` | Remote `myk1yt/feature/task-dnd-ux` |
|---|---|---|
| Tip | `78ba8218e` | `0453c3a70` |
| Commits not in main | 102 (99 contaminated) | 1 (clean squash) |
| Backend store (`TaskOrganizationStore.ts`, types) | present in tree but mixed with contamination | present, clean |
| Workspace-fix `92436e41f` | ✅ present | ❌ absent |
| Workspace-fix `78ba8218e` (model part) | ✅ present | ❌ absent |
| Base | stale parallel upstream line | clean |

---

## 2. Commit Classification (102 total, oldest → newest)

### 🔴 CONTAMINATION — SHELL (4 commits)
```
0ead76de7 feat(terminal): add unified shell resolution system
71a85444f fix(terminal): add logging to silent error paths in shell resolution
8e6799525 feat(terminal): port CommandScheduler and Shell abstraction from Zoo-Code/
3947666f0 chore(unified-shell-resolution): remove non-feature report files for PR readiness
```
Verified: all 4 are **NOT ancestors of main** → true contamination, will NOT auto-drop.

### 🔴 CONTAMINATION — UPSTREAM-STALE (16 commits)
```
9c10c6c62 Release v3.72.0 (#1013)
a44903692 [Fix] Flaky mocked e2e subtasks test ... (#1002)
b78990fec fix(settings): buffer Save-managed settings in cachedState until Save (#872)
16bdb5183 fix(ollama): ... (#878)
9870649da Fix bedrock DNS resolution ... (#906)
8a12b8f2a chore: update Node.js to v22 LTS (#743)
6d366bd24 fix(architect): instruct plans directory ... (#968)
3b8f60119 feat(TaskRegistry): introduce TaskRegistry ... (#1014)
971b786bd chore(deps): update dependency shell-quote ... (#986)
582a10fad test(webview): add Playwright visual regression harness (#526)
629637468 refactor(api): use canonical provider identifiers (#1012)
e3516a5f3 refactor(types): use canonical identifiers for default models (#991)
5ea11fa44 refactor(api): use canonical model cache provider identifiers (#1020)
48758603e refactor(shared): use canonical profile provider identifiers (#1019)
bb2f7996e refactor(core): use canonical provider identifiers (#1022)
9762e0e0f fix(ripgrep): support @vscode/ripgrep >=1.18 ... (#1032)
```
**CRITICAL FINDING:** Verified via `git merge-base --is-ancestor <c> main` — **NONE of these 16
are ancestors of `main` (`569b43df9`).** `9c10c6c62` (Release v3.72.0) is reachable ONLY from the
contaminated feature branches, not from main. This branch sits on a **stale parallel upstream
line**; current main is 25 commits ahead of the merge-base `d5a8c4a3c` on a *different* PR line
(`#1040/#1030/#1023/#1045/#1031…`).
> **Consequence:** `git rebase --onto main <base>` will **NOT** auto-drop these 16. A rebase
> strategy would have to drop them explicitly and would hit cascading conflicts. This is the
> decisive reason to prefer the remote-squash + cherry-pick path.

### 🔴 CONTAMINATION — ERROR (18 + 2 chore)
```
26ec8ae88 feat(error-interception): add deterministic error interception middleware
2388b9c9f fix(error-interception): address CodeRabbit review findings
ae83729c0 fix: update e2e fixture and add coverage tests for Codecov
edb61c735 test: add 3 targeted coverage tests for 80% Codecov threshold
c82006502 test: add 13 targeted tests for 80%+ Codecov patch coverage
9e430c2c8 feat(error-interception): add INVALID_JSON_ARGUMENTS pattern ...
d9da3fdb5 fix(error-interception): add logging to silent error paths
9bd90f403 feat(error-interception): improve AI guidance quality for 4 patterns
6245ea269 fix(error-interception): show errors to user in UI alongside AI guidance
1f8981c2f feat(error-interception): user-friendly error UI with structured detail view
a59ab2573 fix(error-interception): add non-null assertion in test ...
3108de5c8 fix(error-interception): update stale test assertion ...
866b97850 fix(error-interception): rebase onto upstream/main and fix eslint ...
5f155fb28 fix(error-interception): address PR review findings ...
e60c6d999 fix: resolve CI lint and test failures for PR #1009
8330c6b96 fix(e2e): update apply-diff fixture ... + integration test
cdc042f0e fix: correct PushToolResult type in integration test
d797f0b32 docs: add flaky-test note for interrupted-child E2E
3013a09f7 chore(error-interception-middleware): revert non-feature .gitignore changes
4e52024d1 fix(error-interception): rebase onto upstream/main and fix eslint ...
```
> Note: The ERROR feature was already cleaned and force-pushed as
> `feat/error-interception-middleware` (see `175300_code-report.md`). These copies here are the
> stale duplicate series baked into this branch's history.

### 🔴 CONTAMINATION — MIMO (8 + 4 chore)
```
ff9d40453 feat: add model-level tool-call capability and policy resolution
615dfbacc feat: wire MiMo provider controls and tighten argument normalization
ead1d7ccd feat: add ghost quarantine and max-one tool call enforcement
1d48e24c6 feat: add tool-call policy telemetry events
2e4fd63b9 fix: resolve no-explicit-any lint errors in mimo and telemetry files
6e406ecca fix: preserve parallel behavior for known providers ...
a16d104b3 chore(mimo-parallel-tool-call-policy): remove error-interception contamination ...
96e34eca7 chore(mimo-parallel-tool-call-policy): remove accidentally staged docs session files
8d468d891 chore(mimo-parallel-tool-call-policy): revert eslint-suppressions.json to main baseline
25fc2edff chore(mimo-parallel-tool-call-policy): fix eslint-suppressions.json BOM ...
```

### 🔴 CONTAMINATION — STRICT (2 + 1 i18n)
```
d983aefec feat: add strict tool schema toggle and expand reasoning effort for OpenAI Compatible
8486592ef chore(openai-compatible-strict-reasoning): remove terminal feature contamination ...
4fadbab95 fix(i18n): add strictToolSchemas locale keys to modelInfo section
```
> Plus STRICT-adjacent shell/settings commits `50d62c877`, `76ce6fb6a`, `a8c241fa4` (3 more).

### 🔴 CONTAMINATION — STATS / DASHBOARD (~40 commits)
```
f7382fb43 feat(stats): define usage event and message contracts
da279a69b feat(stats): add append-only local usage store and aggregation
07bc1e516 feat(stats): record final usage for each API attempt
c4c501fb8 feat(stats): expose stats query export and clear handlers
fa1a3496b feat(stats): add slash entry and statistics webview
4bf70b3a9 fix(stats): resolve blockers B1/B2/B3 and highs H1/H3
f8a746bd1 feat(stats): add autocomplete entry and time-axis groupBy in UI
390032164 test(stats): add coverage tests ...
65ffaf40a i18n(stats): add translations for 17 languages
88eda2b29 fix(i18n): remove BOM from package.nls.ca.json
e5c3b11b7 fix(i18n): remove BOM from all package.nls locale files
444b17fe2 fix(i18n): restore missing opening brace in all package.nls locale files
1498a5197 i18n(stats): apply CodeRabbit translation review fixes ...
cf42d1882 refactor(stats): convert all Korean comments to English
a7c777c2a feat(dashboard): remove /stats command and add Dashboard sidebar entry
51ed9643d feat(dashboard): add DashboardView ...
47b3a0c24 feat(dashboard): add session list ...
d1a0a691e feat(dashboard): add session detail ...
b4d5dc40b feat(dashboard): add translations for all 17 languages
ee7abe0cb test(stats): remove stale 'stats' command test assertions
23eda15f5 refactor(dashboard): remove orphaned StatsView ...
8d2396732 feat(dashboard): default Custom date range to yesterday-today
956493364 feat(dashboard): compute missing costs at query time ...
1ee13832d feat(dashboard): add usage dashboard with mode column ...
025220485 feat(heatmap): blue gradient 6 levels ... 221 new tests
ad9ff2fd7 feat(dashboard): responsive heatmap ... CI fixes, and 221 tests
5d386a23c feat(stats): make UsageHeatmap self-fetching ...
2f85922b6 test(stats): add comprehensive DashboardView test suite ...
1ff32a520 fix(stats): remove unused variables in DashboardView.spec.tsx ...
e23a4b013 fix(stats): correct totalTokens calculation ...
f110bb707 fix(stats): remove day axis from breakdown groupBy ...
2c80d30c0 feat(stats): add endpoint domain extraction ...
3ad730ecd fix(stats): update MiMo pricing ... NDJSON cache ...
9a09a3727 feat(dashboard): add multi-window refresh ...
35d68f017 fix(stats): pass all CI checks after rebase onto main
8b43f839c fix(dashboard): remove unknownEventCount display ...
d3e69b352 fix(ci): pass test:coverage
1aa13c1b7 fix(ci): revert e2e timeout + add coverage tests
6cc1eab93 feat(usage-stats): port TaskOrganization infrastructure from Zoo-Code/ duplicate
7a774cb2b chore(usage-stats): remove temporary scripts and reports ...
788f11aaa fix(stats): add totalCost to provider streams ...
26fed470c chore(local-usage-stats): remove task-dnd contamination ... for PR readiness
482ff720d chore(local-usage-stats): remove remaining task-dnd files and temp log
```
> Note: `6cc1eab93` is a STATS-infra port (not DND). `26fed470c`/`482ff720d` are STATS cleanup
> commits that *reference* "remove task-dnd contamination" — they are STATS-branch hygiene, not DND.

### 🟢 DND-NATIVE (3 commits) — the ONLY ones to keep
```
cfcfa25da feat(task-organization): add DnD folder management and task grouping   (base feature)
92436e41f fix(history): prevent workspace cross-contamination of tasks, pins, and folders
78ba8218e fix(history): hide workspace-specific folders when no workspace is open
```

---

## 3. Remote vs Local Content Reconciliation (patch-id + diff)

| Item | patch-id | Notes |
|---|---|---|
| Remote `0453c3a70` (squash) | `d3202e52103e599685cc0cd3297c192b25da5ff2` | superset of local base |
| Local `cfcfa25da` (base) | `8160be0eebc0b4ce43a2aaf15b33ca20f21af6ba` | different patch-id |

- `0453c3a70` is **NOT** an ancestor of local `78ba8218e` (`git merge-base --is-ancestor` → NO).
- **File-level diff `cfcfa25da` vs `0453c3a70`** for the files the fixes touch:
  - `HistoryPreview.tsx`, `HistoryView.tsx`, `taskOrganizationModel.ts` → **EMPTY diff (identical)**.
  - `ClineProvider.ts` → differs ONLY because remote removed SHELL/STATS imports baked into local.
- Remote `0453c3a70` **adds** the backend store layer the local base lacks:
  `packages/types/src/task-organization.ts`, `TaskOrganizationStore.ts`,
  `vscode-extension-host.ts`, plus richer `ClineProvider.ts` wiring (74 lines vs 2).

**Conclusion:** The remote squash is the more complete, cleaner base. The two local fixes touch
files that are byte-identical between the two bases → they transplant cleanly. The only exception
is the `ClineProvider.ts` hunk inside `78ba8218e` (see conflict prediction §5).

---

## 4. Cleanup Strategy (RECOMMENDED)

**Adopt remote squash + cherry-pick 2 fixes.** This sidesteps the 102-commit rebase across a stale
upstream line that current main never merged (which would NOT auto-drop the 16 upstream commits
and would generate many conflicts).

> ⚠️ **ALL commands below are git mutations — VP-ONLY.** Execute top-to-bottom. Do not skip backup.

### Preconditions (verify before starting)
```powershell
git fetch myk1yt
git rev-parse main                          # expect 569b43df9...
git rev-parse myk1yt/feature/task-dnd-ux    # expect 0453c3a70...
git rev-parse feature/task-dnd-ux           # expect 78ba8218e...
```

### Step 1 — Backup (MANDATORY)
```powershell
git branch feature/task-dnd-ux-contaminated-backup feature/task-dnd-ux
```

### Step 2 — Create clean branch from remote squash
```powershell
git checkout -b feature/task-dnd-ux-clean myk1yt/feature/task-dnd-ux
```

### Step 3 — Cherry-pick the 2 workspace fixes
```powershell
git cherry-pick 92436e41f
# ^ expected CLEAN: touches HistoryPreview.tsx / HistoryView.tsx / taskOrganizationModel.ts
#   (+ their specs), all identical between the two bases.

git cherry-pick 78ba8218e
# ^ EXPECT CONFLICT in src/core/webview/ClineProvider.ts — see Step 3a.
```

### Step 3a — Resolve the EXPECTED `78ba8218e` ClineProvider conflict
The `78ba8218e` ClineProvider hunk **removes** the lines:
```
import type { ..., TaskOrganizationStateV1 } from "@roo-code/types"
import { createEmptyTaskOrganizationState } from "@roo-code/types"
```
But remote `0453c3a70` **actively uses** both (multi-line import). That hunk is a *regression
artifact of the contaminated base* — NOT a real fix. **Resolution: keep the remote (theirs during
cherry-pick) version of `ClineProvider.ts`, i.e. DROP the ClineProvider hunk entirely and keep
only the `taskOrganizationModel.ts` + spec changes.**

During `git cherry-pick` the conflicted file is the *new* commit applying onto remote HEAD, so:
```powershell
git checkout --theirs src/core/webview/ClineProvider.ts   # keep remote 0453c3a70 version
git add src/core/webview/ClineProvider.ts
# ensure the taskOrganizationModel.ts + spec hunks from 78ba8218e ARE staged, then:
git cherry-pick --continue
```
Verify the model change survived:
```powershell
git diff HEAD~1 HEAD -- webview-ui/src/components/history/taskOrganizationModel.ts
# must show the cwd === undefined / folder-skip logic
```
> If `git status` shows the cherry-pick would become EMPTY after dropping ClineProvider (i.e. the
> model/spec hunks were already applied), use `git cherry-pick --skip` only after confirming the
> model diff above is non-empty. Do NOT skip blindly.

### Step 4 — Verify build + targeted tests
```powershell
pnpm check-types
cd src; npx vitest run core/task-persistence/; cd ..
cd webview-ui; npx vitest run src/components/history/; cd ..
cd webview-ui; npx vitest run src/context/ExtensionStateContext.taskOrganization.spec.tsx; cd ..
```

### Step 5 — Confirm contamination is gone
```powershell
git log --oneline feature/task-dnd-ux-clean --not main
# Expect EXACTLY 3 commits:
#   0453c3a70 feat(task-organization): add DnD folder management and task grouping
#   <new>     fix(history): prevent workspace cross-contamination ...
#   <new>     fix(history): hide workspace-specific folders ...
# NO 0ead76de7/9c10c6c62/26ec8ae88/ff9d40453/d983aefec/f7382fb43 band commits.
```

### Step 6 — Replace the contaminated branch (VP/CPO decision point)
```powershell
git branch -f feature/task-dnd-ux feature/task-dnd-ux-clean
git checkout feature/task-dnd-ux
git branch -D feature/task-dnd-ux-clean
# force-push is IRREVERSIBLE on remote — requires explicit user/CPO approval:
git push --force-with-lease myk1yt feature/task-dnd-ux
```
Keep `feature/task-dnd-ux-contaminated-backup` until the force-push is confirmed good.

---

## 5. Conflict Prediction

| Step | File | Likelihood | Resolution |
|---|---|---|---|
| `cherry-pick 92436e41f` | `HistoryPreview.tsx`, `HistoryView.tsx`, `taskOrganizationModel.ts` + specs | **LOW (clean)** — files identical between bases | none expected |
| `cherry-pick 78ba8218e` | `src/core/webview/ClineProvider.ts` | **HIGH (expected)** — hunk removes imports remote still uses | `--theirs` (drop ClineProvider hunk), keep model+spec |
| `cherry-pick 78ba8218e` | `taskOrganizationModel.ts`, `taskOrganizationModel.spec.ts` | **LOW (clean)** — identical between bases | none expected |
| Rejected alt: `rebase --onto main` | many | **VERY HIGH** — 16 upstream-stale commits NOT ancestors of main → no auto-drop, cascading conflicts | NOT RECOMMENDED |

---

## 6. Rejected Alternatives

- **`git rebase --onto main <base> feature/task-dnd-ux`** — REJECTED. Verified the 16
  "upstream" commits are NOT ancestors of main (`9c10c6c62` etc. unreachable from main). Rebase
  would not auto-drop them and would replay 99 contaminated commits onto a divergent main,
  producing pervasive conflicts. The remote-squash path is strictly safer.
- **Cherry-pick all 3 local DND commits onto main** — REJECTED as primary. Local base `cfcfa25da`
  lacks the backend store layer that remote `0453c3a70` already has. Using the remote squash as
  the base yields the complete feature. (This remains a viable FALLBACK if the remote squash is
  ever found undesirable — cherry-pick `cfcfa25da`, `92436e41f`, `78ba8218e` onto `main`, then
  separately port the backend store.)

---

## 7. Rollback
If verification fails before Step 6:
```powershell
git cherry-pick --abort        # if mid-cherry-pick
git checkout feat/error-interception-middleware   # or any other working branch
git branch -D feature/task-dnd-ux-clean
# original feature/task-dnd-ux + contaminated-backup remain untouched
```

---

## 8. Test Environment Issues
None encountered. All inspection commands were read-only and succeeded. Note: `pnpm` is not on
PowerShell PATH in this environment — use full path
`C:\Users\k1yt\AppData\Roaming\npm\pnpm.cmd` for the verification steps (consistent with the
prior ERROR-branch cleanup, see `175300_code-report.md`).

---

## 9. Next Step Recommendations (for VP)
1. Execute the runbook in §4 (VP-ONLY git mutations).
2. At Step 6, obtain explicit user/CPO approval before `push --force-with-lease` (irreversible).
3. After force-push, verify the PR (if any) for `feature/task-dnd-ux` shows a clean 3-commit diff.
4. Delete `feature/task-dnd-ux-contaminated-backup` only after the clean branch is confirmed good.

---

## 10. Affected File List (analysis touched no files; these are the files the cleanup will touch)
- Git refs: `feature/task-dnd-ux`, `feature/task-dnd-ux-contaminated-backup` (to create),
  `feature/task-dnd-ux-clean` (to create + delete)
- `src/core/webview/ClineProvider.ts` (expected conflict resolution)
- `webview-ui/src/components/history/taskOrganizationModel.ts` (+ spec) — fix content to preserve
- This report: `docs/260730_0001_session_branch-cleanup/181500_debug-dnd-ux-runbook.md`
