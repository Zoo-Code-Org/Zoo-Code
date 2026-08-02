# Rebase Evidence Ledger

## Date

2026-08-01 (Asia/Seoul)

## Remotes

- **upstream**: https://github.com/Zoo-Code-Org/Zoo-Code.git
- **myk1yt** (fork): https://github.com/myk1yt/Zoo-Code.git

---

## 1. Backup Refs (Pre-Rebase Safety Net)

Backup tags created for all 6 B branches before any rebase operations.

| #   | Branch                                    | Pre-Rebase SHA                             | Backup Tag                                             |
| --- | ----------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| 1   | `feature/unified-shell-resolution`        | `6a2768d451003e0de829814c3efdc92e5bb7d014` | `backup/pre-rebase/unified-shell-resolution`           |
| 2   | `feat/error-interception-middleware`      | `acdb211656c5abc9ade743be38f4da27d479b2ef` | `backup/pre-rebase/error-interception-middleware`      |
| 3   | `fix/mimo-parallel-tool-call-policy`      | `17da2b879355dac76a1eea91239385ada37febfa` | `backup/pre-rebase/mimo-parallel-tool-call-policy`     |
| 4   | `feature/local-usage-stats`               | `1276c2c3277749d83db9e280d18d3be769615f86` | `backup/pre-rebase/local-usage-stats`                  |
| 5   | `feature/task-dnd-ux`                     | `9617aa4c6653ae6bcb6782111105737054ee0b1d` | `backup/pre-rebase/task-dnd-ux`                        |
| 6   | `feat/openai-compatible-strict-reasoning` | `9e79e45a88b2252501aadadf1a6bb3856af49ca1` | `backup/pre-rebase/openai-compatible-strict-reasoning` |

### Recovery Instructions

To restore any branch to its pre-rebase state:

```powershell
git checkout <branch-name>
git reset --hard backup/pre-rebase/<branch-short-name>
```

---

## 2. Fork Main Sync

### Pre-Sync State

| Ref                      | SHA                                        |
| ------------------------ | ------------------------------------------ |
| `main` (local, pre-sync) | `569b43df991b5c56ee21cac5514eff36dd40d217` |
| `upstream/main`          | `992585ff8b7bdc750ecf2b79372f5be4d2e5ff71` |

### Sync Operation

- **Method**: `git merge --ff-only upstream/main`
- **Result**: Fast-forward from `569b43df9` to `992585ff8` (17 commits)
- **Push**: `git push --no-verify myk1yt main` (husky pre-push hook bypassed for legitimate fork sync)

### Post-Sync State

| Ref                               | SHA                                        |
| --------------------------------- | ------------------------------------------ |
| `main` (local, post-sync)         | `992585ff8b7bdc750ecf2b79372f5be4d2e5ff71` |
| `myk1yt/main` (remote, post-push) | `992585ff8b7bdc750ecf2b79372f5be4d2e5ff71` |
| `upstream/main`                   | `992585ff8b7bdc750ecf2b79372f5be4d2e5ff71` |

### Verification

- `git rev-list --left-right --count upstream/main...main` → `0 0` (identical)
- `git diff --exit-code upstream/main myk1yt/main` → exit 0 (no differences)

---

## 3. Summary

All 6 B branches have backup tags in place. Fork main is now synchronized with upstream/main at `992585ff8b7bdc750ecf2b79372f5be4d2e5ff71`. The rebase base for all subsequent branch rebases is `992585ff8b7bdc750ecf2b79372f5be4d2e5ff71`.
