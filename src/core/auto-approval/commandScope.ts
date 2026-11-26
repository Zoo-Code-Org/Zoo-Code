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
	/**
	 * VS Code reports `null` here for a key that settings.json sets to `null`,
	 * so the type admits it and {@link selectWorkspaceCommandListLayer} decides
	 * what it means.
	 */
	workspaceFolderValue?: string[] | null
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
 * The deepest match wins, like VS Code's own containment.
 *
 * A root whose real path does not resolve bounds nothing reliable: its real
 * path is unknown, so no candidate can be shown to contain the cwd on its
 * behalf. The lookup then returns `undefined`, and no enclosing root approves
 * a command by standing in for that root. Enforcement reads the global layer
 * only, and the folder layer contributes nothing to the decision.
 *
 * @param cwd - The task's working directory. Empty, absent, unmatched, or
 * bounded only by an unresolvable root gives `undefined` and keeps the
 * first-folder configuration.
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
			if (rootPath === undefined) {
				// The root's real path is unknown, so this candidate cannot be
				// compared. Matching the cwd against the other roots would let one
				// of them decide for a directory this root may own.
				return undefined
			}
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
 * The path that a workspace root compares by: its real path. The cwd is
 * already canonical, so the two sides agree only when both are. The native
 * resolver reports the on-disk spelling, which is what the cwd arrives as. The
 * JavaScript resolver keeps the caller's spelling on Windows, so a root opened
 * under different casing would never match a canonical cwd.
 *
 * A root that does not resolve gives `undefined`, which drops the folder layer
 * rather than comparing the root by a path the filesystem never confirmed.
 */
function realPathOrRegistered(fsPath: string): string | undefined {
	try {
		return fs.realpathSync.native(fsPath)
	} catch {
		return undefined
	}
}

export type WorkspaceCommandListLayer = "workspaceFolder" | "workspace"

export interface WorkspaceCommandListSelection {
	/** The layer that owns the workspace list, or `undefined` when none is set. */
	layer: WorkspaceCommandListLayer | undefined
	/** The layer's value. It is `undefined` only when `layer` is `undefined`. */
	value: string[] | undefined
}

/**
 * The value one named workspace layer holds, or `undefined` when that layer
 * holds none.
 *
 * This answers a different question from
 * {@link selectWorkspaceCommandListLayer}, which answers which layer wins. A
 * caller that needs to know whether a specific layer still exists must ask
 * here: a folder override appearing mid-save makes the selector report the
 * folder layer, and that is not the workspace layer vanishing.
 *
 * @param inspection - The layers from one `inspect()`, or `undefined` when the
 * lookup failed.
 * @param layer - The layer to read.
 * @returns That layer's list, or `undefined` when it holds none.
 */
export function workspaceLayerValue(
	inspection: CommandListInspection | undefined,
	layer: WorkspaceCommandListLayer,
): string[] | undefined {
	// `!= null` covers both an absent folder value and a stored null, which VS
	// Code uses to mean the same thing here: no folder override. An explicit `[]`
	// is a real override and survives the test.
	const folder = inspection?.workspaceFolderValue
	if (layer === "workspaceFolder") {
		return folder == null ? undefined : folder
	}
	return inspection?.workspaceValue
}

/**
 * Decides which configuration layer holds the workspace command list, and what
 * that layer holds, from one inspection. Every reader of the workspace layer
 * resolves it here: the enforcement read, the write target, and the save path's
 * re-read. A caller that picks the layer itself can disagree with the others
 * about which layer exists, and then write one layer while reading another.
 *
 * A `null` folder value means "no folder override", not an override that holds
 * nothing. VS Code reports `null` when settings.json sets the key to null, and
 * a stored null selects no folder layer, so the workspace value serves instead.
 * Reading it as an override would write a folder layer that no read ever saw.
 * An explicit `[]` is a real override and keeps the folder layer.
 *
 * The per-layer rule lives in {@link workspaceLayerValue}, so the layer that
 * wins and the layer a caller writes cannot disagree about what "set" means.
 *
 * @param inspection - The layers from one `inspect()`, or `undefined` when the
 * lookup failed.
 * @returns The owning layer and its value, both `undefined` when neither layer
 * is set.
 */
