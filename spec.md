# Zoo Code CLI Integration Spec
## Integrating an OpenCode-Based CLI Core into Zoo Code for VS Code + CLI Feature Parity

**Version:** 0.1  
**Status:** Draft  
**Purpose:** Agent-ready dev plan spec for forking Zoo Code, integrating a Kilo-Code-style OpenCode CLI fork, and achieving feature parity between the Zoo Code VS Code extension and the Zoo Code CLI.

---

## 1. Executive Summary

Zoo Code is a fork of Roo Code — a VS Code extension built as a single-package TypeScript monorepo with a `src/` extension host, a `webview-ui/` React UI, and shared `packages/` libraries. It has no CLI surface today.

Kilo Code solved the same problem (adding a CLI surface to a VS Code AI coding agent) by forking OpenCode's CLI/server as a "portable core" and rebuilding the VS Code extension to run on top of that shared core. The VS Code extension and CLI both consume the same agent runtime, config model, provider stack, and session store — achieving behavioral parity for free while keeping host-specific UX in its own package.

This spec describes the work required to replicate that architecture in Zoo Code:

1. Fork and rebrand `Kilo-Org/kilocode`'s `packages/opencode` as `packages/zoo-cli` — the OpenCode-derived portable agent core.
2. Migrate the Zoo Code VS Code extension to run on top of that portable core via a Zoo SDK package, the same way `packages/kilo-vscode` consumes `@kilocode/sdk`.
3. Define the shared config model, session model, and provider abstraction so both CLI and extension behave identically for core agent operations.
4. Enumerate the intentional host-divergence points: VS Code-only UX and CLI-only integrations.

The result is a Zoo Code monorepo structured like Kilo's: `packages/zoo-cli` (portable core), `packages/zoo-sdk` (JS SDK), `packages/zoo-vscode` (VS Code extension), and optional shared UI packages.

---

## 2. Current State Analysis

### 2.1 Zoo Code Repo Structure (as of fork point)

```
Zoo-Code/
├── src/                    ← Extension host TypeScript (VS Code API)
├── webview-ui/             ← React webview UI
├── packages/               ← Shared libs (types, utils, schemas)
├── apps/                   ← Additional app targets
├── locales/                ← i18n JSON
├── schemas/                ← JSON schema for config
├── scripts/                ← Build / release scripts
├── .roo/                   ← Roo system prompt directory
├── .roomodes               ← Roo mode definitions
├── .rooignore              ← Roo ignore file
├── AGENTS.md               ← OpenCode-style AGENTS instruction file
├── package.json            ← Root workspace (pnpm + turbo)
├── pnpm-workspace.yaml
└── turbo.json
```

