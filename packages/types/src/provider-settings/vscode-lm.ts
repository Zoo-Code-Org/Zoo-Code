import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createProviderDefinition } from "./common.js"

export const vsCodeLmProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.vscodeLm,
	getModelId: (settings) => settings.vsCodeLmModelSelector?.id,
	schema: {
		...baseProviderSettingsShape,
		vsCodeLmModelSelector: z
			.object({
				vendor: z.string().optional(),
				family: z.string().optional(),
				version: z.string().optional(),
				id: z.string().optional(),
			})
			.optional(),
	},
})
