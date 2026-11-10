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
 * The configuration object for every command-list read and write. Scoped to
 * `folderResource` when the caller resolved one — per-task enforcement reads
 * the folder that task runs in — and to the first workspace folder otherwise,
 * the default the display, save, and seeding callers keep. Sharing one scoped
 * access path keeps the two sides symmetric: `inspect()` can report
 * `workspaceFolderValue`, and `ConfigurationTarget.WorkspaceFolder` updates
 * are legal (the API contract throws for that target when the configuration
 * is not scoped to a resource). With no folder open — or when a supplied
 * resource resolved to nothing, see {@link commandListFolderForResource} —
 * the configuration is unscoped or defaults to the first folder and reports
 * only what that lookup can see.
 */
export function commandListConfiguration(folderResource?: vscode.Uri): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(
		Package.name,
		folderResource ?? vscode.workspace.workspaceFolders?.[0]?.uri,
	)
}

/**
 * Resolves the workspace folder a task's `cwd` lives in, so command-list
 * enforcement scopes its configuration reads to the folder the task belongs
 * to instead of the window's first folder. A child task inherits the working
 * directory of the task it came from, so it resolves to the same folder
 * without separate plumbing.
 *
 * The command path hands this lookup a cwd the filesystem has already
 * resolved to its real path, while the workspace registry holds each root as
 * it was opened. Containment is therefore tested against every root's real
 * path, so a root that is itself a symlink (or a Windows junction) keeps
 * matching its own real directory. Comparing against the registered paths
 * alone could not decide the folder: that comparison is lexical, so an outer
 * root lexically contains a directory that physically belongs to a deeper
 * root, and enforcing the outer root's lists there would let the deeper
 * folder's deny entries be skipped. Among several matches the deepest root
 * wins, mirroring how VS Code's own containment picks the innermost folder.
 * A root whose real path cannot be resolved is compared by its registered
 * path: the cwd is already canonical, so an unresolvable root can only
 * narrow which folder layer applies, never widen what a folder's allow list
 * may approve — and dropping the layer outright would silently change
 * enforcement for a folder the user has open.
 *
 * @param cwd - The task's working directory. An empty or absent cwd yields
 * `undefined` and keeps the first-folder configuration. A nonempty cwd with
 * no matching root also yields `undefined`. When both raw global lists are
 * available, enforcement then excludes the workspace layer; otherwise, it
 * uses the pre-composed state lists.
 * @returns The containing folder's registry URI — never a canonicalized one,
 * because folder-scoped configuration resolves against the registry — or
 * `undefined` when cwd is empty, resolves to no root, or lookup fails.
 */
export function commandListFolderForResource(cwd?: string): vscode.Uri | undefined {
	if (!cwd) {
		return undefined
	}

	// A failed lookup returns undefined, like a cwd naming no root.
	// With both raw global lists available, enforcement excludes the workspace
	// layer; otherwise, it uses the pre-composed state lists.
	try {
		// Comparing by root-path length makes the deepest match win: a root
		// registered lexically above a symlinked root must not claim a command
		// running in the deeper root's real directory. The separator guard
		// keeps a sibling like `/root/other` from matching a root `/root`.
		let match: vscode.Uri | undefined
		let matchedLength = 0
		for (const candidate of vscode.workspace.workspaceFolders ?? []) {
			const rootPath = realPathOrRegistered(candidate.uri.fsPath)
			// A filesystem root (`/`, `C:\`) already ends in a separator;
			// appending a second one (`//`, `C:\\`) would leave no child path
			// able to match the root, so the separator is added only where the
			// root lacks one.
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
 * The path a workspace root is compared by: its real filesystem path, or —
 * when that cannot be resolved (a relocated or deleted root) — the path the
 * registry holds. Root-side lookups stay best-effort because the cwd being
 * matched is already canonical; failing the comparison for one unresolvable
 * root would drop that folder's command-list layer without widening any
 * approval.
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
 * @param folderResource - Workspace folder the configuration is scoped to;
 * `undefined` keeps the first-folder default.
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
		// Only the configuration lookup itself is guarded: it can fail (for
		// example before the workspace is ready), and an absent workspace layer
		// must not break enforcement. The value reads below have no failure mode
		// of their own, so the catch covers exactly the failure it exists to
		// absorb.
		try {
			inspected = commandListConfiguration(folderResource).inspect<string[]>(configKey)
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

/**
 * Reads the `zoo-code.workspaceCommandListsEnabled` gate that decides whether
 * the workspace layers of the command-list keys take part in enforcement and
 * display at all. The configuration declares the key with `scope:
 * "application"`, so only user settings can flip it. The lookup is guarded
 * leniently like the command-list reads: a configuration failure keeps the
 * workspace layers inert, which cannot widen what auto-approval allows.
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
	 * commands no global entry matches (see {@link getEffectiveCommandDecision}).
	 */
	keptWorkspaceAllow: string[]
	/** Deny-side counterpart of {@link keptWorkspaceAllow}. */
	keptWorkspaceDeny: string[]
	/**
	 * Workspace allow entries absent from the effective allowlist — hidden by
	 * the gate or shadowed by a global entry — which a dialog save must not be
	 * able to delete by omission.
	 */
	hiddenWorkspaceAllow: string[]
	/** Deny-side counterpart of {@link hiddenWorkspaceAllow}. */
	hiddenWorkspaceDeny: string[]
}

/**
 * Composes the raw per-key layers into the pair of lists the settings dialog
 * displays, together with the layer split {@link getEffectiveCommandDecision}
 * matches commands against, so display and enforcement draw on one composition
 * pass and cannot drift.
 *
 * Gate off: the workspace layers contribute nothing and the global layers are
 * effective verbatim. Gate on: a workspace entry survives in the pair only
 * when no entry of either global list shadows it — an entry whose every match
 * a global entry also matches can decide nothing on its own, and keeping it
 * out of the pair keeps the dialog honest about what the global layer already
 * covers. A surviving entry may still overlap a global entry without being
 * shadowed by it (a wildcard deny matches commands no global prefix reaches);
 * the overlap is harmless because {@link getEffectiveCommandDecision} lets the
 * global layer decide every command it matches, so a workspace entry never
 * outranks a global match. Shadowing is cross-directional because a global
 * allow entry silences a workspace deny entry (and vice versa) just as much as
 * a same-list shadow.
 *
 * Composing here — not inside {@link readCommandListScopes} — keeps the raw
 * layers intact for the save path, which derives the write split from them and
 * must never see entries filtered out of the workspace layer.
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
 * Decides a single command under the precedence the command layers are
 * authored with: wherever a global (user-level) entry — allow or deny —
 * matches the command, the global layer decides it, so a user's own allow
 * outranks a project's deny and a user's own deny outranks a project's allow;
 * workspace entries apply only where no global entry matches. Within either
 * layer the established matcher semantics stand: the longest matching prefix
 * wins and an equal-length allow/deny conflict denies.
 *
 * The scope is one command: a chained command is decided per sub-command, and
 * chain splitting lives with the command matcher.
 *
 * @param command - The single (unchained) command to decide.
 * @param effective - A composition from {@link resolveEffectiveCommandLists}.
 * @returns The decision produced by the matching layer.
 */
export function getEffectiveCommandDecision(command: string, effective: EffectiveCommandLists): CommandDecision {
	// One longest-prefix probe asks the only question the precedence turns on:
	// does the global layer hold any match for this command at all?
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
