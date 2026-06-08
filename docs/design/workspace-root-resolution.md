# Workspace Root Resolution

This document describes how Zoo determines the "project root" used to locate
workspace-scoped configuration such as `.roomodes`, `.roo/mcp.json`, and
`.roo/rules/`, and how the `zoo-code.workspace.rootResolution` setting lets
users opt into deterministic behavior in multi-root workspaces.

## Background

The canonical resolver is `getWorkspacePath()` in
[`src/utils/path.ts`](../../src/utils/path.ts). It is the single source of
truth that downstream subsystems (`McpHub`, `CustomModesManager`, the rules
loader, the marketplace installer, etc.) call either directly or through cached
values such as `Task.cwd` and `ClineProvider.cwd`.

Historically, `getWorkspacePath()` always preferred the workspace folder
**containing the active editor** in a multi-root workspace, falling back to
`workspaceFolders[0]` only when no editor was open or the active file lived
outside any workspace folder.

That heuristic is convenient for the common case (you typically want
`.roo/rules/` from the project you're actively editing) but is **non‑deterministic**:

- Switching the active editor between files in different workspace roots
  silently changes which `.roomodes` / `.roo/mcp.json` get picked up by
  subsequent lookups.
- Some subsystems (notably the marketplace installers) always target
  `workspaceFolders[0]` regardless. This can produce a state where modes are
  written into folder 0 while rules are read from a different folder.
- Automation scenarios (CI, batch runs, scripted tasks) want a stable answer
  that does not depend on which file happens to be focused.

## The Setting

```jsonc
"zoo-code.workspace.rootResolution": "activeEditor" | "firstFolder"
```

Defined in [`src/package.json`](../../src/package.json) and translated via
[`src/package.nls.json`](../../src/package.nls.json).

| Value                      | Behavior                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"activeEditor"` (default) | Prefer the workspace folder containing the active editor; fall back to the first workspace folder when no editor is open or the active file lives outside any workspace folder. **Preserves legacy behavior.** |
| `"firstFolder"`            | Always use `vscode.workspace.workspaceFolders[0]`. **Deterministic** — independent of which file is currently focused.                                                                                         |

The setting is read inside `getWorkspacePath()` via a small, exception-safe
helper:

```typescript
function getRootResolutionStrategy(): WorkspaceRootResolution {
	try {
		const value = vscode.workspace
			.getConfiguration("zoo-code")
			.get<string>("workspace.rootResolution", DEFAULT_ROOT_RESOLUTION)
		return value === "firstFolder" ? "firstFolder" : DEFAULT_ROOT_RESOLUTION
	} catch {
		return DEFAULT_ROOT_RESOLUTION
	}
}
```

The `try`/`catch` is deliberate: `path.ts` is a low-level utility imported
very early during extension activation and also exercised by some non-VSCode
contexts (CLI, tests). A failed config read must never throw.

## Behavior Matrix

| Scenario                                    | `activeEditor` (default)                    | `firstFolder`    |
| ------------------------------------------- | ------------------------------------------- | ---------------- |
| Single-folder workspace                     | The folder                                  | The folder       |
| Multi-root, active editor inside folder _N_ | Folder _N_                                  | Folder 0         |
| Multi-root, no active editor                | Folder 0                                    | Folder 0         |
| Multi-root, active file outside all folders | Folder 0                                    | Folder 0         |
| No workspace open                           | `defaultCwdPath` (caller-provided fallback) | `defaultCwdPath` |

In `firstFolder` mode, `getWorkspacePathForContext()` also short-circuits to
`getWorkspacePath()` and **does not** consult
`vscode.workspace.getWorkspaceFolder(contextPath)`. This keeps every
workspace-rooted lookup pinned to folder 0, including the code-index service.

## What Is Not Affected

- **Already-running tasks.** `Task.workspacePath` is captured **once** at
  construction time and exposed as `task.cwd`. Changing the setting (or
  switching the active editor) mid-task does not retarget that task. New
  tasks created after the change pick up the new behavior.
- **Global configuration.** The global `~/.roo` directory and global
  `mcp_settings.json` / `custom_modes.yaml` are unaffected — they are
  always read first and overridden by project-level files. This setting
  only changes which workspace folder is treated as "the project".
- **Subfolder rules discovery.** The opt-in `enableSubfolderRules` traversal
  in `discoverSubfolderRooDirectories()` still descends into subfolders of
  whichever root was resolved.

## Recommended Usage

Set `zoo-code.workspace.rootResolution` to `"firstFolder"` in your
**workspace** settings (`.code-workspace` or `.vscode/settings.json`)
when you need:

- Deterministic CI / automation behavior.
- A stable target for `.roomodes` and `.roo/mcp.json` writes that matches
  the marketplace installer's behavior.
- A single canonical project root in a multi-root workspace where only
  one folder is actually the "project" (and the others are auxiliary —
  e.g., a vault, a vendored dependency, scratch notes).

Leave it at `"activeEditor"` (the default) when you want Zoo to follow
your focus across multiple equal-priority projects in a single window.

## Tests

Coverage lives in
[`src/utils/__tests__/path.spec.ts`](../../src/utils/__tests__/path.spec.ts)
under the `getWorkspacePath` and `getWorkspacePathForContext` describe
blocks. The matrix covers:

- Default (`activeEditor`) preference for the active editor's folder.
- Default fallback to `workspaceFolders[0]` when the active file is
  outside any workspace folder.
- Default fallback to `defaultCwdPath` when there are no workspace
  folders.
- `firstFolder` mode pinning to `workspaceFolders[0]` even when an
  active editor lives in a different root.
- `firstFolder` mode never calling `getWorkspaceFolder()`.
- `firstFolder` mode falling back to `defaultCwdPath` when there are no
  workspace folders.
- Exception safety: a throwing `getConfiguration()` must not break path
  resolution.
- `getWorkspacePathForContext()` honoring the same setting.

## Related

- `getWorkspacePath()` in [`src/utils/path.ts`](../../src/utils/path.ts) — the resolver.
- `getWorkspacePathForContext()` in [`src/utils/path.ts`](../../src/utils/path.ts) — context-aware wrapper.
- `Task.workspacePath` — captured once per task.
- `McpHub.getProjectMcpPath()` — `.roo/mcp.json` consumer.
- `CustomModesManager.getWorkspaceRoomodes()` — `.roomodes` consumer.
- `getRooDirectoriesForCwd()` — `[global, project]` directory list used by the rules loader.
