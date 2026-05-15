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

Include explicit file or folder context in a one-off task:

```bash
zoo run --context src/auth.ts --context docs/ "explain the login flow"
```

## Features

- **Code generation** -- describe what you want in natural language
- **Terminal commands** -- the agent can run shell commands on your behalf
- **500+ AI models** -- use models from OpenAI, Anthropic, Google, and more
- **MCP servers** -- extend agent capabilities with the Model Context Protocol
- **Multiple modes** -- Plan with Architect, code with Coder, debug with Debugger, or create your own
- **Sessions** -- resume previous conversations and export transcripts
- **Bring your own keys** -- Zoo Code CLI has no built-in inference provider; configure one of the providers listed from `models.dev`

## Providers

Zoo Code CLI uses the same `models.dev` provider catalog and onboarding pattern as OpenCode. Run `zoo models` to inspect available providers and models, then authenticate or configure the provider you want to use with your own credentials.

Zoo Code does not provide a bundled Zoo inference gateway or credit-backed model provider. Kilo gateway and indexing integrations are intentionally disabled in this package.

OpenAI-compatible providers can be configured directly in `zoo.jsonc`, including local/proxy providers such as Ollama `/v1`, LM Studio, LiteLLM, Unbound, and SambaNova. Catalog-backed OpenAI-compatible providers such as Requesty, Baseten, Poe, and LM Studio are loaded from the bundled `models.dev` snapshot when available.

See `docs/provider-parity.md` for the current Zoo/Roo VS Code provider parity audit.

## Commands

| Command                   | Description                              |
| ------------------------- | ---------------------------------------- |
| `zoo`                     | Launch interactive TUI                   |
| `zoo run "<task>"`        | Run a one-off task                       |
| `zoo server --ipc <path>` | Start a local IPC server for SDK clients |
| `zoo auth`                | Manage authentication                    |
| `zoo models`              | List available models                    |
| `zoo agent`               | List available agents/modes              |
| `zoo mcp`                 | Manage MCP servers                       |
| `zoo session list`        | List sessions                            |
| `zoo session delete`      | Delete a session                         |
| `zoo export`              | Export session transcripts               |

Run `zoo --help` for the full list.

For scripting, `zoo agent list --format json` emits a stable JSON array with public agent metadata and structured permissions.

## Configuration paths

Zoo Code reads and writes its primary global config at `~/.config/zoo-code/zoo.jsonc` and project config at `{project}/zoo.jsonc`.
Project rules live in `{project}/.zoo/rules/*.md`, project modes in `{project}/.zoo/modes/*.json`, and file access ignore patterns in `{project}/.zooignore`.
Legacy Kilo/OpenCode paths may still be read as lower-priority migration fallbacks.

## Roo/Zoo portable config migration

Migration is additive: Zoo Code reads the new portable locations without deleting existing Roo configuration. Move shared team settings into Zoo files when you are ready.

| Old/source location               | Zoo portable target                                                          |
| --------------------------------- | ---------------------------------------------------------------------------- |
| VS Code provider/profile settings | `~/.config/zoo-code/zoo.jsonc` for user defaults or `{project}/zoo.jsonc`    |
| Project config                    | `{project}/zoo.jsonc`                                                        |
| Roo project modes / `.roomodes`   | `{project}/.zoo/modes/*.json`; `.roomodes` remains a lower-priority fallback |
| Project rules                     | `{project}/.zoo/rules/*.md`                                                  |
| Ignore patterns                   | `{project}/.zooignore`                                                       |
| Project instructions              | `{project}/AGENTS.md`                                                        |

Portable provider config is managed in `zoo.jsonc`. For example:

```jsonc
{
	"provider": {
		"openai": {
			"npm": "@ai-sdk/openai",
			"models": {
				"gpt-5.5": {},
			},
		},
	},
	"model": "openai/gpt-5.5",
}
```

Modes can be split into files such as `{project}/.zoo/modes/architect.json`:

```json
{
	"name": "architect",
	"mode": "primary",
	"description": "Plan architecture and migrations"
}
```

`.zoo/modes/*.json` takes precedence over `.roomodes` for duplicate mode slugs. `.zooignore` uses gitignore-style patterns, including `!` negation, to shape file access permissions.

## Modes

Zoo Code CLI supports custom modes from `{project}/.zoo/modes/*.json` and reads existing `{project}/.roomodes` files during Roo/Zoo migration. Use `zoo run --mode <name> "<task>"` or `zoo --mode <name>` to select a mode; invalid mode names fail with an actionable error.

## Context

Use `zoo run --context <path>` to include files or folders as context for a one-off task. Folder context uses the existing portable-core directory reader semantics, which summarize the directory and inline supported top-level files.

## Project Instructions And Rules

Zoo Code CLI loads `{project}/AGENTS.md` as project instructions and `{project}/.zoo/rules/*.md` as rule files for agent sessions. Rules are loaded in deterministic filename order after AGENTS instructions; missing files and empty rules directories are ignored.

## Build And Test

The default package build runs the current-platform binary build and smoke-tests `zoo --version`:

```bash
pnpm --filter @zoo-code/cli build
```

`test` runs the fast focused utility subset. `test:opencode` runs the broader imported OpenCode/Kilo test suite through the isolated runner. The broader suite intentionally quarantines imported tests that assert removed Kilo gateway/indexing behavior, legacy Kilo config precedence, or unresolved upstream-only release assumptions.

```bash
pnpm --filter @zoo-code/cli test
pnpm --filter @zoo-code/cli test:opencode
pnpm --filter @zoo-code/cli check-types
```

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
