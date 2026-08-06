import type { ResolvedAutocompleteConfig } from "@roo-code/types"
import * as vscode from "vscode"

import { Package } from "../../../shared/package"

export interface WorkspaceAutocompleteConfig {
	disabled: boolean
	debugLogging: boolean
}

/**
 * Merges the persisted global autocomplete config (from ContextProxy state) with
 * the workspace-level `zoo-code.autocomplete.*` configuration properties.
 *
 * The workspace properties act as a kill switch and a debug toggle that a repo
 * can ship in `.vscode/settings.json`; they are intentionally NOT part of the
 * persisted `autocompleteConfig` object so repositories cannot pollute user-level
 * settings exports.
 */
export class AutocompleteConfigService {
	constructor(private readonly getGlobalConfig: () => ResolvedAutocompleteConfig) {}

	/**
	 * The fully merged config. Workspace values are read fresh on every call so
	 * `zoo-code.autocomplete.*` edits in `.vscode/settings.json` apply immediately
	 * without an extension reload.
	 */
	getConfig(): ResolvedAutocompleteConfig {
		const global = this.getGlobalConfig()
		const workspace = AutocompleteConfigService.readWorkspaceConfig()

		if (workspace.disabled) {
			return { ...global, enabled: false }
		}

		return global
	}

	isEnabled(): boolean {
		return this.getConfig().enabled
	}

	isDebugLogging(): boolean {
		return AutocompleteConfigService.readWorkspaceConfig().debugLogging
	}

	/**
	 * Reads the `zoo-code.autocomplete.*` properties from VS Code configuration.
	 * Both properties are plain booleans; anything else is treated as unset.
	 */
	static readWorkspaceConfig(): WorkspaceAutocompleteConfig {
		const config = vscode.workspace.getConfiguration(Package.name)
		return {
			disabled: config.get<boolean>("autocomplete.disabled", false),
			debugLogging: config.get<boolean>("autocomplete.debugLogging", false),
		}
	}
}
