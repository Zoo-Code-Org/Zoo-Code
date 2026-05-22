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

5. Review and update the Marketplace-facing root `README.md`.

    - Treat root `README.md` as the source of truth for Marketplace content.
    - Update the "What's New" section for the release when appropriate.
    - Do not manually edit `src/README.md`; the extension bundle step copies root `README.md` into `src/README.md`.
    - Check for stale upstream Roo Code wording that should now say Zoo Code.

6. Create the release notes as a changeset file at `.changeset/v[version].md`, then run `pnpm changeset:version` on the release branch before opening the PR.

    ```md
    ---
    "zoo-code": patch|minor|major
    ---

    [list of changes]
    ```

    - Always include contributor attribution and the PR number: use `(PR #<prNumber> by @username)`.
    - For PRs that close issues, include both issue and PR authors: `- Fix: Description (#123 by @reporter, PR #456 by @contributor)`.
    - For PRs without linked issues, include the PR number and author: `- Add support for feature (PR #456 by @contributor)`.
    - Provide brief descriptions of each item to explain the change.
    - Order the list from most important to least important.
    - Include every PR in the release window. Count the PRs and cross-reference the list before continuing.

7. If an image generation tool is available, create a release image at `releases/[version]-release.png`.

    - The image should relate to the main release highlight and fit the existing release-image style.
    - Add the generated image to `.changeset/v[version].md` before the list of changes:

        ```md
        ![X.Y.Z Release - Description](/releases/X.Y.Z-release.png)
        ```

8. For a major or minor release:

    - Ask the user what three areas should be highlighted.
    - Update relevant announcement files and documentation, including `webview-ui/src/components/chat/Announcement.tsx`, `README.md`, and the `latestAnnouncementId` in `src/core/webview/ClineProvider.ts`.
    - Ask the user to confirm the English announcement before proceeding.
    - Arrange translation updates for all supported locales affected by README, announcement, or package localization changes.

9. Create the release branch:

    ```bash
    git checkout -b release/v[version]
    ```

10. Generate the final release state on that branch:

    ```bash
    pnpm changeset:version
    ```

    - This should update `src/package.json`, `CHANGELOG.md`, and `src/CHANGELOG.md`, then consume the `.changeset` file.
    - Review the generated version and changelog before opening the PR.

11. Open a single release PR with the fully generated release state.

    ```bash
    git add CHANGELOG.md src/CHANGELOG.md src/package.json README.md locales/*/README.md src/package.nls*.json
    # If generated or updated:
    git add releases/[version]-release.png webview-ui/src/components/chat/Announcement.tsx src/core/webview/ClineProvider.ts
    git commit -m "chore: prepare v[version] release"
    git push origin release/v[version]
    gh pr create --title "Release v[version]" --body "Release preparation for v[version]. This PR includes the final version bump, changelog updates, Marketplace README updates, and any release assets or announcement changes." --base main --head release/v[version]
    ```

    - There is no separate version-bump PR in this flow.
    - The release PR should already contain the final version number and generated changelog updates.
    - If the release includes translated README or package-localization updates, include those files in the same PR.
    - Let the release validation workflow and normal PR checks run before merge.

12. After the release PR is merged, stop for a release review on the resulting `main` commit.

    ```bash
    git switch main
    git pull origin main
    REVIEWED_SHA=$(git rev-parse HEAD)
    git rev-parse --short "$REVIEWED_SHA"
    ```

    - Review the merged release state before any publish step.
    - Confirm that `src/package.json`, `CHANGELOG.md`, `src/CHANGELOG.md`, and the Marketplace-facing `README.md` all reflect the intended release.
    - Check that the release PR checks passed and that the merged commit is the one you want to ship.
    - Share that review summary, including `REVIEWED_SHA`, with the user and wait for explicit confirmation before creating the tag.
    - Do not create the tag or trigger publishing until the user says to proceed.

13. Only after explicit confirmation, create the release tag on that reviewed `main` commit:

    ```bash
    git tag v[version] "$REVIEWED_SHA"
    git push origin v[version]
    ```

    - If `main` advances after the review pause, keep using the pinned `REVIEWED_SHA` for the tag instead of silently tagging a newer commit.

14. The stable publish workflow runs from the `v[version]` tag.

    - Do not create the tag before the release PR is merged.
    - The publish workflow validates that the tag version matches `src/package.json`.
    - Marketplace and Open VSX publishing use the configured CI secrets.
