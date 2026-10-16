<div align="center">
<sub>

<b>English</b> • [Català](locales/ca/CONTRIBUTING.md) • [Deutsch](locales/de/CONTRIBUTING.md) • [Español](locales/es/CONTRIBUTING.md) • [Français](locales/fr/CONTRIBUTING.md) • [हिंदी](locales/hi/CONTRIBUTING.md) • [Bahasa Indonesia](locales/id/CONTRIBUTING.md) • [Italiano](locales/it/CONTRIBUTING.md) • [日本語](locales/ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](locales/ko/CONTRIBUTING.md) • [Nederlands](locales/nl/CONTRIBUTING.md) • [Polski](locales/pl/CONTRIBUTING.md) • [Português (BR)](locales/pt-BR/CONTRIBUTING.md) • [Русский](locales/ru/CONTRIBUTING.md) • [Türkçe](locales/tr/CONTRIBUTING.md) • [Tiếng Việt](locales/vi/CONTRIBUTING.md) • [简体中文](locales/zh-CN/CONTRIBUTING.md) • [繁體中文](locales/zh-TW/CONTRIBUTING.md)

</sub>
</div>

# Contributing to Zoo Code

Zoo Code is a community project. We value every contribution. We work on an [Issue-First](#issue-first-approach) basis. This means each [Pull Request (PR)](#submitting-a-pull-request) must link to a GitHub Issue. Read this guide with care.

## Table of Contents

- [Before You Contribute](#before-you-contribute)
- [Finding & Planning Your Contribution](#finding--planning-your-contribution)
- [Development & Submission Process](#development--submission-process)
    - [Pull Request Expectations](#pull-request-expectations)
    - [AI-Assisted Contributions](#ai-assisted-contributions)
    - [Writing Style](#writing-style)
- [Legal](#legal)

## Before You Contribute

### 1. Code of Conduct

All contributors must follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

### 2. Project Roadmap

Our roadmap shows the direction of the project. Align your contributions with these goals:

### Reliability First

- Make diff editing and command execution reliable every time.
- Remove the problems that stop people from using Zoo Code every day.
- Make Zoo Code work on all locales and platforms.
- Support more AI providers and models.

### Enhanced User Experience

- Make the UI and UX clear and easy to use.
- Improve the workflow. Developers expect a high standard from the tools they use every day.

### Leading on Agent Performance

- Build evaluation benchmarks (evals) that measure real-world productivity.
- Make the evals easy to run and easy to read.
- Ship improvements that clearly increase the eval scores.

In your PRs, say which of these areas the change supports.

### 3. Join the Zoo Code Community

- **Discord:** Join our [Discord](https://discord.gg/VxfP4Vx3gX).
- **Reddit:** Join our [Reddit](https://www.reddit.com/r/ZooCode/).

## Finding & Planning Your Contribution

### Types of Contributions

- **Bug Fixes:** Fix code problems.
- **New Features:** Add functions.
- **Documentation:** Improve the guides and make them clearer.

### Issue-First Approach

Each contribution starts with a GitHub Issue. Use our short templates.

- **Check existing issues**: Search [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Create an issue** using:
    - **Enhancements:** "Enhancement Request" template (plain language focused on user benefit).
    - **Bugs:** "Bug Report" template (minimal repro, expected and actual result, version).
- **Write the issue** in the [Writing Style](#writing-style) below.
- **Want to work on it?** Comment "Claiming" on the issue. Then contact the core team on [Discord](https://discord.gg/VxfP4Vx3gX) to get assigned. The core team confirms the assignment in the thread.
- **PRs must link to the issue.** We may close PRs that have no link.

### Deciding What to Work On

- Look at the [GitHub Issues page](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- For docs, go to [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

### Reporting Bugs

- First, check for existing reports.
- Create a new bug using the ["Bug Report" template](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) with:
    - Clear, numbered reproduction steps
    - Expected result and actual result
    - Zoo Code version (required)
    - API provider and model, if they matter
- **Security issues**: Report them in private with [security advisories](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

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
- Follow the ESLint and TypeScript best practices.
- Write clear, descriptive commits that reference issues (for example, `Fixes #123`). Follow the [Writing Style](#writing-style).
- Test your change fully (`npm test`).
- Rebase onto the latest `main` branch before you submit.

### Submitting a Pull Request

- Start as a **Draft PR** if you want early feedback.
- Describe your changes with the Pull Request Template. Follow the [Writing Style](#writing-style).
- Link the issue in the PR description or title (for example, "Fixes #123").
- Add screenshots or videos for UI changes.
- Say if the change needs documentation updates.

### Pull Request Policy

- The PR must reference an assigned GitHub Issue. To get assigned, comment "Claiming" on the issue. Then contact the core team on [Discord](https://discord.gg/VxfP4Vx3gX). The core team confirms the assignment in the thread.
- We may close PRs that have no link.
- A PR must pass the CI tests, follow the roadmap, and have clear documentation.

### Review Process

A PR that is ready for review must meet these conditions:

- It passes the required CI checks.
- It addresses the review feedback that needs action.
- It gets a fresh maintainer or CODEOWNER approval. This happens after the automated review finishes for the latest commit.

The automated review may add a guidance comment and managed state labels. Follow the next step in the comment. Do not edit the labels yourself. New commits reset the review state for the changed code.

The `community-approved` label shows a fresh community approval on the latest commit. The PR then waits for maintainer review. The label is an advisory priority signal for maintainers. It does not replace maintainer review or a required check. The review workflow manages the label.

Automated review helps maintainers. It does not replace human approval. Outside contributors cannot direct CodeRabbit with comments. An eligible review restarts by itself after the required CI passes. Maintainers handle any exceptional restart. Warnings are advisory, unless repository policy says they are not. The native GitHub required checks, CODEOWNER rules, and review protections decide if a PR can merge.

- **Daily Triage:** Maintainers do quick checks.
- **Weekly In-depth Review:** Maintainers do a full assessment.
- **Iterate quickly** when you get feedback.

### Pull Request Expectations

A PR must be easy to review, tested, and easy to maintain. Before you open a PR, make sure of these points:

- The change covers one specific issue, bug, or improvement.
- You can explain what the change does and why it is correct.
- You tested the change on your computer where possible.
- You will answer review feedback and make reasonable follow-up changes.
- Maintainers do not need to rewrite or redesign the change, or take ownership of it, before it can merge.

Maintainers may close a PR for these reasons:

- It is incomplete.
- It is too broad.
- It is inactive.
- It does not follow the direction of the project.
- It creates too much review or maintenance work.

Closing a PR is not a judgment on the contributor. It means the maintainers cannot accept the change in its present form.

A bot also closes PRs automatically:

- **60-day inactivity:** The bot marks a PR as stale after 60 days with no activity. If there is still no activity after 7 more days, the bot closes the PR. A new comment, commit, or review resets the timer.
- **14-day author inactivity:** When a reviewer requests changes, the bot adds the `awaiting-author` label. Activity from the author resets the inactivity timer. When the changes are ready, ask the reviewer for a new review.

To stop automatic closure of a PR, add the `do-not-close`, `pinned`, or `work-in-progress` label.

### AI-Assisted Contributions

You can use AI tools. You are still fully responsible for your submission.

If you use AI tools to help create a PR, you must:

- Review and understand each important change.
- Explain the implementation and the trade-offs in your own words.
- Test the change yourself. If you cannot test in your environment, explain why in the PR description. Also describe how reviewers can verify the change.
- Make sure the generated code is correct, necessary, and compatible with the project license.
- Think about telling reviewers about the AI help in the PR description. Do this when the AI help changed the code, tests, or design in a major way. This helps reviewers give better feedback.

Do not submit AI-generated changes that you do not understand. Do not submit changes that you cannot maintain through review. Maintainers may close a PR that seems to have much AI help. They may do this if it has no human verification, no clear reason, or no follow-up in review.

### Writing Style

Write issue titles, issue text, PR titles, PR descriptions, and commit messages in Simplified Technical English ([ASD-STE100](https://www.asd-ste100.org/)). The issue and PR templates give the same reminder.

- Use short sentences. Use 20 words or fewer for an instruction.
- Use plain words. Write "use", not "utilize". Write "start", not "commence".
- Use the active voice. Write "the parser reads the file", not "the file is read by the parser".
- Write one idea in each sentence.
- Do not use contractions, semicolons, or em-dashes.
- Keep the title short and specific.
- Do not change exact logs, error messages, identifiers, commands, or reproduction evidence. Paste them as they are.

These rules are writing guidance. Reviewers do not check formal ASD-STE100 compliance. Code, identifiers, and command syntax are not part of this rule.

## Legal

When you contribute, you agree that your contributions use the Apache 2.0 License. This is the license of Zoo Code.
