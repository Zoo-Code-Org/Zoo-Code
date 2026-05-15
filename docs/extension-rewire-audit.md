# Extension Rewire Audit

This audit maps the VS Code extension host code under `packages/zoo-vscode/src` into migration buckets for the portable-core transition. The immediate goal is to keep VS Code-specific behavior in `packages/zoo-vscode` while routing core agent/session/provider behavior through `@zoo-code/sdk` and the Zoo CLI server behind `zoo-code.usePortableCore`.

`packages/zoo-vscode/src/providers/webview` does not exist in this workspace. The webview provider and bridge code currently lives under `packages/zoo-vscode/src/core/webview`.

## Key Findings

- Core agent logic is still mixed with VS Code host APIs in `core/task/Task.ts`, `core/tools`, `core/prompts`, `core/config`, and `core/webview/ClineProvider.ts`.
- `extension.ts` is activation and host composition glue; it should stay in the VS Code package.
- `api` is mostly portable provider and transform code, except VS Code LM support and timeout helpers that read VS Code configuration.
- `services` contains portable services and VS Code-bound services. Code indexing, MCP, marketplace, search, ripgrep, skills, checkpoints, auth, and telemetry need adapter boundaries.
- Webview bridge responsibilities are concentrated in `core/webview`.
- Task, session, and config surfaces are centered on `core/task`, `core/task-persistence`, `core/config`, `core/message-*`, and `core/webview/ClineProvider.ts`.

## Core Agent Logic

Destination: the portable core already imported under `packages/zoo-cli`, with shared types exposed through `@zoo-code/sdk` or existing shared packages when needed.

| Source                                     | Destination                                    | Migration note                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `core/task/Task.ts`                        | `packages/zoo-cli` task/session runtime        | Main agent loop. Extract host capabilities before moving or replacing with SDK-backed session calls.                                    |
| `core/task/AskIgnoredError.ts`             | Portable task utility                          | Portable.                                                                                                                               |
| `core/task/build-tools.ts`                 | Portable task/tool setup                       | Verify no implicit VS Code assumptions before moving.                                                                                   |
| `core/task/mergeConsecutiveApiMessages.ts` | Shared task/message utility                    | Portable message logic.                                                                                                                 |
| `core/task/validateToolResultIds.ts`       | Shared task/message utility                    | Portable message validation.                                                                                                            |
| `core/tools`                               | Split between portable tools and host adapters | Tool protocol belongs in portable core; VS Code-specific execution, editing, search, and image display need injected host capabilities. |
| `core/auto-approval`                       | Portable approval policy                       | Keep host prompts and notifications outside the policy.                                                                                 |
| `core/condense`                            | Portable context compaction                    | Portable conversation/context compaction.                                                                                               |
| `core/diff`                                | Portable diff logic plus host editor adapter   | Diff strategies are portable; applying edits in VS Code stays host-side.                                                                |
| `core/mentions`                            | Split                                          | Mention parsing can move; file/image/workspace resolution needs host adapters.                                                          |
| `core/environment`                         | Split                                          | Prompt/environment formatting can move; workspace, shell, and VS Code env discovery stays host-side.                                    |
| `core/context`                             | Portable context model                         | Validate VS Code-free boundaries.                                                                                                       |
| `core/context-management`                  | Portable context budget logic                  | Portable context budget and error handling.                                                                                             |
| `core/assistant-message`                   | Portable assistant message parser              | Portable assistant message parsing and formatting.                                                                                      |
| `core/prompts`                             | Split                                          | Prompt composition belongs in core; files importing VS Code need injected workspace/config adapters.                                    |
| `core/protect/RooProtectedController.ts`   | Split                                          | Extract protection policy; keep VS Code/workspace enforcement in host glue.                                                             |
| `services/tree-sitter`                     | Portable source-analysis service               | Tree-sitter parsing can be portable.                                                                                                    |
| `services/glob`                            | Split                                          | Glob/list logic can be portable; current VS Code imports require filesystem adapters.                                                   |

## VS Code Host Glue

Destination: keep under `packages/zoo-vscode/src`, ideally in explicit host-focused folders as rewire work progresses.

