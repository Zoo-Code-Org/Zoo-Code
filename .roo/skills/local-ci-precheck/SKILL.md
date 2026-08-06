---
name: local-ci-precheck
description: Pre-push CI check skill that runs 7 local CI checks (invisible characters, translations, ESLint, TypeScript, knip, unit tests, webview visual) before git push. Prevents CI failures by catching errors locally in ~5 minutes instead of waiting for GitHub Actions. Use when about to git push in the Zoo Code project.
---

# Local CI Pre-check Skill

## When to Use This Skill

Use this skill when:

- Code mode or Light-Code mode is about to `git push` in the Zoo Code project
- You want to verify that all locally-runnable CI checks pass before pushing
- You want to catch lint errors, type errors, test failures, and dead code before CI

## When NOT to Use This Skill

Do NOT use this skill when:

- The user explicitly passes `--skip-ci-check`
- Only non-source files changed (e.g., only `.md`, `.json` config files, `.yml` workflow files with no logic changes)
- Pushing to a branch that does not have CI enabled

## Pre-conditions

Before running checks, verify:

1. Node.js is installed (`node --version`)
2. Dependencies are installed (`corepack pnpm install`)
3. Working directory is the Zoo Code project root

## Checks (Sequential, Fastest-First Order)

Run all 7 checks in order. **Stop at the first failure** and report. Each check includes Windows (PowerShell) and Linux/Mac (bash) commands.

---

### Check 1: Invisible Characters (~2s)

Detect zero-width characters, directional overrides, BOM, and soft hyphens that can cause subtle bugs.

**Windows (PowerShell):**
```powershell
$patterns = '[\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}\x{FEFF}\x{00AD}]'
Get-ChildItem -Recurse -Include *.ts,*.tsx,*.js,*.mjs,*.cjs,*.cts,*.mts,*.sh,*.yml,*.yaml -Exclude node_modules,dist,out,coverage,.turbo,.vinxi -Path src,webview-ui,packages,apps,.github |
  Select-String -Pattern $patterns |
  ForEach-Object { Write-Host "FOUND: $($_.Filename):$($_.LineNumber): $($_.Line)" }
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
- If output appears, a file contains invisible Unicode characters
- The output shows `filename:line number: offending line`
- Open the file and remove the invisible character(s)
- Common culprits: copy-pasted text from web pages, accidental BOM from editors
- After removal, re-run Check 1 to confirm clean

---

### Check 2: Check Translations (~5s)

Verify all locale translation files are complete and no keys are missing.

**Windows (PowerShell):**
```powershell
node scripts/find-missing-translations.js
```

**Linux/Mac (bash):**
```bash
node scripts/find-missing-translations.js
```

**Pass criteria:** Exit code 0, no "missing" output.

**Failure diagnosis:**
- The script lists missing translation keys per locale
- Add the missing keys to each locale file under `src/i18n/locales/` and `webview-ui/src/i18n/locales/`
- Reference the English (`en`) file as the source of truth
- Use the `roo-translation` skill for translation guidelines
- After adding keys, re-run Check 2 to confirm

---

### Check 3: Lint ESLint (~30s)

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
- The `eslint-suppressions.json` file has stale entries from rules that were fixed
- The `--prune-suppressions` flag auto-removes them on successful run
- If the prune itself fails, manually open `src/eslint-suppressions.json` and remove entries for rules/files that no longer produce warnings
- After cleanup: `git add src/eslint-suppressions.json` and commit the change

*Scenario B: ESLint rule violations*
- The output shows `filepath:line:col: error [rule-name] message`
- Open each file and fix the code according to the rule
- Run `npx eslint --max-warnings=0 --prune-suppressions .` again after each fix
- Common rules: `@typescript-eslint/no-unused-vars`, `no-console`, `prefer-const`

---

### Check 4: Check Types (~60s)

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
- The output shows `filepath(line,col): error TSxxxx: message`
- `TS2322`: Type mismatch — check the expected vs actual type
- `TS2339`: Property does not exist — check the type definition or add the property
- `TS2345`: Argument type mismatch — cast or adjust the argument
- `TS2531`: Object is possibly null — add null check
- After fixing, re-run the failing directory's `tsc --noEmit` to confirm
- If a new type is introduced, ensure it is exported from the correct module

---

### Check 5: Knip (~30s)

Detect unused code, unused dependencies, and unlisted dependencies.

**Windows (PowerShell):**
```powershell
corepack pnpm knip
```

**Linux/Mac (bash):**
```bash
corepack pnpm knip
```

**Pass criteria:** Exit code 0, no unused exports or unlisted dependencies reported.

**Failure diagnosis:**
- **Unused exports**: Remove the unused function/variable/type, or prefix with `_` if intentionally unused
- **Unused dependencies**: Remove from `package.json` with `corepack pnpm remove <package>`
- **Unlisted dependencies**: Add the missing package to the correct `package.json`
- **Unused files**: Verify the file is truly unused, then delete it
- After fixes, re-run `corepack pnpm knip` to confirm

---

### Check 6: Unit Tests (~120s)

Run all unit and integration tests with coverage.

**Windows (PowerShell):**
```powershell
corepack pnpm turbo run test:coverage
```

**Linux/Mac (bash):**
```bash
corepack pnpm turbo run test:coverage
```

**Alternative (run packages individually):**
```powershell
# Non-core packages
corepack pnpm turbo run test:coverage --filter="!@roo-code/core"

