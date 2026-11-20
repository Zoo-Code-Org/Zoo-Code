---
name: quality-gate
description: >
    Universal, project-agnostic Quality Gate framework. Detects project structure,
    resolves check commands from CI workflows and project scripts, calculates change
    scope, runs non-destructive verification checks, and produces evidence-based
    reports. Audit-only by default — never modifies code without explicit user request.
---

# Quality Gate — Universal Verification Framework

## 1. Purpose

Quality Gate is a universal, project-agnostic verification framework. It:

1. Detects the project structure (root, CI workflows, manifests, lockfiles, build tools, quality configs).
2. Resolves check commands from CI workflows and project scripts (6-tier resolution).
3. Calculates change scope (changed files, base revision, affected monorepo workspaces).
4. Runs non-destructive verification checks across 20 categories.
5. Produces evidence-based reports with a clear verdict.

It is **audit-only by default**: it never modifies code, never auto-fixes, and never mutates the working tree. It works for any project — with or without `package.json` — on Windows PowerShell, bash, and cmd.

## 2. Core Design Principles

### 2.1 Audit-Only Default

Quality Gate NEVER performs any of the following without an explicit, unambiguous user request:

- Auto-fix: `--fix`, `--write`, `-w`, `--autofix`, `eslint --fix`, `prettier --write`, `gofmt -w`, `cargo fmt` (without `--check`), `black` (without `--check`), `isort` (without `--check-only`), `dart format` (without `--output=none`).
- Snapshot updates: `-u`, `--updateSnapshot`, `--ci=false`, `--update-snapshots`.
- Dependency installation: `npm install`, `pnpm install`, `yarn add`, `pip install`, `cargo add`, `go get`, `flutter pub get` (mutating form).
- Lockfile regeneration: `npm install --package-lock-only`, `pnpm install --lockfile-only`, `yarn install --mode=update-lockfile`.
- Unused export deletion: `knip --fix`, `ts-prune --remove`, `eslint --fix` with `no-unused-vars`, `vulture --delete-unused`.
- Test expectation modification: snapshot updates, `--update`, test file rewrites.
- Git state changes: `git add`, `git commit`, `git push`, `git merge`, `git rebase`, `git reset`, `git checkout <commit>`, `git stash`, `git clean`.
- Remote state changes: PR creation, `gh workflow run`, `act`, `git push`, GitHub API mutations, package publishing.
- File deletion or rename of any kind (including generated files and build output).

**Mutation flag handling**: If a resolved command contains a mutation flag, Quality Gate MUST either (a) strip the flag when a read-only equivalent exists (e.g., `eslint --fix` → `eslint`), or (b) reclassify the check as `MANUAL_REVIEW` and report the mutation risk. It must NEVER execute the mutating form.

### 2.2 Separate Verification from Completion

Quality Gate is a **verification skill, not a coding skill**. It reports facts and evidence. On failure it reports the exact cause and a recommended fix, but it does not apply the fix. It NEVER declares "complete", "safe", or "PR ready" while any required check is `FAIL`, `BLOCKED`, `ERROR`, or `TIMEOUT`.

### 2.3 Evidence over Assertion

Every result must be backed by recorded evidence: exact command, cwd, shell, exit code, duration, and key output excerpts. A result without evidence is `NOT_RUN`, not `PASS`.

### 2.4 Repository over Profile

Project profiles are fallback hints, never the source of truth. When the repository (CI workflows, scripts, configs) disagrees with a profile, the repository wins and the report MUST include a `PROFILE DRIFT` note.

## 3. Project Detection

### 3.1 Project Root

1. Run `git rev-parse --show-toplevel` (read-only) to find the repository root.
2. If not a git repository, use the current working directory as root and record `git: none` in the environment table.
3. Record the resolved root path in the report.

### 3.2 CI Workflow Detection

Scan for, in priority order:

- `.github/workflows/*.yml`, `.github/workflows/*.yaml`
- `.gitlab-ci.yml`
- `azure-pipelines.yml`, `.azure-pipelines/*.yml`
- `Jenkinsfile`, `.circleci/config.yml`, `.buildkite/pipeline.yml`, `bitbucket-pipelines.yml`
- `drone.yml`, `.travis.yml`, `appveyor.yml`, `buildspec.yml`, `cloudbuild.yaml`

