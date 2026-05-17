# Zoo Code Portable-Core Integration PR README

This PR brings the Zoo Code fork work into `Zoo-Code-Org/Zoo-Code` as one reviewable integration branch. It is intentionally broad: the repository is reorganized into a monorepo, the OpenCode-derived portable core is imported as the Zoo CLI, a TypeScript SDK is introduced, and VS Code gets a default-off portable-core integration path.

## Goals

- Establish `packages/zoo-cli` as the portable agent core with Zoo-branded `zoo` and `zoo-code` CLI binaries.
- Establish `packages/zoo-sdk` as the typed client layer for CLI server, IPC, and HTTP routes.
- Move the VS Code extension into `packages/zoo-vscode` and add a default-off `zoo-code.usePortableCore` path that can talk to the CLI through the SDK.
- Preserve existing extension behavior unless the portable-core flag is explicitly enabled.
- Remove bundled Kilo proprietary gateway/indexing dependencies while keeping BYOK provider support and migration fallbacks.
- Document remaining migration boundaries so other maintainers can continue the work without reverse-engineering the branch.

## High-Level Changes

- Monorepo package layout:
    - `packages/zoo-cli`: imported OpenCode/Kilo-derived portable core, Zoo-branded package metadata, CLI binaries, config paths, provider docs, tests, and current-platform build path.
    - `packages/zoo-sdk`: hand-written SDK facade over the CLI server plus transports and lifecycle helpers.
    - `packages/zoo-vscode/src`: relocated VS Code extension host package.
    - `packages/zoo-vscode/webview-ui`: relocated React webview package.
- Portable config model:
    - Zoo-native paths include `~/.config/zoo-code/zoo.jsonc`, project `zoo.jsonc`, `.zoo/rules/*.md`, `.zoo/modes/*.json`, and `.zooignore`.
    - Legacy Kilo/OpenCode paths remain as migration/fallback inputs where useful.
    - A local VSIX-shipped schema is available at `packages/zoo-vscode/src/schemas/zoo-config.schema.json` and is wired to `zoo.jsonc` JSON validation.
- CLI and TUI rebrand:
    - Exported CLI commands and visible TUI strings use Zoo Code branding.
    - TUI tips, banner, status labels, provider labels, MCP auth help, ACP/MCP client names, and generated provider/model display names have been rebranded.
    - `packages/zoo-cli/script/generate.ts` rewrites generated Kilo provider/model display names so future builds do not reintroduce user-facing Kilo labels.
- SDK route coverage:
    - Wrappers cover sessions, messages, permissions, questions, providers, config reads/writes, project routes, file/find routes, VCS routes, worktree routes, PTY reads, TUI controls, metadata reads, MCP status, experimental reads, sync history reads, and prompt async queueing.
    - Generated SDK parity tests cover deterministic direct-vs-HttpApi route behavior for many read/update routes.
- VS Code portable-core path:
    - `zoo-code.usePortableCore` defaults to `false`.
    - Activation can bootstrap a local CLI IPC server and create a `PortableSessionAdapter`.
    - Portable mode currently covers session create/list/get, text-only send/stream, abort, tool approval event bridging, read-only provider config state, portable mode listing, config reload watching, and shape validation at the adapter boundary.
    - Unsupported portable inputs, such as image tasks and empty text follow-ups, surface deterministic portable errors instead of falling back into legacy task execution.

## Review Map

