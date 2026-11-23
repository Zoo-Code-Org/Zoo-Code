import * as vscode from "vscode"

import { commandListConfiguration, workspaceCommandListsEnabled } from "../core/auto-approval/commandScope"
import type { CommandListConfigKey } from "../core/auto-approval/commandScope"

/**
 * Seeds one command-list key from its settings value into extension global
 * state, only when global state holds no list for that key. Each key has its
 * own guard, so a seeded allowlist does not block a later deny-list migration.
 *
 * The seed reads `inspect()`, not `get()`. `get()` folds in workspace
 * overrides, which would leak a project's `.vscode/settings.json` into global
 * state for good. The lookup shares `commandListConfiguration()` with the
 * read and write paths, so the folder layer is visible where enforcement sees
 * it.
 *
 * Selection: the global value wins. With no value set anywhere, the package
 * default is seeded, because enforcement never falls back to it. An enforced
 * workspace override suppresses the default: array settings replace across
 * scopes, so seeding past the override would re-grant the approvals it
 * removed. With the gate off the override is inert, so the default is still
 * seeded.
 *
 * @param globalState - The extension global-state memento to seed.
 * @param configKey - The command-list configuration key to seed.
 */
export async function seedCommandList(globalState: vscode.Memento, configKey: CommandListConfigKey): Promise<void> {
	if (globalState.get(configKey)) {
		return
	}

	// Guard only the lookup. It can fail before the workspace is ready, and a skip
	// then defers the seed to a later activation.
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