### 3.3 Manifest Detection

- Node: `package.json` (plus `pnpm-workspace.yaml`, `lerna.json`)
- Rust: `Cargo.toml` (workspace root and members)
- Python: `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt`, `Pipfile`, `poetry.lock`
- Go: `go.mod`
- Java/Kotlin: `pom.xml`, `build.gradle`, `build.gradle.kts`, `settings.gradle`
- Ruby: `Gemfile`, `*.gemspec`
- C#/.NET: `*.csproj`, `*.sln`
- Swift: `Package.swift`
- Dart/Flutter: `pubspec.yaml`
- PHP: `composer.json`
- C/C++: `CMakeLists.txt`, `Makefile`, `meson.build`
- Generic: `Makefile`, `justfile`, `Taskfile.yml`, `Rakefile`

### 3.4 Lockfile Detection

`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `poetry.lock`, `Pipfile.lock`, `go.sum`, `Gemfile.lock`, `composer.lock`, `pubspec.lock`, `gradle.lockfile`, `requirements.lock`

### 3.5 Build Tool Detection

`turbo.json`, `nx.json`, `rush.json`, `lage.config.json`, `bazel` files, `BUILD` files, `flake.nix`, `nix` files

### 3.6 Quality Config Detection

`.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `prettier.config.*`, `tsconfig*.json`, `vitest.config.*`, `jest.config.*`, `playwright.config.*`, `cypress.config.*`, `pytest.ini`, `pyproject.toml` (`[tool.pytest]`, `[tool.ruff]`, `[tool.black]`, `[tool.mypy]`, `[tool.coverage]`), `.flake8`, `ruff.toml`, `.golangci.yml`, `clippy.toml`, `.quality-gate.yml`, `AGENTS.md`, `.editorconfig`

## 4. Command Resolution (6 Tiers)

Resolve each check command in the following order. Stop at the first tier that yields a usable command. Record the tier and fidelity for every check.

### Tier 0: Explicit Safe Override

User/VP provides an explicit command. **Danger detection**: scan the command for mutation flags (see section 2.1). If destructive, refuse and report `BLOCKED` with reason. If safe, use it with fidelity `EXACT` and record `source: user-override`.

### Tier 1: Repository Quality-Gate Config

Look for `.quality-gate.yml` (or `.quality-gate.yaml`) at the repo root, then `AGENTS.md`, then other repo-level config files. Read the `quality-gate:` section for per-check commands. Fidelity `EXACT`, `source: repo-config`.

### Tier 2: CI Workflow Source of Truth

Analyze actual `run:` commands in CI workflows. For each check, find the workflow job that performs it and extract the exact command. Classify fidelity:

- `EXACT`: CI command is directly runnable locally as-is.
- `EQUIVALENT`: CI command needs small local adaptation (CI env vars, artifact paths) but uses the same tool and semantics.
- `APPROXIMATE`: CI command differs materially (different tool, scope, or flags).
- `REMOTE_ONLY`: CI runs on remote infrastructure (CodeQL upload, remote cache, cloud build, GitHub-hosted services) — cannot be reproduced locally.

### Tier 3: Project Scripts from Manifests

Read `package.json` scripts (`lint`, `test`, `build`, `check-types`, `typecheck`, `format:check`, `e2e`, `test:integration`, `test:coverage`), `Makefile` targets, `justfile` recipes, `Cargo.toml` workspace scripts, `pyproject.toml` tool configs. Fidelity `EXACT` (script exists) or `EQUIVALENT` (script exists but wraps CI behavior).

### Tier 4: Ecosystem Tool Detection

Detect installed tools and configs:

- ESLint: `.eslintrc*` / `eslint.config.*` → `npx eslint .` (never `--fix`)
- Prettier: `.prettierrc*` → `npx prettier --check .`
- TypeScript: `tsconfig.json` → `npx tsc --noEmit`
- Vitest: `vitest.config.*` → `npx vitest run`
- Jest: `jest.config.*` → `npx jest --runInBand`
- pytest: `pytest.ini` / `pyproject.toml` → `python -m pytest -q`
- Cargo: `Cargo.toml` → `cargo check` (type/compile), `cargo test`, `cargo clippy -- -D warnings` (lint), `cargo fmt --check` (format)
- Go: `go.mod` → `go vet ./...`, `go test ./...`, `go build ./...`
- Flutter: `pubspec.yaml` → `flutter analyze`, `flutter test`
- Python: `pyproject.toml` → `python -m ruff check .` / `python -m flake8` / `python -m mypy .`

