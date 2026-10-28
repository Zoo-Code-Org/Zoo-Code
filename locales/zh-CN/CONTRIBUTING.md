<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • <b>简体中文</b> • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# 为 Zoo Code 做贡献

Zoo Code 是一个社区项目。我们重视每一份贡献。我们采用[先建 Issue](#issue-first-approach) 的方式。这意味着每个 [Pull Request（PR）](#submitting-a-pull-request) 都必须链接到一个 GitHub Issue。请仔细阅读这份指南。

<a id="table-of-contents"></a>

## 目录

- [贡献前的准备](#before-you-contribute)
- [寻找和规划你的贡献](#finding--planning-your-contribution)
- [开发与提交流程](#development--submission-process)
    - [Pull Request 要求](#pull-request-expectations)
    - [AI 辅助贡献](#ai-assisted-contributions)
    - [写作风格](#writing-style)
- [法律条款](#legal)

<a id="before-you-contribute"></a>

## 贡献前的准备

<a id="1-code-of-conduct"></a>

### 1. 行为准则

所有贡献者都必须遵守我们的[行为准则](./CODE_OF_CONDUCT.md)。

<a id="2-project-roadmap"></a>

### 2. 项目路线图

路线图展示了项目的发展方向。请让你的贡献符合这些目标：

<a id="reliability-first"></a>

### 可靠性优先

- 让差异更新和命令运行每次都可靠。
- 解决妨碍大家每天使用 Zoo Code 的问题。
- 让 Zoo Code 支持所有语言区域和平台。
- 支持更多 AI 提供商和模型。

<a id="enhanced-user-experience"></a>

### 改善用户体验

- 让 UI 和 UX 清晰、易用。
- 改善工作流程。开发者对每天使用的工具有很高的要求。

<a id="leading-on-agent-performance"></a>

### 领先的智能体性能

- 建立能衡量实际生产力的评估基准（evals）。
- 让 evals 易于运行和阅读。
- 发布能明显提高 evals 分数的改进。

在 PR 中说明你的改动支持上述哪些方向。

<a id="3-join-the-zoo-code-community"></a>

### 3. 加入 Zoo Code 社区

- **Discord：** 加入我们的 [Discord](https://discord.gg/VxfP4Vx3gX)。
- **Reddit：** 加入我们的 [Reddit](https://www.reddit.com/r/ZooCode/)。

<a id="finding--planning-your-contribution"></a>

## 寻找和规划你的贡献

<a id="types-of-contributions"></a>

### 贡献类型

- **修复错误：** 修复代码问题。
- **新功能：** 添加功能。
- **文档：** 改善指南，让内容更清楚。

<a id="issue-first-approach"></a>

### 先建 Issue

每份贡献都从一个 GitHub Issue 开始。请使用我们的简短模板。

- **检查已有 Issue：** 搜索 [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues)。
- **创建 Issue** 时使用：
    - **改进：** "Enhancement Request" 模板（使用平实的语言，重点说明对用户的好处）。
    - **错误：** "Bug Report" 模板（最小复现示例、预期和实际结果、版本）。
- **编写 Issue** 时遵循下方的[写作风格](#writing-style)。
- **想接手这项工作？** 在 Issue 中评论 "Claiming"。然后在 [Discord](https://discord.gg/VxfP4Vx3gX) 联系核心团队，让他们把 Issue 分配给你。核心团队会在讨论中确认分配。
- **PR 必须链接到 Issue。** 我们可能关闭没有链接的 PR。

<a id="deciding-what-to-work-on"></a>

### 决定做什么

- 查看 [GitHub Issues 页面](https://github.com/Zoo-Code-Org/Zoo-Code/issues)。
- 文档相关工作请前往 [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs)。

<a id="reporting-bugs"></a>

### 报告错误

- 先检查已有报告。
- 使用 ["Bug Report" 模板](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) 创建新的错误报告，并提供：
    - 清晰、编号的复现步骤
    - 预期结果和实际结果
    - Zoo Code 版本（必填）
    - API 提供商和模型（如与问题相关）
- **安全问题：** 通过 [security advisories](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new) 私下报告。

<a id="development--submission-process"></a>

## 开发与提交流程

<a id="development-setup"></a>

### 配置开发环境

1. **Fork 并克隆：**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **安装依赖：**

```
pnpm install
```

3. **调试：** 用 VS Code 打开（`F5`）。

<a id="writing-code-guidelines"></a>

### 编写代码的指南

- 每个功能或修复只提交一个专注于该项工作的 PR。
- 遵循 ESLint 和 TypeScript 的最佳实践。
- 编写清晰、有说明性的 commit 消息，并引用 Issue（例如 `Fixes #123`）。遵循[写作风格](#writing-style)。
- 完整测试你的改动（`npm test`）。
- 提交前，rebase 到最新的 `main` 分支。

<a id="submitting-a-pull-request"></a>

### 提交 Pull Request

- 如果想尽早获得反馈，先创建 **Draft PR**。
- 使用 Pull Request Template 描述改动。遵循[写作风格](#writing-style)。
- 在 PR 描述或标题中链接 Issue（例如 "Fixes #123"）。
- UI 改动需添加截图或视频。
- 说明改动是否需要更新文档。

<a id="pull-request-policy"></a>

### Pull Request 政策

- PR 必须引用一个已分配的 GitHub Issue。要获得分配，先在 Issue 中评论 "Claiming"。然后在 [Discord](https://discord.gg/VxfP4Vx3gX) 联系核心团队。核心团队会在讨论中确认分配。
- 我们可能关闭没有链接的 PR。
- PR 必须通过 CI 测试、符合路线图，并有清晰的文档。

<a id="review-process"></a>

### 审查流程

准备好接受审查的 PR 必须满足以下条件：

- 通过必需的 CI 检查。
- 处理需要采取行动的审查反馈。
- 获得维护者或 CODEOWNER 的最新批准。批准必须发生在最新 commit 的自动审查完成之后。

自动审查可能添加指导评论和受管理的状态标签。按照评论中的下一步操作。不要自行修改标签。新的 commit 会重置已改动代码的审查状态。

`community-approved` 标签表示最新 commit 获得了社区的最新批准。随后，PR 等待维护者审查。这个标签为维护者提供优先级参考。它不能替代维护者审查或必需的检查。审查工作流程管理这个标签。

自动审查帮助维护者，但不能替代人工批准。外部贡献者不能通过评论指挥 CodeRabbit。符合条件的审查会在必需的 CI 通过后自动重新开始。维护者处理例外情况下的重启。除非仓库政策另有规定，否则警告仅供参考。GitHub 原生的必需检查、CODEOWNER 规则和审查保护决定 PR 能否合并。

- **每日初步检查：** 维护者进行快速检查。
- **每周深入审查：** 维护者进行全面评估。
- 收到反馈后，**尽快修改**。

<a id="pull-request-expectations"></a>

### Pull Request 要求

PR 必须便于审查、经过测试，并且易于维护。打开 PR 前，确认以下几点：

- 改动只针对一个具体的 Issue、错误或改进。
- 你能解释改动做了什么，以及为什么正确。
- 你已尽可能在自己的电脑上测试改动。
- 你会回应审查反馈，并进行合理的后续修改。
- 合并前，维护者不需要重写、重新设计或接管改动。

维护者可能因以下原因关闭 PR：

- 内容不完整。
- 范围太广。
- 没有活动。
- 不符合项目方向。
- 产生过多的审查或维护工作。

关闭 PR 不是对贡献者的评价。这表示维护者无法接受当前形式的改动。

机器人也会自动关闭 PR：

- **60 天无活动：** PR 连续 60 天没有活动后，机器人会将它标记为过期。如果再过 7 天仍没有活动，机器人会关闭 PR。新的评论、commit 或审查会重置计时器。
- **作者 14 天无活动：** 审查者请求修改时，机器人会添加 `awaiting-author` 标签。作者的活动会重置无活动计时器。改动准备好后，请向审查者请求再次审查。

要阻止 PR 自动关闭，请添加 `do-not-close`、`pinned` 或 `work-in-progress` 标签。

<a id="ai-assisted-contributions"></a>

### AI 辅助贡献

你可以使用 AI 工具，但仍须对提交内容负全部责任。

如果你使用 AI 工具辅助创建 PR，你必须：

- 审查并理解每项重要改动。
- 用自己的话解释实现方式和取舍。
- 自行测试改动。如果无法在你的环境中测试，请在 PR 描述中说明原因。还要说明审查者如何验证改动。
- 确认生成的代码正确、必要，并与项目许可证兼容。
- 考虑在 PR 描述中告知审查者 AI 的帮助。如果 AI 大幅改变了代码、测试或设计，就应说明。这有助于审查者给出更好的反馈。

不要提交你不理解的 AI 生成改动。不要提交你无法在审查期间维护的改动。维护者可能关闭看起来大量依赖 AI 的 PR。如果缺少人工验证、明确理由或审查跟进，他们可以这样做。

<a id="writing-style"></a>

### 写作风格

这些规则仅适用于英文文本。Issue 标题和正文、PR 标题和描述，以及 commit 消息应使用 [Simplified Technical English (ASD-STE100)](https://www.asd-ste100.org/)。Issue 和 PR 模板也有同样的提醒。

- 使用短句。每条指令不超过 20 个单词。
- 使用简单词语。写 "use"，不要写 "utilize"。写 "start"，不要写 "commence"。
- 使用主动语态。写 "the parser reads the file"，不要写 "the file is read by the parser"。
- 每句只表达一个意思。
- 不要使用缩约形式、分号或长破折号。
- 标题保持简短、具体。
- 不要改动确切的日志、错误消息、标识符、命令或复现证据。请原样粘贴。

这些规则是写作指导。审查者不会检查是否正式符合 ASD-STE100。代码、标识符和命令语法不在这条规则的范围内。

<a id="legal"></a>

## 法律条款

参与贡献即表示你同意以 Apache 2.0 许可证发布你的贡献。这也是 Zoo Code 使用的许可证。
