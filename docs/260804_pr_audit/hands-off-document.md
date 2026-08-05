# 📋 Hands-Off Document: 17 Stacked PR → Upstream Zoo-Code-Org

> **Created**: 2026-08-04 20:11 KST
> **Purpose**: Next session picks up from here to complete upstream PR submission
> **Do NOT load Crow Memory** — all context is in this document

---

## 1. Goal

Push 17 squashed stacked PR branches to `Zoo-Code-Org/Zoo-Code` and create PRs there.

## 2. Current State

### Repository

- **Fork**: `myk1yt/Zoo-Code` (remote name: `myk1yt` or `origin`)
- **Upstream**: `Zoo-Code-Org/Zoo-Code` (remote name: `upstream`)
- **Local workspace**: `c:/Users/k1yt/OneDrive/Projects/ZooCode`

### 17 PR Branches (all exist on `myk1yt/Zoo-Code`, all OPEN)

| PR# | Branch                         | Base | Feature                             | Squash Commit Message                                                        |
| --- | ------------------------------ | ---- | ----------------------------------- | ---------------------------------------------------------------------------- |
| #22 | `pr/b04-shell-contracts-v2`    | main | unified-shell (1/4)                 | `feat: add unified shell resolution contracts and settings UI`               |
| #23 | `pr/b01-error-contracts-v2`    | main | error-interception (1/3)            | `feat: add error interception classification contracts`                      |
| #24 | `pr/b08-task-persistence-v2`   | main | task-dnd-ux (1/3)                   | `feat: add task organization persistence store and schema`                   |
| #25 | `pr/b13-usage-store-v2`        | main | local-usage-stats (1/4)             | `feat: add usage statistics event store and contracts`                       |
| #26 | `pr/b05a-strict-reasoning-v2`  | main | openai-strict (1/2) **SHARED ROOT** | `feat: add provider strict reasoning settings and base request shaping`      |
| #27 | `pr/b05-shell-resolution-v2`   | #22  | unified-shell (2/4)                 | `feat: add shell resolver, invocation adapter, and profile resolution`       |
| #28 | `pr/b02-error-runtime-v2`      | #23  | error-interception (2/3)            | `feat: add error interception runtime and task error state`                  |
| #29 | `pr/b09-task-org-ipc-v2`       | #24  | task-dnd-ux (2/3)                   | `feat: add task organization message handler and webview IPC`                |
| #30 | `pr/b03-error-integration-v2`  | #28  | error-interception (3/3)            | `feat: integrate error interception into assistant message presentation`     |
| #31 | `pr/b10-task-org-ui-v2`        | #29  | task-dnd-ux (3/3)                   | `feat: add task organization DnD UI, dialogs, and optimistic reconciliation` |
| #32 | `pr/b12-mimo-enforcement-v2`   | #26  | mimo (2/2)                          | `fix: add MiMo parallel tool call policy, ghost quarantine, and retention`   |
| #33 | `pr/b14-usage-aggregation-v2`  | #25  | local-usage-stats (2/4)             | `feat: add usage aggregation, cost recalculation, and service`               |
| #34 | `pr/b17-provider-cost-v2`      | #26  | openai-strict (2/2)                 | `feat: add provider cost normalization and usage field handling`             |
| #35 | `pr/b15-usage-capture-v2`      | #33  | local-usage-stats (3/4)             | `feat: add exactly-once usage capture from task API completion`              |
| #36 | `pr/b16-stats-ui-v2`           | #35  | local-usage-stats (4/4)             | `feat: add SQLite projection, migration, stream IPC, and dashboard UI`       |
| #37 | `pr/b06-terminal-lifecycle-v2` | #27  | unified-shell (3/4)                 | `feat: add terminal lifecycle, command scheduler, registry, and trace`       |
| #38 | `pr/b07-shell-integration-v2`  | #37  | unified-shell (4/4)                 | `feat: wire shell resolver and lifecycle to task, command tool, and API`     |

### Dependency Graph

```
main
├── #22 (b04) ──→ #27 (b05) ──→ #37 (b06) ──→ #38 (b07)
├── #23 (b01) ──→ #28 (b02) ──→ #30 (b03)
├── #24 (b08) ──→ #29 (b09) ──→ #31 (b10)
├── #25 (b13) ──→ #33 (b14) ──→ #35 (b15) ──→ #36 (b16)
└── #26 (b05a) ──→ #32 (b12)
              └──→ #34 (b17)
```

### PR Descriptions

- All PR descriptions are already written on `myk1yt/Zoo-Code`
- Use `gh api repos/myk1yt/Zoo-Code/pulls/{num}` to fetch each description
- Reuse the `body` field when creating PRs on `Zoo-Code-Org/Zoo-Code`

## 3. Blocking Issues from This Session

### Issue 1: Permission Denied (403)

