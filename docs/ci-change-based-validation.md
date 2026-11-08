# Change-based validation with an audit gate

Every pull request update previously ran the full validation suite even when the
change could not affect product behavior. This document describes the
conservative change-based validation introduced for issue #2291, its safety
model, its override and rollback paths, and the evidence collected before
skips were enabled.

## How it works

Five workflows (`code-qa`, `e2e`, `visual-regression`, `mutation-testing`,
`codeql`) run a fast `classify` job first. It runs
`scripts/change-classification.mjs` over the pull request's full change range
and emits either `docs-only` or `full`. Expensive jobs read that result through
their `needs` graph:

- A job is skipped only when classification succeeded, the event is
  `pull_request`, and the category is exactly `docs-only`. The job-level
  condition reports `skipped`, and GitHub treats a skipped required check as
  successful. The required unit-test matrix jobs start both platform checks
  and gate their steps instead, because GitHub evaluates job conditions before
  expanding a matrix. Skipping the matrix job itself may leave its named
  required contexts unreported.
  The required `compile` job also starts every time and fails unless the
  always-running formatting and validation-policy tests passed; only its
  expensive steps are gated. This preserves the existing check names without a ruleset change; live
  verification is still pending.
- Every other outcome runs the job unchanged: category `full`, a failed
  classification, a missing classification, or any non-`pull_request` event
  (merge queue, pushes, scheduled runs).

Each workflow also runs a `validation-gate` job that always executes.
The classify and gate checks have unique display names, such as
`classify (code-qa)` and `validation-gate (code-qa)`, for branch rulesets. The gate
replays the classifier against the same commit range and rejects the run when:

- the classification is missing, malformed, or non-terminal,
- a validation job did not run when full validation was required,
- a validation job ran when a documentation-only skip was expected,
- the replay disagrees with the recorded classification,
- a watched job is missing from the `needs` graph.

On merge-queue events classification never reduces validation; existing
event and draft conditions still apply, including skips for PR-only jobs.
CodeQL does not currently subscribe to merge-queue events. The gate writes a job
summary with the classification, the expected and actual outcome of every
watched job, best-effort runner minutes per job, the total runner minutes of the run, and
the time from run start to the last completed job (the required-check
completion time).

## The documentation-only allowlist

`scripts/change-classification.mjs` holds one explicit allowlist. Only these
files can produce a `docs-only` classification:

| Pattern              | Reason                                            |
| -------------------- | ------------------------------------------------- |
| `CONTRIBUTING.md`    | Contributor guide.                                |
| `SECURITY.md`        | Security policy.                                  |
| `PRIVACY.md`         | Privacy notice.                                   |
| `CODE_OF_CONDUCT.md` | Code of conduct.                                  |
| `docs/**/*.md`       | Documentation tree; contains only Markdown today. |
| `.github/**/*.md`    | Issue and pull request templates.                 |

The allowlist is deliberately narrow:

- Release inputs stay out. `CHANGELOG.md`, `src/CHANGELOG.md`, `locales/*/README.md`,
  `README.md` (copied by `src/esbuild.mjs` into the packaged extension),
  and packaging manifests trigger full validation, and the separate
  release-validation workflow is untouched.
- Workflow and toolchain configuration stays out. Only `.md` files under
  `.github/` match; executable workflow/action YAML and `CODEOWNERS` select
  full validation. Inert Markdown notes under workflows or actions may skip.
- Embedded fixtures, executable examples, and generated inputs never skip:
  any path containing `fixtures`, `__tests__`, `__mocks__`, `test-utils`,
  `snapshots`, `__snapshots__`, `generated`, `examples`, or `testdata` is
  rejected even under an allowlisted prefix.
- The `format-check` job always runs because `pnpm format:check` validates
  every Markdown file; documentation changes keep their own check.
- The `knip` and `invisible-chars` jobs always run. `dependency-review` is
  never gated by classification but stays pull-request-only. Knip is
  deliberately unconditional because a repository invariant test requires
  the knip job to run without conditions or allowed failure.

## Documentation input audit

The audit at `687f8489d` checked references to the allowlisted paths and their
file names across tracked source, tests, build scripts, and CI configuration.
It also checked package build entry points, test discovery, asset copying,
Turbo inputs, and VSIX packaging rules.

| Surface                    | Evidence                                                                                                                                      | Result                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension bundling         | `src/esbuild.mjs` calls `copyPaths()` with an explicit source list. `packages/build/src/esbuild.ts` copies only those configured paths.       | Root `README.md` and `CHANGELOG.md` are package inputs and remain outside the allowlist. No allowlisted documentation is copied.                                |
| VSIX packaging             | `src/.vscodeignore` excludes everything, then includes the built extension, webview, assets, and release metadata.                            | Root `docs/`, `.github/`, and the four allowlisted root files are not packaged.                                                                                 |
| Webview and package builds | `webview-ui/vite.config.ts`, `apps/cli/tsup.config.ts`, and `packages/types/tsup.config.ts` select code entry points and assets.              | No imports, raw-file loads, or asset rules select allowlisted documentation.                                                                                    |
| Tests and models           | Vitest configurations select code tests. Searches covered `docs/`, current documentation basenames, Markdown imports, and filesystem readers. | Documentation references are comments, temporary repository files, mocked paths, or workspace examples. Tests do not read the checked-in allowlisted documents. |
| Turbo and Knip             | Root and package Turbo files define package-local inputs. `knip.json` selects code entry points and projects.                                 | No explicit input reaches the root documentation tree. Default package inputs can include package-local Markdown, which remains outside the allowlist.          |
| Release validation         | `.github/workflows/release-validation.yml` builds the extension and compares root `README.md` with the copied package README.                 | Release inputs retain full validation. The release workflow is unchanged.                                                                                       |

