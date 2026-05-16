# Zoo Code CLI Integration Development Plan

## Ad hoc maintenance completed

- [✅] Restore imported Zoo CLI runtime alias resolution by wiring Kilo's `@opencode-ai/core` workspace package and a no-op telemetry compatibility stub.
- [✅] Import Kilo upstream `@kilocode/sdk` and `@kilocode/plugin` as local workspace packages for CLI blocker reduction without reintroducing Kilo gateway/indexing packages.
- [✅] Restore real `@zoo-code/cli` typechecking in workspace `pnpm check-types` by reconciling imported Kilo/OpenCode type drift and stale gateway/indexing tests.
- [✅] Restore `@zoo-code/cli` broader imported test and build blocker coverage by running `test:opencode` through an explicit quarantine list and aligning `build:opencode` with the current-platform monorepo build path.
- [✅] Clean up stale imported Kilo/OpenCode config docs by labeling legacy paths as migration fallbacks, documenting Zoo portable config paths, and removing bundled Kilo Gateway notification guidance.
- [✅] Fix built-in markdown skill loading under Bun tests by importing the bundled config skill as text and hardening coverage to assert real markdown content.

## Phase 0 — Fork and Rebrand

1. Fork source repositories and establish upstream references

    - **What:** Fork `https://github.com/Zoo-Code-Org/Zoo-Code` into the target Zoo Code organization/repository, and fork or otherwise source `https://github.com/Kilo-Org/kilocode` for `packages/opencode`. Record `https://github.com/anomalyco/opencode` as the optional cleaner upstream OpenCode base for product-owner decision-making before CLI port work starts.
    - **Files touched:** Repository remotes/configuration only; `HANDOFF.md` if the selected target org or upstream source differs from this plan.
    - **Acceptance criteria:** Zoo Code fork exists in the target org; Kilo Code fork or source copy path is available; upstream remotes are documented for future syncs; no implementation code has been changed.
    - **Tests required:** None; verify remotes with non-destructive git commands.
    - **Docs required:** Update `HANDOFF.md` with actual fork URLs and any selected target org.
    - **Commit message:** `chore(repo): fork zoo code and opencode sources`
    - **Depends on:** None.
    - **Can parallelize with:** None.

2. Create monorepo package skeleton

    - **What:** Create `packages/zoo-cli/`, `packages/zoo-sdk/`, and `packages/zoo-vscode/` package locations without changing behavior. Move the existing extension host `src/` and `webview-ui/` into `packages/zoo-vscode/` as a mechanical relocation. If the local workspace was initialized from planning docs only, first materialize the Zoo upstream source tree before moving these existing directories.
    - **Files touched:** `packages/zoo-cli/`, `packages/zoo-sdk/`, `packages/zoo-vscode/`, moved `src/`, moved `webview-ui/`, root `package.json` if path references require adjustment.
    - **Acceptance criteria:** Existing VS Code extension sources are located under `packages/zoo-vscode/`; empty package scaffolds exist for `zoo-cli` and `zoo-sdk`; no CLI runtime is implemented yet; old extension behavior remains intended to be unchanged.
    - **Tests required:** Existing extension tests/build commands that were available before the move.
    - **Docs required:** Update root README package layout section if present; update `HANDOFF.md`.
    - **Commit message:** `chore(repo): scaffold zoo packages`
    - **Depends on:** Phase 0, Task 1.
    - **Can parallelize with:** None.

3. Update workspace and build graph for new packages

    - **What:** Add `packages/zoo-cli`, `packages/zoo-sdk`, and `packages/zoo-vscode` to the pnpm workspace and turbo pipeline so package builds can be addressed independently.
    - **Files touched:** `pnpm-workspace.yaml`, `turbo.json`, root `package.json` scripts if package paths are hard-coded.
    - **Acceptance criteria:** Workspace package discovery includes all three Zoo packages; turbo can target package builds; existing extension build target still resolves after relocation.
    - **Tests required:** Workspace package listing command; existing build/test command that does not require new dependencies.
    - **Docs required:** Update root README build instructions if package commands changed; update `HANDOFF.md`.
    - **Commit message:** `chore(repo): wire zoo packages into workspace`
    - **Depends on:** Phase 0, Task 2.
    - **Can parallelize with:** Phase 0, Task 4 after package paths exist.

4. Add attribution inventory

    - **What:** Preserve upstream Zoo Code, Roo Code, OpenCode, and Kilo Code attribution requirements before copied code is edited. Add or update `ATTRIBUTIONS.md` with upstream repositories and license notes. Zoo Code/Roo Code are Apache 2.0; Kilo Code/OpenCode are MIT as currently published upstream.
    - **Files touched:** `ATTRIBUTIONS.md`, existing license files only if required by copied source headers.
    - **Acceptance criteria:** Upstream Zoo/Roo/OpenCode/Kilo sources are listed with accurate license names and repository URLs; existing upstream license headers are not removed.
    - **Tests required:** None.
    - **Docs required:** `ATTRIBUTIONS.md`; update `HANDOFF.md`.
    - **Commit message:** `docs(legal): record upstream attributions`
    - **Depends on:** Phase 0, Task 1.
    - **Can parallelize with:** Phase 0, Task 3.

5. Perform safe exported-surface rebrand pass
    - **What:** Replace exported/user-facing `roo`, `kilo`, and `opencode` branding with `zoo`/`zoo-code` only in non-sensitive contexts. Preserve required upstream attribution, license headers, and historical references.
    - **Files touched:** Package manifests, README files, schemas, command IDs, config keys, help text, extension manifest, non-license source comments where user-facing.
    - **Acceptance criteria:** Exported package names, command names, config keys, binary names, and public docs use Zoo branding; license attribution remains intact; no broad replacement corrupts code, licenses, URLs, or migration docs.
    - **Tests required:** Existing full test suite; package build; targeted search showing no unintended exported `roo`/`kilo` branding except migration/attribution references.
    - **Docs required:** README branding updates; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `chore(repo): rebrand exported surfaces to zoo code`
    - **Depends on:** Phase 0, Tasks 2 and 4.
    - **Can parallelize with:** None.

## Phase 1 — Zoo CLI Package: Port and Rebrand OpenCode Core

