import * as vscode from "vscode"

import { commandListConfiguration } from "../core/auto-approval/commandScope"

/**
 * Seeds the extension's global-state allowlist from the `allowedCommands`
 * setting, but only when global state holds no list yet (first run).
 *
 * The seed reads scoped values via `inspect()` rather than the effective
 * `get()` on purpose: `get()` folds in workspace-scoped overrides, so a
 * project's `.vscode/settings.json` would otherwise be copied permanently
 * into global state the first time the extension activates inside that
 * project — a leak that survives closing the project. The lookup goes
 * through `commandListConfiguration()`, the folder-scoped accessor shared
 * with the command-list read and write paths: only a configuration resolved
 * against a resource reports `workspaceFolderValue` at all, so the folder
 * layer is visible here exactly where enforcement can see it. In a
 * multi-root workspace only the first folder is in scope; with no folder
 * open the configuration is unscoped and reports no folder value.
 *
 * Selection: the global-scope value wins. With nothing set at any scope (a
 * fresh install) the declared package default is seeded, because the
 * enforcement path reads only global state plus workspace scopes and never
 * falls back to that default on its own. A workspace-scoped value is an
 * explicit choice and suppresses the default: array settings replace across
 * scopes, so seeding it would re-grant the auto-approvals the override
 * removed.
 *
 * @param globalState - The extension global-state memento to seed.
 */
export async function seedAllowedCommands(globalState: vscode.Memento): Promise<void> {
	if (globalState.get("allowedCommands")) {
		return
	}

	// Only the configuration lookup itself is guarded: it can fail (for example
	// before the workspace is ready), and skipping the seed then only defers it
	// to a later activation. The `inspected` reads below stay outside the
	// guarded region so a genuine lookup failure stays distinguishable from an
	// absent value rather than being swallowed as one.
	let inspected:
		| {
				globalValue?: string[]
				defaultValue?: string[]
				workspaceValue?: string[]
				workspaceFolderValue?: string[]
		  }
		| undefined
	try {
		inspected = commandListConfiguration().inspect<string[]>("allowedCommands")
	} catch {
		return
	}

	// The `undefined` checks, not truthiness: an explicitly empty array still
	// counts as an override.
	const seedValue =
		inspected?.globalValue ??
		(inspected?.workspaceValue === undefined && inspected?.workspaceFolderValue === undefined
			? inspected?.defaultValue
			: undefined)

	if (!Array.isArray(seedValue)) {
		return
	}

	// Copy so global state never shares a reference with the configuration object.
	await globalState.update("allowedCommands", [...seedValue])
}
