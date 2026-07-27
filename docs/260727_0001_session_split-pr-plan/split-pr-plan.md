# Split PR Plan: feature/local-usage-stats

## Original PR Summary

- **Branch**: `feature/local-usage-stats`
- **Base**: `upstream/main` at `d1f399989` (v3.72.0)
- **Total**: 43 commits (feature-specific), 138 files changed, +20,131/-319 lines
- **Reviewer request**: Split into 4 mutually exclusive PRs (A, B, C, D)
- **Suggested merge order**: C → A → B → D (C and A in parallel; D waits for B)

---

## Commit Assignment Map

| #   | Commit      | Message                                                                                            | Target PR |
| --- | ----------- | -------------------------------------------------------------------------------------------------- | --------- |
| 1   | `7af6292e5` | feat(stats): define usage event and message contracts                                              | **D**     |
| 2   | `cbfab67aa` | feat(stats): add append-only local usage store and aggregation                                     | **D**     |
| 3   | `87570b222` | feat(stats): record final usage for each API attempt                                               | **D**     |
| 4   | `0b7e1de89` | feat(stats): expose stats query export and clear handlers                                          | **D**     |
| 5   | `b786b73e7` | feat(stats): add slash entry and statistics webview                                                | **D**     |
| 6   | `0a3a90295` | fix(stats): resolve blockers B1/B2/B3 and highs H1/H3                                              | **D**     |
| 7   | `0d44f57f0` | feat(stats): add autocomplete entry and time-axis groupBy in UI                                    | **D**     |
| 8   | `e199309b8` | test(stats): add coverage tests for UsageStatsService, UsageHeatmap, StatsView, UsageAggregator    | **D**     |
| 9   | `b3c7027df` | i18n(stats): add translations for 17 languages                                                     | **D**     |
| 10  | `22dbf9ad5` | fix(i18n): remove BOM from package.nls.ca.json                                                     | **D**     |
| 11  | `b8657f4ba` | fix(i18n): remove BOM from all package.nls locale files                                            | **D**     |
| 12  | `bc9df7b89` | fix(i18n): restore missing opening brace in all package.nls locale files                           | **D**     |
| 13  | `c16136577` | i18n(stats): apply CodeRabbit translation review fixes (de, fr, vi, zh-TW)                         | **D**     |
| 14  | `9899f4f00` | refactor(stats): convert all Korean comments to English                                            | **D**     |
| 15  | `d4c838d47` | feat(dashboard): remove /stats command and add Dashboard sidebar entry                             | **D**     |
| 16  | `2e250c3dc` | feat(dashboard): add DashboardView with summary, time range, and breakdown                         | **D**     |
| 17  | `2889921e5` | feat(dashboard): add session list with titles and model/provider filters                           | **D**     |
| 18  | `c1981a436` | feat(dashboard): add session detail with expandable API call list                                  | **D**     |
| 19  | `7acc894c0` | feat(dashboard): add translations for all 17 languages                                             | **D**     |
| 20  | `138aa8143` | test(stats): remove stale 'stats' command test assertions                                          | **D**     |
| 21  | `b2a7cba5c` | refactor(dashboard): remove orphaned StatsView, i18n relative time, extract format utils           | **D**     |
| 22  | `995c7c8cf` | feat(dashboard): default Custom date range to yesterday-today                                      | **D**     |
| 23  | `f0a7c9c9d` | fix(providers): add totalCost calculation using user-configured pricing                            | **B**     |
| 24  | `ad71891f4` | feat(dashboard): compute missing costs at query time and fix session grouping                      | **D**     |
| 25  | `968d735a8` | feat(dashboard): add usage dashboard with mode column, multi-model aggregation, i18n, and CI fixes | **D**     |
| 26  | `70d093f75` | feat(heatmap): blue gradient 6 levels, white borders, and 221 new tests                            | **D**     |
| 27  | `a94046117` | feat(dashboard): responsive heatmap, 30d/60d/120d/360d ranges, CI fixes, and 221 tests             | **D**     |
| 28  | `b447fd379` | feat(stats): make UsageHeatmap self-fetching for independent range selection                       | **D**     |
| 29  | `eae70eadb` | test(stats): add comprehensive DashboardView test suite for codecov patch coverage                 | **D**     |
| 30  | `415b7e772` | fix(stats): remove unused variables in DashboardView.spec.tsx to fix lint                          | **D**     |
| 31  | `3b86708be` | fix(stats): correct totalTokens calculation, provider pricing, and dashboard improvements          | **D**     |
| 32  | `7e7fbe4df` | fix(stats): remove day axis from breakdown groupBy to eliminate duplicate rows                     | **D**     |
| 33  | `4a49d3e7e` | feat(stats): add endpoint domain extraction for provider identification in dashboard               | **D**     |
| 34  | `0e24866ca` | fix(terminal): retry with execa when shell integration loses command                               | **A**     |
| 35  | `21465e473` | fix(stats): update MiMo pricing, remove session filters, add NDJSON cache for dashboard perf       | **D**     |
| 36  | `5f375bf99` | feat(dashboard): add multi-window refresh, cache ratio estimation, and CodeRabbit fixes            | **D**     |
| 37  | `76be6eb93` | fix(stats): pass all CI checks after rebase onto main                                              | **D**     |
| 38  | `59ac789b0` | fix(dashboard): remove unknownEventCount display and utility scripts                               | **D**     |
| 39  | `fa8f19a6c` | fix(ci): increase e2e timeout and add provider totalCost tests                                     | **B\***   |
| 40  | `99c7bf0e1` | fix(ci): pass test:coverage                                                                        | **D**     |
| 41  | `c17d09e82` | fix(ci): revert e2e timeout + add coverage tests                                                   | **D\***   |
| 42  | `5c5debed4` | fix(ci): break terminal-reuse fixture re-match loop                                                | **A\***   |
| 43  | `1d1eb915e` | fix(task): guard saveClineMessages against abandoned tasks                                         | **C**     |
| 44  | `e9f061cb7` | feat(usage-stats): port TaskOrganization infrastructure                                            | **D\***   |

