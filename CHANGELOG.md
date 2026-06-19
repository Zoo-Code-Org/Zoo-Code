# Boo Code Changelog

All notable changes to Boo Code will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Boo Code uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** Boo Code is a fork of Zoo Code. For the full history prior to version 3.56.0, see the [Zoo Code repository](https://github.com/Zoo-Code-Org/Zoo-Code).

---

## 3.60.1

### Added

- **Brainstorm Mode:** New mode for open-ended, big-picture project development after the foundation is established. Engages flexibly with whatever is on the writer's mind instead of redirecting "out of scope" topics, and offers to hand off to Outline when the structural picture has genuinely settled.

### Changed

- **Outline Mode is now sub-agent only:** Its `whenToUse` discourages direct switching — it is spawned via sub-task by Collaborate (and now Brainstorm). Users are pointed to Brainstorm for project-level planning and Collaborate for writing.
- **Knowledge Lookup delegation across modes:** Collaborate, Brainstorm, and Outline no longer bulk-read the `knowledge/` detail files. They read the lightweight `glossary.md` index inline and delegate fact-finding to the Knowledge Lookup sub-agent, keeping the main thread light. A new `knowledge_lookup.model` field in `.boo/config.yaml` lets lookups run on a cheaper model.
- **Knowledge Lookup favors targeted grep:** Instructions now encourage grepping the grep-friendly knowledge files and reading only matching sections, then returning a synthesized, self-contained report. Callers are guided to pass fully-formed questions rather than bare keywords.
- **Collaborate pre-draft exploration is more free-form:** Before the structured drafting process, Collaborate now opens a relaxed, multi-turn back-and-forth to clarify section details with the user, rather than a single orienting question.

## 3.60.0

### Added

- **Claude Fable 5:** New Anthropic model available across Anthropic, Bedrock, and Vertex providers
- **OpenAI GPT-5.5:** Added GPT-5.5 to the OpenAI provider
- **Gemini 3.5 Flash:** Added Gemini 3.5 Flash to the Gemini provider
- **Semble Embedding Provider:** Local on-the-fly embedding provider for code indexing — no external API required
- **VS Code Terminal Shell Override:** New setting to control which shell profile is used in the integrated terminal
- **Configurable Chat Font Size:** Slider in UI settings to adjust chat panel font size (8–32px)
- **GitHub-Style Alerts:** Webview now renders `> [!NOTE]`, `> [!WARNING]`, `> [!TIP]`, `> [!IMPORTANT]`, and `> [!CAUTION]` blocks as styled callout boxes
- **Configurable Max Output Tokens for GLM Models:** Models with adjustable output limits now show a dedicated max output tokens slider
- **WorkspacePathResolver:** Symlink-aware path canonicalization for rules and instructions files
- **Per-Mode MCP Server Restrictions:** Configure an allowlist per mode to restrict which MCP servers are active
- **LiteLLM Reasoning Field Support:** LiteLLM streaming responses now surface `reasoning_content` and `reasoning` fields from models like DeepSeek R1
- **Show Ripgrep Diagnostic Command:** New command palette entry that generates a ripgrep diagnostic report for troubleshooting
- **Terminal Profile Settings Redesign:** Unified dropdown with "Follow VS Code" option, profile selector, and configure button

### Fixed

- Chat window running out of memory when transcript grows large
- Relative symlinks in rules files not resolving correctly
- Removed unsupported `--no-absolute-filenames` tar argument in Semble downloader

---

## 3.59.2

### Added

- **Collaborate Mode: Sub-Agent Drafting:** Beat prose is now delegated to a draft-mode sub-agent rather than written directly by the orchestrator
    - Orchestrator builds a structured sub-task message containing the beat description, a directorial brief (synthesized from user steering, style guidance, and editorial judgment), and trailing context from `main.md` (~3000 tokens)
    - Sub-agent appends prose to `main.md` and returns; orchestrator resumes the turn loop at the mark-drafted step
    - Optional `drafting_profile` setting in `.boo/config.yaml` specifies a Roo Code API provider profile for sub-agent tasks — allows a different model for drafting without changing the main conversation model
    - Blank or absent `drafting_profile` inherits the active profile (zero-friction default)
    - `.boo/config.yaml.example` template committed for easy onboarding; actual config file is gitignored

### Changed

- **Custom Modes:** Removed upstream zoo/developer placeholder modes (`translate`, `issue-fixer`, `pr-fixer`, `merge-resolver`, etc.) from `.roomodes`; replaced with a minimal `example-mode` template

---

## 3.59.1

### Added

- **Collaborate Mode:** New writing mode that merges outlining and drafting into a turn-by-turn conversational loop
    - Human-driven: agent proposes each move before writing, waits for go-ahead or steering input
    - Intake interview establishes component scope, session goal, and constraints; branches into fresh/continue/existing-plan workflows
    - Living beat list (`plan-collaborate-<N>.md`) tracks drafted/completed states with per-beat decision notes for cold-restart continuity
    - Session-end review surfaces issues noticed, flags new lore for Develop mode, and writes a handoff note to `notes/`
    - File access scoped to component `main.md`, `plans/plan-collaborate-*.md`, and `notes/` — no writes to `knowledge/` or `.boo/`
    - Compatible with existing Outline → Collaborate workflow (consumes existing plan files) or standalone Collaborate-only sessions

---

## 3.58.1

### Added

- **Context Loading:** Automatic discovery and injection of workspace context into system prompts
    - Load workspace metadata (`.boo/instructions.md`, `.boo/style.md`, `workspace.boo.md`)
    - Detect active component from file path with explicit override capability
    - Load active component context (`component.boo.md`, active plan from `plans/` directory)
    - Load knowledge files from `knowledge/` directory with `.booignore` filtering
    - Context prioritization: workspace + component always preserved; knowledge trimmed first on token limit
    - Context formatted and injected into system prompt for consistent AI behavior across conversation

---

## 3.58.0

### Changed

- **Writing Modes:** Completely redesigned mode system for long-form writing workflows
    - Replaced developer modes (Architect, Code, Ask, Debug, Orchestrator) with five writing-focused modes
    - New modes: **Interview** (persistent entry point, now default), **Outline** (planning/structure), **Draft** (prose execution), **Revise** (editing/refinement), **Develop** (knowledge base expansion)
    - Each mode has task-specific tool access, role definitions, and custom instructions
    - Interview is the hub; users manually switch to specialist modes for focused work
    - Tool access aligned with workflow: Interview reads all/writes to `.boo/` and `knowledge/`; Draft reads plan + style, writes `main.md`; Revise reads broadly, edits `main.md`; Develop expands `knowledge/` files; Outline reads broadly, writes plan docs

---

## 3.57.1

### Added

- Workspace management: detect, initialize, and manage Boo Code writing workspaces (`workspace.boo.md`, `.boo/`, `knowledge/`, `components/`)
- `boo.workspace.init` command scaffolds a new workspace; status bar prompt appears in non-workspace folders
- Pillar path overrides via `workspace.boo.md` frontmatter (`meta`, `knowledge`, `components`)
- Component discovery by scanning `components/` for `component.boo.md` manifests

---

## 3.57.0

### Changes

- Fork from Zoo Code; rebrand to Boo Code under Anthologist Inc.

---

## 3.56.0

### Minor Changes

- Add Claude Opus 4.8 support across Anthropic, Bedrock, and Vertex providers (PR #386 by @vandre-sales)
- Add Opencode Go as a first-class provider (#172 by @vijay-0001, PR #319 by @proyectoauraorg)
- Add glm-5.1, kimi-k2.6, and deepseek-v4-pro models to the Fireworks provider (#198 by @DeCodeTheWeb, PR #231 by @proyectoauraorg)
- Show Zoo Code identity in outbound provider activity logs (#203 by @yfdyh000, PR #219 by @app/roomote)
- Fix API requests hanging indefinitely on VS Code 1.122.0+ (#381 by @greatgradz-svg, #382 by @abcxlab, PR #383 by @app/roomote)
- Fix terminal task cancellation so the running process is terminated when a task is cancelled (#245 by @proyectoauraorg, PR #261 by @proyectoauraorg)
- Fix terminal Ctrl+C retry so processes that need multiple SIGINT signals are properly stopped (#266 by @edelauna, PR #272 by @proyectoauraorg)
- Fix Gemini provider to honor custom model IDs instead of falling back to the default (#227 by @notoccupy2023-design, PR #317 by @proyectoauraorg)
- Fix truncated Grok diffs caused by missing diff markers (#186 by @jcalfee, PR #230 by @proyectoauraorg)
- Fix PowerShell detection on Windows when no shell profile is configured (#82 by @rossdonald, PR #239 by @proyectoauraorg)
- Fix Vertex AI warning when the Google Cloud Credentials field receives a file path instead of JSON (PR #294 by @0xMink)
- Rename Zoo Code in VS Code code actions (#328 by @rrewll, PR #329 by @rrewll)
- Localize VS Code code action commands (#334 by @edelauna, PR #339 by @rrewll)
- Migrate webview build to Vite 8 (PR #214 by @maxdewald)
- Add comprehensive unit tests for AskFollowupQuestionTool and ListFilesTool (#206 by @app/roomote, PR #212, #213 by @proyectoauraorg)
- Update `diff` to v5.2.2 for a security fix (PR #173 by @app/renovate)
- Update `i18next-http-backend` to v3.0.5 for a security fix (PR #174 by @app/renovate)
- Update `fast-xml-parser` to v5.7.0 for a security fix (PR #175 by @app/renovate)
- Update `simple-git` to v3.36.0 for a security fix (PR #182 by @app/renovate)
- Update `uuid` and pin esbuild/rollup/vite for a security fix (PR #205 by @app/renovate)
- Update `turbo` to v2.9.14 for a security fix (PR #236 by @app/renovate)
