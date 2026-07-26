# @roo-code/cli

Command Line Interface for Roo Code - Run the Roo Code agent from the terminal without VSCode.

## Overview

This CLI uses the `@roo-code/vscode-shim` package to provide a VSCode API compatibility layer, allowing the main Roo Code extension to run in a Node.js environment.

## Installation

### Quick Install (Recommended)

Install the Roo Code CLI with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/apps/cli/install.sh | sh
```

**Requirements:**

- Node.js 20 or higher
- macOS Apple Silicon (M1/M2/M3/M4) or Linux x64

**Custom installation directory:**

```bash
ROO_INSTALL_DIR=/opt/roo-code ROO_BIN_DIR=/usr/local/bin curl -fsSL ... | sh
```

**Install a specific version:**

```bash
ROO_VERSION=0.1.0 curl -fsSL https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/apps/cli/install.sh | sh
```

### Updating

Re-run the install script to update to the latest version:

```bash
curl -fsSL https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/apps/cli/install.sh | sh
```

Or run:

```bash
roo upgrade
```

### Uninstalling

```bash
rm -rf ~/.roo/cli ~/.local/bin/roo
```

### Development Installation

For contributing or development:

```bash
# From the monorepo root.
pnpm install

# Build the main extension first.
pnpm --filter ./src bundle

# Build the CLI.
pnpm --filter @roo-code/cli build
```

## Usage

### Interactive Mode (Default)

By default, the CLI auto-approves actions and runs in interactive TUI mode:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...

roo "What is this project?" -w ~/Documents/my-project
```

You can also run without a prompt and enter it interactively in TUI mode:

```bash
roo -w ~/Documents/my-project
```

In interactive mode:

- Tool executions are auto-approved
- Commands are auto-approved
- Followup questions show suggestions with a 60-second timeout, then auto-select the first suggestion
- Browser and MCP actions are auto-approved

### Approval-Required Mode (`--require-approval`)

If you want manual approval prompts, enable approval-required mode:

```bash
roo "Refactor the utils.ts file" --require-approval -w ~/Documents/my-project
```

In approval-required mode:

- Tool, command, browser, and MCP actions prompt for yes/no approval
- Followup questions wait for manual input (no auto-timeout)

### Print Mode (`--print`)

Use `--print` for non-interactive execution and machine-readable output:

```bash
# Prompt is required
roo --print "Summarize this repository"

# Create a new task with a specific session ID (UUID)
roo --print --create-with-session-id 018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87 "Summarize this repository"
```

### Autonomous Orchestrator Draft (`--autonomous`)

> **Danger:** This profile gives the agent unrestricted authority to read and write inside or outside the workspace, modify protected configuration, execute any command, call any configured MCP tool, switch child modes, create subtasks, and accept completion. Run it only in an environment where the selected workspace, configuration, commands, MCP servers, and provider are fully trusted. It does not change VS Code or normal interactive CLI approval behavior.

Every new autonomous root starts in the effective `orchestrator` mode. A project `.roomodes` definition with the `orchestrator` slug overrides the global custom definition, which overrides the built-in definition, following normal Zoo Code precedence. `--mode` and `--require-approval` are rejected for autonomous roots. Child mode selection remains available to the existing `new_task` engine.

```bash
export OPENROUTER_API_KEY=sk-or-v1-...

roo --autonomous --print \
  --workspace /absolute/path/to/project \
  --timeout 3600 \
  --output-format stream-json \
  "Implement the task and verify it"
```

`--workspace` and `--timeout` are required. The workspace is resolved to its canonical filesystem path before activation. One process owns one root task tree; stdin multi-root stream mode is intentionally unavailable with this profile.

The real extension bundle remains the agent engine:

- `switch_mode` changes the mode in the same task and preserves its conversation.
- `new_task` persists the parent and creates a fresh child context.
- Child completion resumes the original parent with the child result and does not exit the process.
- Only an accepted `attempt_completion` event for the root task exits successfully. No implicit validation command is added.
- `--session-id` and `--continue` use persisted task history. A resumed task retains its persisted mode and context; a newly created autonomous root always starts as Orchestrator.
- The first `SIGINT` or `SIGTERM` cooperatively aborts and settles persistence. A second signal force-terminates.

#### Portable Configuration

The selected workspace is used by the existing runtime to load `.roomodes`, `.roo/mcp.json`, `.roo/rules*`, legacy rule fallbacks, and root `AGENTS.md`/`AGENT.md` plus `AGENTS.local.md`. Global rules remain under `~/.roo/rules*`. Shim-backed global custom modes and MCP settings use `~/.vscode-mock/global-storage/settings/custom_modes.yaml` and `~/.vscode-mock/global-storage/settings/mcp_settings.json`; project definitions take precedence where Zoo Code normally gives them precedence. Configuration is loaded before the first task starts. Long-running file-watcher reloads are not supported by the shim, so restart the process after changing these files.

