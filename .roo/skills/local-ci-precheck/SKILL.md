---
name: local-ci-precheck
description: >
  Pre-push CI check skill that runs 12 local CI checks (git diff, invisible chars, lockfile, translations, ESLint, Prettier, TypeScript, knip, build, unit tests, coverage, E2E mock, webview visual) before git push. Prevents CI failures by catching errors locally in ~5 minutes instead of waiting for GitHub Actions. Use when about to git push in the Zoo Code project.
---

# Local CI Pre-check Skill

## Role

You are a **Local CI Pre-flight Agent**. Your sole job is to run the fastest possible local validation suite before the user executes `git push` in the Zoo Code project. You catch errors locally in ~5 minutes instead of letting them fail 15 minutes later on GitHub Actions.

## When to Activate

Activate **immediately** when:
- The user says anything semantically equivalent to "push", "git push", "commit and push", "PR ready", "check before push", or "CI pre-check".
- The user is in Code mode or Light-Code mode and about to push changes to the Zoo Code repository.
- The user asks you to verify changes before opening a pull request.

## When to Refuse / Skip

Do **NOT** run this skill if ANY of the following is true:
1. The user explicitly passed `--skip-ci-check` in their command.
2. **Only** non-source files changed: `.md`, `.json` (except `package.json`/`tsconfig.json`), `.yml`/`.yaml` (except workflow logic changes), `.github/` label/config changes, `docs/` changes, `.gitignore`, `.gitattributes`.
3. The target branch does not have CI enabled (e.g., a personal experiment branch with no PR intended).
4. The user is working on a completely different project that is not Zoo Code.

If skipping, output exactly: `⏭️ CI pre-check skipped (no source code changes or --skip-ci-check flag).`

## Pre-conditions (Verify Before First Check)

Before running **any** check, confirm:

1. `node --version` works (Node.js installed).
2. `corepack pnpm install` has been run and `node_modules` exists.
3. Current working directory is the Zoo Code project root (contains `package.json`, `pnpm-workspace.yaml`, `turbo.json`).

If any pre-condition fails, stop immediately and report the failure.

---

## Execution Order: 12 Checks (Fastest-First, Stop on First Failure)

Run the following checks **strictly in order**. If any check fails, **stop immediately**, skip all remaining checks, and output the failure summary table. Do not attempt to auto-fix unless the user explicitly asks.

---

### Check 0: Git Diff Integrity (~1s)

Detect trailing whitespace, merge conflict markers, and blank lines at EOF.

**Windows (PowerShell):**
```powershell
git diff --check HEAD; if ($LASTEXITCODE -ne 0) { exit 1 }
```

**Linux/Mac (bash):**
```bash
git diff --check HEAD
```

**Pass criteria:** Exit code 0, no output.

**Failure diagnosis:**
- Output shows `filename:line: trailing whitespace` or `filename:line: conflict marker`
- Open the file, remove trailing spaces, resolve conflict markers, or remove blank lines at EOF.
- Re-run Check 0.

---

### Check 1: Invisible Characters (~2s)

Detect zero-width characters, directional overrides, BOM, and soft hyphens.

**Windows (PowerShell):**
```powershell
$patterns = '[\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}\x{FEFF}\x{00AD}]'
Get-ChildItem -Recurse -Include *.ts,*.tsx,*.js,*.mjs,*.cjs,*.cts,*.mts,*.sh,*.yml,*.yaml -Exclude node_modules,dist,out,coverage,.turbo,.vinxi -Path src,webview-ui,packages,apps,.github |
  Select-String -Pattern $patterns |
  ForEach-Object { Write-Host "FOUND: $($_.Filename):$($_.LineNumber): $($_.Line)" }
if ($LASTEXITCODE -eq 0 -and $?) { exit 0 } else { exit 1 }
```

**Linux/Mac (bash):**
```bash
grep -rnP '[\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}\x{FEFF}\x{00AD}]' \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
  --include='*.cjs' --include='*.cts' --include='*.mts' --include='*.sh' \
  --include='*.yml' --include='*.yaml' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=out \
  --exclude-dir=coverage --exclude-dir=.turbo --exclude-dir=.vinxi \
  src webview-ui packages apps .github
```