- Repository/package structure: `pnpm-workspace.yaml`, `turbo.json`, root package scripts, `packages/zoo-cli`, `packages/zoo-sdk`, `packages/zoo-vscode`.
- CLI config and migration: `packages/zoo-cli/src/config`, `packages/zoo-cli/src/kilocode`, `packages/zoo-cli/test/config/config.test.ts`, `packages/zoo-cli/README.md`.
- CLI server and generated SDK parity: `packages/zoo-cli/src/server`, `packages/zoo-cli/test/server/httpapi-sdk.test.ts`, `packages/kilocode-sdk/src/gen/core/params.gen.ts`.
- SDK facade: `packages/zoo-sdk/src/client.ts`, `packages/zoo-sdk/src/types.ts`, `packages/zoo-sdk/src/transport`, `packages/zoo-sdk/test`.
- VS Code portable bridge: `packages/zoo-vscode/src/services/portable-core`, `packages/zoo-vscode/src/core/webview/ClineProvider.ts`, `packages/zoo-vscode/src/utils/config.ts`.
- Webview protocol and state: `packages/types/src/webview-protocol.ts`, `docs/webview-message-protocol.md`, `packages/zoo-vscode/webview-ui/src/context/ExtensionStateContext.tsx`.
- Planning and handoff docs: `DEVPLAN.md`, `HANDOFF.md`, `CHANGELOG.md`, `docs/extension-rewire-audit.md`, `docs/webview-message-protocol.md`, `packages/zoo-cli/docs/provider-parity.md`.

## Verification Already Run

The branch has been developed in small slices with focused verification after each slice. Recent focused checks include:

- `pnpm --filter @zoo-code/cli build`
- `pnpm --filter @zoo-code/cli check-types`
- `pnpm --filter @zoo-code/cli test`
- `pnpm --filter @zoo-code/cli test:opencode`
- `pnpm --filter @zoo-code/sdk test`
- `pnpm --filter @zoo-code/sdk check-types`
- `pnpm --filter @zoo-code/sdk build`
- `pnpm --filter zoo-code check-types`
- `pnpm --filter zoo-code exec vitest run services/portable-core/__tests__/PortableSessionAdapter.test.ts core/webview/__tests__/ClineProvider.spec.ts`
- `pnpm --filter @opencode-ai/core test`
- `pnpm build`
- Push hook `turbo check-types`

Expected local warning:

- The local development environment used Node `v20.19.6`, while the repository requests Node `20.20.2`. Commands completed with warnings.

## Known Gaps And Follow-Up Work

- The portable-core VS Code path is still behind `zoo-code.usePortableCore` and should stay default-off until full extension e2e coverage exists.
- Public hosted `$schema` URL for `zoo.jsonc` remains deferred; the VSIX-shipped local schema is implemented.
- `sync.start()` and `sync.replay()` are intentionally not wrapped as convenience SDK APIs because they start background sync loops or mutate sync/session state.
- Broad direct `packages/zoo-cli/test/agent/agent.test.ts` still has unrelated existing permission expectation failures and should be tackled separately.
- Some internal source paths and compatibility package names still contain `kilo` because they are inherited integration seams or dependency names. User-facing TUI strings were rebranded, but internal names should only be renamed in dedicated compatibility-safe cleanup slices.
- All-platform CLI release packaging is not fully restored. Current-platform build works through `bun run script/build.ts --single --skip-install`.
- Provider/cloud decisions for a first-party Zoo gateway remain product decisions. This PR avoids reintroducing Kilo gateway/indexing packages and focuses on BYOK/OpenCode-style provider support.

## Suggested Maintainer Review Strategy

- Review package layout and build graph first, because many later changes depend on the monorepo move.
- Review CLI config/path migration separately from SDK/VS Code portable-core behavior.
- Review SDK wrappers by route groups using `packages/zoo-sdk/test/client.test.ts` and generated HttpApi parity tests.
- Review VS Code portable-core behavior with the feature flag disabled first, then enabled adapter tests.
- Treat `HANDOFF.md` and `DEVPLAN.md` as the current continuation guide for maintainers taking over the integration.

## Local Smoke Commands

```bash
pnpm install
pnpm --filter @zoo-code/cli build
packages/zoo-cli/dist/@zoo-code/cli-linux-x64/bin/zoo --version
packages/zoo-cli/dist/@zoo-code/cli-linux-x64/bin/zoo
pnpm --filter @zoo-code/sdk test
pnpm --filter zoo-code check-types
```