> `*` = Mixed-concern commit, needs split or manual handling (see §Conflict Risks)

---

## PR Definitions

### PR C — `fix(task): guard saveClineMessages against abandoned tasks`

| Field                  | Value                                            |
| ---------------------- | ------------------------------------------------ |
| **Commits**            | `1d1eb915e` (1 commit)                           |
| **Files**              | `src/core/task/Task.ts` (1 file)                 |
| **Lines**              | +50 / -45                                        |
| **Cherry-pick from**   | `feature/local-usage-stats` onto `upstream/main` |
| **Conflict risk**      | 🟢 Low — single file, no overlap with other PRs  |
| **Reviewer reference** | Fixes #1021                                      |

**Notes**: Pure bug fix. No stats dependency. Should be the fastest to review and merge.

---

### PR A — `fix(terminal): retry with execa when shell integration loses command`

| Field                  | Value                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Commits**            | `0e24866ca` + `5c5debed4` (2 commits)                                                                                                                                                                      |
| **Files**              | `src/core/tools/ExecuteCommandTool.ts`, `src/core/tools/__tests__/executeCommandTool.spec.ts`, `src/integrations/terminal/TerminalProcess.ts`, `apps/vscode-e2e/src/fixtures/terminal-reuse-shell-race.ts` |
| **Lines**              | ~125 insertions                                                                                                                                                                                            |
| **Cherry-pick from**   | `feature/local-usage-stats` onto `upstream/main`                                                                                                                                                           |
| **Conflict risk**      | 🟢 Low — terminal code is isolated                                                                                                                                                                         |
| **Reviewer reference** | Fixes #779, #705, #634                                                                                                                                                                                     |

