# Zoo Code CLI Integration Handoff

- **Project:** Zoo Code CLI Integration
- **Current status:** Phase 0 repository source references are established. No implementation code has changed.
- **Last completed task:** `DEVPLAN.md` Phase 0, Task 1 — Fork source repositories and establish upstream references.
- **Next task to execute:** `DEVPLAN.md` Phase 0, Task 2 — Create monorepo package skeleton.
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
- Preserve upstream attribution for Roo Code, OpenCode, and Kilo Code. Do not remove Apache 2.0 license headers from copied files; maintain `ATTRIBUTIONS.md`.
- The portable-core feature flag must be implemented before Phase 3 rewire tasks: VS Code setting `zoo-code.usePortableCore`, default `false`, with helper `usePortableCore(): boolean` reading `vscode.workspace.getConfiguration('zoo-code').get('usePortableCore', false)`.
- All SDK-based VS Code code paths must be gated by `zoo-code.usePortableCore`; old extension-host paths remain functional until the flag is enabled by default in a later release.
- Shared config locations are `~/.config/zoo-code/zoo.jsonc`, `{project}/zoo.jsonc`, `{project}/AGENTS.md`, `{project}/.zoo/rules/*.md`, `{project}/.zoo/modes/*.json`, and `{project}/.zooignore`.
- CLI binaries must be `zoo` and `zoo-code` from `@zoo-code/cli`.
- SDK bootstrap pattern: on VS Code activation, check for an existing Zoo CLI server; if absent, spawn `zoo server --ipc /tmp/zoo-{pid}.sock`; connect using `ZooClient.connect({ ipcPath })`; on deactivation, shut down gracefully; on unexpected exit, retry up to three times before surfacing an error.
- Phase execution order is 0 through 6. Phases 1, 2, and 4 can parallelize after Phase 0. Phase 3 depends on Phase 2. Phase 5 depends on Phase 3. Phase 6 hardens tests, CI, and release.
- No implementation, dependency installation, or repository fork has been performed in this session.
- GitHub CLI is authenticated as `mojomast`.
- Local git was initialized in `/home/mojo/projects/zoocode` for this integration workspace.
- Zoo Code fork/reference: GitHub would not create a second fork of `Zoo-Code-Org/Zoo-Code` because `mojomast/roo-code-cloud-alternate-auth` already exists in the same Roo/Zoo fork network. This existing fork is recorded as the target Zoo fork reference: `https://github.com/mojomast/roo-code-cloud-alternate-auth`.
- Zoo upstream remote: `zoo-upstream` -> `https://github.com/Zoo-Code-Org/Zoo-Code.git`.
- Local `origin` remote: `https://github.com/mojomast/roo-code-cloud-alternate-auth.git`.
- Kilo Code fork: `https://github.com/mojomast/kilocode`.
- Kilo remotes: `kilo-fork` -> `https://github.com/mojomast/kilocode.git`; `kilo-upstream` -> `https://github.com/Kilo-Org/kilocode.git`.
- Optional OpenCode upstream remote: `opencode-upstream` -> `https://github.com/anomalyco/opencode.git`.
- Source repositories were verified with non-destructive `gh repo view` commands; local remotes were verified with `git remote -v`.

## How to update this file

At the end of every task, update `Current status`, `Last completed task`, and `Next task to execute`.

If `SPEC.md`/`spec.md` or `DEVPLAN.md` changed, add a row to the spec's Revision History table and note what changed and why here before proceeding.
