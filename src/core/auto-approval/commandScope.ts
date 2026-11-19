import fs from "fs"
import path from "path"

import { DEFAULT_WORKSPACE_COMMAND_LISTS_ENABLED } from "@roo-code/types"
import * as vscode from "vscode"

import { Package } from "../../shared/package"
import {
	type CommandDecision,
	findLongestPrefixMatch,
	getSingleCommandDecision,
	isShadowedByAnyEntry,
} from "./commands"

export type CommandListConfigKey = "allowedCommands" | "deniedCommands"

export interface CommandListScopes {
	global: string[]
	workspace: string[]
	merged: string[]
}

/**
 * The workspace layers of a command-list key, from `inspect()`. One capture
 * gives a save consistent read layers, write target, and rollback value.
 */
export interface CommandListInspection {
	workspaceValue?: string[]
	workspaceFolderValue?: string[]
}

/**
 * The configuration for every command-list read and write. Scoped to
 * `folderResource` when given, else the first workspace folder. One shared
 * scoped path keeps read and write symmetric: `ConfigurationTarget.
 * WorkspaceFolder` updates are legal only when the configuration is scoped to
 * a resource.
 */
export function commandListConfiguration(folderResource?: vscode.Uri): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(
		Package.name,
		folderResource ?? vscode.workspace.workspaceFolders?.[0]?.uri,
	)
}

/**
 * Resolves the workspace folder a task's `cwd` lives in, so command-list
 * enforcement reads that folder's configuration instead of the window's
 * first folder. A child task inherits its parent's cwd and resolves the same
 * way.
 *
 * The cwd arrives canonicalized, but the registry holds roots as opened, so
 * containment is tested against each root's real path. A lexical-only compare
 * would let an outer root claim a symlinked deeper root's directory and skip
 * its deny entries. The deepest match wins, like VS Code's own containment.
 * A root whose real path cannot be resolved falls back to its registered
 * path: that can only narrow which layer applies, never widen approvals.
 *
 * @param cwd - The task's working directory. Empty, absent, or unmatched
 * yields `undefined` and keeps the first-folder configuration.
 * @returns The containing folder's registry URI — never canonicalized, since
 * folder-scoped configuration resolves against the registry.
 */
export function commandListFolderForResource(cwd?: string): vscode.Uri | undefined {
	if (!cwd) {
		return undefined
	}

	// A failed lookup returns undefined, like a cwd naming no root; the caller
	// then falls back to the pre-composed state lists.
	try {
		// Longest match wins so an outer root cannot claim a symlinked deeper
		// root's directory. The separator guard keeps `/root/other` out of `/root`.
		let match: vscode.Uri | undefined
		let matchedLength = 0
		for (const candidate of vscode.workspace.workspaceFolders ?? []) {
			const rootPath = realPathOrRegistered(candidate.uri.fsPath)
			// A filesystem root (`/`, `C:\`) already ends in a separator;
			// doubling it would leave no child path able to match.
			const childPrefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep
			if ((cwd === rootPath || cwd.startsWith(childPrefix)) && rootPath.length > matchedLength) {
				match = candidate.uri
				matchedLength = rootPath.length
			}
		}
		return match
	} catch {
		return undefined
	}
}

/**
 * The path a workspace root is compared by: its real path, or the registered
 * path when the real one cannot be resolved. The cwd is already canonical, so
 * a fallback here can only narrow matching, never widen approvals.
 */
function realPathOrRegistered(fsPath: string): string {
	try {
		return fs.realpathSync(fsPath)
	} catch {
		return fsPath
	}
}