**Cleanup needed**:

- `commit-shell-int-fix.ps1` (helper script in `0e24866ca`) should be excluded from the PR commit. Add it to `.gitignore` or remove it in a fixup commit.
- `5c5debed4` (terminal fixture fix) is needed for the e2e test to pass with the new terminal behavior.

---

### PR B — `fix(providers): add totalCost calculation using user-configured pricing`

| Field                  | Value                                                           |
| ---------------------- | --------------------------------------------------------------- |
| **Commits**            | `f0a7c9c9d` + `fa8f19a6c` (2 commits)                           |
| **Files**              | 11 provider files + 2 test files + 1 e2e test + 1 terminal file |
| **Lines**              | ~210 insertions                                                 |
| **Cherry-pick from**   | `feature/local-usage-stats` onto `upstream/main`                |
| **Conflict risk**      | 🟡 Medium — `fa8f19a6c` is mixed-concern                        |
| **Reviewer reference** | API-layer correctness fix                                       |

**⚠️ Mixed commit: `fa8f19a6c`**
This commit touches 4 files spanning 2 concerns:

- `src/api/providers/__tests__/openai-compatible.spec.ts` → **PR B** (provider totalCost tests)
- `src/api/providers/__tests__/openai.spec.ts` → **PR B** (provider totalCost tests)
- `apps/vscode-e2e/src/suite/tools/terminal-reuse-shell-race.test.ts` → **PR A** (terminal e2e test)
- `src/integrations/terminal/BaseTerminal.ts` → **PR A** (terminal fix)

**Resolution**: Split this commit during cherry-pick:

1. Cherry-pick `f0a7c9c9d` cleanly (11 provider files)
2. For `fa8f19a6c`, use `git cherry-pick --no-commit` then selectively stage only the provider test files. The terminal-related changes go to PR A.
3. Alternatively, cherry-pick the whole commit to PR B, then cherry-pick just the terminal-related file changes to PR A.

---

### PR D — `feat(dashboard): local usage statistics dashboard`

| Field             | Value                                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| **Commits**       | All remaining 38 commits (after removing A, B, C)                           |
| **Files**         | ~120 files (stats services, dashboard components, i18n, tests, configs)     |
| **Lines**         | ~19,500 insertions                                                          |
| **Strategy**      | Rebase `feature/local-usage-stats` and drop commits assigned to A, B, C     |
| **Conflict risk** | 🟡 Medium — provider files touched by B; Task.ts touched by C               |
| **Depends on**    | PR B must merge first (provider `totalCost` API used by cost recalculation) |

**Cleanup needed for `e9f061cb7`** (port TaskOrganization infrastructure):
This commit includes temporary files that should NOT be in the PR:

- `check-git-status.ps1`
- `do-push.sh`
- `push.ps1`
- `docs/260718_*/` (multiple session report files)

These should be removed via `git rebase -i` with an additional cleanup commit, or by amending.

---

## Cherry-Pick Execution Strategy

### Step 1: Sync upstream

```bash
git fetch upstream
```

### Step 2: PR C (parallel with A)

```bash
git checkout -b fix/task-guard-abandoned-tasks upstream/main
git cherry-pick 1d1eb915e
# Resolve conflicts if any (unlikely)
git push myk1yt fix/task-guard-abandoned-tasks
# Open PR targeting upstream/main
```

### Step 3: PR A (parallel with C)

```bash
git checkout -b fix/terminal-execa-retry upstream/main
git cherry-pick 0e24866ca
# Remove commit-shell-int-fix.ps1 (git rm + commit --amend or fixup)
git cherry-pick 5c5debed4
# Cherry-pick terminal-related parts from fa8f19a6c (see mixed-commit resolution)
git push myk1yt fix/terminal-execa-retry
# Open PR targeting upstream/main
```

### Step 4: PR B (after C and A are open)

