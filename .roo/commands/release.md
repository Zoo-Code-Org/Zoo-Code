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
