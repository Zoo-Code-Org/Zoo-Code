# Zoo Code CLI Integration Handoff

- **Project:** Zoo Code CLI Integration
- **Current status:** Phase 0 is complete. Zoo upstream source has been materialized locally, the VS Code extension/webview have been relocated under `packages/zoo-vscode/`, scaffold packages exist for `packages/zoo-cli` and `packages/zoo-sdk`, workspace discovery/build graph wiring has been updated, `ATTRIBUTIONS.md` records upstream Zoo/Roo/OpenCode/Kilo attribution inventory, and exported/user-facing surfaces have been rebranded to Zoo where safe.
- **Last completed task:** `DEVPLAN.md` Phase 0, Task 5 — Perform safe exported-surface rebrand pass.
- **Next task to execute:** `DEVPLAN.md` Phase 1, Task 1 — Import OpenCode-derived portable core into `packages/zoo-cli`. This is blocked until Open Question 1 is answered.
- **Blocked on:**
    - Open Question 1, OpenCode fork vs. Kilo CLI fork as base: blocks `DEVPLAN.md` Phase 1, Task 1.
    - Open Question 2, runtime/toolchain choice: blocks final implementation details for `DEVPLAN.md` Phase 1, Task 9 and may affect Phase 6 packaging tasks.
    - Open Question 3, cloud services/gateway strategy: blocks final behavior for `DEVPLAN.md` Phase 1, Task 4 and Phase 5 scope decisions.
    - Open Question 4, inline autocomplete scope: blocks only any future autocomplete work; current `DEVPLAN.md` treats it as out of scope pending Phase 5, Task 7.
    - Open Question 5, JetBrains/other IDE support: blocks only future IDE packages; current `DEVPLAN.md` treats it as out of scope pending Phase 5, Task 7.

## Context the next agent needs