- `myk1yt` does NOT have push access to `Zoo-Code-Org/Zoo-Code`
- **Fix needed**: Either:
    - (A) Add `myk1yt` as collaborator on `Zoo-Code-Org/Zoo-Code`
    - (B) Push to `myk1yt/Zoo-Code` fork and create PRs from fork → `Zoo-Code-Org/Zoo-Code`
    - (C) Use GitHub API `create_pull_request` with `head: "myk1yt:pr/bXX"` and `base: "pr/bYY"` or `"main"`

### Issue 2: Bug Found During Push Attempt

- A bug was discovered during the squash process (details in `docs/260804_pr_audit/091400_code-report.md`)
- Needs to be fixed before re-attempting

### Issue 3: Branches Modified Since Audit

- Some branches were modified during bug fixing in this session
- Need to re-verify branch state before squashing

## 4. Squash Strategy

For each PR branch (in dependency order):

```powershell
# Phase 1: Root PRs (base = upstream/main)
git fetch upstream
git checkout -b temp/pr/bXX upstream/main
git merge --squash myk1yt/pr/bXX-v2
git commit -m "<squash commit message>"
git push upstream HEAD:pr/bXX-v2 --force-with-lease
git checkout main
git branch -D temp/pr/bXX

# Phase 2+: Stacked PRs (base = previously pushed squashed branch)
git checkout -b temp/pr/bXX upstream/<base_branch>
git merge --squash myk1yt/pr/bXX-v2
git commit -m "<squash commit message>"
git push upstream HEAD:pr/bXX-v2 --force-with-lease
git checkout main
git branch -D temp/pr/bXX
```

### Automation Script

- Already created: [`scripts/squash-push-17prs.ps1`](scripts/squash-push-17prs.ps1)
- Needs: permission fix + bug fix before running

## 5. PR Creation Strategy

After all 17 branches are pushed to `Zoo-Code-Org/Zoo-Code`:

```powershell
# For each PR, create via GitHub API
gh api repos/Zoo-Code-Org/Zoo-Code/pulls `
  --method POST `
  --field title="<PR title>" `
  --field body="<PR description from myk1yt>" `
  --field head="<branch_name>" `
  --field base="<base_branch>" `
  --field draft=false
```

### PR Creation Order (must follow dependency order)

1. Phase 1 (base=main): #22, #23, #24, #25, #26
2. Phase 2 (base=Phase 1 branch): #27, #28, #29, #32, #33, #34
3. Phase 3 (base=Phase 2 branch): #30, #31, #35, #37
4. Phase 4 (base=Phase 3 branch): #36, #38

## 6. Key Findings from This Session

### Audit Results

- **17 PRs confirmed**: All exist, all OPEN, all mergeable
- **15 junk files removed**: 12 from PR #31, 3 from PR #36
- **Source code verification**: PR chain tips are equal to or MORE up-to-date than feature branches
- **Cross-branch shared files**: `Task.ts`, `ClineProvider.ts`, `webviewMessageHandler.ts`, `eslint-suppressions.json` (managed via dependency ordering)

### Known CodeQL Issue (PR #30)

- `presentAssistantMessage.ts` line ~70: `.replace(/_/g, "_")` — replaces underscore with itself
- GitHub Advanced Security flagged this as "Replacement of a substring with itself"
- Should be fixed (remove the `.replace(/_/g, "_")` or replace with actual intended replacement)

### 6 Feature Branches (NOT submitted as PRs)

- `feature/unified-shell-resolution`
- `feat/error-interception-middleware`
- `fix/mimo-parallel-tool-call-policy`
- `feature/local-usage-stats`
- `feature/task-dnd-ux`
- `feat/openai-compatible-strict-reasoning`

These are the aggregated results of the stacked PR chains. NOT used for upstream submission.

## 7. Session Reports

All reports from this session are in:

- [`docs/260804_pr_audit/`](docs/260804_pr_audit/)
    - [`audit-report.md`](docs/260804_pr_audit/audit-report.md) — Initial audit
    - [`deep_diff_report.md`](docs/260804_pr_audit/deep_diff_report.md) — Feature vs PR comparison
    - [`172500_code-report.md`](docs/260804_pr_audit/172500_code-report.md) — Junk cleanup report
    - [`091400_code-report.md`](docs/260804_pr_audit/091400_code-report.md) — Squash attempt report

## 8. Next Session Action Items

1. **Resolve permission**: Get push access to `Zoo-Code-Org/Zoo-Code` OR use fork-based PR strategy
2. **Fix bug**: Check `docs/260804_pr_audit/091400_code-report.md` for details
3. **Re-verify branches**: Run `verify_tips.py` again to confirm branch state
4. **Run squash script**: Execute `scripts/squash-push-17prs.ps1`
5. **Create 17 PRs**: Via GitHub API in dependency order
6. **Fix CodeQL issue**: Remove `.replace(/_/g, "_")` in `presentAssistantMessage.ts`
