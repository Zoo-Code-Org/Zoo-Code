---
description: "Prepare a new release of the Zoo Code extension"
argument-hint: patch | minor | major
mode: code
---

1. Identify the most recent stable extension release:

    ```bash
    gh release view --json tagName,targetCommitish,publishedAt
    ```

2. Analyze changes since that release:

    ```bash
    gh pr list --state merged --base main --json number,title,author,url,mergedAt,closingIssuesReferences --limit 1000 -q '[.[] | select(.mergedAt > "TIMESTAMP") | {number, title, author: .author.login, url, mergedAt, issues: .closingIssuesReferences}] | sort_by(.number)'
    ```

3. For each PR with linked issues, fetch the issue reporter:

    ```bash
    gh issue view ISSUE_NUMBER --json number,author -q '{number, reporter: .author.login}'
    ```

4. Summarize the changes. If the user did not specify a release type, ask whether this should be a major, minor, or patch release.

    - Before choosing the target release version, treat the nightly pre-release lane as separate from the stable lane.
    - Zoo Code nightlies should stay on `major.ODD_NUMBER.patch` and use a large patch number for CI-generated pre-releases.
    - Stable releases should stay on `major.EVEN_NUMBER.patch`.
    - When preparing a stable release after an odd-minor pre-release line, advance to the next even minor instead of reusing the odd-minor pre-release lane.

5. Review and update the Marketplace-facing root `README.md`.

    - Treat root `README.md` as the source of truth for Marketplace content.
    - Update the "What's New" section for the release when appropriate.
    - Do not manually edit `src/README.md`; the extension bundle step copies root `README.md` into `src/README.md`.
    - Check for stale upstream Roo Code wording that should now say Zoo Code.

6. Write the release notes directly into `CHANGELOG.md` on the release branch.

    - Use the heading format `## [version]` (with square brackets) — e.g. `## [3.58.1]`. The publish workflow at `.github/workflows/marketplace-publish.yml` extracts release notes by matching this exact pattern; headings without brackets will be missed and the GitHub release will fall back to a generic message.
    - Always include contributor attribution and the PR number: use `(PR #<prNumber> by @username)`.
    - For PRs that close issues, include both issue and PR authors: `- Fix: Description (#123 by @reporter, PR #456 by @contributor)`.
    - For PRs without linked issues, include the PR number and author: `- Add support for feature (PR #456 by @contributor)`.
    - Provide brief descriptions of each item to explain the change.
    - Order the list from most important to least important.
    - Include every PR in the release window. Count the PRs and cross-reference the list before continuing.

7. For a major or minor release:

    - Ask the user what three areas should be highlighted.
    - Update relevant announcement files and documentation, including `webview-ui/src/components/chat/Announcement.tsx`, `README.md`, and the `latestAnnouncementId` in `src/core/webview/ClineProvider.ts`.
    - Ask the user to confirm the English announcement before proceeding.
    - Arrange translation updates for all supported locales affected by README, announcement, or package localization changes. Use the `/roo-translate` skill to propagate the updated `chat.json` announcement highlight keys and the "What's New" section to all supported locales.
    - All 17 locale READMEs should contain a translated "What's New" section. Check each one and add a translated section where missing.

8. Create the release branch:

    ```bash
    git checkout -b release/v[version]
    ```

9. Bump the version in `src/package.json` to the target release version and ensure `CHANGELOG.md` and `src/CHANGELOG.md` are up to date.

    - Verify the `CHANGELOG.md` heading uses `## [version]` (with brackets).
    - Copy or sync `CHANGELOG.md` to `src/CHANGELOG.md` if the project keeps both.
    - Review the generated version and changelog before opening the PR.

10. Open a single release PR with the fully generated release state.

    ```bash
    git add CHANGELOG.md src/CHANGELOG.md src/package.json README.md locales/*/README.md src/package.nls*.json
    # If generated or updated:
    git add webview-ui/src/components/chat/Announcement.tsx src/core/webview/ClineProvider.ts
    git commit -m "chore: prepare v[version] release"
    git push origin release/v[version]
    gh pr create --title "Release v[version]" --body "Release preparation for v[version]. This PR includes the final version bump, changelog updates, Marketplace README updates, and any announcement changes." --base main --head release/v[version]
    ```

    - There is no separate version-bump PR in this flow.
    - The release PR should already contain the final version number and generated changelog updates.
    - If the release includes translated README or package-localization updates, include those files in the same PR.
    - Let the release validation workflow and normal PR checks run before merge.

11. Once the release PR is open and passing checks, get it approved by a reviewer before proceeding.

    - Do not create the tag until the PR has at least one approval — the publish workflow enforces this automatically and will fail if no approved PR is found for the tagged commit.

12. After the PR is approved, create the release tag on the release branch tip and push it:

    ```bash
    git tag v[version]
    git push origin v[version]
    ```

    - Tag the branch tip as-is. Do not rebase or merge additional commits into the release branch before tagging — doing so changes the commit SHA and may pull in unreviewed changes that weren't part of the approval.
    - The publish workflow validates that the tag version matches `src/package.json`.