/**
 * Reads an auto-approval command list from both configuration layers and
 * composes the list that should be enforced and displayed.
 *
 * The workspace layer comes from `inspect()`, not `get()`: `get()` returns the
 * effective value, which already folds in `globalValue`. Unioning that with
 * the global layer would double-count and keep global removals from shrinking
 * the enforced set.
 *
 * @param configKey - The extension configuration key to read.
 * @param globalList - The list persisted in extension global state.
 * @param inspectionOverride - A pre-write snapshot; when present it is used
 * as-is so a save's reads, target, and rollback share one configuration
 * state. Without it the lookup is guarded: enforcement degrades to an empty
 * workspace layer rather than failing.
 * @param folderResource - Workspace folder to scope to; `undefined` keeps the
 * first-folder default.
 * @returns The per-layer lists and their deduplicated set union.
 */
export function readCommandListScopes(
	configKey: CommandListConfigKey,
	globalList: string[] | undefined,
	inspectionOverride?: CommandListInspection,
	folderResource?: vscode.Uri,
): CommandListScopes {
	const global = sanitizeCommandList(globalList)

	let inspected: CommandListInspection | undefined = inspectionOverride
	if (inspected === undefined) {
		// Only the lookup is guarded: it can fail before the workspace is ready.
		// The reads below have no failure mode of their own.
		try {
			inspected = commandListConfiguration(folderResource).inspect<string[]>(configKey)
		} catch {
			inspected = undefined
		}
	}

	// Folder value wins over workspace value, as in VS Code's precedence.
	const workspace = sanitizeCommandList(inspected?.workspaceFolderValue ?? inspected?.workspaceValue)

	// Set union: an entry in both layers collapses to one.
	const merged = [...new Set([...global, ...workspace])]

	return { global, workspace, merged }
}

export interface CommandListWriteScopes {
	globalWrite: string[]
	workspaceWrite: string[]
}

/**
 * Splits the dialog's merged list back into the two layers it was composed
 * from, so saving cannot flatten workspace entries into global settings.
 *
 * - A kept entry stays in every layer that contained it; dropping it from the
 *   global write would delete a global entry the folder merely mirrors.
 * - A removed entry leaves every layer that contained it, so dialog deletes
 *   work for workspace entries.
 * - A new entry lands in the global layer, as dialog edits did before.
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
 * Picks the configuration target that owns the current workspace layer for
 * `configKey`, reading through the same scoped configuration as
 * `readCommandListScopes`.
 *
 * - `workspaceFolderValue` set -> `WorkspaceFolder`.
 * - Else `workspaceValue` set -> `Workspace`.
 * - Neither -> `undefined`: an empty workspace layer must not materialize in
 *   settings.json.
 *
 * @param configKey - The extension configuration key to inspect.
 * @param inspectionOverride - A caller snapshot; when present it alone
 * decides the target, keeping a save on one configuration state. Without it
 * a failed lookup means no workspace layer exists.
 * @returns The workspace-scoped target to write, or `undefined`.
 */