Fidelity: `EXACT` if config and tool are both present; `APPROXIMATE` if the tool is present without config.

### Tier 5: Manual Review

If no tier yields a command, mark the check `MANUAL_REVIEW` with fidelity `MANUAL` and record what was attempted. Do not invent commands.

## 5. Profile Policy

- Profiles (e.g., the Zoo-Code profile in section 17) are fallback hints used only when Tiers 0–4 produce nothing.
- If a profile command differs from what the repository actually defines, use the repository command and emit `PROFILE DRIFT` in the report.
- Never let a profile override CI workflows or repository scripts.

## 6. Change Scope Calculation

### 6.1 Changed File Collection

Collect changed files from ALL of the following (read-only git commands):

1. Committed changes since base: `git diff --name-only <base>...HEAD`
2. Staged: `git diff --cached --name-only`
3. Unstaged: `git diff --name-only`
4. Untracked: `git ls-files --others --exclude-standard`

Merge, dedupe, and sort. Record the total count and the list (or a truncated list with the total).

### 6.2 Base Revision Priority

1. User/VP-specified base
2. CI base (from workflow `on:` push/PR branches, or the PR base ref)
3. Upstream tracking branch (`@{upstream}`)
4. `origin/main`
5. `origin/master`
6. Local `main` / `master`

If no base can be determined, record `base: unknown` and set scope confidence `LOW`.

### 6.3 File Classification

Classify each changed file into categories:

- `source` — implementation code
- `test` — test files, fixtures, mocks
- `build/config` — build scripts, CI, tool configs
- `dependency` — manifests, lockfiles
- `workflow` — CI definitions
- `localization` — locale files, i18n catalogs
- `ui` — UI components, styles, assets
- `docs` — markdown, comments-only changes
- `security-sensitive` — auth, payment, credentials, RBAC, encryption, file upload, network, persistence, migration, public API, concurrency, parsers
- `generated` — build output, generated code, snapshots

### 6.4 Monorepo Affected Workspaces