export function selectWorkspaceCommandListLayer(
	inspection: CommandListInspection | undefined,
): WorkspaceCommandListSelection {
	const folderValue = workspaceLayerValue(inspection, "workspaceFolder")
	if (folderValue !== undefined) {
		return { layer: "workspaceFolder", value: folderValue }
	}
	const workspaceList = workspaceLayerValue(inspection, "workspace")
	if (workspaceList !== undefined) {
		return { layer: "workspace", value: workspaceList }
	}
	return { layer: undefined, value: undefined }
}

/**
 * Reads one auto-approval command list from both configuration layers and
 * composes the list to enforce and display.
 *
 * The workspace layer comes from `inspect()`, not `get()`. `get()` returns the
 * effective value, which already folds in `globalValue`. A union with the
 * global layer would count an entry twice and would keep a global removal from
 * shrinking the enforced set. Which layer supplies the workspace list is
 * {@link selectWorkspaceCommandListLayer}'s decision, so a read agrees with the
 * target a save writes.
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

	const workspace = sanitizeCommandList(selectWorkspaceCommandListLayer(inspected).value)

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
 * `readCommandListScopes`, and takes the layer from
 * {@link selectWorkspaceCommandListLayer}, so the target is the layer a read
 * saw.
 *
 * - The folder layer gives `WorkspaceFolder`.
 * - Else the workspace layer gives `Workspace`.
 * - No layer gives `undefined`, so an empty workspace layer never appears in
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

	switch (selectWorkspaceCommandListLayer(inspected).layer) {
		case "workspaceFolder":
			return vscode.ConfigurationTarget.WorkspaceFolder
		case "workspace":
			return vscode.ConfigurationTarget.Workspace
		default:
			return undefined
	}
}

export interface CommandListBaselineClassification {
	/** Entries a layer held at save start that the baseline and the submission both omit. */
	externallyAdded: string[]
	/** Entries the split treats as known state, so a file deletion still applies. */
	splitSourceEntries: string[]
	/** Hidden workspace entries the split must not read as new promotions. */
	promotionHiddenEntries: string[]
}

/**
 * Classifies the submitted list against the baseline the dialog displayed.
 *
 * The three results feed one split. `externallyAdded` holds entries that a
 * layer gained while the dialog was open. `splitSourceEntries` holds the
 * entries the split may keep. `promotionHiddenEntries` holds hidden entries
 * that must not become a promotion into the global layer.
 *
 * @param input.baseline - The lists the dialog displayed for this key, or
 * `undefined` when the sender shows no lists.
 * @param input.incoming - The submitted list for this key.
 * @param input.currentScopes - The layers read from the state copy and the
 * save-start snapshot.
 * @param input.configGlobalAtSaveStart - The configuration's global layer at
 * save start.
 * @param input.globalLayerAtSaveStart - The same layer, kept as absent when the
 * key had no global value.
 * @param input.hiddenWorkspaceEntries - Workspace entries the dialog did not
 * display.
 * @param input.gateAtDisplay - The gate as the dialog showed it, if it sent it.
 * A sender that sent no value writes its hidden set unclassified.
 * @returns The externally added entries, the split source, and the promotion
 * hidden entries.
 */