Credentials must be supplied with `--api-key` or the provider environment variable. This standalone process does not inspect or import native VS Code settings databases, profiles, OAuth state, or encrypted `SecretStorage`. Its own persisted history and shim state can contain sensitive prompts, outputs, and settings and should be protected accordingly.

#### Headless Capability Boundary

Headless filesystem reads/writes, protected-file edits, command execution through Execa, ripgrep search, configured MCP transports, mode switching, subtasks, persistence, and provider HTTP streams are supported. There is no interactive VS Code window. Editor selections/tabs, live diagnostics, visual diff UI, VS Code terminal shell integration, VS Code Language Models, native VS Code authentication/URI callbacks, clipboard UI, and reliable VS Code file-watcher semantics are unsupported. Required questions without a defined automatic answer terminate instead of selecting a suggestion or sending an empty answer.

#### Terminal Outcomes

Machine-readable modes emit exactly one final `result` with `subtype: "terminal"`, `state`, `exitCode`, and the root task ID when available. Progress remains NDJSON in `stream-json`; extension debug logs do not go to stdout.

| State                 | Exit | Meaning                                                     |
| --------------------- | ---: | ----------------------------------------------------------- |
| `completed`           |    0 | Accepted root completion after descendant resumption        |
| `needs_input`         |    2 | A question has no defined autonomous answer                 |
| `provider_failed`     |    4 | Provider request failed or retry would require intervention |
| `tool_failed`         |    5 | A host/tool failure prevents continuation                   |
| `cancelled`           |    6 | Explicit non-signal cancellation                            |
| `cancelled`           |  130 | `SIGINT` after cooperative persistence settlement           |
| `cancelled`           |  143 | `SIGTERM` after cooperative persistence settlement          |
| `timed_out`           |  124 | Root-tree wall-clock timeout                                |
| `configuration_error` |   78 | Invalid workspace, flags, credentials, or configuration     |
| `crashed`             |   70 | Unexpected internal failure                                 |

The non-billable process smoke starts a local fake OpenRouter-compatible server and disposable workspaces. It verifies custom Orchestrator/rule precedence, mode switching, delegation/resumption, questions, provider failure, timeout, cancellation, and parseable terminal output:

```bash
pnpm --filter ./src bundle
pnpm --filter @roo-code/cli build
pnpm --filter @roo-code/cli test:autonomous-process
```

### Stdin Stream Mode (`--stdin-prompt-stream`)

For programmatic control (one process, multiple prompts), use `--stdin-prompt-stream` with `--print`.
Send NDJSON commands via stdin:

```bash
printf '{"command":"start","requestId":"1","prompt":"1+1=?"}\n' | roo --print --stdin-prompt-stream --output-format stream-json

# Optional: provide taskId per start command
printf '{"command":"start","requestId":"1","taskId":"018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87","prompt":"1+1=?"}\n' | roo --print --stdin-prompt-stream --output-format stream-json
```

### Legacy Roo Auth Token Cleanup

Normal CLI usage is login-free. Use `--provider` with your own API key, or set the provider environment variable directly.

Roo Code Router has been removed from the CLI. The remaining `auth` commands only help inspect or delete any legacy Roo auth token still stored from older releases:

```bash
# Check whether a legacy Roo auth token is still stored
roo auth status

# Remove an old stored Roo auth token
roo auth logout
```

If you never used Roo Code Router, you can ignore this section entirely.

## Options

