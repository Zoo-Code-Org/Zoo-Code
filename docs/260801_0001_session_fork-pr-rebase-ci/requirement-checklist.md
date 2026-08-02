# Requirement Checklist

## Task: Fork PR Rebase & CI Pass (myk1yt/Zoo-Code)

## Date: 260801

### Phase 1: Fork Main Sync

- [ ] [REQ-001] Sync `myk1yt/main` with `upstream/main` (17 commits behind)
- [ ] [REQ-002] Force-push synced main to `myk1yt/main`

### Phase 2: Branch Rebase (Dependency Order)

- [ ] [REQ-003] Rebase Wave 1 branches (no deps): B01, B04, B08, B13
- [ ] [REQ-004] Rebase Wave 2 branches (deps on Wave 1): B02, B05, B09
- [ ] [REQ-005] Rebase Wave 3 branches (deps on Wave 2): B03, B05a, B06
- [ ] [REQ-006] Rebase Wave 4 branches (deps on Wave 3): B07, B10, B12
- [ ] [REQ-007] Rebase Wave 5 branches (deps on Wave 4): B14, B15, B17
- [ ] [REQ-008] Rebase Wave 6 branches (deps on Wave 5): B16

### Phase 3: CI Verification

- [ ] [REQ-009] Each rebased branch passes: `pnpm lint`
- [ ] [REQ-010] Each rebased branch passes: `pnpm check-types`
- [ ] [REQ-011] Each rebased branch passes: `pnpm knip`
- [ ] [REQ-012] Each rebased branch passes: `node scripts/find-missing-translations.js`

### Phase 4: Push & PR

- [ ] [REQ-013] All branches pushed to `myk1yt` remote
- [ ] [REQ-014] PRs created with dependency chain documented
- [ ] [REQ-015] All PRs show CI GREEN on GitHub

### Branch Dependency Graph

```
Wave 1 (no deps):
  B01  (error-contracts)
  B04  (shell-contracts)
  B08  (task-persistence)
  B13  (usage-store)

Wave 2:
  B02  ← B01
  B05  ← B04
  B09  ← B08

Wave 3:
  B03  ← B01, B02
  B05a ← B05
  B06  ← B05

Wave 4:
  B07  ← B05, B06
  B10  ← B09
  B12  ← B05a, B11

Wave 5:
  B14  ← B13
  B15  ← B12, B13, B14
  B17  ← B05a

Wave 6:
  B16  ← B09, B10, B14, B15
```