export function classifyCommandListBaseline(input: {
	baseline: string[] | undefined
	incoming: string[]
	currentScopes: CommandListScopes
	configGlobalAtSaveStart: string[]
	globalLayerAtSaveStart: string[] | undefined
	hiddenWorkspaceEntries: string[]
	gateAtDisplay: boolean | undefined
}): CommandListBaselineClassification {
	const {
		baseline,
		incoming,
		currentScopes,
		configGlobalAtSaveStart,
		globalLayerAtSaveStart,
		hiddenWorkspaceEntries,
		gateAtDisplay,
	} = input

	// A file entry the dialog never showed looks like a user deletion: in the file,
	// absent from the submitted list. The baseline separates the two, so entries
	// outside it are re-admitted before the split, while deleting a baseline entry
	// still applies. Hidden entries are excluded because the caller's workspace
	// re-add preserves them, so a warning would fire on every save. That
	// exclusion covers only entries the hidden workspace layer held. The
	// configuration's global layer is displayed, and excluding it would delete
	// the user's file addition.
	// A sender with no baseline writes its list unclassified. The union spans every
	// layer that can hold an entry at save start, because the state copy lags.
	const externallyAdded = Array.isArray(baseline)
		? [...new Set([...currentScopes.workspace, ...currentScopes.global, ...configGlobalAtSaveStart])].filter(
				(entry) =>
					!baseline.includes(entry) &&
					!incoming.includes(entry) &&
					(!hiddenWorkspaceEntries.includes(entry) || configGlobalAtSaveStart.includes(entry)),
			)
		: []
	// A file-deleted entry is still in the submitted list. With no layer holding
	// it, the split would treat it as brand-new and promote a project entry into
	// the global layer. The baseline separates that case from a user addition.
	// Submitting a displayed entry signals retention. A retained entry that no
	// configuration layer holds was removed in the file. The file then wins over
	// the stale dialog buffer. The state copy still counts where the
	// configuration has no global layer. An absent layer deleted nothing, and the
	// activation-seeded defaults would otherwise vanish on the first save.
	const splitSourceEntries = Array.isArray(baseline)
		? [...incoming, ...externallyAdded].filter(
				(entry) =>
					!baseline.includes(entry) ||
					currentScopes.workspace.includes(entry) ||
					configGlobalAtSaveStart.includes(entry) ||
					(currentScopes.global.includes(entry) && globalLayerAtSaveStart === undefined),
			)
		: [...incoming, ...externallyAdded]
	// A hidden entry the baseline shows was displayed, so keeping it stays a
	// workspace decision. It must not become a promotion into the global layer,
	// whether or not the gate moved since the dialog read it. An entry absent
	// from the baseline was never displayed and may still be promoted. A sender
	// with no baseline writes its hidden set unclassified.
	const promotionHiddenEntries =
		gateAtDisplay === undefined
			? hiddenWorkspaceEntries
			: hiddenWorkspaceEntries.filter((entry) => !Array.isArray(baseline) || !baseline.includes(entry))

	return { externallyAdded, splitSourceEntries, promotionHiddenEntries }
}

export type CommandListRollbackOutcome =
	/** The global write never landed, so nothing needs undoing. */
	| { status: "not-applied" }
	/** The global delta is undone, and no entry of another writer was lost. */
	| { status: "rolled-back" }
	| { status: "re-read-failed"; message: string }
	| { status: "restore-failed"; message: string }

/**
 * Reconciles a failed or half-applied command-list save against its own global
 * write.
 *
 * The undo is a delta against a fresh read, so an entry a third party added
 * mid-save survives. It never rewinds to a snapshot, because the configuration
 * API offers no compare-and-set.
 *
 * @param input.key - The command-list key that failed.
 * @param input.failure - The failure text of the write that threw.
 * @param input.globalWrite - The global list this save attempted.
 * @param input.configGlobalAtSaveStart - The configuration's global layer at
 * save start, which is the delta baseline.
 * @param input.globalLayerAtSaveStart - The same layer, kept as absent when the
 * key had no global value.
 * @param input.globalWriteApplied - Whether this save's global write landed.
 * @param input.readGlobalLayer - Reads the global layer now. It may throw.
 * @param input.writeGlobalLayer - Writes the global layer, or clears the key
 * with `undefined`. It may reject.
 * @returns The outcome. Only `rolled-back` states that the undo landed.
 */
