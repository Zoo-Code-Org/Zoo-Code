import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const bedrockProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.bedrock,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		awsAccessKey: z.string().optional(),
		awsSecretKey: z.string().optional(),
		awsSessionToken: z.string().optional(),
		awsRegion: z.string().optional(),
		awsUseCrossRegionInference: z.boolean().optional(),
		awsUseGlobalInference: z.boolean().optional(), // Enable Global Inference profile routing when supported
		awsUsePromptCache: z.boolean().optional(),
		awsProfile: z.string().optional(),
		awsUseProfile: z.boolean().optional(),
		awsApiKey: z.string().optional(),
		awsUseApiKey: z.boolean().optional(),
		awsCustomArn: z.string().optional(),
		awsModelContextWindow: z.number().optional(),
		awsBedrockEndpointEnabled: z.boolean().optional(),
		awsBedrockEndpoint: z.string().optional(),
		awsBedrock1MContext: z.boolean().optional(), // Enable 'context-1m-2025-08-07' beta for 1M context window.
		awsBedrockServiceTier: z.enum(["STANDARD", "FLEX", "PRIORITY"]).optional(), // AWS Bedrock service tier selection
	},
})
