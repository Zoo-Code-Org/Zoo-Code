import axios from "axios"
import { z } from "zod"

import { type ModelInfo, UMANS_DEFAULT_BASE_URL } from "@roo-code/types"

const supportedReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])

const umansReasoningSchema = z
	.object({
		supported: z.boolean().optional(),
		can_disable: z.boolean().optional(),
		levels: z.array(supportedReasoningEffortSchema).optional(),
		default_level: supportedReasoningEffortSchema.nullish(),
	})
	.optional()

const umansModelSchema = z.object({
	name: z.string(),
	display_name: z.string().optional(),
	description: z.string().optional(),
	capabilities: z.object({
		max_completion_tokens: z.number().nullish(),
		recommended_max_tokens: z.number().nullish(),
		context_window: z.number(),
		supports_vision: z.union([z.boolean(), z.string()]).optional(),
		reasoning: umansReasoningSchema,
	}),
})

const umansModelsInfoResponseSchema = z.record(z.string(), umansModelSchema)

const umansPricingResponseSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			pricing: z
				.object({
					input: z.number().optional(),
					output: z.number().optional(),
				})
				.optional(),
		}),
	),
})

export async function getUmansModels(): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	try {
		const [infoResponse, pricingResponse] = await Promise.all([
			axios.get(`${UMANS_DEFAULT_BASE_URL}/models/info`),
			axios.get(`${UMANS_DEFAULT_BASE_URL}/models`),
		])

		const infoResult = umansModelsInfoResponseSchema.safeParse(infoResponse.data)
		if (!infoResult.success) {
			return models
		}

		const pricingResult = umansPricingResponseSchema.safeParse(pricingResponse.data)
		const pricingById = new Map(
			(pricingResult.success ? pricingResult.data.data : []).map((entry) => [entry.id, entry.pricing]),
		)

		for (const [id, rawModel] of Object.entries(infoResult.data)) {
			const reasoning = rawModel.capabilities.reasoning
			const reasoningLevels = reasoning?.levels

			models[id] = {
				maxTokens:
					rawModel.capabilities.recommended_max_tokens ??
					rawModel.capabilities.max_completion_tokens ??
					undefined,
				contextWindow: rawModel.capabilities.context_window,
				supportsImages: rawModel.capabilities.supports_vision !== false,
				supportsPromptCache: false,
				supportsMaxTokens: rawModel.capabilities.max_completion_tokens != null,
				supportsReasoningEffort: reasoningLevels && reasoningLevels.length > 0 ? reasoningLevels : undefined,
				reasoningEffort: reasoning?.default_level ?? undefined,
				inputPrice: pricingById.get(id)?.input,
				outputPrice: pricingById.get(id)?.output,
				description: rawModel.description ?? rawModel.display_name,
			}
		}
	} catch (error) {
		console.error(`Error fetching Umans models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
	}

	return models
}