If a monorepo is detected (`pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `turbo.json`, Cargo workspace, `go.work`):

1. Map each changed file to its workspace/package.
2. Compute dependents: workspaces that depend on changed workspaces (read dependency fields in manifests).
3. Affected = changed workspaces ∪ transitive dependents.
4. Record the affected workspace list in the report; scope test/build checks to affected workspaces when the tool supports it (e.g., `pnpm --filter`).

### 6.5 Scope Confidence

- `HIGH`: base resolved, git history available, classification complete
- `MEDIUM`: base resolved but untracked files or shallow history
- `LOW`: base unknown or not a git repository

## 7. Execution Plan

Before running anything, build an internal plan. For each check, record:

- check ID (`QG-XX`)
- category
- required/optional (per risk level and change scope)
- applicability reason (why this check applies or not)
- resolution tier (0–5)
- fidelity (`EXACT` / `EQUIVALENT` / `APPROXIMATE` / `REMOTE_ONLY` / `MANUAL`)
- command (exact, read-only)
- cwd (explicit directory)
- shell (`powershell` / `bash` / `cmd`)
- environment (env vars, PATH notes)
- timeout (per section 13)
- prerequisites (services, browsers, build artifacts)
- mutation risk (`none` / `low` / `high` — refuse if high)
- expected success criteria (exit code 0, specific output markers)

## 8. Check Categories (QG-01 … QG-20)

### QG-01 Repository State

- **Purpose**: capture root, branch, HEAD, base, changed files, merge conflicts, dirty tree.
- **Commands** (read-only): `git rev-parse --show-toplevel`, `git branch --show-current`, `git rev-parse HEAD`, `git status --porcelain`, `git diff --name-only <base>...HEAD`, `git ls-files --others --exclude-standard`, `git diff --check` (whitespace errors), `git diff --name-only --diff-filter=U` (merge conflicts).
- **Applicability**: REQUIRED always.
- **Success criteria**: state captured; merge conflicts reported as `FAIL` (blocking); whitespace errors as `WARN`.

### QG-02 Formatting

- **Purpose**: verify formatting without modifying files.
- **Read-only commands only**: `npx prettier --check .`, `cargo fmt --check`, `gofmt -l .`, `black --check .`, `ruff format --check .`, `dart format --output=none --set-exit-if-changed .`, `clang-format --dry-run --Werror`.
- **NEVER** `--write`, `-w`, `--fix`.
- **Applicability**: REQUIRED if a formatter config exists; OPTIONAL otherwise.
- **Success criteria**: exit 0 and no files listed.

### QG-03 Lint

- **Purpose**: static lint per repository script or ecosystem tool.
- **Commands**: `npm run lint` / `pnpm lint` / `npx eslint .` / `cargo clippy -- -D warnings` / `go vet ./...` / `flutter analyze` / `python -m ruff check .` / `python -m flake8`.
- **Read-only**: never `--fix`.
- **Applicability**: REQUIRED if a lint script or config exists.
- **Success criteria**: exit 0.

### QG-04 Type Check / Static Compile Check

- **Purpose**: verify types/compilation without producing artifacts.
- **Commands**: `npx tsc --noEmit`, `cargo check`, `go build ./...` (no output), `python -m mypy .`, `gradle compileJava` (no output), `flutter analyze` (when it covers type errors).
- **Separate from QG-05**: this check verifies types/compilation only; it does not produce build artifacts. If the repo has no separate type check, note that QG-04 is merged into QG-05 with fidelity `APPROXIMATE`.
- **Applicability**: REQUIRED if type-check tooling exists.
- **Success criteria**: exit 0, no type errors.

### QG-05 Build

- **Purpose**: actual build/bundle, separate from type check.
- **Commands**: `npm run build` / `pnpm build` / `cargo build` / `go build ./...` / `python -m build` / `flutter build` (may be slow) / `gradle build -x test`.
- Build output must go to the tool's default location or a temp dir; never overwrite user artifacts. If the build writes into the working tree (e.g., `dist/`), record the pre-existing state and verify in Phase E.
- **Applicability**: REQUIRED if a build script/tool exists; OPTIONAL for pure-library repos without a build step.
- **Success criteria**: exit 0 and expected artifacts exist.

### QG-06 Unit Tests

- **Purpose**: run unit tests; extract test count, pass, fail, skip from output.
- **Commands**: `npm test` / `pnpm test` / `npx vitest run` / `npx jest --runInBand` / `cargo test` / `go test ./...` / `python -m pytest -q` / `flutter test`.
- **Read-only**: never `-u`, `--updateSnapshot`, `--ci=false`.
- **Applicability**: REQUIRED if tests exist and change scope includes source or test files; OPTIONAL otherwise.
- **Success criteria**: exit 0; record counts (total, passed, failed, skipped).

### QG-07 Integration Tests

- **Purpose**: run integration tests, separate from unit tests.
- **Commands**: `test:integration` script, `cargo test --test *`, `pytest -m integration`, `go test -tags=integration ./...`, `test:coverage:integration` (Zoo-Code).
- Record required services (DB, cache, network) and whether they are available locally.
- **Applicability**: REQUIRED if integration tests exist and change scope touches integration paths; OPTIONAL otherwise.
- **Success criteria**: exit 0; record counts.

### QG-08 E2E / Smoke Tests

- **Purpose**: run end-to-end or smoke tests.
- **Commands**: `playwright test`, `cypress run`, `test:e2e`, `test:ci:mock`.
- Record required services, browsers, and whether they are available locally.
- If E2E requires remote services, classify `REMOTE_ONLY` or run the mock variant if one exists.
- **Applicability**: REQUIRED if E2E exists and change scope includes UI or critical flows; OPTIONAL otherwise.
- **Success criteria**: exit 0; record counts.

### QG-09 Coverage

- **Purpose**: measure coverage; separate report generation from policy judgment.
- **Report generation**: `vitest run --coverage`, `jest --coverage`, `cargo llvm-cov`, `pytest --cov`, `go test -coverprofile`.
- **Policy judgment** (separate step): compare against repo config (`coverageThreshold` in `package.json`, `[tool.coverage]` in `pyproject.toml`). If no threshold is configured, report numbers without judgment; flag a drop vs baseline as `WARN`.
- **Applicability**: OPTIONAL; REQUIRED only if the repo enforces coverage in CI.
- **Success criteria**: report generated; threshold comparison recorded.

### QG-10 Dead Code and Dependency Usage

- **Purpose**: audit unused exports and dependencies. **Audit-only — never auto-delete.**
- **Commands**: `pnpm knip` (no `--fix`), `npx knip`, `npx ts-prune` (no `--remove`), `cargo udeps`, `go mod tidy -diff` (read-only diff), `python -m vulture`.
- Report findings as `WARN` with file:line evidence; the user decides deletion.
- **Applicability**: OPTIONAL; REQUIRED if the repo runs it in CI.
- **Success criteria**: exit 0, or findings reported as `WARN` with evidence.

### QG-11 Localization

- **Purpose**: check locale files AND user-facing source changes.
- **Commands**: run the repo translation check (e.g., `node scripts/find-missing-translations.js`), verify all locale files have identical key sets, verify changed user-facing strings exist in all locales.
- **Read-only**: never write locale files.
- **Applicability**: REQUIRED if an i18n system exists and change scope includes user-facing strings or locale files; NOT_APPLICABLE otherwise.
- **Success criteria**: no missing keys.

### QG-12 Invisible and Suspicious Unicode

- **Purpose**: scan source files for zero-width and directionality characters.
- **PowerShell** (uses .NET regex, `\uXXXX` form — `\x{...}` is NOT supported in .NET regex and MUST NOT be used in PowerShell):

```powershell
Get-ChildItem -Recurse -File | Where-Object { $_.Extension -match '\.(ts|tsx|js|jsx|dart|rs|py|md|json|yaml|yml|html|css|scss|vue|svelte)$' } | Select-String -Pattern '[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]' | Select-Object Path, LineNumber, Line
```

- **bash** (grep `-P` supports `\x{...}`):

```bash
grep -rPn '[\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}\x{FEFF}\x{00AD}]' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.dart' --include='*.rs' --include='*.py' --include='*.md' --include='*.json' --include='*.yaml' --include='*.yml' --include='*.html' --include='*.css' --include='*.scss' --include='*.vue' --include='*.svelte' .
```

- **Applicability**: REQUIRED if source files exist.
- **Success criteria**: no matches. Matches are reported as `FAIL` (invisible characters are high-risk) with file:line evidence.

### QG-13 Dependency and Lockfile Hygiene

- **Purpose**: local dependency and lockfile consistency checks. **Do NOT confuse with GitHub Dependency Review** (a remote GitHub feature that scans PRs — that is `REMOTE_ONLY`).
- **Commands** (read-only): `npm ls`, `pnpm list`, `cargo tree`, `go mod verify`, `pip check`, `npm outdated`, `pnpm outdated`, `cargo outdated`, `pip list --outdated`.
- Never install packages or regenerate lockfiles.
- **Applicability**: REQUIRED if a lockfile exists and change scope includes dependency files; OPTIONAL otherwise.
- **Success criteria**: lockfile consistent with manifest; findings reported as `WARN`.

### QG-14 Security Review

- **Purpose**: local static security analysis.
- **Commands** (read-only): `npm audit`, `pnpm audit`, `cargo audit`, `pip-audit`, `govulncheck`, `trivy fs .`, `gitleaks detect`, `bandit`, `semgrep`.
- **CodeQL is REMOTE_ONLY** (GitHub-hosted analysis) — record it as a remote check remaining.
- For high-risk changes (auth, payment, credentials, etc.), perform a manual review pass and record findings.
- **Applicability**: REQUIRED if security tooling exists or change scope is high-risk; OPTIONAL otherwise.
- **Success criteria**: no high/critical findings; findings reported with severity.

### QG-15 Cross-Platform

- **Purpose**: detect platform-specific issues; separate static detection from actual execution.
- **Static detection**: scan for path separator misuse (`\` in strings), `os.path` vs `pathlib` misuse, shell-specific commands in scripts, `rm -rf` in cross-platform scripts, CRLF/LF issues, case-sensitive imports.
- **Actual execution separation**: if the repo has a cross-platform CI matrix (windows-latest, ubuntu-latest, macos-latest), note that local execution covers only the current platform; other platforms are `REMOTE_ONLY`.
- **Applicability**: OPTIONAL; REQUIRED if change scope includes platform-specific code.
- **Success criteria**: static findings reported; platform matrix recorded.

### QG-16 Type-Safety Review

- **Purpose**: distinguish pre-existing vs new type issues.
- **Method**: run the type check on the base revision (via a separate worktree or safe temp copy — NEVER `git checkout`/`git reset` the working tree) and compare with the current result. Issues present in both = pre-existing (`WARN`); issues present only in current = new (`FAIL` if required).
- **Applicability**: REQUIRED if a type check exists and change scope includes source.
- **Success criteria**: no new type issues.

### QG-17 Tests for Changed Behavior

- **Purpose**: verify changed behavior has test coverage.
- **Method**: for each changed source file, verify corresponding tests exist or were updated. Missing tests for changed behavior are `WARN`, not auto-`FAIL`.
- **Applicability**: REQUIRED if change scope includes source; NOT_APPLICABLE for docs-only changes.
- **Success criteria**: mapping of changed files → test files recorded; missing coverage as `WARN`.

### QG-18 Package / Artifact Validation

- **Purpose**: validate package/artifact contents.
- **Commands** (read-only or temp-output): `npm pack --dry-run`, `pnpm pack --dry-run`, `cargo package --list`, `python -m build` (to temp dir), `go list -m`, `gradle assemble` (to build dir).
- Verify artifact contents: expected files included, no secrets, no `node_modules`, no local paths.
- **Applicability**: OPTIONAL; REQUIRED if change scope includes packaging config.
- **Success criteria**: artifact list verified; no secrets in artifact.

### QG-19 Schema / Migration Safety

- **Purpose**: review DB migrations and schema changes (read-only).
- **Method**: review migration files for ordering, destructive operations (`DROP`, `TRUNCATE`, `DELETE` without `WHERE`), and idempotency; validate schema changes against consuming code.
- **Applicability**: REQUIRED if change scope includes migrations/schemas; NOT_APPLICABLE otherwise.
- **Success criteria**: review recorded; destructive ops flagged as `FAIL` (blocking) or `WARN` per policy.

### QG-20 Documentation and Generated Files

- **Purpose**: verify docs and generated files are in sync.
- **Method**: verify docs updated for changed behavior (`WARN` if not). For generated files (API clients, codegen output), run codegen in check mode if available (`--check`, `--dry-run`) or compare hashes. NEVER regenerate in place.
- **Applicability**: OPTIONAL; REQUIRED if the repo enforces generated-file sync in CI.
- **Success criteria**: sync verified or `WARN` recorded.

## 9. Applicability & Status Model

### 9.1 Applicability

Each check is classified as:

- `REQUIRED`: must pass for the verdict to be `PASS`.
- `OPTIONAL`: run if applicable; failures are `WARN`-level unless high-risk.
- `NOT_APPLICABLE`: irrelevant to this project/change (e.g., localization in a repo with no i18n).

### 9.2 Status Model

- `PASS` — check executed, success criteria met
- `FAIL` — check executed, success criteria not met
- `WARN` — check executed with non-blocking findings
- `NOT_APPLICABLE` — irrelevant (not a failure)
- `SKIP` — policy decision not to run (record reason)
- `NOT_RUN` — could not execute (no command resolved, no tool)
- `BLOCKED` — prerequisite missing (service down, browser missing, artifact absent)
- `ERROR` — check crashed or produced unusable output
- `TIMEOUT` — exceeded timeout (see section 13; `TIMEOUT` ≠ `FAIL` unless the check is required)
- `REMOTE_ONLY` — only executable on remote CI
- `MANUAL_REVIEW` — requires human judgment

### 9.3 Fidelity

Each result carries a fidelity: `EXACT`, `EQUIVALENT`, `APPROXIMATE`, `REMOTE_ONLY`, `MANUAL`.

## 10. Risk Levels

Classify the change set:

- `LOW`: docs, comments, formatting, non-functional config
- `MEDIUM`: source, UI, refactor, tests
- `HIGH`: auth, payment, credentials, filesystem, network, persistence, migration, public API, concurrency, dependencies, build/release, parsers

Policy:

- `HIGH` risk ⇒ broader test execution (unit + integration + E2E where available) + security review (QG-14) + manual review.
- `MEDIUM` risk ⇒ unit + integration tests.
- `LOW` risk ⇒ static checks only.

## 11. Baseline Comparison

Goal: distinguish `NEW REGRESSION` from `PRE-EXISTING FAILURE` from `ENVIRONMENTAL` from `UNKNOWN`.

- NEVER `git checkout`, `git reset`, or `git stash` on the working tree to obtain a baseline.
- Use `git worktree add` (separate directory) or a safe temp copy (`git archive` or `git clone --shared` to a temp dir).
- Run the failing check on the baseline and compare:
    - Fails on both → `PRE-EXISTING` (`WARN`, not blocking)
    - Fails only on current → `NEW REGRESSION` (`FAIL`)
    - Fails on neither but environment differs → `ENVIRONMENTAL` (record environment)
    - Cannot determine → `UNKNOWN` (record why)
- Clean up the temp worktree after comparison (removing the temp dir is allowed; it is not part of the working tree).

## 12. Execution Phases

### Phase A: Discovery

Project root, CI workflows, manifests, lockfiles, build tools, quality configs, changed files, base revision, monorepo workspaces, environment (OS, shell, node/python/rust versions, available services). Build the execution plan (section 7).

### Phase B: Fast Static Checks

Run ALL independent static checks — do NOT stop at the first failure:

- QG-01 Repository State
- QG-02 Formatting
- QG-03 Lint
- QG-04 Type Check
- QG-12 Unicode
- QG-11 Localization (static part)
- QG-13 Dependency metadata (read-only)
- QG-10 Dead code (if fast)

Each with its own timeout (2–10 min). Collect all results.

### Phase C: Build and Tests

Only if Phase B has no critical errors (no `FAIL` in required checks that would invalidate build/test results):

- QG-05 Build
- QG-06 Unit Tests
- QG-07 Integration Tests
- QG-08 E2E / Smoke
- QG-09 Coverage

If Phase B has critical errors, still run QG-05 if it is independent of the failing checks, and record the rest as `BLOCKED` with reason.

### Phase D: Semantic Review

- QG-15 Cross-Platform
- QG-16 Type-Safety Review (baseline comparison)
- QG-14 Security Review
- QG-17 Tests for Changed Behavior
- QG-19 Schema / Migration Safety
- QG-20 Documentation and Generated Files
- QG-18 Package / Artifact Validation (if applicable)

### Phase E: Integrity Check

Compare the working tree before/after:

- `git status --porcelain` snapshot taken at start vs end
- `git diff --stat` before vs after
- Any new/modified/deleted files not caused by the user = unexpected mutation → `ERROR`-level finding
- Report in the Working Tree Integrity section

## 13. Timeout Policy

No fixed 5min/15min defaults. Use:

- Fast static (state, unicode, formatting check): 2 min
- Lint / type check: 5–10 min
- Build: 10–15 min
- Unit / integration tests: 15 min
- E2E: 30 min
- Coverage: 15 min
- Dependency audits: 5 min

Prefer the repository workflow timeout (from CI `timeout-minutes`) or user settings when available. `TIMEOUT` is recorded as the `TIMEOUT` status; it counts as `FAIL` for the overall verdict only if the check is REQUIRED. For OPTIONAL checks, `TIMEOUT` → `WARN`.

## 14. Command Execution Rules

### 14.1 Per-Command Record

For every executed command, record:

- exact command (as executed, with args)
- cwd (explicit)
- shell (`powershell` / `bash` / `cmd`)
- start time, end time, duration
- exit code
- timeout flag (whether the timeout was hit)
- stdout/stderr key parts (first/last N lines, error excerpts)
- generated report location (if the tool writes a report file)

### 14.2 Shell Handling

- Windows default: PowerShell. Use `;` for chaining, `Select-String` for grep, `Get-Content` for cat, `Copy-Item` for cp, `Move-Item` for mv.
- bash: use `&&` for chaining, `grep`, `cat`.
- cmd: use `&&`.
- Never assume a Unix utility exists on Windows; never assume PowerShell exists on Linux.
- For cross-platform commands, prefer the tool's own CLI (`npx`, `cargo`, `go`, `python -m`) which is shell-agnostic.

### 14.3 cwd Management

- Each command runs in an explicit cwd (repo root, workspace dir, or subdirectory).
- Record the cwd per command; never rely on inherited cwd.

## 15. Overall Verdict

- `PASS`: ALL required applicable checks executed and passed; no `BLOCKED`/`ERROR`/`TIMEOUT`/`NOT_RUN` in required checks; no unexpected working-tree mutation; no unresolved high-severity manual findings. If remote-only checks remain: `LOCAL PASS — remote checks still required`.
- `CONDITIONAL PASS`: required local checks passed, but optional warnings / manual review items / remote-only checks remain.
- `FAIL`: one or more required checks failed, or a high-severity issue was found.
- `INCONCLUSIVE`: environment issues, missing dependencies, unclear base, or required checks could not run.

## 16. Output Format

Structured markdown report:

1. **Verdict** (`PASS` / `CONDITIONAL PASS` / `FAIL` / `INCONCLUSIVE`)
2. **Scope**: repository, branch, HEAD, base, changed files (count + list), risk level, scope confidence
3. **Environment table**: OS, shell, node/python/rust versions, git, available services
4. **Resolution table**: check → tier → fidelity → source
5. **Results table**: ID | Check | Requirement | Fidelity | Status | Duration | Evidence
6. **Failures detail**: check, command, exit code, output excerpt, root cause, recommended fix
7. **Warnings**: non-blocking findings with evidence
8. **Remote Checks Remaining**: checks that can only run in CI
9. **Working Tree Integrity**: before/after comparison
10. **Final Statement**: one sentence summarizing the verdict and any required follow-up

## 17. Zoo-Code Profile

Fallback hints for the Zoo Code repository (used only when Tiers 0–4 yield nothing):

- lint: `pnpm lint`
- type-check: `pnpm check-types`
- dead-code: `pnpm knip`
- translations: `node scripts/find-missing-translations.js`
- unit-test: `pnpm turbo run test:coverage --filter="!@roo-code/core" && pnpm turbo run test:coverage:unit --filter="@roo-code/core" && pnpm turbo run test:coverage:integration --filter="@roo-code/core"`
- e2e: `pnpm --filter @roo-code/vscode-e2e test:ci:mock`

These are hints only. If the repository defines different commands, use the repository's and emit `PROFILE DRIFT`.

## 18. Prohibited Actions (Complete List)

Consolidated from section 2.1 — Quality Gate MUST NOT, without explicit user request:

1. Auto-fix code or formatting (`--fix`, `--write`, `-w`, `--autofix`).
2. Update snapshots or test expectations (`-u`, `--updateSnapshot`, `--ci=false`).
3. Install dependencies or regenerate lockfiles.
4. Delete unused exports or dead code.
5. Modify test files.
6. Run any `git` state-changing command (`add`, `commit`, `push`, `merge`, `rebase`, `reset`, `checkout <commit>`, `stash`, `clean`).
7. Create PRs, run workflows, publish packages, or change remote state.
8. Delete or rename any file.
9. Modify the working tree in any way beyond what the user explicitly requested.

## 19. Error Codes

All error messages MUST include a traceable code: `QG/<check-id>/<NNN>` (e.g., `QG/QG-12/001` for a unicode scan failure, `QG/QG-05/002` for a build timeout). This applies to report findings, failure details, and any error surfaced to the user.

## 20. Quick Reference

| Item                     | Value                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Verdicts                 | PASS, CONDITIONAL PASS, FAIL, INCONCLUSIVE                                                           |
| Statuses                 | PASS, FAIL, WARN, NOT_APPLICABLE, SKIP, NOT_RUN, BLOCKED, ERROR, TIMEOUT, REMOTE_ONLY, MANUAL_REVIEW |
| Fidelity                 | EXACT, EQUIVALENT, APPROXIMATE, REMOTE_ONLY, MANUAL                                                  |
| Resolution tiers         | 0 (user override) → 1 (repo config) → 2 (CI) → 3 (scripts) → 4 (ecosystem) → 5 (manual)              |
| Phases                   | A Discovery → B Fast Static → C Build & Tests → D Semantic Review → E Integrity                      |
| Checks                   | QG-01 … QG-20                                                                                        |
| PowerShell unicode regex | `[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]` (never `\x{...}`)                                   |
| Default posture          | Audit-only, read-only commands, evidence-based, never auto-fix                                       |