13. The tag push triggers the stable publish workflow.

    - The workflow first checks that the tagged commit belongs to an approved PR. If the PR is not yet approved this step fails — approve the PR first, then retrigger by recreating and pushing the tag: `git tag -d v[version] && git push origin :refs/tags/v[version] && git tag v[version] && git push origin v[version]`.
    - Once the approval check passes, the `marketplace-production` environment gate fires and notifies the configured approvers.
    - A human approver must then approve the deployment before the extension is published to VS Code Marketplace and Open VSX.

14. After a successful deployment, add the release PR to the merge queue.

    ```bash
    gh pr merge [pr-number] --auto --squash
    ```

    - Do not merge before the deployment succeeds — merging first and then discovering a publish failure leaves `main` ahead of what was actually shipped.
    - The merge queue runs all required checks against the release branch before merging to `main`.

15. As the final stable extension release step, open a separate documentation PR in `Zoo-Code-Org/Zoo-Code-Docs`.

    - Run this step only after the marketplace workflow for the exact stable tag has succeeded, the corresponding GitHub release exists, and step 14 has added the Zoo Code release PR to the merge queue. This step does not apply to nightly, CLI, npm, or types releases.
    - Retain the exact Zoo Code changelog section, complete merged-PR inventory, release PR URL, tag and GitHub release URL, marketplace workflow URL, successful publication timestamp, and release PR merge-queue state as inputs to the docs work and final report.

    **Preflight and checkout**

    - Verify local GitHub authentication and access and push permission for `Zoo-Code-Org/Zoo-Code-Docs` (for example, with `gh auth status`, `gh repo view`, and an authenticated permission query). Do not assume or claim that `GITHUB_TOKEN` has cross-repository access.
    - Prefer the portable sibling checkout `../Zoo-Code-Docs`. If it is absent, create a clean temporary directory and clone `https://github.com/Zoo-Code-Org/Zoo-Code-Docs.git` there. Do not modify the docs repository from the Zoo Code checkout.
    - In an existing checkout, read `AGENTS.md` and `.roorules` when present, abort if the worktree is dirty, verify `origin` is `Zoo-Code-Org/Zoo-Code-Docs` and its default branch is `main`, fetch `origin`, switch to local `main`, and fast-forward it only to the exact `origin/main` with `git merge --ff-only origin/main`. Never stash or reset work, and never change remotes. The fallback clone must likewise use `origin/main` as its clean base.

    **Idempotency and branch safety**

    - Use the deterministic branch `docs/release-v[version]`. Before creating or pushing anything, query the local branch, the remote branch, and all matching open, closed, and merged PRs in the target repository; validate the repository, `main` base, head branch, commit history, and content.
    - A matching merged PR with the expected content means this step is complete. Reuse and validate a matching open PR. Inspect and reuse a branch without a PR only when its commits and content are clearly the expected release-docs work.
    - Abort on a closed-unmerged PR, wrong repository or base, local/remote divergence, unexpected commits, a version conflict, or ambiguous state. Never force-push blindly, stop on any remote race, and never downgrade a docs `package.json` version that is newer than the released version.

    **Documentation and version synchronization**

    - Always assess and create or update `docs/update-notes/v[version].md`, register that exact version newest-first in both `docs/update-notes/index.md` and `sidebars.ts`, and use the stable publication date, Zoo Code branding, and the docs project's existing linking conventions.
    - Build a per-PR documentation impact matrix from every shipped PR. Cover every user-visible change in the release note, and update all relevant canonical evergreen provider, feature, tool, and getting-started pages. Record a rationale for each implementation-only exclusion and, when no evergreen page changes are needed, record that no-change rationale.
    - Synchronize the docs repository's sole package version in `package.json` using exactly:

        ```bash
        pnpm version "$VERSION" --no-git-tag-version --allow-same-version
        ```

        Confirm this creates no tag and no incidental `pnpm-lock.yaml` change.

    **Validation and PR creation**

    - From the docs checkout, run all of these commands successfully:

        ```bash
        mise install
        pnpm install --frozen-lockfile
        pnpm run check-types
        pnpm run lint
        pnpm run lint:unused
        pnpm run build
        git diff --check
        ```

    - Inspect build warnings explicitly. Block the PR on newly introduced broken-link, document, MDX, sidebar, or content warnings. Verify the changed and staged scope contains only intended source files and no generated output.
    - Commit as `docs(release): document v[version]`, push normally (never force-push) to `docs/release-v[version]`, and stop rather than overwrite a remote race.
    - Open or reuse a PR in `Zoo-Code-Org/Zoo-Code-Docs` with base `main` and title `[Docs] Update documentation for Zoo Code v[version]`. Its body must include the source release and tag, Zoo Code release PR, marketplace workflow and successful publication timestamp, summary, package version synchronization, per-PR impact matrix and exclusions, evergreen changes or no-change rationale, validation results and warning review, and an explicit statement that this is a separate docs PR and will not be auto-merged. Never enable auto-merge for this PR.

    **Reporting and partial failure**

    - Docs failure cannot roll back or invalidate the published extension. A failure report must begin: `Zoo Code v[version] is already published and docs PR completion is pending.` Then report the failed checkpoint, checkout path, branch, PR URL/state when present, failure details, and the safe recovery action.
    - The final release report must include release/tag/workflow URLs and the successful publication timestamp, the Zoo Code release PR merge-queue state, docs PR URL/state, docs branch and commit SHA, package-version synchronization status, release-note/index/sidebar status, evergreen documentation status, validation results and inspected warnings, and confirmation that the separate docs PR was not auto-merged.