1. Import OpenCode-derived portable core into `packages/zoo-cli`

    - **What:** Copy the chosen OpenCode-derived CLI core into `packages/zoo-cli`, using either Kilo `packages/opencode` or upstream `anomalyco/opencode` per product-owner decision. Keep the import as mechanical as possible before Zoo-specific changes.
    - **Files touched:** `packages/zoo-cli/**`, `packages/zoo-cli/package.json`, copied license/header files, `ATTRIBUTIONS.md` if additional upstream details are found.
    - **Acceptance criteria:** Source tree for the portable agent core exists under `packages/zoo-cli`; package metadata is present; copied files retain upstream license headers; no proprietary service dependency has been intentionally wired into Zoo behavior.
    - **Tests required:** Package typecheck/build if possible without further rebrand; smoke import/build test for the package entrypoint.
    - **Docs required:** `packages/zoo-cli/README.md` initial package description; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-cli): import portable opencode core`
    - **Depends on:** Phase 0 complete; Open Question 1 answered.
    - **Can parallelize with:** Phase 2, Task 1 after core server API shape is known; Phase 4, Task 1.

2. Rebrand CLI package metadata and binaries

    - **What:** Rename CLI package metadata to `@zoo-code/cli`, expose `zoo` and `zoo-code` bins pointing at the CLI entrypoint, and update help text, banner, version output, command examples, and package scripts to Zoo branding.
    - **Files touched:** `packages/zoo-cli/package.json`, CLI entrypoint files, help/banner/version files, `packages/zoo-cli/README.md`.
    - **Acceptance criteria:** `zoo --help`, `zoo-code --help`, and version output use Zoo Code branding; no `kilo` binary remains in exported package metadata; package can build.
    - **Tests required:** CLI help/version snapshot or equivalent unit tests; package build.
    - **Docs required:** `packages/zoo-cli/README.md`; CHANGELOG `[Unreleased]`; JSDoc for any exported renamed entrypoints; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-cli): expose zoo binary entrypoints`
    - **Depends on:** Phase 1, Task 1.
    - **Can parallelize with:** Phase 1, Task 3.

