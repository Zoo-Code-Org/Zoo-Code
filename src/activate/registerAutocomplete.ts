import type { ResolvedAutocompleteConfig } from "@roo-code/types"
import * as vscode from "vscode"

import { ClineProvider } from "../core/webview/ClineProvider"
import { AutocompleteService, setAutocompleteService } from "../services/autocomplete/AutocompleteService"

export interface RegisterAutocompleteOptions {
	context: vscode.ExtensionContext
	/** Resolved global autocomplete config; re-read after every settings change. */
	getGlobalConfig: () => ResolvedAutocompleteConfig
	/** The persisted API key from SecretStorage, or undefined when none is set. */
	getApiKey: () => string | undefined
	provider: ClineProvider
}

/**
 * Registers the inline autocomplete feature: the inline completion provider,
 * the status bar and the workspace-scoped configuration watcher.
 *
 * The global config is read through `getGlobalConfig` so the service picks up
 * saved settings without re-registering; `webviewMessageHandler` calls
 * `handleSettingsChange()` after `updateSettings` completes.
 */
export async function registerAutocomplete(options: RegisterAutocompleteOptions): Promise<AutocompleteService> {
	const { context, getGlobalConfig, provider } = options

	const openSettings = () => {
		void provider
			.postMessageToWebview({
				type: "action",
				action: "switchTab",
				tab: "settings",
				values: { section: "autocomplete" },
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error)
				void vscode.window.showErrorMessage(`Failed to open autocomplete settings: ${message}`)
			})
	}

	const service = await AutocompleteService.create({
		context,
		getGlobalConfig,
		getApiKey: () => provider.contextProxy.getValue("autocompleteApiKey"),
		openSettings,
		setEnabled: async (enabled) => {
			await provider.contextProxy.setValue("autocompleteConfig", {
				...getGlobalConfig(),
				enabled,
			})
		},
	})
	setAutocompleteService(service)
	return service
}
