# Mutation report PR comments

Changed-code mutation testing analyzes the pull request merge commit. Its report
keeps that merge SHA in the reproduction command, but uses the PR head SHA in the
comment marker. The trusted comment workflow checks that marker against the
completed run's head SHA and the PR's current head before posting.

The workflow maintains one advisory comment per PR. Reports from older heads and
closed PRs are ignored. Counts remain visible; a section collapsed by default
contains the full report, mutant details, guidance, and reproduction steps.
The renderer supports headings, paragraphs, lists, emphasis, inline code, fenced
code blocks, and tables using trusted HTML structure with escaped text. Table
cells, URLs, mentions, issue references, commit SHAs, and emoji shortcodes remain
literal code. Commands and code examples use
code blocks; guidance renders as prose. Artifact text cannot introduce active
links, images, HTML, or mentions.

Focused test names come from Stryker's report or the selected-test fallback. An
empty list means the names were not recorded; it does not establish that the run
failed. The summary identifies incomplete runs from their result and reports
zero-mutant packages separately.

A missing, unreadable, oversized, or invalid report deliberately leaves the last
valid comment unchanged. This includes failed runs that exit before producing a
report. The visible head SHA identifies which commit the comment describes; it
does not certify that later runs completed. A valid clean report updates an
existing comment to an all-clear result, but does not create a new comment.

Run `pnpm test:mutation-ci` to check report generation and execute the trusted
inline comment script with mocked GitHub and filesystem APIs. The tests cover
SHA matching, stale heads, invalid artifacts, table rendering, hostile cell escaping, truncation, and
comment creation and updates.

## Validate the GitHub workflow before merge

Use private disposable repositories with the consumer workflow on the base
repository's default branch. Copy the consumer and formatter unchanged. A minimal
producer can call the real formatter with deterministic survivor, clean, invalid,
and delayed reports while retaining the production SHA environment variables,
merge checkout, workflow name, and artifact upload action.

Exercise a same-repository PR and a genuine cross-owner fork PR. Check comment
creation and updates, clean results with and without an existing comment, invalid
or missing report retention, rendered HTML, and an old run finishing after a new
head. Download the artifact to verify that its PR head marker differs from the
analyzed merge SHA. Keep fork jobs read-only with no forwarded secrets.

This checks real triggers, token permissions, artifact downloads, and comment
writes before merge. It does not rerun mutation analysis or establish the target
repository's own Actions policy; verify that policy after deployment.