| Option                                  | Description                                                                             | Default                     |
| --------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------- |
| `[prompt]`                              | Your prompt (positional argument, optional)                                             | None                        |
| `--prompt-file <path>`                  | Read prompt from a file instead of command line argument                                | None                        |
| `--create-with-session-id <session-id>` | Create a new task using the provided session ID (UUID)                                  | None                        |
| `-w, --workspace <path>`                | Workspace path to operate in                                                            | Current directory           |
| `-p, --print`                           | Print response and exit (non-interactive mode)                                          | `false`                     |
| `--stdin-prompt-stream`                 | Read NDJSON control commands from stdin (requires `--print`)                            | `false`                     |
| `-e, --extension <path>`                | Path to the extension bundle directory                                                  | Auto-detected               |
| `-d, --debug`                           | Enable debug output (includes detailed debug information, prompts, paths, etc)          | `false`                     |
| `-a, --require-approval`                | Require manual approval before actions execute                                          | `false`                     |
| `--autonomous`                          | Dangerous unrestricted headless Orchestrator profile (requires `--print`)               | `false`                     |
| `--timeout <seconds>`                   | Required wall-clock deadline for an autonomous root tree                                | None                        |
| `-k, --api-key <key>`                   | API key for the LLM provider                                                            | From env var                |
| `--provider <provider>`                 | API provider (anthropic, openai-native, gemini, openrouter, vercel-ai-gateway)          | `openrouter`                |
| `--provider-base-url <url>`             | OpenRouter-compatible endpoint override                                                 | Provider default            |
| `-m, --model <model>`                   | Model to use                                                                            | `anthropic/claude-opus-4.6` |
| `--mode <mode>`                         | Mode to start in (code, architect, ask, debug, etc.)                                    | `code`                      |
| `--terminal-shell <path>`               | Absolute shell path for inline terminal command execution                               | Auto-detected shell         |
| `-r, --reasoning-effort <effort>`       | Reasoning effort level (unspecified, disabled, none, minimal, low, medium, high, xhigh) | `medium`                    |
| `--consecutive-mistake-limit <n>`       | Consecutive error/repetition limit before guidance prompt (`0` disables the limit)      | `10`                        |
| `--ephemeral`                           | Run without persisting state (uses temporary storage)                                   | `false`                     |
| `--oneshot`                             | Exit upon task completion                                                               | `false`                     |
| `--output-format <format>`              | Output format with `--print`: `text`, `json`, or `stream-json`                          | `text`                      |

## Auth Commands

| Command           | Description                          |
| ----------------- | ------------------------------------ |
| `roo auth logout` | Clear a stored legacy Roo auth token |
| `roo auth status` | Show legacy Roo token status         |

## Environment Variables

The CLI will look for API keys in environment variables if not provided via `--api-key`:

| Provider          | Environment Variable        |
| ----------------- | --------------------------- |
| anthropic         | `ANTHROPIC_API_KEY`         |
| openai-native     | `OPENAI_API_KEY`            |
| openrouter        | `OPENROUTER_API_KEY`        |
| gemini            | `GOOGLE_API_KEY`            |
| vercel-ai-gateway | `VERCEL_AI_GATEWAY_API_KEY` |

## Architecture

```
┌─────────────────┐
│   CLI Entry     │
│   (index.ts)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  ExtensionHost  │
│  (extension-    │
│   host.ts)      │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌───────┐  ┌──────────┐
│vscode │  │Extension │
│-shim  │  │ Bundle   │
└───────┘  └──────────┘
```

## How It Works

1. **CLI Entry Point** (`index.ts`): Parses command line arguments and initializes the ExtensionHost

2. **ExtensionHost** (`extension-host.ts`):

    - Creates a VSCode API mock using `@roo-code/vscode-shim`
    - Intercepts `require('vscode')` to return the mock
    - Loads and activates the extension bundle
    - Manages bidirectional message flow

3. **Message Flow**:
    - CLI → Extension: `emit("webviewMessage", {...})`
    - Extension → CLI: `emit("extensionWebviewMessage", {...})`

## Development

```bash
# Run directly from source (no build required)
pnpm dev --provider openrouter --api-key $OPENROUTER_API_KEY --print "Hello"

# Run tests
pnpm test

# Type checking
pnpm check-types

# Linting
pnpm lint
```

By default the dev script still points `ROO_CODE_PROVIDER_URL` at `http://localhost:8080/proxy` for local extension-host development. The CLI provider selection itself should use a non-Router provider such as OpenRouter. To point the backend URL at production instead, override the environment variable:

```bash
ROO_CODE_PROVIDER_URL=https://api.roocode.com/proxy pnpm dev --provider openrouter --api-key $OPENROUTER_API_KEY --print "Hello"
```

## Releasing

Official releases are created via the GitHub Actions workflow at `.github/workflows/cli-release.yml`.

To trigger a release:

1. Go to **Actions** → **CLI Release**
2. Click **Run workflow**
3. Optionally specify a version (defaults to `package.json` version)
4. Click **Run workflow**

The workflow will:

1. Build the CLI on all platforms (macOS Apple Silicon, Linux x64)
2. Create platform-specific tarballs with bundled ripgrep
3. Verify each tarball
4. Create a GitHub release with all tarballs attached

### Local Builds

For local development and testing, use the build script:

```bash
# Build tarball for your current platform
./apps/cli/scripts/build.sh

# Build and install locally
./apps/cli/scripts/build.sh --install

# Fast build (skip verification)
./apps/cli/scripts/build.sh --skip-verify
```