3. Rebrand CLI config paths and project directories

    - **What:** Replace global config path usage with `~/.config/zoo-code/zoo.jsonc`, project config with `{project}/zoo.jsonc`, rules with `{project}/.zoo/rules/*.md`, modes with `{project}/.zoo/modes/*.json`, and ignore file usage with `{project}/.zooignore`.
    - **Files touched:** `packages/zoo-cli/src/config/**`, config constants, schema references, config tests, CLI docs.
    - **Acceptance criteria:** CLI config loader reads and writes Zoo paths from SPEC section 7; no exported config path uses Kilo branding; project `.zoo` directories are recognized.
    - **Tests required:** Unit tests for global config resolution, project config resolution, `.zoo/rules`, `.zoo/modes`, and `.zooignore`; config path snapshot tests.
    - **Docs required:** `packages/zoo-cli/README.md` config section; schema comments if schema exists; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-cli): rebrand config paths to zoo code`
    - **Depends on:** Phase 1, Task 1.
    - **Can parallelize with:** Phase 1, Tasks 2 and 4.

4. Remove Kilo-specific gateway and indexing integrations

    - **What:** Remove `@kilocode/kilo-gateway` and `@kilocode/kilo-indexing` dependencies and replace proprietary account/gateway behaviors with documented no-op/open stubs unless product owner selects a Zoo cloud direction.
    - **Files touched:** `packages/zoo-cli/package.json`, gateway/indexing integration modules, provider routing code, tests.
    - **Acceptance criteria:** CLI installs/builds without Kilo proprietary packages; BYOK providers remain available; gateway-related commands fail gracefully or are absent per existing CLI pattern; no Kilo account requirement exists for local use.
    - **Tests required:** Unit tests for gateway-disabled behavior; provider routing tests verifying BYOK path still works; full package build.
    - **Docs required:** CLI README note that Zoo Code is BYOK unless cloud service is later added; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `refactor(zoo-cli): remove kilo cloud integrations`
    - **Depends on:** Phase 1, Task 1; Open Question 3 answered for final behavior.
    - **Can parallelize with:** Phase 1, Tasks 2 and 3.

5. Add AGENTS and Zoo rules ingestion

    - **What:** Ensure CLI config/instruction loading reads `{project}/AGENTS.md` and `{project}/.zoo/rules/*.md` into the shared prompt/rules model used by agent sessions.
    - **Files touched:** `packages/zoo-cli/src/config/**`, instruction/rules parser modules, tests, docs.
    - **Acceptance criteria:** A session started in a project with `AGENTS.md` and `.zoo/rules/*.md` includes both sources in deterministic order; missing files are handled without error.
    - **Tests required:** Unit tests for AGENTS-only, rules-only, combined, and missing-file cases; integration test that a mocked run receives loaded instructions.
    - **Docs required:** CLI README rules section; schema comments if rules are schema-referenced; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-cli): load agents and zoo rules`
    - **Depends on:** Phase 1, Task 3.
    - **Can parallelize with:** Phase 1, Task 6.

6. Implement Roo/Zoo mode ingestion bridge

    - **What:** Support mode definitions from existing `.roomodes` during migration and from Zoo target locations (`.zoomodes` if chosen or `.zoo/modes/*.json` / `zoo.jsonc` modes section as specified). Expose modes to CLI command selection.
    - **Files touched:** `packages/zoo-cli/src/config/**`, mode parser modules, CLI option parsing, tests, docs.
    - **Acceptance criteria:** `zoo --mode architect` resolves an available mode; `.roomodes` is read additively for migration; `.zoo/modes/*.json` is supported; invalid modes produce actionable errors.
    - **Tests required:** Unit tests for `.roomodes`, `.zoo/modes`, duplicate/invalid modes, and CLI `--mode`; integration test with mocked run selecting a mode.
    - **Docs required:** CLI README mode migration section; config schema comments; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-cli): support zoo mode ingestion`
    - **Depends on:** Phase 1, Task 3.
    - **Can parallelize with:** Phase 1, Task 5.

7. [✅] Audit and merge missing Zoo/Roo providers

    - **What:** Compare `packages/zoo-cli/src/providers/` with current Zoo/Roo provider implementations and merge missing providers required for Zoo Code's 500+ model support.
    - **Files touched:** `packages/zoo-cli/src/providers/**`, provider registry, provider config types, provider tests, README provider docs.
    - **Acceptance criteria:** Provider parity matrix lists all current Zoo providers and CLI support status; missing open providers are implemented or explicitly deferred with rationale; existing BYOK providers continue to work.
    - **Tests required:** Unit tests for provider registry entries and config validation; mocked provider request tests for newly merged providers.
    - **Docs required:** Provider matrix in `packages/zoo-cli/README.md` or package docs; JSDoc for exported provider types/functions; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-cli): align provider registry with zoo code`
    - **Depends on:** Phase 1, Tasks 1 and 4.
    - **Can parallelize with:** Phase 1, Tasks 5 and 6.

8. [✅] Add CLI server and run smoke coverage

    - **What:** Verify the portable core exposes `zoo server --ipc ...` and `zoo run <task>` using the shared agent runtime, with mocked LLM support for deterministic tests.
    - **Files touched:** `packages/zoo-cli/src/server/**`, CLI command files, run command tests, server tests.
    - **Acceptance criteria:** `zoo server --ipc /tmp/zoo-test.sock` starts a local server; `zoo run "<task>"` executes through the runtime with mocked provider; process exits cleanly on shutdown.
    - **Tests required:** Server startup/shutdown integration tests; run command mocked-provider integration test; full CLI package test suite.
    - **Docs required:** CLI README quickstart; JSDoc for exported server start/stop functions; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-cli): enable server and run commands`
    - **Depends on:** Phase 1, Tasks 2, 3, 4, 5, 6, and 7.
    - **Can parallelize with:** None.

9. [✅] Add VS Code CLI binary preparation script
    - **What:** Add `prepare:cli-binary` to `packages/zoo-vscode` following Kilo's `script/local-bin.ts` pattern so the built CLI binary can be embedded in the VSIX.
    - **Files touched:** `packages/zoo-vscode/package.json`, `packages/zoo-vscode/script/local-bin.ts` or equivalent, `.vscodeignore`, build scripts, docs.
    - **Acceptance criteria:** Running the preparation script copies the correct Zoo CLI binary artifact into extension assets; `.vscodeignore` includes the binary in packaged VSIX; script works with the selected runtime/toolchain.
    - **Tests required:** Script unit test or integration smoke test; extension package dry-run if available.
    - **Docs required:** `packages/zoo-vscode/README.md` build instructions; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `build(zoo-vscode): embed zoo cli binary`
    - **Depends on:** Phase 1, Task 8; Open Question 2 answered for runtime choice.
    - **Can parallelize with:** Phase 2 implementation tasks after SDK shape is stable.

## Phase 2 — Zoo SDK Package

1. [✅] Define SDK package exports and shared types

    - **What:** Create `@zoo-code/sdk` with exported shared types: `Session`, `Message`, `MessageChunk`, `ToolCall`, `ToolResult`, `Provider`, `Mode`, `Permission`, and `WorktreeInfo`.
    - **Files touched:** `packages/zoo-sdk/package.json`, `packages/zoo-sdk/src/types.ts`, `packages/zoo-sdk/src/index.ts`, package tsconfig/build files, README.
    - **Acceptance criteria:** Package builds and exports all listed types; types match CLI server API contracts; every exported type has JSDoc.
    - **Tests required:** Type export test or compile-time type test; package build.
    - **Docs required:** `packages/zoo-sdk/README.md`; JSDoc for every exported type; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-sdk): define shared client types`
    - **Depends on:** Phase 0 complete; Phase 1, Task 1 for server API reference.
    - **Can parallelize with:** Phase 1, Tasks 3-7; Phase 4, Task 1.

2. [✅] Implement `ZooClient` interface

    - **What:** Implement `ZooClient` with `connect`, `createSession`, `sendMessage`, `getSession`, `listSessions`, `abortSession`, and `on` methods matching SPEC section 4 Phase 2.
    - **Files touched:** `packages/zoo-sdk/src/client.ts`, `packages/zoo-sdk/src/index.ts`, SDK tests.
    - **Acceptance criteria:** Client compiles; method signatures match spec; streaming `sendMessage` returns `AsyncIterableIterator<MessageChunk>`; event subscription is typed or documented.
    - **Tests required:** Unit tests for method request construction, streaming iteration, and event handling using mocked transport.
    - **Docs required:** SDK README client usage; JSDoc for `ZooClient` and exported methods; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-sdk): add zoo client interface`
    - **Depends on:** Phase 2, Task 1.
    - **Can parallelize with:** Phase 2, Task 3 after transport contract is agreed.

    - **Progress:** Added route-parity wrappers for pending permissions, config warnings, config updates, and permission always-rule saves. The Effect HttpApi config bridge now also exposes `/config/warnings` to match the legacy Hono route.

3. [✅] Implement IPC/HTTP transport layer

    - **What:** Wrap the CLI local IPC/HTTP server API so SDK consumers can connect via `ipcPath` or `httpPort`, following Kilo's SDK pattern.
    - **Files touched:** `packages/zoo-sdk/src/transport/**` or equivalent, `packages/zoo-sdk/src/client.ts`, transport tests.
    - **Acceptance criteria:** SDK can connect to a running mocked CLI server by IPC or HTTP; connection errors surface actionable diagnostics; transport is isolated from VS Code APIs.
    - **Tests required:** Mock server integration tests for IPC and HTTP; error handling tests; full SDK tests.
    - **Docs required:** SDK README connection examples; JSDoc for exported transport options; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-sdk): connect over local cli transport`
    - **Depends on:** Phase 2, Task 2; Phase 1, Task 8 for actual server verification.
    - **Can parallelize with:** Phase 2, Task 4 after client construction exists.

4. [✅] Implement CLI process lifecycle management

    - **What:** Add SDK functionality to detect an existing Zoo CLI server, spawn `zoo server --ipc /tmp/zoo-{pid}.sock` when needed, gracefully stop it, and restart unexpected exits up to three times before surfacing an error.
    - **Files touched:** `packages/zoo-sdk/src/process/**` or equivalent, `packages/zoo-sdk/src/client.ts`, lifecycle tests.
    - **Acceptance criteria:** SDK starts CLI server when no server is running; connects to existing server when available; shuts down cleanly; restarts unexpected exits with capped retries; no VS Code-specific code is required.
    - **Tests required:** Mock process lifecycle tests for start, reuse, shutdown, crash restart, and retry exhaustion.
    - **Docs required:** SDK README lifecycle section; JSDoc for exported lifecycle options; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-sdk): manage zoo cli process lifecycle`
    - **Depends on:** Phase 2, Tasks 2 and 3.
    - **Can parallelize with:** Phase 1, Task 9.

5. [✅] Add SDK round-trip integration coverage
    - **What:** Add integration tests that exercise `ZooClient` against a mocked or real local `zoo-cli` server for session creation, streaming, session listing, abort, and shutdown.
    - **Files touched:** `packages/zoo-sdk/test/**`, test fixtures, CI/test scripts if needed.
    - **Acceptance criteria:** SDK round trips pass deterministically without real LLM calls; tests validate message chunk order and lifecycle cleanup.
    - **Tests required:** Integration tests for create/list/get/send/abort/shutdown; full SDK suite.
    - **Docs required:** README test instructions if new commands are added; CHANGELOG `[Unreleased]` if user-facing behavior changed; update `HANDOFF.md`.
    - **Commit message:** `test(zoo-sdk): cover cli client round trips`
    - **Depends on:** Phase 2, Tasks 3 and 4; Phase 1, Task 8 for real server tests.
    - **Can parallelize with:** Phase 3 audit tasks only, not rewire tasks.

## Phase 3 — VS Code Extension Rewire

1. [✅] Audit extension host code into migration buckets

    - **What:** Map modules in `packages/zoo-vscode/src/` to core agent logic, VS Code host glue, or shared types/utils as defined in SPEC section 4 Phase 3a.
    - **Files touched:** `docs/extension-rewire-audit.md` or equivalent audit doc, `HANDOFF.md`.
    - **Acceptance criteria:** Audit lists every relevant module under `src/core/`, `src/api/`, `src/services/`, `src/extension.ts`, and `src/providers/webview/`; each entry has a destination and migration note.
    - **Tests required:** None beyond ensuring no code changed; if imports changed accidentally, run existing typecheck.
    - **Docs required:** Audit document; update `HANDOFF.md`.
    - **Commit message:** `docs(zoo-vscode): audit extension rewire boundaries`
    - **Depends on:** Phase 0 complete.
    - **Can parallelize with:** Phase 1 and Phase 2 tasks.

2. [✅] Add portable core feature flag

    - **What:** Implement `zoo-code.usePortableCore` setting and helper `usePortableCore(): boolean` in `packages/zoo-vscode/src/config/`, defaulting to `false`, exactly before any SDK-based rewire tasks.
    - **Files touched:** `packages/zoo-vscode/package.json` contributes/configuration section, `packages/zoo-vscode/src/config/**`, extension config tests, README.
    - **Acceptance criteria:** VS Code setting `zoo-code.usePortableCore` exists, defaults to `false`, and helper returns the setting value; old code path remains default; all future SDK code can gate on this helper.
    - **Tests required:** Unit test for default false and configured true; package manifest validation/build.
    - **Docs required:** `packages/zoo-vscode/README.md` feature flag note; JSDoc for `usePortableCore`; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-vscode): add portable core feature flag`
    - **Depends on:** Phase 3, Task 1.
    - **Can parallelize with:** Phase 2 tasks; must complete before Phase 3 Tasks 4-12.

3. [✅] Add SDK dependency and activation bootstrap scaffold

    - **What:** Add `@zoo-code/sdk` as a workspace dependency and create an activation-time bootstrap service that can initialize `ZooClient` only when `usePortableCore()` is true.
    - **Files touched:** `packages/zoo-vscode/package.json`, `packages/zoo-vscode/src/extension.ts`, new bootstrap service under `packages/zoo-vscode/src/**`, tests.
    - **Acceptance criteria:** Extension activation does not start SDK when flag is false; when true, activation attempts SDK bootstrap through isolated service; old activation still works.
    - **Tests required:** Extension activation tests for flag false and true with mocked SDK; package build.
    - **Docs required:** README developer note; JSDoc for exported bootstrap service; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-vscode): bootstrap sdk behind feature flag`
    - **Depends on:** Phase 2, Task 4; Phase 3, Task 2.
    - **Can parallelize with:** Phase 3, Task 4 after contracts are defined.

4. [✅] Version webview message protocol contracts

    - **What:** Audit and define the host-webview message protocol before changing behavior, including streaming chunks, tool approval requests, session state changes, send message, abort, approve tool, and change mode actions.
    - **Files touched:** `packages/zoo-vscode/webview-ui/src/**` message type files, `packages/zoo-vscode/src/**` bridge type files, shared contract docs/tests.
    - **Acceptance criteria:** Every current `postMessage` type has a documented old and target mapping; protocol version is explicit; contract tests fail on incompatible message shape changes.
    - **Tests required:** Message contract tests for all current and target message types.
    - **Docs required:** Protocol doc or README section; JSDoc for exported message types; CHANGELOG `[Unreleased]` if user-facing behavior changes; update `HANDOFF.md`.
    - **Commit message:** `test(zoo-vscode): define webview message contracts`
    - **Depends on:** Phase 3, Tasks 1 and 2.
    - **Can parallelize with:** Phase 3, Task 3.

5. [✅] Rewire session creation and lookup paths

    - **What:** Replace extension-host session create/get/list flows with `ZooClient.createSession()`, `getSession()`, and `listSessions()` when the feature flag is true; preserve old behavior when false.
    - **Files touched:** Session services/controllers in `packages/zoo-vscode/src/**`, SDK bootstrap service, tests.
    - **Acceptance criteria:** Flag false uses old in-process session logic; flag true uses SDK session APIs; session list and current-session display still work in webview.
    - **Tests required:** Unit tests for both flag paths; mocked SDK integration tests for create/get/list; extension activation regression tests.
    - **Docs required:** JSDoc for exported adapter functions; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-vscode): route sessions through zoo sdk`
    - **Depends on:** Phase 3, Tasks 2, 3, and 4.
    - **Can parallelize with:** Phase 3, Task 6 if adapters are isolated.

6. [✅] Rewire message sending and streaming responses

    - **What:** Replace direct agent execution/send-message paths with `ZooClient.sendMessage()` under the feature flag and forward streaming chunks to the webview protocol.
    - **Files touched:** Chat/message controllers, webview bridge, streaming handlers, tests.
    - **Acceptance criteria:** Flag true streams SDK `MessageChunk` events into existing chat UI; abort/error states are handled; flag false remains unchanged.
    - **Tests required:** Mocked streaming tests for chunk order, completion, error, and cancellation; webview contract tests.
    - **Docs required:** JSDoc for exported stream adapter functions; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-vscode): stream chat through zoo sdk`
    - **Depends on:** Phase 3, Tasks 3 and 4; Phase 2, Task 5.
    - **Can parallelize with:** Phase 3, Task 5 if shared adapters are stable.

7. [✅] Rewire abort and process lifecycle UX

    - **What:** Route abort actions through `ZooClient.abortSession()` when the feature flag is true and surface SDK process lifecycle errors/restarts to the extension logger or user notification path.
    - **Files touched:** Abort command handlers, lifecycle notification/logging modules, tests.
    - **Acceptance criteria:** Abort button/command cancels active SDK session; unexpected CLI restart is logged; retry exhaustion surfaces an actionable error; old abort path remains when flag false.
    - **Tests required:** Mocked abort tests; lifecycle error notification tests; flag-path tests.
    - **Docs required:** README troubleshooting note for portable core process failures; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-vscode): handle sdk abort and lifecycle events`
    - **Depends on:** Phase 3, Tasks 3 and 6.
    - **Can parallelize with:** Phase 3, Task 8.

8. Rewire tool approval bridge

    - **What:** Proxy SDK tool approval requests to the existing webview approval UI and route approval/denial responses back through the SDK/CLI protocol.
    - **Files touched:** Tool approval handlers, webview bridge, approval message types, tests.
    - **Acceptance criteria:** Bash/file-write approval prompts display in the webview under portable-core mode; user decisions reach CLI; denied tools do not execute; old approval path remains when flag false.
    - **Tests required:** Contract tests for approval request/response messages; mocked SDK approval flow tests; denial-path tests.
    - **Docs required:** JSDoc for approval adapter types; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-vscode): proxy tool approvals to cli core`
    - **Depends on:** Phase 3, Tasks 4 and 6.
    - **Can parallelize with:** Phase 3, Task 7.

    - **Progress:** SDK and VS Code adapter expose CLI event subscription and permission reply methods. `ClineProvider` now subscribes to portable `permission.asked` events when the adapter is present, maps bash requests to existing `command` asks, maps file-diff edit requests to existing `appliedDiff` tool approval payloads, maps other requests to existing tool/MCP asks, stores transient pending request IDs, and routes yes/no/message/object responses back through `replyPermission()` while preserving the legacy no-adapter path. Remaining work: validate against real CLI permission event payloads and add any missing specialized tool mappings.

9. Rewire provider config access

    - **What:** Replace direct reads of VS Code provider settings with SDK/config-derived provider state under the feature flag, while preserving old settings path until migration is complete.
    - **Files touched:** Provider config services, settings UI bridge if present, tests.
    - **Acceptance criteria:** Portable-core mode uses `zoo.jsonc` provider config through SDK/CLI; old VS Code settings remain used when flag false; missing config produces migration guidance.
    - **Tests required:** Unit tests for flag paths, missing config, and provider config retrieval; mocked SDK tests.
    - **Docs required:** README provider config migration note; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-vscode): read provider config from portable core`
    - **Depends on:** Phase 3, Task 3; Phase 4, Tasks 1 and 2.
    - **Can parallelize with:** Phase 3, Task 10 after config schema is stable.

    - **Progress:** SDK and VS Code adapter can read portable-core `/config` and `/config/providers`. `ExtensionState` now carries optional read-only portable provider metadata, and `ClineProvider.getStateToPostToWebview()` populates it from `PortableSessionAdapter.getConfigProviders()` when the adapter is present without mutating `ProviderSettingsManager` or legacy VS Code profiles. `SettingsView` now renders portable provider metadata as read-only guidance from `cachedState` and suppresses legacy `upsertApiConfiguration` saves while portable provider config is active. Extension-host save/upsert/rename message paths now ignore legacy profile mutations when portable provider config is read-only. Remaining work: finalize selected portable defaults once Phase 4 config schema semantics are stable.

10. Rewire mode selection actions

- **What:** Route webview/command mode selection through SDK/CLI mode APIs under the feature flag so `.roomodes` and `.zoo/modes` selections match CLI behavior.
- **Files touched:** Mode services, command handlers, webview action handlers, tests.
- **Acceptance criteria:** Mode list and selected mode come from portable core when flag true; `change mode` action updates active SDK session/config as designed; old mode service remains when flag false.
- **Tests required:** Mocked mode listing and selection tests; webview message contract tests; flag-path tests.
- **Docs required:** README mode migration note; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
- **Commit message:** `feat(zoo-vscode): route modes through portable core`
- **Depends on:** Phase 3, Task 4; Phase 1, Task 6; Phase 4, Task 2.
- **Can parallelize with:** Phase 3, Task 9.

- **Progress:** SDK and VS Code adapter can list portable-core agents/modes from `/agent`, with SDK mapping aligned to CLI agent fields (`name`, `displayName`, `mode`). Portable text sends translate the selected VS Code mode to the CLI `agent` request field. `ClineProvider.getModes()` now returns `PortableSessionAdapter.listModes()` data when the adapter is present and preserves the legacy `CustomModesManager` path when absent. The webview now keeps read-only portable modes in `ExtensionState.availableModes`, requests them when portable provider state is active, uses them for the visible mode selector, slash-mode mentions, and keyboard mode cycling, and hides mode-management controls because portable modes are CLI-managed. Current coverage pins that portable sends use the persisted global selected mode after mode switching. Remaining behavior gap: restoring a selected portable session does not restore a per-session mode because portable session metadata currently has no mode field; product semantics are needed before adding per-session mode persistence.

11. Add settings and mode migration wizard

- **What:** Add command `Migrate Zoo Code settings` that reads existing VS Code extension settings and legacy `.roomodes` data, then writes additive `zoo.jsonc` and `.zoo/modes` output without deleting old config.
- **Files touched:** `packages/zoo-vscode/package.json` command contributions, migration command/service files, config writer modules, tests, docs.
- **Acceptance criteria:** Command appears in VS Code; migration writes Zoo config alongside old settings; migration is idempotent; no old config is deleted; complex `.roomodes` files are preserved or reported clearly.
- **Tests required:** Unit tests for settings conversion, `.roomodes` conversion, idempotency, and invalid input; command registration test.
- **Docs required:** `packages/zoo-vscode/README.md` migration section; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
- **Commit message:** `feat(zoo-vscode): add config migration wizard`
- **Depends on:** Phase 4, Tasks 1 and 2; Phase 3, Task 2.
- **Can parallelize with:** Phase 3, Task 12.

12. Validate portable core end-to-end behind flag

- **What:** Run extension with `zoo-code.usePortableCore` true and mocked LLM/provider to validate activation, session creation, streaming chat, approval flow, abort, and mode selection through SDK.
- **Files touched:** E2E test harness, extension integration tests, bug fixes in touched adapters only.
- **Acceptance criteria:** Portable-core flow passes deterministic e2e coverage; flag false regression tests still pass; any known behavior gaps are documented and linked to Phase 5 tasks.
- **Tests required:** Extension e2e tests with mocked LLM; full extension test suite; full workspace suite.
- **Docs required:** README feature flag testing instructions; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
- **Commit message:** `test(zoo-vscode): verify portable core flow behind flag`
- **Depends on:** Phase 3, Tasks 5-10; Phase 2 complete.
- **Can parallelize with:** None.

- **Progress:** Adapter-level deterministic validation is in place for portable-core sessions, streamed message chunks, server event envelopes, non-permission event properties, `permission.asked` event properties, mode lists, and provider-config responses. ClineProvider coverage proves valid non-permission events are ignored while later approval requests still reach the bridge; full extension e2e flow validation still depends on completing visible approval, provider config, and mode UI seams.

- **Progress:** Added deterministic ClineProvider coverage using a real `PortableSessionAdapter` over a fake SDK client, proving validated `permission.asked` events reach the approval UI and replies route back through the SDK boundary.

## Phase 4 — Config Model Unification

1. Define `zoo.jsonc` schema

    - **What:** Create or update JSON schema for global and project `zoo.jsonc`, extending OpenCode config with Zoo/Roo mode and rule concepts.
    - **Files touched:** `schemas/**`, `packages/zoo-cli/src/config/**` schema types if colocated, `packages/zoo-sdk/src/types.ts` if config types are exported, docs.
    - **Acceptance criteria:** Schema covers providers, default model, tool permissions, modes, global rules, and project overrides; schema validates examples for global and project config.
    - **Tests required:** Schema validation tests for valid/invalid examples; type generation tests if applicable.
    - **Docs required:** Schema comments/descriptions; config docs in CLI README; JSDoc for exported config types; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(config): define zoo jsonc schema`
    - **Depends on:** Phase 0 complete.
    - **Can parallelize with:** Phase 1 and Phase 2 tasks.

    - **Progress:** Added focused generated-schema coverage proving `Config.Info.zod` exposes provider, model, default agent, agent, instruction/rules path, and permission keys for `zoo.jsonc`, and accepts a representative Zoo config with provider/model/agent/instructions/top-level and agent-level permissions. `packages/zoo-cli/script/schema.ts` can generate the schema from `Config.Info.zod`, but checking in the generated file and adding VS Code `jsonValidation` are deferred until the product selects a canonical shipped or hosted schema location. A root `schemas/` file would not automatically be packaged in the VSIX, while an extension-local schema needs an explicit package location and `.vscodeignore` decision.

2. Implement unified config loader

    - **What:** Implement config loading in `packages/zoo-cli/src/config/` for `~/.config/zoo-code/zoo.jsonc`, `{project}/zoo.jsonc`, `{project}/AGENTS.md`, `{project}/.zoo/rules/*.md`, `{project}/.zoo/modes/*.json`, and `{project}/.zooignore`.
    - **Files touched:** `packages/zoo-cli/src/config/**`, config tests, fixtures, docs.
    - **Acceptance criteria:** Global and project configs merge deterministically; project config overrides global fields where specified; AGENTS/rules/modes/ignore files are loaded; missing optional files do not fail.
    - **Tests required:** Unit tests for merge precedence, file discovery, invalid JSONC, missing files, modes, rules, and ignore handling.
    - **Docs required:** CLI README config hierarchy; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(config): load unified zoo configuration`
    - **Depends on:** Phase 4, Task 1; Phase 1, Task 3.
    - **Can parallelize with:** Phase 4, Task 4 after schema is stable.

    - **Progress:** Added regression coverage proving the existing config loader accepts `watcher.ignore` arrays and reports warnings for invalid watcher ignore shapes. Added focused coverage proving project `zoo.jsonc` loads Zoo-native provider, primary agent, model, and instruction fields through the unified config loader. Added focused `Config.get()` integration coverage proving `.zoo/modes/*.json` becomes agent config, `.zoo/rules/*.md` becomes deterministic instructions, `.zooignore` becomes read/edit permission rules with negation support, and `.zoo/modes` overrides legacy `.roomodes` for the same mode slug. Added instruction-layer coverage proving project `AGENTS.md` is loaded before sorted `.zoo/rules/*.md` content when config-discovered rule paths feed system instructions. Added focused precedence coverage proving project `zoo.jsonc` overrides global Zoo `zoo.jsonc` for overlapping scalar fields while preserving global-only fields. Added focused merge coverage proving global/project Zoo configs deep-merge provider and agent objects, concat/dedupe `instructions`, and replace ordinary arrays. Fixed the project and global shell update regression assertions so they read the Zoo-native `zoo.jsonc` update targets rather than stale legacy config files, with global tests isolating homedir to avoid touching user config. Fixed project config-directory target ordering so `.kilo` overrides legacy `.kilocode` for both config files and discovered commands. Isolated the permission key-order regression from real Zoo global config; the full `packages/zoo-cli/test/config/config.test.ts` file now passes.

3. Add VS Code config watcher for portable core

    - **What:** Watch Zoo config files from the extension and trigger CLI reload or restart when relevant files change.
    - **Files touched:** `packages/zoo-vscode/src/config/**`, extension activation/disposal code, tests.
    - **Acceptance criteria:** Changes to global/project `zoo.jsonc`, `AGENTS.md`, `.zoo/rules`, `.zoo/modes`, and `.zooignore` are detected; portable core reload/restart is requested; watchers are disposed on deactivation.
    - **Tests required:** Mocked file watcher tests for each config path; disposal tests; SDK reload/restart interaction tests.
    - **Docs required:** VS Code README note about config reload behavior; JSDoc for exported watcher setup; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-vscode): watch zoo config files`
    - **Depends on:** Phase 3, Task 3; Phase 4, Task 2.
    - **Can parallelize with:** Phase 4, Task 4.

    - **Progress:** Added an SDK `invalidateConfig()` wrapper for `POST /global/dispose`, `PortableCoreService.reloadConfig()`, and a debounced VS Code watcher for global/project `zoo.jsonc`, `AGENTS.md`, `.zoo/rules`, `.zoo/modes`, and `.zooignore` that invalidates portable-core config caches when files change.

4. Document Roo-to-Zoo config migration

    - **What:** Document migration from VS Code settings, `.roomodes`, `.roo/rules`, and `.rooignore` to `zoo.jsonc`, `.zoo/modes`, `.zoo/rules`, and `.zooignore`.
    - **Files touched:** Root README if migration is global, `packages/zoo-cli/README.md`, `packages/zoo-vscode/README.md`, migration docs if present.
    - **Acceptance criteria:** Users can identify old and new config locations; docs state migration is additive and does not delete old config; examples show modes and provider config.
    - **Tests required:** Documentation link/check tests if available.
    - **Docs required:** README migration sections; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `docs(config): explain roo to zoo migration`
    - **Depends on:** Phase 4, Task 1.
    - **Can parallelize with:** Phase 4, Task 3.

    - **Progress:** Updated CLI, root, and VS Code READMEs with additive migration notes for `zoo.jsonc`, `.zoo/modes`, `.zoo/rules`, `.zooignore`, `AGENTS.md`, read-only portable provider config in VS Code, and CLI-managed mode selection.

## Phase 5 — Feature Parity Matrix Implementation

- **Progress:** SDK route parity started with provider route wrappers for listing providers, reading provider auth methods, and running provider OAuth authorize/callback flows through existing CLI routes. Added persisted session message/part wrappers for listing, reading, deleting, and updating stored message data. Added session maintenance wrappers for status, children, todo, update, delete, viewed-session state, fork, diff, share/unshare, revert, unrevert, and no-reply promptAsync routes. Added worktree lifecycle wrappers for list/create/remove/reset routes. Added SDK wrappers for legacy Hono worktree diff, diff summary, and diff-file routes, and added matching Effect HttpApi parity for those worktree diff routes. Added deterministic generated SDK HttpApi smoke coverage for file read, session create/list, project current, config get, config warnings, and find files while leaving provider discovery isolated. Enabled generated SDK parity coverage for deterministic instance read routes across direct and HttpApi backends, including config warnings, VCS diff, and `find.symbols()` while excluding provider, agent, and command discovery until Kilo overlays/review command initialization are isolated. Added generated SDK question list/reply/reject parity using missing request IDs to avoid seeding LLM/question state, and added hand-written `@zoo-code/sdk` wrappers for listing, replying to, and rejecting question requests. Added generated SDK permission missing-request parity for list/reply/always-rules without seeding permission state. Added generated SDK MCP status parity using a disabled local MCP fixture to avoid spawning or network access. Added hand-written `@zoo-code/sdk` wrappers for path metadata, VCS metadata, VCS diffs, command listing, skill/LSP/formatter/tool-ID metadata, file read/list/status, file/text search, workspace symbol search, MCP status, project list/current/init-git, project update routes, and experimental session/resource/workspace read routes. Added generated SDK experimental read parity for session list, resources, workspace adapters, workspaces, and workspace status. Remaining SDK/CLI route parity wrappers should be added in coherent groups for any remaining session action routes.
- **Progress addendum:** Added generated SDK project update parity for project name, icon color, and start command metadata across direct and HttpApi backends.
- **Progress addendum:** Added generated SDK worktree diff, diff summary, and diff-file route parity across direct and HttpApi backends using a deterministic temp git fixture.
- **Progress addendum:** Added generated SDK PTY shells/list read parity across direct and HttpApi backends without creating or connecting PTYs.
- **Progress addendum:** Added hand-written `@zoo-code/sdk` wrappers for PTY shells/list read routes with mocked transport coverage.
- **Progress addendum:** Added hand-written `@zoo-code/sdk` wrappers for portable-core TUI prompt append/submit/clear, help/sessions/themes/models dialogs, command, toast, and session selection routes with mocked transport coverage.
- **Progress addendum:** Added generated SDK sync history read parity across direct and HttpApi backends with seeded event rows, while excluding sync start/replay side effects.
- **Progress addendum:** Fixed generated SDK parameter handling to preserve explicitly supplied empty bodies, closing the `sync.history.list({ body: {} })` direct-vs-HttpApi parity gap.
- **Progress addendum:** Added a hand-written `@zoo-code/sdk` wrapper for sync history reads with mocked transport coverage, keeping sync start/replay excluded.

- **Progress:** Fixed the focused generated SDK no-reply prompt route parity test by supplying explicit fake model metadata, keeping the route test out of provider discovery while preserving no-LLM behavior.

1. Add CLI context flag support

    - **What:** Implement CLI support for context mentions via explicit flags such as `--context file.ts` so CLI can represent VS Code `@file` and `@folder` context.
    - **Files touched:** `packages/zoo-cli/src/cli/**`, context ingestion modules, tests, README.
    - **Acceptance criteria:** `zoo run "task" --context file.ts` includes file context; folder context is supported or explicitly validated; invalid paths produce clear errors.
    - **Tests required:** CLI parser tests; context loader tests for files/folders/missing paths; mocked run integration test.
    - **Docs required:** CLI README context examples; JSDoc for exported context option types; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-cli): add context flags for run tasks`
    - **Depends on:** Phase 1, Task 8; Phase 4, Task 2.
    - **Can parallelize with:** Phase 5, Tasks 2 and 3.

    - **Progress:** Added `zoo run --context <path>` for files and folders by reusing the existing file-part ingestion path. Context parts are sent before `--file` attachments and prompt text, and command invocations receive the same context/file parts through the existing command input shape. Focused run smoke coverage pins file and directory context payloads. Folder content expansion remains the existing portable-core directory reader behavior rather than a new recursive context implementation.

2. Add CLI tool approval modes

    - **What:** Ensure CLI supports interactive TTY approval prompts and non-interactive `--auto-approve` behavior using the shared approval protocol.
    - **Files touched:** `packages/zoo-cli/src/tools/**`, approval prompt modules, CLI option parsing, tests, README.
    - **Acceptance criteria:** Interactive CLI prompts before bash/file-write tools unless auto-approved; `--auto-approve` bypasses prompts according to permissions; non-TTY mode has deterministic failure or configured behavior.
    - **Tests required:** Unit tests for approval policy; TTY prompt tests with mocked input; non-TTY tests; auto-approve tests.
    - **Docs required:** CLI README approval section; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-cli): support cli tool approvals`
    - **Depends on:** Phase 1, Task 8; Phase 3, Task 8 for shared approval validation.
    - **Can parallelize with:** Phase 5, Tasks 1 and 3.

3. Add `zoo commit` convenience command

    - **What:** Implement the CLI shortcut for commit message generation through the shared agent runtime, matching the parity matrix entry.
    - **Files touched:** `packages/zoo-cli/src/cli/**`, command modules, tests, README.
    - **Acceptance criteria:** `zoo commit` invokes the runtime with git diff context and returns a proposed commit message; no git commit is performed unless existing CLI design explicitly supports that behavior.
    - **Tests required:** CLI command tests with mocked git/diff and mocked provider; error tests outside git repo.
    - **Docs required:** CLI README command docs; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-cli): add commit message command`
    - **Depends on:** Phase 1, Task 8.
    - **Can parallelize with:** Phase 5, Tasks 1 and 2.

4. Validate shared session continuity between CLI and VS Code

    - **What:** Ensure sessions persisted by CLI can be listed/resumed by VS Code and sessions started in VS Code can be listed/resumed by CLI.
    - **Files touched:** `packages/zoo-cli/src/session/**`, `packages/zoo-sdk/**`, `packages/zoo-vscode/src/**`, tests.
    - **Acceptance criteria:** Shared session database is used by both surfaces; session IDs are stable; resume/list behavior matches through SDK and CLI.
    - **Tests required:** Integration tests creating session through CLI then reading through SDK/VS Code adapter, and inverse path; mocked LLM only.
    - **Docs required:** CLI and VS Code README session continuity notes; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(session): share sessions across cli and vscode`
    - **Depends on:** Phase 2 complete; Phase 3, Task 12.
    - **Can parallelize with:** Phase 5, Task 5.

5. Audit MCP and worktree parity

    - **What:** Compare Zoo/Roo MCP and worktree behavior against OpenCode-derived CLI behavior, then close documented gaps required by the parity matrix.
    - **Files touched:** `packages/zoo-cli/src/tools/**`, MCP modules, worktree modules, VS Code integration adapters if needed, tests, parity docs.
    - **Acceptance criteria:** MCP and worktree parity gaps are listed; required gaps are fixed or explicitly deferred; CLI and VS Code use shared behavior where possible.
    - **Tests required:** MCP config/connection tests with mocked server; worktree operation tests with temporary git repo; VS Code adapter tests if touched.
    - **Docs required:** Parity matrix doc/README update; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(parity): align mcp and worktree behavior`
    - **Depends on:** Phase 1, Task 7; Phase 3, Task 12.
    - **Can parallelize with:** Phase 5, Task 4.

    - **Progress:** Closed a narrow MCP parity documentation/schema gap: root migration notes now list project MCP servers as `zoo.jsonc` `mcp` config with legacy `.kilocode/mcp.json` and `.kilo/mcp.json` as CLI migration fallbacks, and generated `zoo.jsonc` schema coverage now pins local and remote MCP config acceptance. Closed a narrow worktree parity checklist gap by listing the already-implemented Effect HttpApi worktree diff, diff summary, and diff-file routes.

6. Add CLI JSON output for scripting

    - **What:** Implement `--json` output for relevant CLI operations as the CLI-only intentional divergence for scripting/headless use.
    - **Files touched:** `packages/zoo-cli/src/cli/**`, output formatter modules, tests, README.
    - **Acceptance criteria:** `--json` produces machine-readable output for run/session commands without TUI formatting; errors are structured; default human output remains unchanged.
    - **Tests required:** Snapshot tests for JSON outputs and errors; CLI parser tests.
    - **Docs required:** CLI README scripting section; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `feat(zoo-cli): add json output mode`
    - **Depends on:** Phase 1, Task 8; Phase 5, Task 4 for session command shape if applicable.
    - **Can parallelize with:** Phase 5, Task 7.

    - **Progress:** Added `zoo agent list --format json` as the first small non-LLM JSON output mode. The output is a stable array of public agent metadata and structured permissions, excluding large prompt text and arbitrary options. Focused formatter coverage pins the JSON shape.

7. Decide and document out-of-scope parity items
    - **What:** Record product decisions for inline autocomplete, browser automation stretch scope, JetBrains/future IDE support, and cloud gateway behavior so parity work does not expand beyond SPEC scope.
    - **Files touched:** `SPEC.md`/`spec.md` if decisions amend the spec, `DEVPLAN.md` if tasks change, `HANDOFF.md`, README roadmap if present.
    - **Acceptance criteria:** Open questions affecting Phase 5 are answered or explicitly deferred; no implementation starts for out-of-scope items; changed scope is reflected in spec revision history.
    - **Tests required:** None.
    - **Docs required:** SPEC revision history entry if spec changes; CHANGELOG only if user-facing scope docs changed; update `HANDOFF.md`.
    - **Commit message:** `docs(parity): record scope decisions`
    - **Depends on:** Product-owner answers to Open Questions 3, 4, and 5.
    - **Can parallelize with:** Phase 5, Tasks 1-6 if decisions do not affect them.

## Phase 6 — Testing, CI, and Release Pipeline

1. Expand CLI core unit tests

    - **What:** Add or complete unit coverage for CLI agent loop, config loader, provider abstraction, session persistence, tool approval, and mode handling.
    - **Files touched:** `packages/zoo-cli/test/**` or package test directories, test fixtures, test scripts.
    - **Acceptance criteria:** Targeted CLI core areas have deterministic mocked tests; no tests require real API keys; package test command runs in CI.
    - **Tests required:** Unit tests listed in What; full CLI suite.
    - **Docs required:** CLI README testing notes if commands changed; CHANGELOG only for user-facing fixes found; update `HANDOFF.md`.
    - **Commit message:** `test(zoo-cli): cover core runtime behavior`
    - **Depends on:** Phase 1 complete; Phase 4, Task 2.
    - **Can parallelize with:** Phase 6, Tasks 2 and 3.

2. Expand SDK integration tests

    - **What:** Complete SDK tests for client-server round trips, streaming, process lifecycle, restart handling, and abort behavior.
    - **Files touched:** `packages/zoo-sdk/test/**`, test fixtures, scripts.
    - **Acceptance criteria:** SDK integration suite runs without real LLMs; lifecycle cleanup leaves no orphaned server processes; failures include actionable diagnostics.
    - **Tests required:** Integration tests for connect/create/send/list/get/abort/start/stop/restart.
    - **Docs required:** SDK README test instructions if changed; update `HANDOFF.md`.
    - **Commit message:** `test(zoo-sdk): cover client server integration`
    - **Depends on:** Phase 2 complete; Phase 1, Task 8.
    - **Can parallelize with:** Phase 6, Tasks 1 and 3.

3. Expand VS Code extension tests

    - **What:** Add tests for extension activation, command registration, webview message bridge, config watcher, migration wizard, and portable-core flag paths without real LLM calls.
    - **Files touched:** `packages/zoo-vscode/test/**`, test fixtures, package scripts.
    - **Acceptance criteria:** Extension tests cover flag false and true paths; command registration and webview contracts are deterministic; tests run headlessly in CI if supported.
    - **Tests required:** Extension activation, command registration, bridge, watcher, migration, and flag-path tests.
    - **Docs required:** VS Code README test instructions if changed; update `HANDOFF.md`.
    - **Commit message:** `test(zoo-vscode): cover portable core integration`
    - **Depends on:** Phase 3 complete; Phase 4, Task 3.
    - **Can parallelize with:** Phase 6, Tasks 1 and 2.

4. Add e2e parity test harness

    - **What:** Build a harness that runs the same mocked task through CLI and VS Code portable-core flow and asserts identical tool call sequences and final output.
    - **Files touched:** E2E test package or directories, mocked LLM fixtures, CI scripts, docs.
    - **Acceptance criteria:** At least one send-message/run-task parity test passes through both surfaces; tool call sequence comparison is deterministic; harness can add future parity cases.
    - **Tests required:** E2E parity tests for task run, tool approval, and session resume where feasible.
    - **Docs required:** Testing README or root README e2e section; CHANGELOG `[Unreleased]` if user-facing regressions are fixed; update `HANDOFF.md`.
    - **Commit message:** `test(e2e): add cli vscode parity harness`
    - **Depends on:** Phase 3, Task 12; Phase 5, Task 4.
    - **Can parallelize with:** Phase 6, Task 5 after basic package tests exist.

5. Update CI build and test pipeline

    - **What:** Add CI jobs for `packages/zoo-cli`, `packages/zoo-sdk`, and `packages/zoo-vscode`; include CLI binary packaging for macOS arm64/x64, Linux x64, and Windows x64; include VSIX build with embedded CLI binary.
    - **Files touched:** CI workflow files, `turbo.json`, package scripts, packaging scripts, docs.
    - **Acceptance criteria:** CI builds and tests all packages; CLI binaries are packaged for target platforms; VSIX build includes correct CLI binary; no real provider credentials are needed.
    - **Tests required:** CI dry run or workflow validation; full local test/build before commit.
    - **Docs required:** Root README CI/release notes; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `ci: build and package zoo cli and vscode extension`
    - **Depends on:** Phase 6, Tasks 1, 2, and 3; Phase 1, Task 9.
    - **Can parallelize with:** Phase 6, Task 4 once package commands are stable.

6. Implement coordinated release versioning
    - **What:** Configure single-version release flow so CLI and VS Code extension versions are updated together via changeset or existing release mechanism.
    - **Files touched:** Changeset/release config, `packages/zoo-cli/package.json`, `packages/zoo-vscode/package.json`, root release scripts, docs.
    - **Acceptance criteria:** One release command updates CLI and VS Code extension to the same version; changelog generation includes both packages; package manifests stay in sync.
    - **Tests required:** Release dry-run test; package version sync test or script validation.
    - **Docs required:** Release docs in root README or release guide; CHANGELOG `[Unreleased]`; update `HANDOFF.md`.
    - **Commit message:** `build(release): coordinate zoo package versions`
    - **Depends on:** Phase 6, Task 5.
    - **Can parallelize with:** None.

## Habits

- Run the full test suite before committing.
- Never commit broken builds.
- Update `CHANGELOG.md` under `[Unreleased]` for every user-facing change.
- Update the relevant package `README.md` when a new capability is added.
- Write JSDoc for every exported function and type.
- Keep `HANDOFF.md` current at the end of every task.
- If a task reveals that the spec or devplan is wrong or incomplete, update `SPEC.md`/`spec.md` and `DEVPLAN.md`, then note the change in `HANDOFF.md` before proceeding.
