import * as vscode from "vscode"

import { Package } from "../../shared/package"

export type CommandListConfigKey = "allowedCommands" | "deniedCommands"

export interface CommandListScopes {
	global: string[]
	workspace: string[]
	merged: string[]
}

/**
 * The workspace-scoped layers of a command-list key as reported by
 * `WorkspaceConfiguration.inspect()`. Capturing it once lets a save derive
 * the read layers, the write target, and a rollback value from a single
 * configuration state instead of three independent reads that could disagree.
 */
export interface CommandListInspection {
	workspaceValue?: string[]
	workspaceFolderValue?: string[]
}

/**
 * The configuration object for every command-list read and write, scoped to
 * the first workspace folder. Sharing one scoped access path keeps the two
 * sides symmetric: `inspect()` can report `workspaceFolderValue`, and
 * `ConfigurationTarget.WorkspaceFolder` updates are legal (the API contract
 * throws for that target when the configuration is not scoped to a
 * resource). In a multi-root workspace only the first folder's values are in
 * scope; with no folder open the configuration is unscoped and reports no
 * folder value.
 */
export function commandListConfiguration(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(Package.name, vscode.workspace.workspaceFolders?.[0]?.uri)
}

/**
 * Reads an auto-approval command list from both configuration layers and
 * composes the list that should be enforced and displayed.
 *
 * The workspace layer is read via `inspect()` rather than `get()` on purpose:
 * `get()` returns the effective value, which already folds `globalValue` into
 * the result. Unioning that with the global layer would double-count entries
 * and make removals from global settings unable to shrink the enforced set.
 *
 * @param configKey - The extension configuration key to read.
 * @param globalList - The list persisted in extension global state.
 * @param inspectionOverride - A snapshot captured by the caller before any
 * write; when present it is used as-is and no fresh lookup happens, so a
 * save's reads, target resolution, and rollback stay derived from one
 * configuration state. Without it the lookup runs guarded (lenient): this is
 * the enforcement/display path, where an unavailable workspace layer must
 * degrade to empty rather than fail.
 * @returns The per-layer lists and their deduplicated set union.
 */
export function readCommandListScopes(
	configKey: CommandListConfigKey,
	globalList: string[] | undefined,
	inspectionOverride?: CommandListInspection,
): CommandListScopes {
	const global = sanitizeCommandList(globalList)

	let inspected: CommandListInspection | undefined = inspectionOverride
	if (inspected === undefined) {
		// Only the configuration lookup itself is guarded: it can fail (for
		// example before the workspace is ready), and an absent workspace layer
		// must not break enforcement. The value reads below have no failure mode
		// of their own, so the catch covers exactly the failure it exists to
		// absorb.
		try {
			inspected = commandListConfiguration().inspect<string[]>(configKey)
		} catch {
			inspected = undefined
		}
	}

	// The folder value wins over the workspace value, matching VS Code's
	// folder-over-workspace precedence. An absent inspect result composes to
	// an empty workspace layer: enforcement must not break.
	const workspace = sanitizeCommandList(inspected?.workspaceFolderValue ?? inspected?.workspaceValue)

	// Set union: an entry present in both layers collapses to one, so
	// composition cannot change prefix-match outcomes.
	const merged = [...new Set([...global, ...workspace])]

	return { global, workspace, merged }
}

export interface CommandListWriteScopes {
	globalWrite: string[]
	workspaceWrite: string[]
}

/**
 * Splits the merged command list the settings dialog saves back into the two
 * configuration layers it was composed from, so saving the dialog cannot
 * flatten workspace-scoped entries into the user's global settings.
 *
 * Semantics:
 * - An entry the user kept that exists in the workspace layer stays in the
 *   workspace layer. If the same entry also exists in the global layer it
 *   stays there too: dropping it from the global write would silently delete
 *   a user's global entry just because the current folder happens to define
 *   it as well.
 * - An entry the user removed is dropped from every layer that contained it,
 *   which makes workspace-scoped entries deletable from the dialog.
 * - A brand-new entry (in neither layer) lands in the global layer, matching
 *   the pre-existing behavior of routing dialog edits to
 *   `ConfigurationTarget.Global`.
 *
 * @param incoming - The full merged list sent by the webview on save.
 * @param workspaceLayer - The current workspace-scope configuration value.
 * @param globalLayer - The list currently persisted in extension global state.
 * @returns The per-layer values to write back.
 */
export function splitCommandListScopes(
	incoming: string[],
	workspaceLayer: string[],
	globalLayer: string[],
): CommandListWriteScopes {
	const kept = new Set(sanitizeCommandList(incoming))
	const workspace = sanitizeCommandList(workspaceLayer)
	const global = sanitizeCommandList(globalLayer)
	const known = new Set([...workspace, ...global])

	// Deduplicated so re-writing a layer cannot introduce duplicates.
	const workspaceWrite = [...new Set(workspace.filter((command) => kept.has(command)))]
	const globalWrite = [
		...new Set(global.filter((command) => kept.has(command))),
		// Preserve the dialog's ordering for entries the user just added.
		...[...kept].filter((command) => !known.has(command)),
	]

	return { globalWrite, workspaceWrite }
}

/**
 * Picks the configuration target that owns the current workspace-scope layer
 * for `configKey`. Reading the layers runs through the same
 * `commandListConfiguration()` object `readCommandListScopes` uses; because
 * that configuration is scoped to the first workspace folder, folder values
 * resolve against that folder's settings; with no folder open the
 * configuration is unscoped and reports no folder value, so no folder target
 * can be selected.
 *
 * - `workspaceFolderValue` set -> write at `WorkspaceFolder` scope.
 * - Otherwise `workspaceValue` set -> write at `Workspace` scope.
 * - Neither set -> `undefined`: no workspace layer exists, so none should be
 *   created (an empty workspace layer must not materialize in settings.json).
 *
 * @param configKey - The extension configuration key to inspect.
 * @param inspectionOverride - A snapshot captured by the caller; when present
 * it alone decides the target and no fresh lookup happens, keeping a save's
 * split, write, and rollback on one configuration state. Without it the
 * lookup is guarded leniently: a failure means no workspace layer exists.
 * @returns The workspace-scoped target to write, or `undefined` when no
 * workspace layer exists.
 */
export function resolveWorkspaceWriteTarget(
	configKey: CommandListConfigKey,
	inspectionOverride?: CommandListInspection,
): vscode.ConfigurationTarget.WorkspaceFolder | vscode.ConfigurationTarget.Workspace | undefined {
	let inspected: CommandListInspection | undefined = inspectionOverride
	if (inspected === undefined) {
		// Same defensive posture as readCommandListScopes: only the
		// configuration lookup itself may fail, and a failure means we create no
		// workspace layer.
		try {
			inspected = commandListConfiguration().inspect<string[]>(configKey)
		} catch {
			inspected = undefined
		}
	}

	if (inspected?.workspaceFolderValue !== undefined) {
		return vscode.ConfigurationTarget.WorkspaceFolder
	}
	if (inspected?.workspaceValue !== undefined) {
		return vscode.ConfigurationTarget.Workspace
	}
	return undefined
}

function sanitizeCommandList(list: unknown): string[] {
	if (!Array.isArray(list)) {
		return []
	}

	return list.filter((command): command is string => typeof command === "string" && command.trim().length > 0)
}
