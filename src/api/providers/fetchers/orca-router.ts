import axios from "axios"
import { z } from "zod"

import { ORCA_ROUTER_BASE_URL, orcaRouterDefaultModelInfo, type ModelInfo, type ModelRecord } from "@roo-code/types"

const orcaRouterModelSchema = z.object({
	id: z.string().min(1),
	name: z.string().optional(),
	description: z.string().optional(),
	context_length: z.number().positive().nullish(),
	max_completion_tokens: z.number().positive().nullish(),
	architecture: z
		.object({
			input_modalities: z.array(z.string()).optional(),
		})
		.optional(),
	pricing: z
		.object({
			prompt: z.string().nullish(),
			completion: z.string().nullish(),
		})
		.optional(),
})

const orcaRouterModelsResponseSchema = z.object({
	data: z.array(z.unknown()),
})

function parseApiPrice(value: string | null | undefined): number | undefined {
	if (value === null || value === undefined) {
		return undefined
	}

	const price = Number(value)
	return Number.isFinite(price) ? price : undefined
}

export const parseOrcaRouterModel = (model: z.infer<typeof orcaRouterModelSchema>): ModelInfo => ({
	contextWindow: model.context_length ?? orcaRouterDefaultModelInfo.contextWindow,
	maxTokens: model.max_completion_tokens ?? orcaRouterDefaultModelInfo.maxTokens,
	supportsPromptCache: false,
	supportsImages: model.architecture?.input_modalities?.includes("image") ?? false,
	...(model.name !== undefined ? { displayName: model.name } : {}),
	...(model.description !== undefined ? { description: model.description } : {}),
	...(model.pricing?.prompt !== undefined ? { inputPrice: parseApiPrice(model.pricing.prompt) } : {}),
	...(model.pricing?.completion !== undefined ? { outputPrice: parseApiPrice(model.pricing.completion) } : {}),
})

/**
 * Fetches OrcaRouter's public model catalog. The endpoint is unauthenticated,
 * so the API key is optional and only forwarded when present.
 */
export async function getOrcaRouterModels(apiKey?: string): Promise<ModelRecord> {
	try {
		const response = await axios.get(`${ORCA_ROUTER_BASE_URL}/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			timeout: 10_000,
		})
		const responseResult = orcaRouterModelsResponseSchema.safeParse(response.data)
		if (!responseResult.success) {
			console.warn("OrcaRouter models response did not match the expected top-level schema")
			return {}
		}

		const models: ModelRecord = {}
		for (const rawModel of responseResult.data.data) {
			const modelResult = orcaRouterModelSchema.safeParse(rawModel)
			if (!modelResult.success) {
				continue
			}

			models[modelResult.data.id] = parseOrcaRouterModel(modelResult.data)
		}

		return models
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(
			`Error fetching OrcaRouter models: ${apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message}`,
		)
		return {}
	}
}