export function resolveWorkspaceWriteTarget(
	configKey: CommandListConfigKey,
	inspectionOverride?: CommandListInspection,
): vscode.ConfigurationTarget.WorkspaceFolder | vscode.ConfigurationTarget.Workspace | undefined {
	let inspected: CommandListInspection | undefined = inspectionOverride
	if (inspected === undefined) {
		// Same guarded posture as readCommandListScopes: failure means no workspace layer.
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

/**
 * Reads the gate that decides whether workspace command lists take part in
 * enforcement and display. Its manifest scope is "application", so only user
 * settings flip it. A failed lookup keeps the workspace layers inert, which
 * cannot widen approvals.
 */
export function workspaceCommandListsEnabled(): boolean {
	try {
		return commandListConfiguration().get<boolean>("workspaceCommandListsEnabled") === true
	} catch {
		return DEFAULT_WORKSPACE_COMMAND_LISTS_ENABLED
	}
}

export interface EffectiveCommandLists {
	allowed: string[]
	denied: string[]
	/** The global layer's allow entries: they decide every command they match. */
	globalAllow: string[]
	/** Deny-side counterpart of {@link globalAllow}. */
	globalDeny: string[]
	/**
	 * Workspace allow entries the gate and shadowing kept; they decide only
	 * commands no global entry matches.
	 */
	keptWorkspaceAllow: string[]
	/** Deny-side counterpart of {@link keptWorkspaceAllow}. */
	keptWorkspaceDeny: string[]
	/**
	 * Workspace allow entries hidden from the effective list by the gate or a
	 * global shadow. A dialog save must not delete these by omission.
	 */
	hiddenWorkspaceAllow: string[]
	/** Deny-side counterpart of {@link hiddenWorkspaceAllow}. */
	hiddenWorkspaceDeny: string[]
}

/**
 * Composes the raw per-key layers into the pair the dialog displays and the
 * layer split {@link getEffectiveCommandDecision} matches against, so display
 * and enforcement share one pass and cannot drift.
 *
 * Gate off: the global layers are effective verbatim. Gate on: a workspace
 * entry survives only when no global entry shadows it. Shadowing is
 * cross-directional: a global allow silences a workspace deny just as a
 * global deny silences a workspace allow. A surviving entry may overlap a
 * global entry without being shadowed; the overlap is harmless because the
 * global layer decides every command it matches.
 *
 * Composing here keeps the raw layers intact for the save path, which derives
 * its write split from them.
 *
 * @param allowScopes - Raw `allowedCommands` layers from readCommandListScopes.
 * @param denyScopes - Raw `deniedCommands` layers from readCommandListScopes.
 * @param enabled - The value of the `workspaceCommandListsEnabled` gate.
 * @returns The effective allow/deny lists, the per-layer split behind them, and
 * the workspace entries hidden from each.
 */
export function resolveEffectiveCommandLists(
	allowScopes: CommandListScopes,
	denyScopes: CommandListScopes,
	enabled: boolean,
): EffectiveCommandLists {
	const globalAllow = allowScopes.global
	const globalDeny = denyScopes.global
	const globalEntries = [...globalAllow, ...globalDeny]

	const keptWorkspaceAllow = enabled
		? allowScopes.workspace.filter((entry) => !isShadowedByAnyEntry(entry, globalEntries))
		: []
	const keptWorkspaceDeny = enabled
		? denyScopes.workspace.filter((entry) => !isShadowedByAnyEntry(entry, globalEntries))
		: []

	const allowed = [...new Set([...globalAllow, ...keptWorkspaceAllow])]
	const denied = [...new Set([...globalDeny, ...keptWorkspaceDeny])]

	return {
		allowed,
		denied,
		globalAllow,
		globalDeny,
		keptWorkspaceAllow,
		keptWorkspaceDeny,
		hiddenWorkspaceAllow: allowScopes.workspace.filter((entry) => !allowed.includes(entry)),
		hiddenWorkspaceDeny: denyScopes.workspace.filter((entry) => !denied.includes(entry)),
	}
}

/**
 * Decides one command. Any matching global entry decides it: a user's allow
 * outranks a project's deny, and a user's deny outranks a project's allow.
 * Workspace entries apply only where no global entry matches. Within a layer
 * the matcher semantics stand: longest prefix wins, equal-length conflicts
 * deny. Chain splitting lives with the command matcher.
 *
 * @param command - The single (unchained) command to decide.
 * @param effective - A composition from {@link resolveEffectiveCommandLists}.
 * @returns The decision produced by the matching layer.
 */
export function getEffectiveCommandDecision(command: string, effective: EffectiveCommandLists): CommandDecision {
	// One probe asks the precedence question: does the global layer match at all?
	if (findLongestPrefixMatch(command, [...effective.globalAllow, ...effective.globalDeny]) !== null) {
		return getSingleCommandDecision(command, effective.globalAllow, effective.globalDeny)
	}
	return getSingleCommandDecision(command, effective.keptWorkspaceAllow, effective.keptWorkspaceDeny)
}

function sanitizeCommandList(list: unknown): string[] {
	if (!Array.isArray(list)) {
		return []
	}

	return list.filter((command): command is string => typeof command === "string" && command.trim().length > 0)
}