- `SPEC.md` was requested by name, but this workspace currently contains `spec.md`. The full `spec.md` was read before creating this handoff and `DEVPLAN.md`.
- Target architecture is a monorepo with `packages/zoo-cli` for the OpenCode-derived portable core, `packages/zoo-sdk` for the JS/TS client, and `packages/zoo-vscode` as a thin VS Code adapter over the SDK.
- Source repositories from the spec are `https://github.com/Zoo-Code-Org/Zoo-Code`, `https://github.com/Kilo-Org/kilocode` for `packages/opencode` and SDK references, and optional upstream `https://github.com/anomalyco/opencode`.
- Naming convention is Zoo-branded exported surfaces only: `zoo`, `zoo-code`, `@zoo-code/cli`, `@zoo-code/sdk`, `packages/zoo-cli`, `packages/zoo-sdk`, and `packages/zoo-vscode`.
- Preserve upstream attribution for Zoo Code, Roo Code, OpenCode, and Kilo Code. Zoo Code/Roo Code are Apache 2.0; Kilo Code/OpenCode are MIT as currently published upstream. Do not remove upstream license headers from copied files; maintain `ATTRIBUTIONS.md`.
- The portable-core feature flag must be implemented before Phase 3 rewire tasks: VS Code setting `zoo-code.usePortableCore`, default `false`, with helper `usePortableCore(): boolean` reading `vscode.workspace.getConfiguration('zoo-code').get('usePortableCore', false)`.
- All SDK-based VS Code code paths must be gated by `zoo-code.usePortableCore`; old extension-host paths remain functional until the flag is enabled by default in a later release.
- Shared config locations are `~/.config/zoo-code/zoo.jsonc`, `{project}/zoo.jsonc`, `{project}/AGENTS.md`, `{project}/.zoo/rules/*.md`, `{project}/.zoo/modes/*.json`, and `{project}/.zooignore`.
- CLI binaries must be `zoo` and `zoo-code` from `@zoo-code/cli`.
- SDK bootstrap pattern: on VS Code activation, check for an existing Zoo CLI server; if absent, spawn `zoo server --ipc /tmp/zoo-{pid}.sock`; connect using `ZooClient.connect({ ipcPath })`; on deactivation, shut down gracefully; on unexpected exit, retry up to three times before surfacing an error.
- Phase execution order is 0 through 6. Phases 1, 2, and 4 can parallelize after Phase 0. Phase 3 depends on Phase 2. Phase 5 depends on Phase 3. Phase 6 hardens tests, CI, and release.
- No portable CLI runtime implementation has been performed yet; `packages/zoo-cli` and `packages/zoo-sdk` remain scaffold-only.
- GitHub CLI is authenticated as `mojomast`.
- Local git was initialized in `/home/mojo/projects/zoocode` for this integration workspace.
- Zoo Code fork/reference: GitHub would not create a second fork of `Zoo-Code-Org/Zoo-Code` because `mojomast/roo-code-cloud-alternate-auth` already exists in the same Roo/Zoo fork network. This existing fork is recorded as the target Zoo fork reference: `https://github.com/mojomast/roo-code-cloud-alternate-auth`.
- Zoo upstream remote: `zoo-upstream` -> `https://github.com/Zoo-Code-Org/Zoo-Code.git`.
- Local `origin` remote: `https://github.com/mojomast/roo-code-cloud-alternate-auth.git`.
- Kilo Code fork: `https://github.com/mojomast/kilocode`.
- Kilo remotes: `kilo-fork` -> `https://github.com/mojomast/kilocode.git`; `kilo-upstream` -> `https://github.com/Kilo-Org/kilocode.git`.
- Optional OpenCode upstream remote: `opencode-upstream` -> `https://github.com/anomalyco/opencode.git`.
- Source repositories were verified with non-destructive `gh repo view` commands; local remotes were verified with `git remote -v`.
- `DEVPLAN.md` Phase 0, Task 2 was clarified because this local workspace initially contained only planning docs; implementing the task required first materializing `zoo-upstream/main` into the working tree before the mechanical `src/` and `webview-ui/` relocation could happen.
- `packages/zoo-vscode/src` contains the relocated VS Code extension package, and `packages/zoo-vscode/webview-ui` contains the relocated React webview package. This preserves the existing package manifests while grouping both under `packages/zoo-vscode/`.
- `packages/zoo-cli` and `packages/zoo-sdk` are scaffold-only packages with no runtime/API implementation yet.
- `pnpm-workspace.yaml` now discovers `packages/zoo-cli`, `packages/zoo-sdk`, `packages/zoo-vscode/src`, and `packages/zoo-vscode/webview-ui` alongside existing `apps/*` and `packages/*` packages.
- Path-sensitive build references were adjusted for the relocation, including extension/webview scripts, VS Code launch config, nightly build source path, webview Vite output paths, and workspace lockfile links.
- Phase 0 Tasks 2 and 3 verification completed: `pnpm list --depth -1 --recursive`, `pnpm --filter @zoo-code/cli build`, `pnpm --filter @zoo-code/sdk build`, `pnpm --filter zoo-code check-types`, `pnpm --filter @zoo-code/vscode-webview check-types`, `pnpm --filter @zoo-code/vscode-webview build`, `pnpm --filter @zoo-code/build build`, and `pnpm --filter zoo-code bundle`.
- Verification warning: the environment uses Node `v20.19.6`; root and extension package manifests request Node `20.20.2`. Commands still completed after dependency installation.
- Dependency installation was required because `node_modules` was missing. `pnpm install` completed and retained the existing lockfile resolution.
- `spec.md` and `DEVPLAN.md` were updated during Phase 0 Task 4 because they incorrectly described OpenCode/Kilo licensing as Apache 2.0. Upstream verification showed Kilo Code and OpenCode currently publish MIT license text, while Zoo Code and Roo Code publish Apache 2.0 license text.
- `ATTRIBUTIONS.md` was added with repository URLs, license names, and notes for Zoo Code, Roo Code, Kilo Code, and OpenCode. No upstream license headers were removed.
- Phase 0 Task 5 rebranded exported workspace package names from the old Roo package scope to `@zoo-code/*`, root package naming to `zoo-code`, schema metadata, docs/examples, provider headers, safe config filenames, CI/workflow package filters, and active Roo-prefixed environment variables to Zoo-prefixed names where they are part of shipped/configured surfaces.
- The existing legacy CLI under `apps/cli` is now `@zoo-code/legacy-cli` with `zoo-legacy` as its bin to avoid colliding with the scaffolded target `@zoo-code/cli` under `packages/zoo-cli`.
- `packages/types/package.json` now points its import export at built `./dist/index.js`, and `turbo.json` build tasks depend on `^build` so downstream packages consume built workspace dependencies. This fixed Turbopack resolution of `@zoo-code/types` during web builds.
- `packages/core/package.json` now declares `esbuild-wasm`, which was required by core custom-tool registry tests.
- Phase 0 Task 5 verification completed: `pnpm install`, `pnpm list --depth -1 --recursive`, `pnpm check-types`, `pnpm build`, `pnpm --filter @zoo-code/types test`, `pnpm --filter @zoo-code/web-zoo-code test`, `pnpm --filter @zoo-code/core test -- --runInBand`, and `pnpm exec turbo test --log-order grouped --output-logs new-only --concurrency=1`.
- Full `pnpm test -- --concurrency=1` is not the correct limited-concurrency command because it forwards `--concurrency` into package-level Vitest scripts. Use `pnpm exec turbo test --log-order grouped --output-logs new-only --concurrency=1` instead.
- Final branding searches were run for the old package scope, old settings filename, old LM API display name, old user-agent prefix, old CLI help/name strings, and Roo-prefixed environment variables. Remaining matches are historical changelog/progress entries, generated/cache output such as `.turbo`, `.next`, `dist`, `node_modules`, or repo-local upstream `.roo` docs, not active exported surfaces.

## How to update this file

At the end of every task, update `Current status`, `Last completed task`, and `Next task to execute`.

If `SPEC.md`/`spec.md` or `DEVPLAN.md` changed, add a row to the spec's Revision History table and note what changed and why here before proceeding.