**Pass criteria:** No output (exit code 0).

**Failure diagnosis:**
- If output appears, a file contains invisible Unicode characters.
- Open the file and remove the invisible character(s). Common culprits: copy-pasted text from web pages, accidental BOM.
- Re-run Check 1 to confirm clean.

---

### Check 2: Lockfile Synchronization (~5s)

Verify `pnpm-lock.yaml` is in sync with `package.json`.

**All platforms:**
```bash
corepack pnpm install --frozen-lockfile
```

**Pass criteria:** Exit code 0, lockfile not modified.

**Failure diagnosis:**
- If exit code is non-zero, `package.json` was modified without updating `pnpm-lock.yaml`.
- Run `corepack pnpm install` (without `--frozen-lockfile`) to regenerate, then commit the updated lockfile.
- Re-run Check 2.

---

### Check 3: Check Translations (~5s)

Verify all locale translation files are complete and no keys are missing.

**All platforms:**
```bash
node scripts/find-missing-translations.js
```

**Pass criteria:** Exit code 0, no "missing" output.

**Failure diagnosis:**
- The script lists missing translation keys per locale.
- Add missing keys to each locale file under `src/i18n/locales/` and `webview-ui/src/i18n/locales/`.
- Reference the English (`en`) file as the source of truth.
- Re-run Check 3.

---

### Check 4: Lint ESLint (~30s)

Run ESLint with zero-warning tolerance and auto-prune stale suppressions.

**Windows (PowerShell):**
```powershell
cd src; npx eslint --max-warnings=0 --prune-suppressions .
```

**Linux/Mac (bash):**
```bash
cd src && npx eslint --max-warnings=0 --prune-suppressions .
```

**Pass criteria:** Exit code 0, no warnings or errors.

**Failure diagnosis:**

*Scenario A: "There are suppressions left that do not occur anymore"*
- `eslint-suppressions.json` has stale entries. `--prune-suppressions` auto-removes them on successful run.
- If prune itself fails, manually open `src/eslint-suppressions.json` and remove entries for rules/files that no longer produce warnings.
- After cleanup: `git add src/eslint-suppressions.json` and commit.

*Scenario B: ESLint rule violations*
- Output shows `filepath:line:col: error [rule-name] message`.
- Fix each file according to the rule. Common rules: `@typescript-eslint/no-unused-vars`, `no-console`, `prefer-const`.
- Re-run Check 4 after each fix.

---

### Check 5: Format Prettier (~15s)

Verify code formatting across all project areas.

**Windows (PowerShell):**
```powershell
cd src; npx prettier --check .; cd ..\webview-ui; npx prettier --check .; cd ..\packages\core; npx prettier --check .
```

**Linux/Mac (bash):**
```bash
cd src && npx prettier --check . && cd ../webview-ui && npx prettier --check . && cd ../packages/core && npx prettier --check .
```

**Pass criteria:** Exit code 0 for all three directories.

**Failure diagnosis:**
- Output lists unformatted files: `filepath`
- Run `npx prettier --write .` in the failing directory, then stage the changes.
- Re-run Check 5.

---

### Check 6: Check Types (~60s)

Run TypeScript type checking across all three project areas.

**Windows (PowerShell):**
```powershell
cd src; npx tsc --noEmit
cd ..\webview-ui; npx tsc --noEmit
cd ..\packages\core; npx tsc --noEmit
```

**Linux/Mac (bash):**
```bash
cd src && npx tsc --noEmit
cd ../webview-ui && npx tsc --noEmit
cd ../packages/core && npx tsc --noEmit
```

**Pass criteria:** Exit code 0 for all three directories, zero type errors.

**Failure diagnosis:**
- `TS2322`: Type mismatch — check expected vs actual type.
- `TS2339`: Property does not exist — check type definition or add property.
- `TS2345`: Argument type mismatch — cast or adjust argument.
- `TS2531`: Object is possibly null — add null check.
- After fixing, re-run the failing directory's `tsc --noEmit` to confirm.
- If a new type is introduced, ensure it is exported from the correct module.

---

### Check 7: Knip (~30s)

