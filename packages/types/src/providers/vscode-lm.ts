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

export const vsCodeLmProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.vscodeLm,
	getModelId: (settings) => settings.vsCodeLmModelSelector?.id,
	getDefaultModelId: () => vscodeLlmDefaultModelId,
	schema,
})

export const githubCopilotProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.githubCopilot,
	getModelId: (settings) => settings.vsCodeLmModelSelector?.id,
	getDefaultModelId: () => vscodeLlmDefaultModelId,
	schema,
})
