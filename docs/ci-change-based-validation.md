# Change-based validation with a required gate

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
  successful, so existing required-check contracts are preserved without any
  ruleset change.
- Every other outcome runs the job unchanged: category `full`, a failed
  classification, a missing classification, or any non-`pull_request` event
  (merge queue, pushes, scheduled runs).

Each workflow also runs a `validation-gate` job that always executes. The gate
replays the classifier against the same commit range and rejects the run when:

- the classification is missing, malformed, or non-terminal,
- a validation job did not run when full validation was required,
- a validation job ran when a documentation-only skip was expected,
- the replay disagrees with the recorded classification,
- a watched job is missing from the `needs` graph.

On merge-queue events the gate additionally asserts that every watched job ran;
classification can never reduce merge-queue validation. The gate writes a job
summary with the classification, the expected and actual outcome of every
watched job, runner minutes per job, the total runner minutes of the run, and
the time from run start to the last completed job (the required-check
completion time).

## The documentation-only allowlist

`scripts/change-classification.mjs` holds one explicit allowlist. Only these
files can produce a `docs-only` classification:

| Pattern              | Reason                                            |
| -------------------- | ------------------------------------------------- |
| `README.md`          | Root readme; not read by any validation job.      |
| `CONTRIBUTING.md`    | Contributor guide.                                |
| `SECURITY.md`        | Security policy.                                  |
| `PRIVACY.md`         | Privacy notice.                                   |
| `CODE_OF_CONDUCT.md` | Code of conduct.                                  |
| `docs/**/*.md`       | Documentation tree; contains only Markdown today. |
| `.github/**/*.md`    | Issue and pull request templates.                 |

The allowlist is deliberately narrow:

- Release inputs stay out. `CHANGELOG.md`, `src/CHANGELOG.md`, `locales/*/README.md`,
  and packaging manifests trigger full validation, and the separate
  release-validation workflow is untouched.
- Workflow and toolchain configuration stays out. Only `.md` files under
  `.github/` match; `workflows/**`, `actions/**`, and `CODEOWNERS` always
  select full validation.
- Embedded fixtures, executable examples, and generated inputs never skip:
  any path containing `fixtures`, `__tests__`, `__mocks__`, `test-utils`,
  `snapshots`, `__snapshots__`, `generated`, `examples`, or `testdata` is
  rejected even under an allowlisted prefix.
- The `format-check` job always runs because `pnpm format:check` validates
  every Markdown file; documentation changes keep their own check.
- The `knip`, `dependency-review`, and `invisible-chars` jobs always run. Knip
  is deliberately unconditional because a repository invariant test requires
  the knip job to run without conditions or allowed failure.

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

## Override and rollback

Full validation can be forced at three levels:

1. **Per pull request:** add the `ci:full-validation` label. The classify job
   reports `full` with reason `override-label`.
2. **Repository-wide, immediate:** set the repository variable
   `ZOO_CODE_REQUIRE_FULL_VALIDATION` to `true`. No code change is needed;
   every classification reports `full` with reason `override-variable`.
3. **Permanent:** revert the pull request that introduced this change. All
   workflows then run exactly as before.

The gate applies the same override rules when it replays the classifier, so an
overridden run still validates coherence.

## Historical validation before enabling skips

Before enabling skips, the classifier was run over the 500 most recent
first-parent commits of `main` with `pull_request` semantics
(`node scripts/change-classification.mjs history --limit 500`):

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