Generic runtime tools can read Markdown in a user's workspace. This does not
make repository documentation a build or test input. The audit found no reason
to narrow the current allowlist further. This is source-level evidence for the
current tree, not a guarantee about future consumers. A new documentation
reader must update the classification policy and its regression tests.

## Fail-safe behavior

| Input                                                                                                                             | Classification                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| All changed files match the allowlist (additions, modifications, deletions, documentation-to-documentation renames, type changes) | `docs-only`                                                                            |
| Any path outside the allowlist, including source, dependency manifests, lockfiles, workflow files                                 | `full`                                                                                 |
| Rename from or into a non-allowlisted path (both sides are classified)                                                            | `full`                                                                                 |
| Empty change range                                                                                                                | `full`                                                                                 |
| Change status the classifier does not recognize (for example copies)                                                              | `full`                                                                                 |
| Missing or unresolvable merge base, shallow history, unknown commits                                                              | Classification fails; jobs fall back to full validation; the gate records the fallback |
| Any git error or malformed diff output                                                                                            | Classification fails; jobs fall back to full validation                                |

The changed-file enumeration uses NUL-delimited `git diff --name-status` over
the full merge-base range with rename detection, so it cannot silently
truncate on whitespace or large diffs. Rename entries classify the old and the
new path.

Changes to `scripts/change-classification.mjs` or `scripts/change-gate.mjs`
always select full validation, independently of the documentation allowlist.
The gate also checks these paths directly with git against the base range
before accepting a documentation-only result. An allowlist expansion cannot
classify its own policy change as documentation-only. The fingerprint remains
an observability value rather than a trust boundary.

## Override and rollback

Full validation can be forced at three levels:

1. **Per pull request:** add the `ci:full-validation` label. The classify job
   reports `full` with reason `override-label`.
2. **Repository-wide:** set the repository variable
   `ZOO_CODE_REQUIRE_FULL_VALIDATION` to `true`. No code change is needed;
   every classification reports `full` with reason `override-variable`.
3. **Permanent:** revert the pull request that introduced this change. All
   workflows then run exactly as before.

The label must exist in the repository before it can be applied. Adding or
removing a label starts a fresh run in all five workflows. Their concurrency
groups replace superseded PR runs, so the latest label state determines the
active classification. Repository variables do not trigger runs: push an update
or dispatch a fresh run after changing the variable. Re-running an old run
retains its original event payload.

The gate applies the same override rules when it replays the classifier, so an
overridden run still validates coherence.

## Historical validation before enabling skips

The original pre-enablement review snapshot (PR #2325 at `d13547de0`)
reported the following results over the 500 most recent
first-parent commits of `main` with `pull_request` semantics
(`node scripts/change-classification.mjs history --limit 500`). These are
historical results, not a current measurement; the original capture date was
not recorded. To reproduce the sample, fetch
complete history first (`git fetch --unshallow` for a shallow checkout), check
out the snapshot, and record the date and main SHA with the report:

- 499 commits classified `full` (reason `non-documentation-path`).
- 1 commit classified `docs-only`: `a704002b67fd`, "[Docs] Specify P1
  persisted ownership and add the run-state kernel target architecture
  (#1706)". Its eight files are all `docs/architecture/*.md`; skipping
  comprehensive validation for that change is correct.
- 0 classification failures and 0 unrecognized change statuses: the parser
  handled every real change set in the sample, including renames and
  deletions.

The sample starts narrow by design: about 0.2% of changes would have skipped,
and the only proposed skip was verified file by file. Skipped work is always
explained in the gate summary.

## Expanding the allowlist

Expand the allowlist only with dependency evidence:

1. Prove the new pattern is not a build, runtime, or test input: grep the
   test suites, build scripts, Knip configuration, and Turbo inputs for reads
   of the path.
2. Extend `scripts/change-classification.test.mjs` with accept and reject
   cases for the new pattern.
3. Run the history mode over a large sample and verify every newly proposed
   skip by hand.
4. Expand one pattern at a time and watch the gate summaries for unexpected
   skips.

Broader package selection (running only affected packages) remains out of
scope until the shared-input audit is done; Zoo imports shared source outside
package-local directories. Existing coverage slicing (issue #47) is a separate
effort. A comprehensive merge-queue run is additional protection, not a
substitute for correct pull request classification.

## Trust boundary and maintenance

Replay detects accidental disagreement. On `pull_request`, workflow, action,
classifier, and gate code all come from the PR merge commit; the gate is not
independent protection against a PR author who edits validation itself.
Maintainers should review `.github/**` and `scripts/change-*.mjs` as CI policy;
CODEOWNERS protection for these paths is a possible separate policy change.
The gate jobs must be added to branch rulesets if maintainers want gate failures
themselves to block merging. Formatting and policy-test failures already flow
through the existing required `compile` context.

The repeated gate jobs remain explicit to keep workflow needs and check names
visible. Extracting a shared gate action is deferred to a separate refactor.

## Current verification and open work

No live docs-only PR run has confirmed the two platform check contexts yet.
Local workflow tests verify their names and wiring; this does not establish
GitHub's live check-reporting behavior.

`format-check` and all `validation-gate` jobs are not required checks in the
current ruleset. Formatting and policy-test failures block via required
`compile`. Making audit-gate failures block directly still requires a separate
ruleset update. The gate reads job results and cannot observe step-level gating
inside `compile` or `unit-test`; workflow tests pin those step conditions.

All label changes currently start all five workflows and may cancel in-flight
PR validation, including mutation testing. This runner-time cost is accepted
for now to keep override event handling simple and consistent. A shared gate
action and broader Stryker integration remain follow-ups.
