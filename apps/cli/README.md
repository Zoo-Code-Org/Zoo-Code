# @zoo-code/legacy-cli

Command Line Interface for Zoo Code - Run the Zoo Code agent from the terminal without VS Code.

## Overview

This CLI uses the `@zoo-code/vscode-shim` package to provide a VS Code API compatibility layer, allowing the main Zoo Code extension to run in a Node.js environment.

## Installation

### Quick Install (Recommended)

Install the Zoo Code CLI with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/Zoo-Code-Org/Zoo-Code/main/apps/cli/install.sh | sh
```

**Requirements:**

- Node.js 20 or higher
- macOS Apple Silicon (M1/M2/M3/M4) or Linux x64

**Custom installation directory:**

```bash
ZOO_INSTALL_DIR=/opt/zoo-code ZOO_BIN_DIR=/usr/local/bin curl -fsSL ... | sh
```

**Install a specific version:**

```bash
ZOO_VERSION=0.1.0 curl -fsSL https://raw.githubusercontent.com/Zoo-Code-Org/Zoo-Code/main/apps/cli/install.sh | sh
```

### Updating

Re-run the install script to update to the latest version:

```bash
curl -fsSL https://raw.githubusercontent.com/Zoo-Code-Org/Zoo-Code/main/apps/cli/install.sh | sh
```

Or run:

```bash
zoo-legacy upgrade
```

### Uninstalling

```bash
rm -rf ~/.zoo/cli ~/.local/bin/zoo-legacy
```

### Development Installation

For contributing or development:

```bash
# From the monorepo root.
pnpm install

# Build the main extension first.
pnpm --filter ./src bundle

# Build the CLI.
pnpm --filter @zoo-code/legacy-cli build
```

## Usage

### Interactive Mode (Default)

By default, the CLI auto-approves actions and runs in interactive TUI mode:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...

zoo-legacy "What is this project?" -w ~/Documents/my-project
```

You can also run without a prompt and enter it interactively in TUI mode:

```bash
zoo-legacy -w ~/Documents/my-project
```

In interactive mode:

- Tool executions are auto-approved
- Commands are auto-approved
- Followup questions show suggestions with a 60-second timeout, then auto-select the first suggestion
- Browser and MCP actions are auto-approved

### Approval-Required Mode (`--require-approval`)

If you want manual approval prompts, enable approval-required mode:

```bash
zoo-legacy "Refactor the utils.ts file" --require-approval -w ~/Documents/my-project
```

In approval-required mode:

- Tool, command, browser, and MCP actions prompt for yes/no approval
- Followup questions wait for manual input (no auto-timeout)

### Print Mode (`--print`)

Use `--print` for non-interactive execution and machine-readable output:

```bash
# Prompt is required
zoo-legacy --print "Summarize this repository"

# Create a new task with a specific session ID (UUID)
zoo-legacy --print --create-with-session-id 018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87 "Summarize this repository"
```

### Stdin Stream Mode (`--stdin-prompt-stream`)

For programmatic control (one process, multiple prompts), use `--stdin-prompt-stream` with `--print`.
Send NDJSON commands via stdin:

```bash
printf '{"command":"start","requestId":"1","prompt":"1+1=?"}\n' | zoo-legacy --print --stdin-prompt-stream --output-format stream-json

# Optional: provide taskId per start command
printf '{"command":"start","requestId":"1","taskId":"018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87","prompt":"1+1=?"}\n' | zoo-legacy --print --stdin-prompt-stream --output-format stream-json
```

### Legacy Roo Auth Token Cleanup

Normal CLI usage is login-free. Use `--provider` with your own API key, or set the provider environment variable directly.

Roo Code Router has been removed from the CLI. The remaining `auth` commands only help inspect or delete any legacy Roo auth token still stored from older releases:

```bash
# Check whether a legacy Roo auth token is still stored
zoo-legacy auth status

# Remove an old stored Roo auth token
zoo-legacy auth logout
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
| `-k, --api-key <key>`                   | API key for the LLM provider                                                            | From env var                |
| `--provider <provider>`                 | API provider (anthropic, openai-native, gemini, openrouter, vercel-ai-gateway)          | `openrouter`                |
| `-m, --model <model>`                   | Model to use                                                                            | `anthropic/claude-opus-4.6` |
| `--mode <mode>`                         | Mode to start in (code, architect, ask, debug, etc.)                                    | `code`                      |
| `--terminal-shell <path>`               | Absolute shell path for inline terminal command execution                               | Auto-detected shell         |
| `-r, --reasoning-effort <effort>`       | Reasoning effort level (unspecified, disabled, none, minimal, low, medium, high, xhigh) | `medium`                    |
| `--consecutive-mistake-limit <n>`       | Consecutive error/repetition limit before guidance prompt (`0` disables the limit)      | `10`                        |
| `--ephemeral`                           | Run without persisting state (uses temporary storage)                                   | `false`                     |
| `--oneshot`                             | Exit upon task completion                                                               | `false`                     |
| `--output-format <format>`              | Output format with `--print`: `text`, `json`, or `stream-json`                          | `text`                      |

## Auth Commands

| Command                  | Description                          |
| ------------------------ | ------------------------------------ |
| `zoo-legacy auth logout` | Clear a stored legacy Roo auth token |
| `zoo-legacy auth status` | Show legacy Roo token status         |

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

    - Creates a VSCode API mock using `@zoo-code/vscode-shim`
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

By default the dev script still points `ZOO_CODE_PROVIDER_URL` at `http://localhost:8080/proxy` for local extension-host development. The CLI provider selection itself should use a non-Router provider such as OpenRouter. To point the backend URL at production instead, override the environment variable:

```bash
ZOO_CODE_PROVIDER_URL=https://api.zoocode.com/proxy pnpm dev --provider openrouter --api-key $OPENROUTER_API_KEY --print "Hello"
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