Detect unused code, unused dependencies, and unlisted dependencies.

**All platforms:**
```bash
corepack pnpm knip
```

**Pass criteria:** Exit code 0, no unused exports or unlisted dependencies reported.

**Failure diagnosis:**
- **Unused exports**: Remove unused function/variable/type, or prefix with `_` if intentionally unused.
- **Unused dependencies**: Remove from `package.json` with `corepack pnpm remove <package>`.
- **Unlisted dependencies**: Add missing package to correct `package.json`.
- **Unused files**: Verify file is truly unused, then delete.
- Re-run Check 7 after fixes.

---

### Check 8: Build Compile (~45s)

Run actual build pipeline (not just type check) to catch bundling/esbuild/vite errors.

**All platforms:**
```bash
corepack pnpm turbo run build --filter=@roo-code/vscode
```

**Pass criteria:** Exit code 0, no build errors.

**Failure diagnosis:**
- `Error: Cannot find module` — missing dependency or incorrect import path.
- `SyntaxError` in bundled output — check for unsupported syntax in target environment.
- `Out of memory` — may need to increase Node memory limit.
- Fix the error, re-run Check 8.

---

### Check 9: Unit Tests (~120s)

Run all unit and integration tests with coverage.

**All platforms:**
```bash
corepack pnpm turbo run test:coverage
```

**Alternative (individual packages):**
```bash
# Non-core packages
corepack pnpm turbo run test:coverage --filter="!@roo-code/core"

# Core unit tests
corepack pnpm turbo run test:coverage:unit --filter="@roo-code/core"

# Core integration tests
corepack pnpm turbo run test:coverage:integration --filter="@roo-code/core"
```

**Pass criteria:** Exit code 0, all tests pass, no coverage regression below threshold.

**Failure diagnosis:**
- **Assertion failure**: Check expected vs actual value in test.
- **Timeout**: Test may need more time or mock may be missing.
- **Import error**: Module moved or renamed — update import path.
- Fix failing test or production code it tests.
- Re-run only failing package first: `cd <package> && npx vitest run` for faster iteration.
- Once individual package passes, re-run full suite.

---

### Check 10: Coverage Threshold (~5s)

Verify local coverage meets the threshold (mirrors Codecov patch requirement).

**All platforms:**
```bash
# If vitest.config.ts has threshold configured, Check 9 already validates this.
# If not, run explicit check:
cd packages/core && npx vitest run --coverage --threshold=80
```

**Pass criteria:** Exit code 0, coverage ≥ 80% (or project-specific threshold).

**Failure diagnosis:**
- If coverage is below threshold, add tests for uncovered lines/branches.
- Re-run Check 9 and Check 10.

---

### Check 11: E2E Mock (Conditional, ~300s)

Run mocked E2E tests. **Only if** `apps/vscode-e2e/**` files changed.

**Conditional execution (bash):**
```bash
if git diff --name-only HEAD | grep -qE '^apps/vscode-e2e/'; then
  cd apps/vscode-e2e && xvfb-run -a pnpm test:ci:mock
else
  echo "SKIP: No e2e changes detected"
fi
```

**Windows:** E2E mock requires Linux/macOS with xvfb. On Windows, skip with warning: `⚠️ E2E mock requires Linux/macOS environment. Skipping on Windows.`

**Pass criteria:** Exit code 0, all E2E tests pass.

**Failure diagnosis:**
- **VS Code download failure**: Check network or use cached binary.
- **Extension activation failure**: Check for missing dependencies in `apps/vscode-e2e`.
- Fix and re-run.

---

### Check 12: Webview Visual Regression (Conditional, ~60s)

Run webview UI snapshot tests. **Only if** `webview-ui/**` or `src/shared/**` files changed.

**Conditional execution (bash):**
```bash
if git diff --name-only HEAD | grep -qE '^webview-ui/|^src/shared/'; then
  cd webview-ui && npx vitest run
else
  echo "SKIP: No webview-ui changes detected"
fi
```

**Pass criteria:** Exit code 0, all snapshot tests pass.

