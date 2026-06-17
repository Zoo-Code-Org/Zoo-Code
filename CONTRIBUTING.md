<div align="center">
<sub>

<b>English</b> • [Català](locales/ca/CONTRIBUTING.md) • [Deutsch](locales/de/CONTRIBUTING.md) • [Español](locales/es/CONTRIBUTING.md) • [Français](locales/fr/CONTRIBUTING.md) • [हिंदी](locales/hi/CONTRIBUTING.md) • [Bahasa Indonesia](locales/id/CONTRIBUTING.md) • [Italiano](locales/it/CONTRIBUTING.md) • [日本語](locales/ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](locales/ko/CONTRIBUTING.md) • [Nederlands](locales/nl/CONTRIBUTING.md) • [Polski](locales/pl/CONTRIBUTING.md) • [Português (BR)](locales/pt-BR/CONTRIBUTING.md) • [Русский](locales/ru/CONTRIBUTING.md) • [Türkçe](locales/tr/CONTRIBUTING.md) • [Tiếng Việt](locales/vi/CONTRIBUTING.md) • [简体中文](locales/zh-CN/CONTRIBUTING.md) • [繁體中文](locales/zh-TW/CONTRIBUTING.md)

</sub>
</div>

# Contributing to Zoo Code

Zoo Code is a community-driven project, and we deeply value every contribution. To streamline collaboration, we operate on an [Issue-First](#issue-first-approach) basis, meaning all [Pull Requests (PRs)](#submitting-a-pull-request) must first be linked to a GitHub Issue. Please review this guide carefully.

## Table of Contents

- [Before You Contribute](#before-you-contribute)
- [Finding & Planning Your Contribution](#finding--planning-your-contribution)
- [Development & Submission Process](#development--submission-process)
    - [Pull Request Expectations](#pull-request-expectations)
    - [AI-Assisted Contributions](#ai-assisted-contributions)
- [Legal](#legal)

## Before You Contribute

### 1. Code of Conduct

All contributors must adhere to our [Code of Conduct](./CODE_OF_CONDUCT.md).

### 2. Project Roadmap

Our roadmap guides the project's direction. Align your contributions with these key goals:

### Reliability First

- Ensure diff editing and command execution are consistently reliable.
- Reduce friction points that deter regular usage.
- Guarantee smooth operation across all locales and platforms.
- Expand robust support for a wide variety of AI providers and models.

### Enhanced User Experience

- Streamline the UI/UX for clarity and intuitiveness.
- Continuously improve the workflow to meet the high expectations developers have for daily-use tools.

### Leading on Agent Performance

- Establish comprehensive evaluation benchmarks (evals) to measure real-world productivity.
- Make it easy for everyone to easily run and interpret these evals.
- Ship improvements that demonstrate clear increases in eval scores.

Mention alignment with these areas in your PRs.

### 3. Join the Zoo Code Community

- **Discord:** Join our [Discord](https://discord.gg/VxfP4Vx3gX).
- **Reddit:** Join our [Reddit](https://www.reddit.com/r/ZooCode/).

## Finding & Planning Your Contribution

### Types of Contributions

- **Bug Fixes:** Addressing code issues.
- **New Features:** Adding functionality.
- **Documentation:** Improving guides and clarity.

### Issue-First Approach

All contributions start with a GitHub Issue using our skinny templates.

- **Check existing issues**: Search [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Create an issue** using:
    - **Enhancements:** "Enhancement Request" template (plain language focused on user benefit).
    - **Bugs:** "Bug Report" template (minimal repro + expected vs actual + version).
- **Want to work on it?** Comment "Claiming" on the issue and reach out to the core team on [Discord](https://discord.gg/VxfP4Vx3gX) to get assigned. Assignment will be confirmed in the thread.
- **PRs must link to the issue.** Unlinked PRs may be closed.

### Deciding What to Work On

- Check the [GitHub Issues page](https://github.com/Zoo-Code-Org/Zoo-Code/issues) for issues.
- For docs, visit [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

### Reporting Bugs

- Check for existing reports first.
- Create a new bug using the ["Bug Report" template](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) with:
    - Clear, numbered reproduction steps
    - Expected vs actual result
    - Zoo Code version (required); API provider/model if relevant
- **Security issues**: Report privately via [security advisories](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

## Development & Submission Process

### Development Setup

1. **Fork & Clone:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Install Dependencies:**

```
pnpm install
```

3. **Debugging:** Open with VS Code (`F5`).

### Writing Code Guidelines

- One focused PR per feature or fix.
- Follow ESLint and TypeScript best practices.
- Write clear, descriptive commits referencing issues (e.g., `Fixes #123`).
- Provide thorough testing (`npm test`).
- Rebase onto the latest `main` branch before submission.

### Submitting a Pull Request

- Begin as a **Draft PR** if seeking early feedback.
- Clearly describe your changes following the Pull Request Template.
- Link the issue in the PR description/title (e.g., "Fixes #123").
- Provide screenshots/videos for UI changes.
- Indicate if documentation updates are necessary.

### Pull Request Policy

- Must reference an assigned GitHub Issue. To get assigned: comment "Claiming" on the issue and reach out to the core team on [Discord](https://discord.gg/VxfP4Vx3gX). Assignment will be confirmed in the thread.
- Unlinked PRs may be closed.
- PRs should pass CI tests, align with the roadmap, and have clear documentation.

### Review Process

- **Daily Triage:** Quick checks by maintainers.
- **Weekly In-depth Review:** Comprehensive assessment.
- **Iterate promptly** based on feedback.

### Pull Request Expectations

Pull requests should be reviewable, tested, and maintainable. Before opening a PR, please make sure that:

- The change is scoped to a specific issue, bug, or improvement.
- You can explain what the change does and why it is correct.
- You have tested the change locally where practical.
- You are willing to respond to review feedback and make reasonable follow-up changes.
- The PR does not require maintainers to substantially rewrite, redesign, or take ownership of the implementation before it can be merged.

Maintainers may close PRs that are incomplete, too broad, inactive, not aligned with the project direction, or that create disproportionate review or maintenance burden. Closing a PR is not a judgment on the contributor; it is a maintainer decision that the change cannot be accepted in its present form.

PRs are also closed automatically by bot:

- **60-day inactivity:** A PR with no activity for 60 days is marked stale and closed after a further 7 days if there is still no activity. Any new comment, commit, or review resets the timer.
- **14-day author inactivity:** After a reviewer requests changes, the PR is labelled `awaiting-author`. Author activity resets the inactivity timer. Once the changes are ready, re-request review from the reviewer; the PR will move to `awaiting-review` and is no longer eligible for automatic closure under this policy.

To opt a PR out of automatic closure, apply the `do-not-close`, `pinned`, or `work-in-progress` label.

### AI-Assisted Contributions

Use of AI tools is allowed, but contributors remain fully responsible for their submissions.

If you use AI tools to help create a PR, you must:

- Review and understand every meaningful change.
- Be able to explain the implementation and tradeoffs in your own words.
- Test the change yourself. If testing is impractical for your environment, explain why in the PR description and describe how reviewers can verify the change instead.
- Verify that generated code is correct, necessary, and compatible with the project license.
- Consider disclosing AI assistance in the PR description when it materially shaped the code, tests, or design — this helps reviewers give better feedback.

Please do not submit AI-generated changes that you do not understand or cannot maintain through review. Maintainers may close PRs that appear substantially AI-assisted but lack human verification, clear rationale, or review follow-through.

## Legal

By contributing, you agree your contributions will be licensed under the Apache 2.0 License, consistent with Zoo Code's licensing.
