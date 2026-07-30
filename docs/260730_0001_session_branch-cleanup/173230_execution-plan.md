# VP Execution Plan — feat/error-interception-middleware 오염 제거 (Runbook)

> ⚠️ **All commands below are git mutations and are VP-ONLY.** Debug mode has already
> validated feasibility via a restored dry-run. Execute top-to-bottom. Do not skip the backup.

## Strategy (validated)

Rebase the **remote** feature series onto current `main` with a single `--onto` range:

- Range: `d27153a25..5c8c495e0` (18 commits = the patch-identical remote copy of the feature).
- This **automatically drops** the 16 upstream commits (already ancestors of `main`) and the
  4 SHELL commits (absent from the remote series). No hand-selection of 19 hashes needed.
- Expected conflicts: **exactly 1**, in `src/eslint-suppressions.json`.

## Preconditions (verify before starting)

```powershell
git fetch myk1yt
git rev-parse main        # must be 569b43df9
git rev-parse d27153a25   # remote series base (upstream tip, ancestor of main)
git rev-parse 5c8c495e0   # remote feature tip
```

## Step 1 — Backup (MANDATORY)

```powershell
git branch feat/error-interception-middleware-backup feat/error-interception-middleware
# also snapshot the remote-tracking ref for the cherry-pick source
git branch feat/error-interception-remote-src 5c8c495e0
```

## Step 2 — Create clean branch from main

```powershell
git checkout -b feat/error-interception-middleware-clean main
```

## Step 3 — Rebase the feature series onto main

```powershell
git rebase --onto main d27153a25 feat/error-interception-middleware-clean
# (clean branch is at main; instead rebase the remote source series)
```

**Corrected command** (rebase the source series, landing on the clean branch name):

```powershell
git checkout feat/error-interception-remote-src
git rebase --onto main d27153a25 feat/error-interception-remote-src
```

### Step 3a — Resolve the single expected conflict (`src/eslint-suppressions.json`)

When the rebase stops at commit `a10a145de` (step ~12/18):

```powershell
git checkout --ours src/eslint-suppressions.json   # take main's (tab-indented) version
git add src/eslint-suppressions.json
git rebase --continue
```

If any _unexpected_ conflict appears (not `eslint-suppressions.json`), STOP and report to VP
before continuing — the dry-run predicted only this one.

### Step 3b — Regenerate suppression counts against current main (post-rebase)

```powershell
pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 .
git add src/eslint-suppressions.json
git commit -m "chore(error-interception): prune eslint suppressions onto main 569b43df9"
```

## Step 4 — Verify

```powershell
pnpm check-types
cd src; npx vitest run core/tools/error-interception/; cd ..
```

Also run the adjacent suites the feature touches (assistant-message parser + e2e fixture unit tests):

```powershell
cd src; npx vitest run core/assistant-message/; cd ..
```

## Step 5 — Confirm contamination is gone

```powershell
git log --oneline feat/error-interception-remote-src --not main
# Expect: ONLY the 18 feature commits. No 9c10c6c62..9762e0e0f, no 0ead76de7/71a85444f/8e6799525/3947666f0.
```

## Step 6 — Replace the contaminated branch (VP decision point)

```powershell
git branch -f feat/error-interception-middleware feat/error-interception-remote-src
git checkout feat/error-interception-middleware
git branch -D feat/error-interception-remote-src
# force-push requires user/CPO approval (irreversible on remote):
git push --force-with-lease myk1yt feat/error-interception-middleware
```

Keep `feat/error-interception-middleware-backup` until the force-push is confirmed good.

## Rollback

If verification fails at any point before Step 6:

```powershell
git rebase --abort   # if mid-rebase
git checkout feature/local-usage-stats
# original branch untouched; backup + contaminated branch still intact.
```

## Appendix A — The 18 feature commits (rebase range, oldest→newest)

`f41920598` feat: add deterministic error interception middleware
`f5bb527d0` fix: address CodeRabbit review findings
`6bd6ec265` fix: update e2e fixture and add coverage tests for Codecov
`7d45ce145` test: add 3 targeted coverage tests for 80% Codecov threshold
`4e29301bc` test: add 13 targeted tests for 80%+ Codecov patch coverage
`37b9b1c5d` feat: add INVALID_JSON_ARGUMENTS pattern for concatenated JSON objects
`027191514` fix: add logging to silent error paths
`5b800dcac` feat: improve AI guidance quality for 4 patterns
`f81d1fb0a` fix: show errors to user in UI alongside AI guidance
`9d3e65d27` feat: user-friendly error UI with structured detail view
`d5255546c` fix: add non-null assertion in test to satisfy TS strict mode
`3f5497e86` fix: update stale test assertion for unknown tool error format
`a10a145de` fix: rebase onto upstream/main and fix eslint suppressions ← CONFLICT HERE
`3d9964eaf` fix: address PR review findings and improve guidance
`fefbe54ae` fix: resolve CI lint and test failures for PR #1009
`321da70c8` fix(e2e): update apply-diff fixture + INVALID_JSON_ARGUMENTS integration test
`cc4008dd8` fix: correct PushToolResult type in integration test
`5c8c495e0` docs: add flaky-test note for interrupted-child E2E

## Appendix B — Files changed by the feature (26)

- `.gitignore` ← note: verify the rebase keeps the "revert non-feature .gitignore changes" intent (commit `3013a09f7` on local; confirm net `.gitignore` diff vs main is empty or feature-only)
- `apps/vscode-e2e/src/fixtures/apply-diff.ts`, `apps/vscode-e2e/src/suite/subtasks.test.ts`
- `src/core/assistant-message/NativeToolCallParser.ts`, `presentAssistantMessage.ts` + 6 spec files
- `src/core/tools/error-interception/`: `ErrorClassifier.ts`, `MessageTransformer.ts`,
  `StructuralValidator.ts`, `TaskErrorState.ts`, `ToolErrorInterceptor.ts`, `errorPatterns.ts`,
  `index.ts`, `types.ts` + 5 spec files
- `src/eslint-suppressions.json`

## Note on `.gitignore`

The local series ends with `3013a09f7` "revert non-feature .gitignore changes". The remote
series (`..5c8c495e0`) does NOT include that revert commit. After the rebase, run:

```powershell
git diff main feat/error-interception-middleware -- .gitignore
```

If a non-feature `.gitignore` delta remains, port `3013a09f7`'s revert onto the clean branch.
