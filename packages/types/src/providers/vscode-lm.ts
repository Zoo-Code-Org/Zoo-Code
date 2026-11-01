import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createProviderDefinition } from "./common.js"
import { vscodeLlmDefaultModelId } from "./vscode-llm.js"

const schema = {
	...baseProviderSettingsShape,
	vsCodeLmModelSelector: z
		.object({
			vendor: z.string().optional(),
			family: z.string().optional(),
			version: z.string().optional(),
			id: z.string().optional(),
		})
		.optional(),
}

// VS Code and Copilot report their available models at runtime, so neither
// provider declares a static catalog. `vscodeLlmModels` is only a measured
// baseline used to describe models once they are discovered.
export const vsCodeLmProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.vscodeLm,
	label: "VS Code LM API",
	serviceUrl: "https://code.visualstudio.com/api/extension-guides/language-model",
	getModelId: (settings) => settings.vsCodeLmModelSelector?.id,
	getDefaultModelId: () => vscodeLlmDefaultModelId,
	schema,
})

export const githubCopilotProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.githubCopilot,
	label: "GitHub Copilot",
	getModelId: (settings) => settings.vsCodeLmModelSelector?.id,
	getDefaultModelId: () => vscodeLlmDefaultModelId,
	schema,
})