# Core unit tests
corepack pnpm turbo run test:coverage:unit --filter="@roo-code/core"

# Core integration tests
corepack pnpm turbo run test:coverage:integration --filter="@roo-code/core"
```

**Pass criteria:** Exit code 0, all tests pass, no coverage regression below threshold.

**Failure diagnosis:**
- The output shows which test file and test case failed
- **Assertion failure**: Check the expected vs actual value in the test
- **Timeout**: The test may need more time or a mock may be missing
- **Import error**: A module may have been moved or renamed — update the import path
- Fix the failing test or the production code it tests
- Re-run only the failing package first: `cd <package> && npx vitest run` to iterate faster
- Once individual package passes, re-run full suite: `corepack pnpm turbo run test:coverage`

---

### Check 7: Webview Visual (~60s)

Run webview UI snapshot tests to catch visual regressions.

**Windows (PowerShell):**
```powershell
cd webview-ui; npx vitest run
```

**Linux/Mac (bash):**
```bash
cd webview-ui && npx vitest run
```

**Pass criteria:** Exit code 0, all snapshot tests pass.

**Failure diagnosis:**
- **Snapshot mismatch**: If the visual change is intentional, update the snapshot:
  ```bash
  cd webview-ui && npx vitest run --update
  ```
  Then review the diff in `webview-ui/src/__snapshots__/` and commit the updated snapshots
- **Unexpected layout shift**: Check CSS changes in webview-ui components
- **Missing snapshot baseline**: Run with `--update` to create initial snapshots
- If the difference is only font rendering (pixel-level), it may be a platform difference — verify the change looks correct visually

---

## Result Format

After all checks complete, output a summary table:

```
## Local CI Pre-check Results

| # | Check Name         | Status | Duration | Error Details |
|---|--------------------|--------|----------|---------------|
| 1 | Invisible Chars    | ✅ PASS | 1.2s     | —             |
| 2 | Check Translations | ✅ PASS | 3.1s     | —             |
| 3 | Lint ESLint        | ✅ PASS | 22.4s    | —             |
| 4 | Check Types        | ❌ FAIL | 45.2s    | TS2322 in src/utils.ts:42 |
| 5 | Knip               | ⏭️ SKIP | —        | Skipped due to Check 4 failure |
| 6 | Unit Tests         | ⏭️ SKIP | —        | Skipped due to Check 4 failure |
| 7 | Webview Visual     | ⏭️ SKIP | —        | Skipped due to Check 4 failure |

**Result: FAILED** — Fix Check 4 (Check Types) before pushing.
```

**Rules:**
- If all 7 checks PASS → output `✅ All checks passed. Safe to push.`
- If any check FAILS → stop immediately, skip remaining checks, output the failure table
- Include the exact error message (first 3 lines) in the Error Details column
- Include the suggested fix below the table

---

## Skip Conditions

Skip the entire pre-check if ANY of the following is true:

1. **Flag**: User passed `--skip-ci-check` in the push command
2. **Non-source only**: `git diff --name-only HEAD` shows only files matching:
   - `*.md`
   - `*.json` (excluding `package.json` and `tsconfig.json`)
   - `*.yml` / `*.yaml` (excluding workflow logic changes)
   - `.github/` label/config changes
   - `docs/` directory changes
   - `.gitignore`, `.gitattributes`

When skipping, output: `⏭️ CI pre-check skipped (no source code changes or --skip-ci-check flag).`

---

## Windows Environment Notes

1. **Use `corepack pnpm`** instead of bare `pnpm` to avoid PowerShell execution policy errors (`pnpm.ps1 cannot be loaded`)
2. **Use `Select-String`** instead of `grep` for pattern matching in PowerShell
3. **Use `;`** as command separator in PowerShell (not `&&`)
4. **Use `cd dir; command`** pattern — PowerShell `cd` does not chain with `&&` like bash
5. **Path separators**: Use `\` in PowerShell commands, `/` in bash commands
6. **Exit code checking**: PowerShell does not propagate exit codes the same way as bash — check `$LASTEXITCODE` after external commands if needed
