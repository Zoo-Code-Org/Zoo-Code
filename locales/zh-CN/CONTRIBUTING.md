<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • <b>简体中文</b> • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

# 为 Zoo Code 做贡献

Zoo Code 是一个由社区驱动的项目，我们非常重视每一份贡献。为了简化协作，我们采用 [“问题优先” 的方法](#问题优先方法)，这意味着所有的 [拉取请求 (PR)](#提交拉取请求) 都必须首先链接到一个 GitHub 问题。请仔细阅读本指南。

## 目录

- [在您贡献之前](#在您贡献之前)
- [寻找和规划您的贡献](#寻找和规划您的贡献)
- [开发和提交流程](#开发和提交流程)
- [拉取请求的期望](#拉取请求的期望)
- [AI辅助贡献](#ai辅助贡献)
- [法律](#法律)

## 在您贡献之前

### 1. 行为准则

所有贡献者都必须遵守我们的 [行为准则](./CODE_OF_CONDUCT.md)。

### 2. 项目路线图

我们的路线图指导着项目的方向。请将您的贡献与这些关键目标保持一致：

### 可靠性第一

- 确保差异编辑和命令执行始终可靠。
- 减少阻碍常规使用的摩擦点。
- 保证在所有地区和平台上的流畅操作。
- 扩大对各种人工智能提供商和模型的强大支持。

### 增强的用户体验

- 简化用户界面/用户体验，以提高清晰度和直观性。
- 不断改进工作流程，以满足开发人员对日常使用工具的高期望。

### 在代理性能上领先

- 建立全面的评估基准 (evals) 来衡量真实世界的生产力。
- 让每个人都能轻松运行和解释这些评估。
- 发布能显示评估分数明显提高的改进。

在您的 PR 中提及与这些领域的一致性。

### 3. 加入 Zoo Code 社区

- **Discord：**加入我们的 [Discord](https://discord.gg/VxfP4Vx3gX)。
- **Reddit：**加入我们的 [Reddit](https://www.reddit.com/r/ZooCode/)。

## 寻找和规划您的贡献

### 贡献类型

- **错误修复：** 解决代码问题。
- **新功能：** 添加功能。
- **文档：** 改进指南和清晰度。

### 问题优先方法

所有贡献都始于使用我们精简模板的 GitHub 问题。

- **检查现有问题**：在 [GitHub 问题](https://github.com/Zoo-Code-Org/Zoo-Code/issues) 中搜索。
- **使用以下模板创建问题**：
    - **增强功能：** “增强请求”模板（侧重于用户利益的简单语言）。
    - **错误：** “错误报告”模板（最少的复现步骤 + 预期与实际 + 版本）。
- **想参与其中吗？** 在问题上评论“领取”，并在[Discord](https://discord.gg/VxfP4Vx3gX)上联系核心团队以获得分配。分配将在帖子中确认。
- **PR 必须链接到问题。** 未链接的 PR 可能会被关闭。

### 决定做什么

- 如需查看 issue，请访问 [GitHub Issues 页面](https://github.com/Zoo-Code-Org/Zoo-Code/issues)。
- 如需文档，请访问 [Zoo Code 文档](https://github.com/Zoo-Code-Org/Zoo-Code-Docs)。

### 报告错误

- 首先检查现有的报告。
- 使用 [“错误报告”模板](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) 创建一个新错误，并提供：
    - 清晰、编号的复现步骤
    - 预期与实际结果
    - Zoo Code 版本（必需）；如果相关，还需提供 API 提供商/模型
- **安全问题**：通过 [安全公告](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new) 私下报告。

## 开发和提交流程

### 开发设置

1. **复刻和克隆：**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **安装依赖项：**

```
pnpm install
```

3. **调试：** 使用 VS Code 打开（`F5`）。

### 编码指南

- 每个功能或修复一个集中的 PR。
- 遵循 ESLint 和 TypeScript 的最佳实践。
- 编写清晰、描述性的提交，并引用问题（例如，`修复 #123`）。
- 提供全面的测试（`npm test`）。
- 在提交前变基到最新的 `main` 分支。

### 提交拉取请求

- 如果希望获得早期反馈，请以 **草稿 PR** 开始。
- 遵循拉取请求模板，清晰地描述您的更改。
- 在 PR 描述/标题中链接问题（例如，“修复 #123”）。
- 为用户界面更改提供屏幕截图/视频。
- 指明是否需要更新文档。

### 拉取请求政策

- 必须引用一个已分配的 GitHub 问题。要获得分配：在问题上评论“领取”，并在[Discord](https://discord.gg/VxfP4Vx3gX)上联系核心团队。分配将在帖子中确认。
- 未链接的 PR 可能会被关闭。
- PR 必须通过 CI 测试，与路线图保持一致，并有清晰的文档。

### 审查流程

- **每日分类：** 维护人员进行快速检查。
- **每周深入审查：** 全面评估。
- **根据反馈及时迭代**。

### 拉取请求的期望

拉取请求应当可审查、经过测试且可维护。在开启 PR 之前，请确保：

- 变更仅限于特定的问题、错误或改进。
- 您能够解释变更的内容以及为何正确。
- 您已在可行的情况下在本地测试了变更。
- 您愿意响应审查反馈并进行合理的后续更改。
- PR 无需维护人员在合并之前实质性地重写、重新设计或接管实现。

维护人员可以关闭不完整、范围过广、不活跃、与项目方向不符或产生不相称的审查或维护负担的 PR。关闭 PR 不是对贡献者的评判；这是维护人员认为该变更以其现有形式无法被接受的决定。

### AI辅助贡献

允许使用 AI 工具，但贡献者对其提交内容负全部责任。

如果您使用 AI 工具帮助创建 PR，您必须：

- 审查并理解每一项有意义的变更。
- 能够用自己的话解释实现方式和权衡取舍。
- 自行测试变更。如果在您的环境中测试不可行，请在 PR 描述中说明原因，并描述审查者如何验证该变更。
- 验证生成的代码是否正确、必要且与项目许可证兼容。
- 当 AI 对代码、测试或设计有实质性影响时，建议在 PR 描述中披露 AI 辅助情况 — 这有助于审查者提供更好的反馈。

请勿提交您不理解或无法在审查过程中维护的 AI 生成变更。维护人员可能会关闭看似主要由 AI 辅助但缺乏人工验证、明确理由或审查跟进的 PR。

## 法律

通过贡献，您同意您的贡献将根据 Apache 2.0 许可证进行许可，这与 Zoo Code 的许可一致。
