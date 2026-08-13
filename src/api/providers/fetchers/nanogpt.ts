import axios from "axios"
import { z } from "zod"

import { NANOGPT_BASE_URL, nanoGptDefaultModelInfo, type ModelInfo, type ModelRecord } from "@roo-code/types"

const nanoGptPricingSchema = z.object({
	prompt: z.number().nonnegative().optional(),
	completion: z.number().nonnegative().optional(),
	cacheReadInputPer1kTokens: z.number().nonnegative().optional(),
	cacheWriteInputPer1kTokens: z.number().nonnegative().optional(),
})

const nanoGptModelSchema = z.object({
	id: z.string().min(1),
	name: z.string().optional(),
	description: z.string().optional(),
	context_length: z.number().positive().optional(),
	max_output_tokens: z.number().positive().optional(),
	capabilities: z
		.object({
			vision: z.boolean().optional(),
			tool_calling: z.boolean().optional(),
		})
		.optional(),
	pricing: nanoGptPricingSchema.optional(),
})

export type NanoGptModel = z.infer<typeof nanoGptModelSchema>

function getSafeErrorMessage(error: unknown, apiKey?: string): string {
	const message = error instanceof Error ? error.message : String(error)
	return apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message
}

const nanoGptModelsResponseSchema = z.object({
	data: z.array(z.unknown()),
})

export const parseNanoGptModel = (model: NanoGptModel): ModelInfo => ({
	contextWindow: model.context_length ?? nanoGptDefaultModelInfo.contextWindow,
	maxTokens: model.max_output_tokens ?? nanoGptDefaultModelInfo.maxTokens,
	supportsPromptCache: false,
	...(model.capabilities?.vision !== undefined ? { supportsImages: model.capabilities.vision } : {}),
	...(model.name !== undefined ? { displayName: model.name } : {}),
	...(model.description !== undefined ? { description: model.description } : {}),
	...(model.pricing?.prompt !== undefined ? { inputPrice: model.pricing.prompt } : {}),
	...(model.pricing?.completion !== undefined ? { outputPrice: model.pricing.completion } : {}),
	...(model.pricing?.cacheReadInputPer1kTokens !== undefined
		? { cacheReadsPrice: model.pricing.cacheReadInputPer1kTokens * 1_000 }
		: {}),
	...(model.pricing?.cacheWriteInputPer1kTokens !== undefined
		? { cacheWritesPrice: model.pricing.cacheWriteInputPer1kTokens * 1_000 }
		: {}),
})

/** Fetches NanoGPT's public detailed catalog, optionally scoped by a Bearer key. */
export async function getNanoGptModels(apiKey?: string): Promise<ModelRecord> {
	try {
		const response = await axios.get(`${NANOGPT_BASE_URL}/models?detailed=true`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			timeout: 10_000,
		})
		const responseResult = nanoGptModelsResponseSchema.safeParse(response.data)
		if (!responseResult.success) {
			console.warn("NanoGPT models response did not match the expected top-level schema")
			return {}
		}

		const models: ModelRecord = {}
		for (const rawModel of responseResult.data.data) {
			const modelResult = nanoGptModelSchema.safeParse(rawModel)
			if (!modelResult.success) {
				console.warn("Skipping invalid NanoGPT model entry")
				continue
			}

			// NanoGPT can route to non-agentic models. An explicit false is authoritative;
			// an omitted capability remains unknown and therefore eligible.
			if (modelResult.data.capabilities?.tool_calling === false) {
				continue
			}

			models[modelResult.data.id] = parseNanoGptModel(modelResult.data)
		}

		return models
	} catch (error) {
		console.error(`Error fetching NanoGPT models: ${getSafeErrorMessage(error, apiKey)}`)
		return {}
	}
}
