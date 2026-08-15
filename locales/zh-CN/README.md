<p align="center">
          <a href="https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
          <a href="https://x.com/ZooCodeDev"><img src="https://img.shields.io/badge/ZooCode-000000?style=flat&logo=x&logoColor=white" alt="X"></a>
          <a href="https://discord.gg/VxfP4Vx3gX"><img src="https://img.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Join Discord"></a>
          <a href="https://www.reddit.com/r/ZooCode/"><img src="https://img.shields.io/badge/Join%20r%2FZooCode-FF4500?style=flat&logo=reddit&logoColor=white" alt="Join r/ZooCode"></a>
          <a href="https://github.com/Zoo-Code-Org/Zoo-Code/issues"><img src="https://img.shields.io/badge/GitHub-Issues-181717?style=flat&logo=github&logoColor=white" alt="GitHub Issues"></a>
        </p>
        <p align="center">
          <em>快速获取帮助 → <a href="https://discord.gg/VxfP4Vx3gX">加入 Discord</a> • 偏好异步？→ <a href="https://www.reddit.com/r/ZooCode/">加入 r/ZooCode</a></em>
        </p>

        # Zoo Code

        > 你的 AI 驱动开发团队，就在你的编辑器里

        ## 我们是 Zoo Code

> 在 Roo 团队停止 Roo Code 的积极开发、转而专注于 [Roomote](https://roomote.dev/)
> 之后，Zoo Code 将继续开发这个项目。感谢 Roo 团队所构建的一切。
>
> 核心团队由此前曾为 Roo 做出贡献、并且非常在乎这个插件的开发者组成。我们
> 会继续更新模型、修复 bug，并发布新功能，也计划认真倾听让这个插件如此特
> 别的社区。欢迎加入我们，一起在
> [Discord](https://discord.gg/VxfP4Vx3gX)、
> [Reddit](https://www.reddit.com/r/ZooCode)，或者
> [创建 PR 或 issue](https://github.com/Zoo-Code-Org/Zoo-Code)。
>
> _-Zoo Code Team_

## 从 Roo Code 迁移到 Zoo Code

你可以在 [Roo→Zoo 迁移指南](https://docs.zoocode.dev/roo-to-zoo-migration) 中找到从 Roo Code 迁移到 Zoo Code 的快速说明。我们希望在大家迁移过程中尽可能提供帮助，这也是我们设立 [Reddit](https://www.reddit.com/r/ZooCode) 和 [Discord](https://discord.gg/VxfP4Vx3gX) 社区的原因。如果你遇到问题或有任何疑问，欢迎加入后直接提问。

## Zoo Code 在 Roo Code 之后新增的功能

Zoo Code 基于 Roo Code 打下的基础持续扩展，新增了：

- **Semble 代码库智能** — 快速、按需的语义代码搜索，可自动设置，无需单独的索引流程。
- **更强大的 Orchestrator 工作流** — 更安全的任务委派、并行任务协调、可靠的父子任务恢复，以及更完善的子任务与提供商配置隔离。
- **通过 Destructive Command Guard (DCG) 实现更长时间的自主运行** — 自动阻止危险命令，同时让可信工作继续执行，无需反复批准。
- **最新模型** — 持续支持新的 Claude、GPT、Gemini、Kimi、GLM、Grok、MiniMax 及其他模型系列。
- **更多连接方式** — 新增和扩展了 Zoo Gateway、Moonshot、Kimi Code、Kenari、Friendli、OpenCode Go 等众多提供商。
- **更可靠的终端和编辑工作流** — 修复终端过早完成、任务状态竞争、上下文管理、差异更新编辑和提供商专用工具调用等问题。
- **更全面的工作区控制** — 支持规则管理、按模式限制 MCP、多根工作区路径控制、模型推理选项和完成后的变更审查操作。

## v3.78.0 新增内容

- **三款重磅新模型现已推出** — 使用全新的 Gemini 3.7 Flash、GLM 5.3 和 Qwen3.8 Max 模型，以及更新后的 DeepSeek V4 推理、定价和提供商覆盖。
- **连接 NanoGPT** — 使用动态模型发现、流式传输和 Prompt 补全，并按速度、价格、延迟、吞吐量、工具支持和缓存设置路由偏好。
- **更可靠的提供商和任务** — 修复改进了 Azure OpenAI endpoint 设置、Kimi Code 输出限制、任务历史标题保留以及 Zoo 设置的导入/导出。
- Destructive Command Guard 现在支持基于 Intel 的 Mac。
- 安全更新修复了 `undici` 和 Mermaid 中的漏洞。

## Zoo Code 能为您做什么？

- 从自然语言描述生成代码
- 使用模式进行调整：代码、架构师、提问、调试和自定义模式
- 重构和调试现有代码
- 编写和更新文档
- 回答关于您的代码库的问题
- 自动化重复性任务
- 使用 MCP 服务器

## 模式

Zoo Code 适应您的工作方式，而不是相反：

- 代码模式：日常编码、编辑和文件操作
- 架构师模式：规划系统、规范和迁移
- 提问模式：快速回答、解释和文档
- 调试模式：跟踪问题、添加日志、隔离根本原因
- 自定义模式：为您的团队或工作流程构建专门的模式

了解更多：[使用模式](https://docs.zoocode.dev/basic-usage/using-modes) • [自定义模式](https://docs.zoocode.dev/advanced-usage/custom-modes)

## 资源

- **[文档](https://docs.zoocode.dev):** 安装、配置和掌握 Zoo Code 的官方指南。
- **[Discord 服务器](https://discord.gg/VxfP4Vx3gX):** 加入社区以获得实时帮助和讨论。
- **[Reddit 社区](https://www.reddit.com/r/ZooCode):** 分享您的经验，看看别人在构建什么。
- **[GitHub 问题](https://github.com/Zoo-Code-Org/Zoo-Code/issues):** 报告错误并跟踪开发。
- **[功能请求](https://github.com/Zoo-Code-Org/Zoo-Code/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** 有想法吗？与开发人员分享。

---

## 本地设置与开发

1. **克隆**仓库：

```sh
git clone https://github.com/Zoo-Code-Org/Zoo-Code.git
```

2. **安装依赖项**:

```sh
pnpm install
```

3. **运行扩展程序**:

有几种方法可以运行 Zoo Code 扩展程序：

### 开发模式（F5）

对于积极开发，请使用 VSCode 的内置调试功能：

在 VSCode 中按 `F5`（或转到 **Run** → **Start Debugging**）。这将在运行 Zoo Code 扩展程序的新 VSCode 窗口中打开。

- 对 webview 的更改将立即显示。
- 对核心扩展程序的更改也会自动热重载。

### 自动化 VSIX 安装

要将扩展程序构建为 VSIX 包并直接安装到 VSCode 中：

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

此命令将：

- 询问要使用的编辑器命令（code/cursor/code-insiders） - 默认为“code”
- 卸载任何现有版本的扩展程序。
- 构建最新的 VSIX 包。
- 安装新构建的 VSIX。
- 提示您重新启动 VS Code 以使更改生效。

选项：

- `-y`: 跳过所有确认提示并使用默认值
- `--editor=<command>`: 指定编辑器命令（例如，`--editor=cursor` 或 `--editor=code-insiders`）

### 手动 VSIX 安装

如果您希望手动安装 VSIX 包：

1.  首先，构建 VSIX 包：
    ```sh
    pnpm vsix
    ```
2.  将在 `bin/` 目录中生成一个 `.vsix` 文件（例如，`bin/zoo-code-<version>.vsix`）。
3.  使用 VSCode CLI 手动安装
    ```sh
    code --install-extension bin/zoo-code-<version>.vsix
    ```

---

我们使用 [changesets](https://github.com/changesets/changesets) 进行版本控制和发布。有关发行说明，请查看我们的 `CHANGELOG.md`。

---

## 免责声明

**请注意**，Zoo Code **不**对与 Zoo Code 相关的任何代码、模型或其他工具、任何相关的第三方工具或任何由此产生的输出作出任何陈述或保证。您承担使用任何此类工具或输出的**所有风险**；此类工具均按**“原样”**和**“可用”**的基础提供。此类风险可能包括但不限于知识产权侵权、网络漏洞或攻击、偏见、不准确、错误、缺陷、病毒、停机、财产损失或损害和/或人身伤害。您对自己使用任何此类工具或输出负全部责任（包括但不限于其合法性、适当性和结果）。

---

## 贡献

我们欢迎社区贡献！请阅读我们的 [CONTRIBUTING.md](CONTRIBUTING.md) 开始。

---

## 许可证

[Apache 2.0 © 2025 Zoo Code Org](../../LICENSE)

---

**尽情享受 Zoo Code！** 无论你是让它保持短绳控制，还是让它自主探索，我们都迫不及待想看看你会构建什么。如果你有问题或功能想法，请提交一个 [issue](https://github.com/Zoo-Code-Org/Zoo-Code/issues) 或发起一个 [discussion](https://github.com/Zoo-Code-Org/Zoo-Code/discussions)。祝你编码愉快！
