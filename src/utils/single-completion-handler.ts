import type { ProviderSettings } from "@roo-code/types"

import { buildApiHandler, disposeApiHandler, SingleCompletionHandler, type CompletePromptOptions } from "../api"

/**
 * Enhances a prompt using the configured API without creating a full Cline instance or task history.
 * This is a lightweight alternative that only uses the API's completion functionality.
 */
export async function singleCompletionHandler(
	apiConfiguration: ProviderSettings,
	promptText: string,
	options?: CompletePromptOptions,
): Promise<string> {
	if (!promptText) {
		throw new Error("No prompt text provided")
	}
	if (!apiConfiguration || !apiConfiguration.apiProvider) {
		throw new Error("No valid API configuration provided")
	}

	const handler = buildApiHandler(apiConfiguration)

	try {
		// Check if handler supports single completions
		if (!("completePrompt" in handler)) {
			throw new Error("The selected API provider does not support prompt enhancement")
		}

		return await (handler as SingleCompletionHandler).completePrompt(promptText, options)
	} finally {
		// Handlers such as VS Code LM / GitHub Copilot hold listeners that must be released.
		disposeApiHandler(handler)
	}
}
