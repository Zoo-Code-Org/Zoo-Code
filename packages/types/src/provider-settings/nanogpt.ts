import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

const NANOGPT_MODEL_ID_FIELD = "nanoGptModelId"

export const nanoGptRoutingPreferences = ["auto", "fast", "cheap", "latency", "throughput", "tools", "caching"] as const

export const nanoGptRoutingPreferenceSchema = z.enum(nanoGptRoutingPreferences)
export type NanoGptRoutingPreference = z.infer<typeof nanoGptRoutingPreferenceSchema>
export const nanoGptDefaultRoutingPreference: NanoGptRoutingPreference = "auto"

export const nanoGptProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.nanogpt,
	modelIdKey: NANOGPT_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(NANOGPT_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		nanoGptApiKey: z.string().optional(),
		[NANOGPT_MODEL_ID_FIELD]: z.string().optional(),
		nanoGptRoutingPreference: nanoGptRoutingPreferenceSchema.optional(),
	},
})