**Failure diagnosis:**
- **Snapshot mismatch**: If intentional, update:
  ```bash
  cd webview-ui && npx vitest run --update
  ```
  Then review diff in `webview-ui/src/__snapshots__/` and commit.
- **Unexpected layout shift**: Check CSS changes in webview-ui components.
- **Platform font rendering difference**: May be benign pixel-level difference. Verify visually.

---

## Result Format

After all checks complete (or stop at first failure), output this exact summary table:

```
## Local CI Pre-check Results

| # | Check Name         | CI Mapping                  | Status | Duration | Error Details |
|---|--------------------|-----------------------------|--------|----------|---------------|
| 0 | git-diff-check     | compile (pre)               | ✅ PASS| 0.8s     | —             |
| 1 | Invisible Chars    | invisible-chars             | ✅ PASS| 1.2s     | —             |
| 2 | Lockfile Sync      | setup-node-pnpm             | ✅ PASS| 4.5s     | —             |
| 3 | Check Translations | check-translations          | ✅ PASS| 3.1s     | —             |
| 4 | Lint ESLint        | compile (lint)              | ✅ PASS| 22.4s    | —             |
| 5 | Format Prettier    | compile (format)            | ✅ PASS| 12.1s    | —             |
| 6 | Check Types        | compile (types)             | ❌ FAIL| 45.2s    | TS2322 in src/utils.ts:42 |
| 7 | Knip               | knip                        | ⏭️ SKIP| —        | Skipped due to Check 6 failure |
| 8 | Build Compile      | compile (build)             | ⏭️ SKIP| —        | Skipped due to Check 6 failure |
| 9 | Unit Tests         | platform-unit-test          | ⏭️ SKIP| —        | Skipped due to Check 6 failure |
|10 | Coverage Threshold | codecov/patch               | ⏭️ SKIP| —        | Skipped due to Check 6 failure |
|11 | E2E Mock           | e2e-mock                    | ⏭️ SKIP| —        | Skipped due to Check 6 failure |
|12 | Webview Visual     | webview-visual              | ⏭️ SKIP| —        | Skipped due to Check 6 failure |

**Result: FAILED** — Fix Check 6 (Check Types) before pushing.
Suggested fix: src/utils.ts:42 — Type 'string' is not assignable to type 'number'. Check the variable assignment or add proper type assertion.
```

**Rules:**
- If all 12 checks PASS → output `✅ All checks passed. Safe to push.`
- If any check FAILS → stop immediately, skip remaining, output failure table.
- Include exact error message (first 3 lines) in Error Details column.
- Include suggested fix below the table.

---

## Skip Conditions (Expanded)

Skip **individual conditional checks** (11, 12) if their path conditions are not met. Skip the **entire suite** only if:

1. `--skip-ci-check` flag present.
2. `git diff --name-only HEAD` shows **only** files matching:
   - `*.md`
   - `*.json` (excluding `package.json`, `tsconfig.json`, `pnpm-lock.yaml`)
   - `*.yml` / `*.yaml` (excluding workflow logic changes)
   - `.github/` label/config changes
   - `docs/` directory changes
   - `.gitignore`, `.gitattributes`

When skipping the entire suite, output: `⏭️ CI pre-check skipped (no source code changes or --skip-ci-check flag).`

---

## Windows Environment Notes

1. Use `corepack pnpm` instead of bare `pnpm` to avoid PowerShell execution policy errors.
2. Use `Select-String` instead of `grep` for pattern matching in PowerShell.
3. Use `;` as command separator in PowerShell (not `&&`).
4. Use `cd dir; command` pattern — PowerShell `cd` does not chain with `&&` like bash.
5. Path separators: Use `\` in PowerShell, `/` in bash.
6. Exit code checking: Check `$LASTEXITCODE` after external commands.
7. **E2E Mock (Check 11)** is not supported on Windows natively; skip with warning if on Windows.

---

## Critical Reminders

- **Never** run checks out of order. The fastest-first ordering ensures you fail cheap.
- **Never** auto-fix without user consent. Report the failure and suggest the fix.
- **Always** verify pre-conditions before starting Check 0.
- **Always** use `corepack pnpm` not bare `pnpm`.
- **Always** stop at the first failure. Do not run subsequent checks "just in case".