| Source                                        | Destination                            | Migration note                                                                                                                    |
| --------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `extension.ts`                                | `packages/zoo-vscode/src/extension.ts` | Activation, subscriptions, output channel, URI handler, provider registration, command registration, file watchers, and teardown. |
| `core/webview/ClineProvider.ts`               | VS Code webview host adapter           | `WebviewViewProvider`, state posting, provider orchestration, and SDK gateway seam.                                               |
| `core/webview/getUri.ts`                      | VS Code webview host helper            | VS Code `Uri` and `Webview` helper.                                                                                               |
| `core/webview/getNonce.ts`                    | Webview utility                        | Can stay host-side or move to shared webview utility.                                                                             |
| `core/webview/worktree`                       | VS Code worktree bridge                | Uses VS Code workspace, commands, and global state.                                                                               |
| `core/checkpoints/index.ts`                   | VS Code checkpoint host adapter        | Imports VS Code; split checkpoint model from host integration later.                                                              |
| `core/config/ContextProxy.ts`                 | VS Code config adapter                 | Wraps VS Code extension, global, and workspace state.                                                                             |
| `core/config/ProviderSettingsManager.ts`      | VS Code provider settings adapter      | Uses `ExtensionContext`; keep as host persistence adapter until config migration is complete.                                     |
| `core/config/CustomModesManager.ts`           | Split                                  | Mode parsing can be shared; VS Code storage/filesystem handling stays host-side.                                                  |
| `core/config/importExport.ts`                 | VS Code config import/export           | VS Code file dialogs and import/export UX.                                                                                        |
| `core/context-tracking/FileContextTracker.ts` | VS Code context tracker                | Uses VS Code document and workspace events.                                                                                       |
| `core/ignore/RooIgnoreController.ts`          | VS Code ignore watcher                 | Workspace/file watcher behavior stays host-side.                                                                                  |
| `services/search/file-search.ts`              | VS Code search adapter                 | Imports VS Code; expose portable search interface later.                                                                          |
| `services/ripgrep`                            | VS Code runtime/binary adapter         | Depends on extension path and bundled runtime assets.                                                                             |
| `services/zoo-code-auth.ts`                   | VS Code auth adapter                   | VS Code secret/session integration.                                                                                               |
| `services/mcp/SecretStorageService.ts`        | VS Code secret adapter                 | VS Code secret storage.                                                                                                           |
| `services/marketplace/SimpleInstaller.ts`     | VS Code marketplace installer          | VS Code install/filesystem/UI behavior.                                                                                           |
| `services/marketplace/MarketplaceManager.ts`  | Split                                  | Marketplace protocol can be shared; install/UI/workspace side effects stay host-side.                                             |
| `api/providers/vscode-lm.ts`                  | VS Code provider plugin                | Host-only VS Code LM API provider.                                                                                                |
| `api/transform/vscode-lm-format.ts`           | VS Code provider transform             | Host-only VS Code LM message transform.                                                                                           |
| `api/providers/utils/timeout-config.ts`       | Split                                  | Reads VS Code configuration; replace with injected setting for portable use.                                                      |

## Shared Types And Utilities

Destination: `@zoo-code/sdk`, `@zoo-code/types`, or package-local shared modules depending on public API needs.

| Source                                             | Destination                      | Migration note                                                                       |
| -------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `core/task-persistence/taskMetadata.ts`            | Shared session metadata          | Metadata shape and serialization can be shared.                                      |
| `core/task-persistence/apiMessages.ts`             | Shared persistence utility       | Portable if storage path is injected.                                                |
| `core/task-persistence/taskMessages.ts`            | Shared persistence utility       | Portable message persistence if filesystem dependency is abstracted.                 |
| `core/task-persistence/TaskHistoryStore.ts`        | Split                            | Store interface/history model can move; VS Code/global-storage path stays host-side. |
| `core/message-manager`                             | Portable session/message manager | Portable message lifecycle management.                                               |
| `core/message-queue/MessageQueueService.ts`        | Portable session queue           | Portable queue/session primitive.                                                    |
| `core/context-tracking/FileContextTrackerTypes.ts` | Shared context types             | Type-only surface.                                                                   |
| `core/webview/aggregateTaskCosts.ts`               | Shared task cost utility         | Pure aggregation utility.                                                            |
| `api/transform` except VS Code LM                  | Shared API transform layer       | Provider-neutral message/stream transforms.                                          |
| `api/providers/constants.ts`                       | Shared provider constants        | Shared provider constants.                                                           |
| `api/providers/utils` except timeout config        | Shared provider utilities        | Error, image, and router utilities are broadly reusable.                             |

## Webview Bridge

Destination: keep UI unchanged while introducing explicit protocol and SDK event mapping.

