# Zoo Code CLI

The `zoo` executable runs the production Zoo Code extension in a private supervised host. It does not contain a second agent loop. Existing `.roo`, `.roomodes`, `.rooignore`, `AGENTS.md`, rules, skills, custom tools, and MCP configuration keep their extension semantics.

## Installation

Zoo CLI requires Node.js 22.23.1. Supported release artifacts are macOS ARM64, Linux x64, and Linux ARM64.

```sh
npm install --global @zoo-code/cli
zoo --version
```

Platform tarballs contain `bin/zoo`; add that directory to `PATH`. Windows, macOS x64, Linux musl, and older CPU baseline packages are not currently supported.

## Quick Start

Start the interactive terminal UI in the current workspace:

```sh
zoo
zoo "explain this repository"
```

Run explicit automation:

```sh
zoo run "run the focused tests" --approval safe
zoo run "summarize the project" --format json
zoo run "fix the reported bug" --format stream-json > events.ndjson
printf '%s\n' "review this workspace" | zoo run --format text
```

Resume and inspect workspace-scoped history:

```sh
zoo sessions list
zoo sessions list --format json -C ./project
zoo resume
zoo resume 019abc --format json
```

Run `zoo --help`, `zoo run --help`, or `zoo resume --help` for live option reference. A positional prompt and piped prompt cannot be combined. Root `zoo` always requires TTY stdin and stdout; redirection never changes approval policy.

## Selection And Credentials

Run selections are invocation-local:

```sh
zoo run "investigate" --provider anthropic --model claude-sonnet-4-20250514 --mode debug
zoo run "review" --profile work --reasoning-effort high
```

`--provider` conflicts with `--profile`. Explicit invalid providers, profiles, models, modes, sessions, workspaces, and durations fail instead of falling back.

Automation can read provider credentials from the provider's documented environment variable. Persisted credentials are accessed only through the operating-system vault adapter: macOS Keychain or Linux Secret Service. Secrets are never written to shim JSON, accepted as command-line flags, or included in events and diagnostics. Unsupported OAuth flows must be completed through a supported environment or vault setup.

Precedence is invocation override, invocation environment credential, selected vault profile, canonical project configuration, CLI state, then product default. CLI state is under `~/.zoo`; VS Code and inherited Roo CLI storage are not imported implicitly.

## Approvals And Threat Model

| Mode          | Use                          | Unresolved `ask`                       |
| ------------- | ---------------------------- | -------------------------------------- |
| `interactive` | TTY UI                       | Prompt the user                        |
| `safe`        | Default automation           | Return resumable `needs_input`, exit 3 |
| `auto`        | Explicit unattended autonomy | Approve eligible asks only             |

`auto` is powerful and should only run in a workspace and account you trust. It never overrides explicit command denials, protected-file policy, outside-workspace restrictions, organization policy, destructive-command boundaries, mode restrictions, or MCP restrictions. Follow-up questions are not answered with invented text.

Tool arguments, terminal output, MCP payloads, errors, debug diagnostics, and final content pass through bounded redaction before rendering. Project files cannot expand access beyond canonical trust boundaries.

## Output Contracts

### Text

`--format text` is append-only and suitable for logs. It shows initialization, assistant/reasoning activity, tools, approvals, terminal and MCP activity, delegation, warnings, and the final result. `--quiet` emits only the final content or failure.

### Final JSON

`--format json` writes exactly one compact `zoo-run-result` object to stdout. Diagnostics go to stderr. Important fields are `schemaVersion`, `success`, `outcome`, root/current task IDs, workspace, resumability, content or stable error, usage/cost, elapsed time, and changed files.

### Streaming JSON

`--format stream-json` writes newline-delimited `zoo-stream` v1 records. The first record is `system.init`; each record has a monotonic `seq`, timestamp, and host identity. Deltas reconstruct ordered output. Exactly one authoritative-root `task.result` is terminal. stdout contains no ANSI or human diagnostics. `--quiet` is intentionally incompatible.

Breaking machine-schema changes increment the major schema version. Additive optional fields retain it. Unknown visible activity is represented generically rather than silently discarded.

## Outcomes And Exit Codes

| Outcome                            | Exit |
| ---------------------------------- | ---: |
| Completed                          |    0 |
| Usage or configuration             |    2 |
| Needs input                        |    3 |
| Explicit cancellation              |    4 |
| Provider failure                   |   10 |
| Runtime, host, or protocol failure |   70 |
| Timeout                            |  124 |
| SIGINT                             |  130 |
| SIGTERM                            |  143 |

Stable errors include invalid selection/workspace/session, missing credentials, permission denial, provider failure, host startup/crash, incompatible protocol, sequence gap, cancellation failure, cleanup timeout, task timeout, and closed output.

## Sessions, Signals, And Ephemeral Runs

Sessions are scoped to the canonical real path of `-C/--cwd`. `zoo resume` selects the latest root for that workspace; an ID must belong to the same workspace. Delegated histories retain root/current identity.

The first Ctrl+C requests canonical cancellation and waits for interrupted history to settle. A second Ctrl+C escalates cleanup. SIGTERM follows bounded graceful cancellation. `--timeout 10m` is a parent-owned whole-invocation deadline covering startup, history, acceptance, execution, cancellation, flush, and shutdown. Broken stdout triggers cancellation without a stack trace.

`--ephemeral` creates isolated temporary storage and removes it after success, error, signal, or timeout. Its session cannot be resumed after exit. It does not weaken project rules or approvals.

## Supported And Unsupported Capabilities

The CLI preserves canonical modes, rules, `.rooignore`, instructions, tools, MCP startup, histories, delegation, cancellation, terminal execution, and accepted root completion. Editor tabs, selections, decorations, diff UI, terminal panels, browser automation, and checkpoints are unavailable. The CLI does not expose config/profile mutation, auth management, MCP management, session mutation/import/export, cloud/daemon/remote control, worktrees, schedules, or a public long-lived stdin protocol.

`modes list` and `models list` are also withheld in this release: the current canonical queries activate mutable extension services, so they do not yet meet the side-effect-free metadata requirement.

## Coexistence With `roo`

The inherited `roo` executable remains intact during migration. `zoo` uses `~/.zoo`; it does not read or mutate inherited CLI state. Project `.roo*` files remain canonical and are shared by design. No history or plaintext-secret migration occurs automatically.

## Troubleshooting

- Run `zoo --version` to report the client/build contract.
- Use `--debug` for bounded redacted host diagnostics on stderr.
- Verify the effective `-C` workspace when a session is not found.
- A `needs_input` result is expected under safe approval; resume interactively to answer it.
- A host/protocol failure exits 70 and never contaminates JSON stdout.
- Timeout or signal cleanup is bounded; no host, shell, MCP, index, terminal, or watcher should survive.
- If vault access fails, verify Keychain or Secret Service availability, or use an invocation environment credential.
