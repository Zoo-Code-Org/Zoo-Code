import * as vscode from "vscode"

import { commandListConfiguration, workspaceCommandListsEnabled } from "../core/auto-approval/commandScope"
import type { CommandListConfigKey } from "../core/auto-approval/commandScope"

/**
 * Seeds one auto-approval command-list key (`allowedCommands` or
 * `deniedCommands`) from its settings-file value into the extension's
 * global state, but only when global state holds no list for that key yet
 * (first run). Each key carries its own guard, so a profile whose allowlist
 * was already seeded still gets an unseeded deny list migrated on the next
 * activation.
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
 * explicit choice and suppresses the default — but only while the
 * `workspaceCommandListsEnabled` gate lets that value take effect: with the
 * gate off the workspace layer contributes nothing to enforcement, so
 * withholding the default would leave commands unapproved that the override
 * never actually governed. Array settings replace across scopes, so seeding
 * past an enforced override would re-grant the approvals it removed.
 *
 * @param globalState - The extension global-state memento to seed.
 * @param configKey - The command-list configuration key to seed.
 */
export async function seedCommandList(globalState: vscode.Memento, configKey: CommandListConfigKey): Promise<void> {
	if (globalState.get(configKey)) {
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
		inspected = commandListConfiguration().inspect<string[]>(configKey)
	} catch {
		return
	}

	// The `undefined` checks, not truthiness: an explicitly empty array still
	// counts as an override.
	const workspaceOverride = inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined

	const seedValue =
		inspected?.globalValue ??
		(workspaceOverride && workspaceCommandListsEnabled() ? undefined : inspected?.defaultValue)

	if (!Array.isArray(seedValue)) {
		return
	}

	// Copy so global state never shares a reference with the configuration object.
	await globalState.update(configKey, [...seedValue])
}