| Source                                     | Destination                           | Migration note                                                                       |
| ------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------ |
| `core/webview/webviewMessageHandler.ts`    | Split bridge router and host handlers | Central dispatcher. Separate protocol/action routing from VS Code side effects.      |
| `core/webview/messageEnhancer.ts`          | Webview bridge utility                | Likely portable webview message shaping.                                             |
| `core/webview/checkpointRestoreHandler.ts` | VS Code host handler                  | Imports VS Code; keep checkpoint restore host-side.                                  |
| `core/webview/diagnosticsHandler.ts`       | VS Code host handler                  | VS Code diagnostics bridge.                                                          |
| `core/webview/skillsMessageHandler.ts`     | Split                                 | Webview action protocol can be shared; skills workspace/file access stays host-side. |
| `core/webview/generateSystemPrompt.ts`     | Split                                 | Extract prompt generation core from VS Code host input collection.                   |
| `core/webview/worktree/index.ts`           | VS Code webview worktree bridge       | Host bridge export.                                                                  |
| `core/webview/worktree/handlers.ts`        | VS Code webview worktree handlers     | VS Code workspace/command glue.                                                      |
| `core/webview/ClineProvider.ts`            | VS Code webview provider              | Remains VS Code-bound; depends on protocol/state helpers and SDK bootstrap.          |
| `core/webview/__tests__`                   | Split tests by layer                  | Unit-test protocol logic separately; keep VS Code mocks for host adapter tests.      |

## Task, Session, And Config Surfaces

| Source                      | Destination                                                | Migration note                                                                                                                     |
| --------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `core/config`               | Split shared config schema and VS Code config adapters     | Define `ConfigStore`, `SecretStore`, `ProviderSettingsStore`, and `ModeStore` interfaces.                                          |
| `core/task`                 | Portable task runtime or SDK-backed session facade         | Define `TaskHost`, `ToolHost`, `TerminalHost`, `WorkspaceHost`, `CheckpointHost`, and `TelemetrySink` dependencies if moving code. |
| `core/task-persistence`     | Shared session history plus host storage adapter           | Keep message/history schemas shared; inject storage location and file I/O.                                                         |
| `core/message-manager`      | Portable session message manager                           | Portable task message lifecycle.                                                                                                   |
| `core/message-queue`        | Portable session queue                                     | Portable queue.                                                                                                                    |
| `services/checkpoints`      | Split checkpoint types and VS Code implementation          | Git/filesystem/VS Code details stay host-side.                                                                                     |
| `services/mcp`              | Split MCP client and host secret/lifecycle adapter         | Protocol/session logic can be shared; secret storage and VS Code lifecycle stay host-side.                                         |
| `services/code-index`       | Split code-index logic and VS Code workspace adapter       | Kilo indexing is intentionally disabled unless a Zoo-specific indexing plan is designed.                                           |
| `services/skills`           | Split skill model and VS Code host access                  | Skill invocation model shared; workspace/file access host-bound.                                                                   |
| `services/mdm`              | VS Code host policy adapter or shared cloud policy service | MDM affects config; keep extension-state updates host-side.                                                                        |
| `services/roo-config`       | Shared config import or VS Code import adapter             | Depends on whether parsing can be made VS Code-free.                                                                               |
| `services/zoo-telemetry.ts` | Split event schema and host telemetry provider             | Event names/properties can be shared; provider wiring stays host-side.                                                             |

## API And Provider Layer

| Source                              | Destination                                               | Migration note                                                            |
| ----------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `api/index.ts`                      | Portable provider factory or SDK/CLI-owned provider layer | Remove direct dependency on VS Code-bound config messaging before moving. |
| `api/providers`                     | Portable provider layer plus host-only plugins            | Most providers are portable.                                              |
| `api/providers/fetchers`            | Portable provider metadata fetchers                       | Validate extension-path assumptions.                                      |
| `api/providers/vscode-lm.ts`        | VS Code host provider plugin                              | Host-only VS Code LM API provider.                                        |
| `api/transform`                     | Shared API transform layer                                | Portable except VS Code LM transform.                                     |
| `api/transform/vscode-lm-format.ts` | VS Code host transform                                    | Host-only VS Code LM transform.                                           |

## Recommended Migration Order

1. Define explicit SDK/host interfaces and webview protocol types before behavior rewiring.
2. Add activation-time portable-core bootstrap behind `usePortableCore()`.
3. Version and test the webview message contract before changing bridge behavior.
4. Add a narrow session/task adapter seam around `ClineProvider` so `newTask`, resume/list, send, and cancel can route through the SDK when the flag is enabled.
5. Keep `webviewMessageHandler` mostly stable by preserving high-level `ClineProvider` methods.
6. Rewire session create/get/list through SDK behind the flag.
7. Rewire message streaming and map SDK `MessageChunk` events into existing `messageUpdated`/`state` messages.
8. Rewire abort and lifecycle notifications through SDK behind the flag.
9. Rewire tool approvals through the webview protocol and SDK approval flow.
10. Rewire provider config and mode selection after Phase 4 config schema/loader work is stable.
11. Add deterministic portable-core adapter/e2e validation behind the feature flag.
12. Only after SDK-backed paths are verified, move or delete duplicated extension-host core logic in separate cleanup slices.