```bash
git checkout -b fix/providers-total-cost upstream/main
git cherry-pick f0a7c9c9d
# Cherry-pick provider-test parts from fa8f19a6c
git push myk1yt fix/providers-total-cost
# Open PR targeting upstream/main
```

### Step 5: PR D (after B merges)

```bash
git checkout feature/local-usage-stats
git rebase upstream/main
# Drop commits: 1d1eb915e, 0e24866ca, 5c5debed4, f0a7c9c9d
# And the mixed commit fa8f19a6c (provider parts already in B; terminal parts in A)
# Fixup e9f061cb7 to remove temp scripts
# Resolve conflicts (likely: Task.ts from C merge, provider files from B merge)
git push myk1yt feature/local-usage-stats --force-with-lease
# Open PR targeting upstream/main
```

---

## Conflict Risk Matrix

| File pattern                                   | PR C | PR A | PR B | PR D | Risk                    |
| ---------------------------------------------- | ---- | ---- | ---- | ---- | ----------------------- |
| `src/core/task/Task.ts`                        | ✅   |      |      |      | 🟢 Only PR C touches it |
| `src/core/tools/ExecuteCommandTool.ts`         |      | ✅   |      |      | 🟢 Only PR A            |
| `src/integrations/terminal/TerminalProcess.ts` |      | ✅   |      |      | 🟢 Only PR A            |
| `src/integrations/terminal/BaseTerminal.ts`    |      | ✅\* |      |      | 🟡 Mixed commit         |
| `src/api/providers/*.ts`                       |      |      | ✅   |      | 🟢 Only PR B            |
| `src/api/providers/__tests__/*.ts`             |      |      | ✅   |      | 🟢 Only PR B            |
| `apps/vscode-e2e/`                             |      | ✅\* |      |      | 🟡 Mixed commit         |
| `src/services/stats/`                          |      |      |      | ✅   | 🟢 Only PR D            |
| `webview-ui/` (dashboard)                      |      |      |      | ✅   | 🟢 Only PR D            |
| `locales/`, `package.nls.*`                    |      |      |      | ✅   | 🟢 Only PR D            |

> ✅\* = Partial ownership from mixed commit `fa8f19a6c`

---

## Merge Order & Dependencies

```
    [upstream/main]
         │
    ┌────┴────┐
    ▼         ▼
   PR C      PR A      (can open in parallel)
    │         │
    └────┬────┘
         ▼
        PR B           (after C and A are at least open)
         │
         ▼
        PR D           (after B merges — rebase required)
```

**Why PR B before PR D?**

- PR D's `costRecalculation.ts` imports `totalCost` from provider streams, which PR B introduces.
- If PR D rebases onto main-with-B, the provider file conflicts disappear.

---

## PR D Size Concern

PR D will still be ~120 files, ~19k lines. This is large. If the reviewer wants further splitting, PR D could be decomposed into:

| Sub-PR | Scope                                                                  | Est. files |
| ------ | ---------------------------------------------------------------------- | ---------- |
| D1     | Stats backend (store, aggregator, contracts, Task.ts instrumentation)  | ~25        |
| D2     | Dashboard UI (DashboardView, UsageHeatmap, SessionList, SessionDetail) | ~30        |
| D3     | i18n (17 language translations, package.nls changes)                   | ~60        |
| D4     | Tests (all spec files, CI fixes, coverage)                             | ~15        |

But the reviewer's request was for 4 PRs total, so we should first present this plan and confirm whether further D-splitting is desired.

---

## Action Items

- [ ] User approves this plan
- [ ] Execute Step 2 (PR C branch + cherry-pick)
- [ ] Execute Step 3 (PR A branch + cherry-pick + cleanup)
- [ ] Execute Step 4 (PR B branch + cherry-pick)
- [ ] Open PRs C and A in parallel
- [ ] Wait for B merge
- [ ] Execute Step 5 (PR D rebase)
- [ ] Open PR D