**Key observations:**
- All agent logic lives in `src/` as VS Code extension host code — tightly coupled to the VS Code API.
- No CLI entrypoint exists. All agent orchestration runs inside VS Code's extension process.
- `AGENTS.md` at root indicates the team is already tracking OpenCode's config conventions.
- The `.roo/`, `.roomodes`, and `.rooignore` files are Roo Code artifacts (Zoo Code's upstream).
- The monorepo toolchain is `pnpm` + `turbo`, which is compatible with how Kilo's monorepo is structured but differs from Kilo's use of `bun`.

### 2.2 OpenCode CLI Fork (Kilo `packages/opencode` / `@kilocode/cli`)

Kilo's portable core provides:
- HTTP/IPC server exposing a session-oriented agent API
- Multi-provider model registry (OpenAI, Anthropic, Google, OpenRouter, local providers)
- Tool execution engine (file read/write, bash, browser, LSP)
- Subagent and parallel execution framework
- Worktree management
- Config system: `~/.config/{brand}/{brand}.jsonc` (global) + `./{brand}.jsonc` (project)
- AGENTS.md / rules file ingestion
- Session persistence (SQLite or file-based)
- TUI for terminal use

The VS Code extension (`packages/kilo-vscode`) communicates with this core via `@kilocode/sdk`, which wraps the local IPC/HTTP server the CLI spins up. The extension embeds the CLI binary using a `prepare:cli-binary` build script.

### 2.3 Architectural Gap

| Dimension | Zoo Code Today | Target State |
|---|---|---|
| Agent runtime | VS Code extension host only | Portable core (`packages/zoo-cli`) usable in both CLI and VS Code |
| CLI surface | None | `zoo` / `zoo-code` binary from `packages/zoo-cli` |
| Config model | Extension settings (`settings.json`) + `.roo/` directory | Shared `zoo.jsonc` (global + project) + `AGENTS.md` + `.zoo/` rules directory |
| Session model | In-memory, VS Code process lifetime | Persistent sessions shared between CLI and extension |
| Provider stack | Bundled in extension host | Shared provider package consumed by CLI and extension |
| Webview UI | React in `webview-ui/` | Retain React webview, rewire to consume SDK instead of direct extension host calls |

---

## 3. Target Architecture

```
zoo-code/  (renamed/rebranded fork)
├── packages/
│   ├── zoo-cli/            ← OpenCode-derived portable core (agent runtime + CLI + TUI)
│   │   ├── src/
│   │   │   ├── server/     ← HTTP/IPC server (session API)
│   │   │   ├── agent/      ← Core agent loop, tool registry, subagent coordination
│   │   │   ├── providers/  ← Model provider abstraction (all provider impls here)
│   │   │   ├── tools/      ← File, bash, browser, LSP, MCP tool implementations
│   │   │   ├── session/    ← Session store, persistence, worktree integration
│   │   │   ├── config/     ← zoo.jsonc loader, AGENTS.md parser, .zoo/ rules
│   │   │   └── tui/        ← Terminal UI (Ink or OpenCode TUI framework)
│   │   └── package.json    ← name: "@zoo-code/cli", bin: { zoo, zoo-code }
│   │
│   ├── zoo-sdk/            ← JS/TS SDK wrapping the CLI's local server API
│   │   ├── src/
│   │   │   ├── client.ts   ← HTTP/IPC client (connects to zoo-cli server)
│   │   │   ├── types.ts    ← Shared types (Session, Message, Tool, Provider, etc.)
│   │   │   └── index.ts
│   │   └── package.json    ← name: "@zoo-code/sdk"
│   │
│   ├── zoo-vscode/         ← VS Code extension (thin host adapter over zoo-sdk)
│   │   ├── src/            ← Extension host TS (VS Code API, commands, webview bridge)
│   │   ├── webview-ui/     ← Webview React app (rewired to use zoo-sdk via message bridge)
│   │   └── package.json    ← name: "zoo-code" (VS Code publisher)
│   │
│   └── zoo-ui/             ← (optional) Shared UI components (SolidJS or React)
│       └── package.json    ← name: "@zoo-code/ui"
│
├── AGENTS.md               ← Root AGENTS instruction file
├── .zoo/                   ← Project-level Zoo rules/modes directory
├── pnpm-workspace.yaml
└── turbo.json
```

### 3.1 Data Flow: VS Code Extension ↔ Portable Core

```
┌─────────────────────────────────────┐
│         VS Code Extension Host      │
│  ┌─────────────────────────────┐    │
│  │   zoo-vscode/src/           │    │
│  │   - SidebarProvider         │    │
│  │   - Commands/Keybindings    │    │  spawns / connects via IPC
│  │   - Webview Bridge          │────┼──────────────────────────────►  zoo-cli
│  └─────────────────────────────┘    │                                 HTTP/IPC server
│  ┌─────────────────────────────┐    │                                 (agent runtime)
│  │   webview-ui/ (React)       │◄───┼── postMessage bridge            │
│  │   - Chat UI                 │    │                                 │
│  │   - Tool approval UI        │    │                                 ▼
│  │   - Session history         │    │                         zoo.jsonc + AGENTS.md
│  └─────────────────────────────┘    │                         + session DB
└─────────────────────────────────────┘

┌─────────────────┐
│   Terminal      │
│   zoo run       │────────────────────────────────────────────────►  zoo-cli
│   (TUI/CLI)     │                                                   same runtime
└─────────────────┘
```

Both surfaces write and read the same `~/.config/zoo-code/zoo.jsonc` and `./zoo.jsonc` files and share the same session database. A session started in the CLI can be resumed in VS Code and vice versa.

---

## 4. Phase Breakdown and Work Estimates

### Phase 0 — Fork and Rebrand (1–2 days)

**Scope:** Create the fork, set up the new monorepo skeleton.

**Tasks:**
1. Fork `Zoo-Code-Org/Zoo-Code` into target org (e.g., `mojomast/zoo-code` or a new org).
2. Fork `Kilo-Org/kilocode` — specifically copy `packages/opencode` into the new repo as `packages/zoo-cli`.
3. Add `packages/zoo-sdk/` as a new empty package (scaffold only).
4. Move existing `src/`, `webview-ui/` into `packages/zoo-vscode/`.
5. Update root `pnpm-workspace.yaml` to include new packages.
6. Update root `turbo.json` to pipeline new package builds.
7. Global text search-replace: `roo` → `zoo`, `kilocode` → `zoo-code`, `kilo` → `zoo` in non-sensitive contexts. Preserve Roo Code's original license attribution where required.

**Deliverables:** New monorepo builds. Old VS Code extension still works from `packages/zoo-vscode/` unchanged.

**Effort:** ~1–2 days (mostly mechanical).

---

### Phase 1 — Zoo CLI Package: Port and Rebrand OpenCode Core (1–2 weeks)

**Scope:** Get `packages/zoo-cli` to a working Zoo-branded CLI binary.

**Tasks:**

1. **Rebrand config paths:**
   - Replace all `~/.config/kilo/kilo.jsonc` references with `~/.config/zoo-code/zoo.jsonc`.
   - Replace all `.kilo` project directory references with `.zoo`.
   - Replace `AGENTS.md` ingestion with support for both `AGENTS.md` and `.zoo/rules/*.md` (Roo Code mode rules migration).
   
2. **Rebrand binary entrypoints:**
   - Update `package.json` bin: `{ "zoo": "./dist/cli.js", "zoo-code": "./dist/cli.js" }`.
   - Update CLI help text, banner, and version string.
   
3. **Remove Kilo-specific gateway / account integrations:**
   - Remove `@kilocode/kilo-gateway` and `@kilocode/kilo-indexing` dependencies from the CLI (these are Kilo's proprietary SaaS services).
   - Replace with a no-op or open stub that can be re-implemented later if Zoo Code wants its own cloud services.
   - Retain BYOK provider stack (OpenAI, Anthropic, Google, OpenRouter, local providers) since those are from OpenCode and are open.
   
4. **Wire in Zoo Code's existing provider configs:**
   - Zoo Code currently supports a superset of providers vs. Kilo CLI (it inherits all Roo Code providers).
   - Audit the provider list in `packages/zoo-cli/src/providers/` vs. Zoo Code's existing `src/api/providers/` and merge any missing providers into the CLI package.
   
5. **Roo-mode → Zoo-mode migration in config:**
   - Roo Code's `.roomodes` file defines agent modes (architect, code, debug, etc.). Zoo CLI's config system must be extended to ingest this file or a `.zoomodes` equivalent and expose modes through the CLI.
   - Add a `zoo.jsonc` → `.roomodes` bridge or a new `zoo.jsonc` modes section.
   
6. **Build pipeline:**
   - Add `packages/zoo-cli/` build to turbo pipeline.
   - Add `prepare:cli-binary` script to `packages/zoo-vscode/` that copies the CLI dist binary into the extension's assets (following Kilo's `script/local-bin.ts` pattern).

**Deliverables:** `zoo` binary that runs, accepts `zoo run <task>`, reads `zoo.jsonc` and `AGENTS.md`, and uses the agent runtime.

**Effort:** ~8–12 days of focused engineering.

---

### Phase 2 — Zoo SDK Package (3–5 days)

**Scope:** Create `packages/zoo-sdk/` — the bridge between the portable CLI server and consumers (VS Code extension, potentially a web UI).

**Tasks:**

1. **Define the client interface:**
   ```typescript
   // packages/zoo-sdk/src/client.ts
   export class ZooClient {
     connect(opts: { ipcPath?: string; httpPort?: number }): Promise<void>;
     createSession(opts: SessionCreateOpts): Promise<Session>;
     sendMessage(sessionId: string, message: string, opts?: MessageOpts): AsyncIterableIterator<MessageChunk>;
     getSession(sessionId: string): Promise<Session>;
     listSessions(): Promise<Session[]>;
     abortSession(sessionId: string): Promise<void>;
     on(event: string, handler: (...args: any[]) => void): void;
   }
   ```

2. **Implement IPC/HTTP transport:** The CLI server exposes a local socket or HTTP endpoint; the SDK wraps it. Follow Kilo's `@kilocode/sdk` pattern — the SDK starts the CLI process if not running, then connects.

3. **Define shared types:** `Session`, `Message`, `MessageChunk`, `ToolCall`, `ToolResult`, `Provider`, `Mode`, `Permission`, `WorktreeInfo`. These are consumed by both VS Code extension and any future surfaces.

4. **Process lifecycle management:** SDK is responsible for spawning, monitoring, and gracefully stopping the CLI server process when the VS Code extension activates/deactivates.

**Deliverables:** `@zoo-code/sdk` package with working `ZooClient`, exported types, and process lifecycle management.

**Effort:** ~3–5 days.

---

### Phase 3 — VS Code Extension Rewire (2–3 weeks)

**Scope:** Migrate `packages/zoo-vscode/src/` from direct extension-host agent logic to a thin adapter consuming `@zoo-code/sdk`. This is the most complex phase.

**Tasks:**

#### 3a. Audit current extension host agent logic (~2 days)

Map every class and module in `src/` to one of three buckets:

| Bucket | Description | Destination |
|---|---|---|
| **Core agent logic** | Provider calls, tool execution, context building, streaming | Move to `packages/zoo-cli/` |
| **VS Code host glue** | Commands, webview bridge, file system access via VS Code API, SCM, terminal | Stays in `packages/zoo-vscode/src/` |
| **Shared types/utils** | Message types, config schemas, provider types | Move to `packages/zoo-sdk/` |

Expect most of `src/core/`, `src/api/`, `src/services/` to move to CLI. Expect `src/extension.ts`, `src/providers/webview/` to stay.

#### 3b. Replace agent execution paths (~5–8 days)

For every place in the extension host that currently:
- Makes a direct LLM API call → replace with `ZooClient.sendMessage()`
- Manages a session in-process → replace with `ZooClient.createSession()` / `getSession()`
- Executes a tool (bash, file write) → replace with the CLI's tool execution (tools run inside the CLI process)
- Reads provider config → replace with zoo.jsonc config via SDK

This is the bulk of the work and the highest-risk phase. There will be behavioral subtleties where Roo Code / Zoo Code's agent loop differs from OpenCode's agent loop (e.g., custom tool approval flows, Roo-specific mode-switching behavior).

**Mitigation:** Run the old and new code paths side by side during transition using a feature flag (`zoo.usePortableCore: boolean` in settings). This allows A/B comparison and a safe rollback path.

#### 3c. Webview UI rewire (~3–5 days)

The webview (`webview-ui/`) currently receives messages from the extension host via `postMessage`. The message protocol will change because the extension host no longer runs the agent — it proxies SDK events.

Tasks:
- Audit all `postMessage` message types in `webview-ui/src/` and the corresponding handlers in `src/`.
- Update extension host → webview message bridge to forward SDK events (streaming chunks, tool approval requests, session state changes).
- Update webview-initiated actions (send message, abort, approve tool, change mode) to route through extension host → SDK → CLI.
- Retain all existing webview UI components; the change is the data contract, not the UI.

#### 3d. Config migration UI (~1–2 days)

- Add a migration wizard command: "Migrate Zoo Code settings" that reads existing VS Code `settings.json` extension config and writes `zoo.jsonc`.
- Add a `.roomodes` → `.zoomodes` / `zoo.jsonc` modes migration script.

**Deliverables:** VS Code extension runs on top of `@zoo-code/sdk`. Agent logic lives in CLI. Webview UI unchanged visually. Feature flag enables safe transition.

**Effort:** ~12–18 days.

---

### Phase 4 — Config Model Unification (3–5 days)

**Scope:** Define and implement the shared configuration surface that gives CLI and VS Code identical behavior.

**Config hierarchy:**

```
~/.config/zoo-code/zoo.jsonc       ← Global config (providers, default model, global rules)
{project}/.zoo/zoo.jsonc           ← Project config (project-specific model, tools, permissions)
{project}/AGENTS.md                ← OpenCode-style AGENTS instruction file (read by both CLI and extension)
{project}/.zoo/rules/*.md          ← Zoo-branded Roo-style mode rules (read by both)
{project}/.zoo/modes/*.json        ← Mode definitions (migrated from .roomodes)
```

**Tasks:**
1. Define the `zoo.jsonc` JSON schema (extend OpenCode's schema with Roo Code's mode/rule system).
2. Implement the config loader in `packages/zoo-cli/src/config/` to read both the OpenCode-style global config and the `.zoo/` project directory.
3. Implement a config watcher in the VS Code extension that triggers CLI restart/reload when config files change.
4. Document the config format for users migrating from Roo Code (`.roomodes` → `.zoo/modes/`).

**Effort:** ~3–5 days.

---

### Phase 5 — Feature Parity Matrix Implementation (ongoing, 2–4 weeks)

**Scope:** Systematically ensure every user-facing capability of the Zoo Code VS Code extension has an equivalent CLI representation, and vice versa.

#### 5.1 Core Feature Parity Matrix

| Feature | Zoo VS Code (current) | Zoo CLI (target) | Parity Work Required |
|---|---|---|---|
| **Send message / run task** | Webview chat input | `zoo run "<task>"` | Implemented in Phase 3 (shared agent) |
| **Multi-agent / subagents** | Yes (Roo Code) | `zoo run` with subagent delegation | CLI inherits from OpenCode; needs Zoo mode wiring |
| **Agent modes (code/architect/debug)** | `.roomodes` | `zoo --mode architect` CLI flag | Phase 4 config migration |
| **Tool approval (bash, file write)** | Interactive UI in webview | CLI prompt (TTY) or `--auto-approve` flag | Core approval protocol shared; UI diverges by host |
| **Context mentions (@file, @folder)** | Webview `@` mentions | `--context file.ts` CLI flag | CLI needs context flag parser |
| **AGENTS.md / rules ingestion** | Already in Zoo (AGENTS.md present) | Same (shared config loader) | Shared in Phase 4 |
| **Provider config** | VS Code settings → BYOK | `zoo.jsonc` BYOK config | Phase 4 config migration |
| **500+ model support** | Yes | Yes (OpenCode provider stack) | Shared provider layer in Phase 1 |
| **MCP server support** | Yes (Roo Code MCP) | Yes (OpenCode MCP integration) | Audit for divergence; merge in Phase 1 |
| **Session history** | In-memory + local storage | Persistent SQLite sessions | Phase 2 SDK; Phase 3 extension rewire |
| **Session continuity CLI↔VS Code** | Not applicable (no CLI) | Shared session DB | Architecture target; Phase 2+3 |
| **Worktree support** | Partial (git worktree commands) | Full worktree management from OpenCode | CLI inherits; VS Code integration Phase 3c |
| **Browser automation** | No | Via OpenCode/Playwright integration | Opt-in, Phase 5 stretch goal |
| **Inline autocomplete** | No (Zoo Code / Roo Code don't have it) | No | Out of scope unless Zoo wants to add Kilo-style autocomplete |
| **Commit message generation** | Via agent task | `zoo commit` shortcut | Phase 5 CLI convenience commands |
| **Terminal context** | VS Code terminal context menu | CLI is the terminal | Natural parity; no special work |
| **Diff viewer** | VS Code diff editor | TUI diff via CLI | CLI inherits TUI diff from OpenCode |

#### 5.2 Intentional Divergence (not parity gaps — by design)

| Feature | VS Code Only | CLI Only |
|---|---|---|
| Editor inline decorations | ✓ | — |
| SCM panel (commit message icon) | ✓ | — |
| VS Code keybindings | ✓ | — |
| Sidebar / Activity Bar view | ✓ | — |
| Non-interactive CI/CD use | — | ✓ |
| SSH / headless server use | — | ✓ |
| Shell integration (zsh/bash hooks) | — | ✓ |
| `--json` output for scripting | — | ✓ |
| Docker / container CLI invocation | — | ✓ |

These are not bugs; they are correct host-specific affordances.

---

### Phase 6 — Testing, CI, and Release Pipeline (1–2 weeks)

**Scope:** Ensure the two-surface architecture is robustly tested and releases are coordinated.

**Tasks:**

1. **Unit tests for CLI core** (`packages/zoo-cli/src/`): agent loop, config loader, provider abstraction, session persistence.
2. **Integration tests for SDK** (`packages/zoo-sdk/`): client-server round trips, streaming, process lifecycle.
3. **VS Code extension tests** (`packages/zoo-vscode/`): extension activation, webview message bridge, command registration — without running a real LLM.
4. **E2E parity tests:** A test harness that runs the same task against both the CLI and the VS Code extension and asserts identical tool call sequences and output (mocked LLM responses).
5. **CI pipeline updates:**
   - Add `packages/zoo-cli/` build and test to CI.
   - Add CLI binary packaging step (cross-platform: macOS arm64/x64, Linux x64, Windows x64).
   - Add VS Code VSIX build step that embeds the correct CLI binary.
6. **Release versioning:** Use a single version across CLI and VS Code extension (same pattern as Kilo: `7.2.52` for both). Update `packages/zoo-vscode/package.json` and `packages/zoo-cli/package.json` together via changeset.

**Effort:** ~8–12 days.

---

## 5. Total Effort Summary

| Phase | Description | Effort |
|---|---|---|
| 0 | Fork and rebrand | 1–2 days |
| 1 | Zoo CLI package (OpenCode port) | 8–12 days |
| 2 | Zoo SDK package | 3–5 days |
| 3 | VS Code extension rewire | 12–18 days |
| 4 | Config model unification | 3–5 days |
| 5 | Feature parity matrix implementation | 10–20 days (iterative) |
| 6 | Testing, CI, release pipeline | 8–12 days |
| **Total** | | **45–74 days (solo, sequential)** |

With parallel subagent execution (multiple focused agents working simultaneously on Phases 1, 2, and 4 in parallel after Phase 0), the wall-clock time can be compressed to approximately **3–5 weeks** for a working MVP (CLI + extension on shared core), with Phase 5 and 6 completing over the following 2–4 weeks.

---

## 6. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **OpenCode agent loop diverges from Roo Code/Zoo Code behavior** — users experience regressions in mode switching, tool approval, context management | High | High | Feature flag (Phase 3b) + parallel running of both paths. Maintain a regression test suite against known Zoo Code behaviors before deprecating old path. |
| **Kilo's `packages/opencode` diverges fast from upstream OpenCode** — pulling in Kilo's fork rather than upstream OpenCode introduces Kilo-specific assumptions | Medium | Medium | Consider forking directly from `anomalyco/opencode` upstream instead of Kilo's fork, then cherry-pick only needed integrations. Evaluate both codebases before Phase 1 begins. |
| **IPC/process lifecycle instability in VS Code** — spawning and managing a child process inside a VS Code extension is fragile across OS/platform/VS Code version combinations | Medium | High | Follow Kilo's exact implementation of `prepare:cli-binary` and `script/local-bin.ts`. Add watchdog restart logic. Test on all three platforms early. |
| **Config migration breakage** — users with complex `.roomodes` and Roo provider configs experience data loss or broken setups | Medium | High | Never delete old config; migration wizard is additive (writes new format alongside old). Keep reading `.roomodes` for at least 2 major versions. |
| **Webview message protocol change breaks existing Zoo Code UI** — Phase 3c changes the message contract between extension host and webview | Medium | Medium | Define and version the message protocol explicitly before Phase 3c. Write contract tests for every message type. |
| **Provider feature regression** — Zoo Code has providers Kilo CLI doesn't (inherits all Roo Code providers) | Low–Medium | Medium | Audit in Phase 1 step 4. Merge missing providers before deprecating old provider code path. |

---

## 7. Agent Instructions for Execution

The following notes are written for the coding agent(s) that will implement this spec.

### Source Repositories

- **Zoo Code fork (base):** `https://github.com/Zoo-Code-Org/Zoo-Code` (fork this first)
- **Kilo Code (OpenCode CLI fork reference):** `https://github.com/Kilo-Org/kilocode` — specifically `packages/opencode/` and `packages/sdk/js/`
- **OpenCode upstream (optional alternative base):** `https://github.com/anomalyco/opencode` — `packages/opencode/`

### Phase Execution Order

Phases must be executed in order: 0 → 1 → 2 → 3 → 4 → 5 → 6. Phases 1, 2, and 4 can be parallelized once Phase 0 is complete (different packages, no circular deps). Phase 3 depends on Phase 2 completing first. Phase 5 depends on Phase 3 completing.

### Naming Conventions

All package names, config keys, binary names, VS Code extension IDs, and directory names use `zoo` / `zoo-code` branding. No `kilo`, `roo`, or `opencode` branding in exported surfaces. Internal comments and git history may reference upstream sources for attribution.

### Preserve Upstream Attribution

Both OpenCode (Apache 2.0) and Roo Code (Apache 2.0) licenses require attribution. Maintain `ATTRIBUTIONS.md` listing upstream repos and their licenses. Do not remove upstream license headers from copied files; add Zoo Code copyright beneath them.

### Feature Flag Pattern

During Phase 3, implement the following in `packages/zoo-vscode/src/config/`:

```typescript
export function usePortableCore(): boolean {
  return vscode.workspace.getConfiguration('zoo-code').get('usePortableCore', false);
}
```

All new SDK-based code paths must be gated behind this flag. The old extension-host code paths remain fully functional until the flag is enabled by default in a later release.

### Config File Locations

| File | Purpose |
|---|---|
| `~/.config/zoo-code/zoo.jsonc` | Global user config (providers, default model, API keys) |
| `{project}/zoo.jsonc` | Project-level config (model override, tool permissions, modes) |
| `{project}/AGENTS.md` | OpenCode-style agent instructions (read by both CLI and extension) |
| `{project}/.zoo/rules/*.md` | Zoo-style mode rules (migrated from `.roo/rules/`) |
| `{project}/.zoo/modes/*.json` | Mode definitions (migrated from `.roomodes`) |
| `{project}/.zooignore` | Ignore file (migrated from `.rooignore`) |

### SDK Client Bootstrap Pattern

Follow Kilo's pattern exactly for spawning the CLI from the VS Code extension:

1. At extension activation, check if a Zoo CLI server is already running (by checking a lock file or attempting socket connection).
2. If not running, spawn the CLI server: `zoo server --ipc /tmp/zoo-{pid}.sock`.
3. Connect via `ZooClient.connect({ ipcPath: '/tmp/zoo-{pid}.sock' })`.
4. On extension deactivation, send a graceful shutdown signal and wait for the process to exit.
5. On unexpected CLI process exit, log error and attempt restart up to 3 times before surfacing an error to the user.

### VS Code Extension Package Manifest Changes

Update `packages/zoo-vscode/package.json`:
- Add `"@zoo-code/sdk": "workspace:*"` to `dependencies`.
- Add `"prepare:cli-binary": "bun script/local-bin.ts"` (or `ts-node` if not using bun) to `scripts`.
- Add CLI binary assets to `.vscodeignore` exclusions so the binary IS included in the packaged VSIX.
- Bump `engines.vscode` to match Kilo's minimum (`^1.105.1` or newer).

---

## 8. Open Questions for Product Owner

1. **OpenCode fork vs. Kilo CLI fork as base:** Should `packages/zoo-cli` be based on upstream `anomalyco/opencode` (cleaner, no Kilo-specific cloud assumptions) or on `Kilo-Org/kilocode/packages/opencode` (more recent, more features, but includes Kilo-specific integrations that need stripping)? Recommendation: start from upstream OpenCode to avoid carrying Kilo's proprietary stubs.

2. **Runtime:** Kilo uses `bun` for the CLI and extension build. Zoo Code currently uses `pnpm` + `turbo`. This is a toolchain decision — use bun for the CLI package and keep pnpm/turbo for the workspace, or standardize on bun throughout? Recommendation: keep pnpm for workspace management; use bun only in `packages/zoo-cli/` if OpenCode's build requires it.

3. **Cloud services / gateway:** Kilo wraps a proprietary `kilo-gateway` for model routing and user accounts. Zoo Code should define whether it wants a similar Zoo gateway service, will remain purely BYOK, or will integrate with an existing model router (e.g., OpenRouter as default). This decision affects Phase 1 step 3.

4. **Inline autocomplete:** Kilo's VS Code extension includes a Codestral-based inline autocomplete feature not present in Roo Code/Zoo Code. Is this in scope for Zoo Code? It requires additional provider integration and a separate autocomplete engine in the CLI core.

5. **JetBrains / other IDEs:** Kilo supports JetBrains via the same portable core. If Zoo Code wants JetBrains support, the portable-core architecture makes it straightforward — add `packages/zoo-jetbrains/` following the same pattern as `packages/zoo-vscode/`. Out of scope for this spec but worth flagging as a future benefit of this architecture.

---

## 9. Appendix: Key File Reference

### Kilo Code files to study before starting Phase 1

| File | Why |
|---|---|
| `packages/opencode/package.json` | CLI package structure, bin names, deps |
| `packages/opencode/src/server/` | IPC/HTTP server implementation |
| `packages/opencode/src/config/` | Config loader — the pattern to replicate for zoo.jsonc |
| `packages/opencode/src/session/` | Session persistence model |
| `packages/opencode/src/providers/` | Provider abstraction to extend |
| `packages/sdk/js/src/client.ts` | SDK client — basis for zoo-sdk |
| `packages/kilo-vscode/script/local-bin.ts` | CLI binary embedding in extension |
| `packages/kilo-vscode/src/extension.ts` | Extension activation / SDK bootstrap |

### Zoo Code files to audit before starting Phase 3

| File | Why |
|---|---|
| `src/extension.ts` | Extension entry point — activation event handling |
| `src/core/` | Agent loop and tool execution — moves to CLI |
| `src/api/` | Provider implementations — audit vs. CLI providers |
| `src/services/` | Session, history, config services — moves to CLI/SDK |
| `webview-ui/src/components/` | Webview UI — stays, message protocol changes |
| `webview-ui/src/utils/` | Message type definitions — move to zoo-sdk types |
| `.roomodes` | Mode definitions — migrate to `.zoo/modes/` |
| `.roo/rules/` | Rule files — migrate to `.zoo/rules/` |
