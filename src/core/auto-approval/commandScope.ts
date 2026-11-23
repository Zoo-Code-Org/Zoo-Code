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
 * The workspace layers of one command-list key, from `inspect()`. One capture
 * gives a save one consistent view for its reads, write target, and rollback.
 */
export interface CommandListInspection {
	workspaceValue?: string[]
	workspaceFolderValue?: string[]
}

/**
 * The configuration for every command-list read and write. It is scoped to
 * `folderResource` when given, else to the first workspace folder. Read and
 * write share this scoped path, because a `ConfigurationTarget.WorkspaceFolder`
 * update is legal only on a resource-scoped configuration.
 */
export function commandListConfiguration(folderResource?: vscode.Uri): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(
		Package.name,
		folderResource ?? vscode.workspace.workspaceFolders?.[0]?.uri,
	)
}

/**
 * Resolves the workspace folder that holds a task's `cwd`, so enforcement
 * reads that folder's configuration and not the window's first folder. A child
 * task inherits the parent cwd and resolves the same way.
 *
 * The cwd arrives canonical. The registry holds roots as opened, so the lookup
 * compares each root's real path. A lexical compare alone would let an outer
 * root claim a symlinked deeper root's directory and skip its deny entries.
 * The deepest match wins, like VS Code's own containment. A root whose real
 * path does not resolve falls back to its registered path. That fallback can
 * only narrow the layer that applies. It can never widen approvals.
 *
 * @param cwd - The task's working directory. Empty, absent, or unmatched gives
 * `undefined` and keeps the first-folder configuration.
 * @returns The containing folder's registry URI. It stays uncanonicalized,
 * because folder-scoped configuration resolves against the registry.
 */
export function commandListFolderForResource(cwd?: string): vscode.Uri | undefined {
	if (!cwd) {
		return undefined
	}

	// A failed lookup gives `undefined`, like a cwd that names no root. The
	// caller then falls back to the pre-composed state lists.
	try {
		// Longest match wins so an outer root cannot claim a symlinked deeper
		// root's directory. The separator guard keeps `/root/other` out of `/root`.
		let match: vscode.Uri | undefined
		let matchedLength = 0
		for (const candidate of vscode.workspace.workspaceFolders ?? []) {
			const rootPath = realPathOrRegistered(candidate.uri.fsPath)
			// A filesystem root (`/`, `C:\`) already ends in a separator. A second separator stops child matching.
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
 * The path that a workspace root compares by: its real path, or the registered
 * path when the real path does not resolve. The cwd is already canonical. A
 * fallback here can only narrow matching, and it can never widen approvals.
 */
function realPathOrRegistered(fsPath: string): string {
	try {
		return fs.realpathSync(fsPath)
	} catch {
		return fsPath
	}
}

/**
 * Reads one auto-approval command list from both configuration layers and
 * composes the list to enforce and display.
 *
 * The workspace layer comes from `inspect()`, not `get()`. `get()` returns the
 * effective value, which already folds in `globalValue`. A union with the
 * global layer would count an entry twice and would keep a global removal from
 * shrinking the enforced set.
 *
 * @param configKey - The extension configuration key to read.
 * @param globalList - The list persisted in extension global state.
 * @param inspectionOverride - A pre-write snapshot. When present the function
 * uses it as-is, so a save shares one configuration state across its reads,
 * target, and rollback. Without it a failed lookup gives an empty workspace
 * layer.
 * @param folderResource - Workspace folder to scope to. `undefined` keeps the
 * first-folder default.
 * @returns The per-layer lists and their deduplicated union.
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
		// Guard only the lookup. It can fail before the workspace is ready. The reads
		// below have no failure mode of their own.
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
 * Splits the dialog's merged list back into the two layers that composed it,
 * so a save cannot flatten workspace entries into global settings.
 *
 * - A kept entry stays in every layer that held it. Dropping it from the global
 *   write would delete a global entry that the folder mirrors.
 * - A removed entry leaves every layer that held it, so a dialog delete works
 *   for workspace entries.
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
		// Preserve the dialog's ordering for entries the user added.
		...[...kept].filter((command) => !known.has(command)),
	]

	return { globalWrite, workspaceWrite }
}

/**
 * Picks the configuration target that owns the current workspace layer for
 * `configKey`. It reads through the same scoped configuration as
 * `readCommandListScopes`.
 *
 * - A set `workspaceFolderValue` gives `WorkspaceFolder`.
 * - Else a set `workspaceValue` gives `Workspace`.
 * - Neither gives `undefined`, so an empty workspace layer never appears in
 *   settings.json.
 *
 * @param configKey - The extension configuration key to inspect.
 * @param inspectionOverride - A caller snapshot. When present it alone picks
 * the target, so a save stays on one configuration state. Without it a failed
 * lookup means no workspace layer exists.
 * @returns The workspace-scoped target to write, or `undefined`.
 */
export function resolveWorkspaceWriteTarget(
	configKey: CommandListConfigKey,
	inspectionOverride?: CommandListInspection,
): vscode.ConfigurationTarget.WorkspaceFolder | vscode.ConfigurationTarget.Workspace | undefined {
	let inspected: CommandListInspection | undefined = inspectionOverride
	if (inspected === undefined) {
		// Same guard as `readCommandListScopes`: a failure means no workspace layer.
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
 * settings change it. A failed lookup keeps the workspace layers inert. That
 * result can only narrow the layers that apply, and it can never widen
 * approvals.
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
	 * Workspace allow entries that the gate and shadowing kept. They decide
	 * only commands that no global entry matches.
	 */
	keptWorkspaceAllow: string[]
	/** Deny-side counterpart of {@link keptWorkspaceAllow}. */
	keptWorkspaceDeny: string[]
	/**
	 * Workspace allow entries that the gate or a global shadow hides. A dialog
	 * save must not delete them by omission.
	 */
	hiddenWorkspaceAllow: string[]
	/** Deny-side counterpart of {@link hiddenWorkspaceAllow}. */
	hiddenWorkspaceDeny: string[]
}

/**
 * Composes the raw per-key layers into the pair that the dialog displays and
 * the layer split that {@link getEffectiveCommandDecision} matches against.
 * Display and enforcement therefore share one pass.
 *
 * Gate off: the global layers are effective as they stand. Gate on: a
 * workspace entry survives only when no global entry shadows it. Shadowing
 * works both ways, so a global allow silences a workspace deny and a global
 * deny silences a workspace allow. A surviving entry may overlap a global
 * entry without a shadow, and the overlap is harmless because the global
 * layer decides every command it matches.
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
 * Decides one command. Any matching global entry decides it: a user allow
 * outranks a project deny, and a user deny outranks a project allow. Workspace
 * entries apply only where no global entry matches. Inside a layer the
 * matcher rules hold: the longest prefix wins and an equal-length conflict
 * denies. The command matcher splits chains.
 *
 * @param command - The single (unchained) command to decide.
 * @param effective - A composition from {@link resolveEffectiveCommandLists}.
 * @returns The decision from the matching layer.
 */
export function getEffectiveCommandDecision(command: string, effective: EffectiveCommandLists): CommandDecision {
	// Ask the precedence question first: does the global layer match at all?
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
