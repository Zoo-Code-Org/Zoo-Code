# Zoo Code CLI

The AI coding agent built for the terminal. Generate code from natural language, automate tasks, and run terminal commands -- powered by 500+ AI models.

## Install

```bash
npm install -g @zoo-code/cli
```

Or run directly with npx:

```bash
npx --package @zoo-code/cli zoo
```

## Getting Started

Run `zoo` in any project directory to launch the interactive TUI:

```bash
zoo
```

Run a one-off task:

```bash
zoo run "add input validation to the signup form"
```

## Features

- **Code generation** -- describe what you want in natural language
- **Terminal commands** -- the agent can run shell commands on your behalf
- **500+ AI models** -- use models from OpenAI, Anthropic, Google, and more
- **MCP servers** -- extend agent capabilities with the Model Context Protocol
- **Multiple modes** -- Plan with Architect, code with Coder, debug with Debugger, or create your own
- **Sessions** -- resume previous conversations and export transcripts
- **API keys optional** -- bring your own keys or use Zoo Code credits when available

## Commands

| Command              | Description                |
| -------------------- | -------------------------- |
| `zoo`                | Launch interactive TUI     |
| `zoo run "<task>"`   | Run a one-off task         |
| `zoo auth`           | Manage authentication      |
| `zoo models`         | List available models      |
| `zoo mcp`            | Manage MCP servers         |
| `zoo session list`   | List sessions              |
| `zoo session delete` | Delete a session           |
| `zoo export`         | Export session transcripts |

Run `zoo --help` for the full list.

## Configuration paths

Zoo Code reads and writes its primary global config at `~/.config/zoo-code/zoo.jsonc` and project config at `{project}/zoo.jsonc`.
Project rules live in `{project}/.zoo/rules/*.md`, project modes in `{project}/.zoo/modes/*.json`, and file access ignore patterns in `{project}/.zooignore`.
Legacy Kilo/OpenCode paths may still be read as lower-priority migration fallbacks.

## Alternative Installation

### Homebrew (macOS/Linux)

```bash
brew install Zoo-Code-Org/tap/zoo
```

### GitHub Releases

Download pre-built binaries from the [Releases page](https://github.com/Zoo-Code-Org/zoocode/releases).

## Documentation

- [Docs](https://zoo-code.ai/docs)
- [Getting Started](https://zoo-code.ai/docs/getting-started)

## Links

- [GitHub](https://github.com/Zoo-Code-Org/zoocode)
- [Discord](https://zoo-code.ai/discord)
- [VS Code Extension](https://zoo-code.ai/vscode-marketplace)
- [Website](https://zoo-code.ai)

## License

MIT