export async function rollbackFailedCommandListWrite(input: {
	key: CommandListConfigKey
	failure: string
	globalWrite: string[]
	configGlobalAtSaveStart: string[]
	globalLayerAtSaveStart: string[] | undefined
	globalWriteApplied: boolean
	readGlobalLayer: () => string[] | undefined
	writeGlobalLayer: (value: string[] | undefined) => PromiseLike<unknown>
}): Promise<CommandListRollbackOutcome> {
	if (!input.globalWriteApplied) {
		return { status: "not-applied" }
	}

	const { key, failure, globalWrite, configGlobalAtSaveStart, globalLayerAtSaveStart } = input

	// Undo exactly this save's global delta, against a fresh read, so entries a
	// third party added mid-save survive. A snapshot rewind would clobber them,
	// because the configuration API offers no compare-and-set.
	const addedByThisSave = globalWrite.filter((entry) => !configGlobalAtSaveStart.includes(entry))
	const removedByThisSave = configGlobalAtSaveStart.filter((entry) => !globalWrite.includes(entry))
	// A failed re-read means nothing is safe to write. The save-start fallback
	// is the clobber this path avoids.
	let freshGlobalValue: string[] | undefined
	try {
		freshGlobalValue = input.readGlobalLayer()
	} catch (reReadError) {
		return {
			status: "re-read-failed",
			message: `Failed to save ${key}: ${failure}. The global-scoped value could not be re-read to undo this save: ${reReadError}. Review the command lists in your user and workspace settings.`,
		}
	}
	// The compensation decides the global layer from four cases, in this order.
	// (a) No value now: the layer that existed at save start is gone, so a later
	//     writer deleted it. Clearing the key is that writer's decision, and the
	//     entries this save removed must not come back.
	// (b) The value now is this save's own write, order aside: the half-applied
	//     save itself, so the entries this save removed go back. A layer that
	//     started absent is restored to absence, because an empty layer left
	//     behind reads back as the user's explicit empty override.
	// (c) An empty value now while this save wrote entries: another writer
	//     cleared the layer. That clear outranks this save's removal, and
	//     restoring over it would re-add entries the user just deleted.
	// (d) Anything else, in particular a value that merely gained entries: the
	//     difference is not a decision about the entries this save removed, so
	//     they go back beside the additions.
	const globalLayerExistsNow = freshGlobalValue !== undefined
	const freshIsThisSavesWrite =
		freshGlobalValue !== undefined &&
		freshGlobalValue.length === globalWrite.length &&
		freshGlobalValue.every((entry) => globalWrite.includes(entry))
	const freshClearedByAnotherWriter =
		freshGlobalValue !== undefined && freshGlobalValue.length === 0 && globalWrite.length > 0
	// Case (c) yields to the clear; cases (b) and (d) restore the removals. Case
	// (a) never reaches this list, because it clears the key instead.
	const restoreRemovedByThisSave = freshIsThisSavesWrite || !freshClearedByAnotherWriter
	const globalUndo = [
		...new Set([
			...(freshGlobalValue ?? []).filter((entry) => !addedByThisSave.includes(entry)),
			...(restoreRemovedByThisSave ? removedByThisSave : []),
		]),
	]
	// Case (b) over a start that held no layer restores the absence itself. An
	// empty layer left behind would read back as the user's explicit override.
	const ownWriteRestoresAbsence =
		globalLayerAtSaveStart === undefined && freshIsThisSavesWrite && globalUndo.length === 0
	try {
		if (!globalLayerExistsNow) {
			// Case (a): the key had a layer at save start, so its absence now is a
			// deletion by a later writer. That decision outranks this save's removed
			// delta, exactly as another writer's `[]` does. Writing the removed entries
			// back would resurrect a layer the user deleted.
			await input.writeGlobalLayer(undefined)
		} else if (ownWriteRestoresAbsence) {
			await input.writeGlobalLayer(undefined)
		} else {
			await input.writeGlobalLayer(globalUndo)
		}
	} catch (restoreError) {
		// The undo itself failed. The configuration keeps the partially written
		// values, and the code skips the extension global-state write. Stored
		// state therefore never reflects a save that did not complete. The user
		// hears about both failures.
		return {
			status: "restore-failed",
			message: `Failed to save ${key}: ${failure}. The global-scoped restore also failed: ${restoreError}. Review the command lists in your user and workspace settings.`,
		}
	}

	return { status: "rolled-back" }
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

export function sanitizeCommandList(list: unknown): string[] {
	if (!Array.isArray(list)) {
		return []
	}

	return list.filter((command): command is string => typeof command === "string" && command.trim().length > 0)
}
