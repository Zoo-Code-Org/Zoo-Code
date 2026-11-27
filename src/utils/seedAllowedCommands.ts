import * as vscode from "vscode"

import {
	commandListConfiguration,
	selectWorkspaceCommandListLayer,
	workspaceCommandListsEnabled,
} from "../core/auto-approval/commandScope"
import type { CommandListConfigKey, CommandListInspection } from "../core/auto-approval/commandScope"

/**
 * The layers one `inspect()` reports for a command-list key: the selector's
 * workspace layers plus the global and default values the seed chooses between.
 */
interface CommandListSeedInspection extends CommandListInspection {
	globalValue?: string[]
	defaultValue?: string[]
}

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
 * seeded. A folder value stored as `null` selects no layer, so it suppresses
 * nothing.
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
	let inspected: CommandListSeedInspection | undefined
	try {
		inspected = commandListConfiguration().inspect<string[]>(configKey)
	} catch {
		return
	}

	// Which layer holds a workspace list is the selector's decision, so the seed
	// cannot disagree with the read and write paths about which layer exists. A
	// stored `null` folder value selects no layer, an explicit `[]` does, and
	// either layer is an override even when it holds nothing.
	const workspaceOverride = selectWorkspaceCommandListLayer(inspected).layer !== undefined

	const seedValue =
		inspected?.globalValue ??
		(workspaceOverride && workspaceCommandListsEnabled() ? undefined : inspected?.defaultValue)

	if (!Array.isArray(seedValue)) {
		return
	}

	// Copy so global state never shares a reference with the configuration object.
	await globalState.update(configKey, [...seedValue])
}
