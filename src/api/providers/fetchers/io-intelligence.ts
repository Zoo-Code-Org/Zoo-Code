import axios from "axios"
import { z } from "zod"

import {
	IO_INTELLIGENCE_BASE_URL,
	ioIntelligenceDefaultModelInfo,
	type ModelInfo,
	type ModelRecord,
} from "@roo-code/types"

const ioIntelligenceModelSchema = z.object({
	id: z.string().min(1),
	name: z.string().optional(),
	max_model_len: z.number().int().positive().nullish(),
	context_window: z.number().int().positive().nullish(),
	max_tokens: z.number().int().positive().nullish(),
	supports_tools: z.boolean().optional(),
	supports_prompt_cache: z.boolean().optional(),
	input_modalities: z.array(z.string()).optional(),
	input_token_price: z.number().nonnegative().optional(),
	output_token_price: z.number().nonnegative().optional(),
	cache_read_token_price: z.number().nonnegative().optional(),
})

export type IOIntelligenceModel = z.infer<typeof ioIntelligenceModelSchema>

function getSafeErrorMessage(error: unknown, apiKey?: string): string {
	const message = error instanceof Error ? error.message : String(error)
	return apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message
}

const ioIntelligenceModelsResponseSchema = z.object({
	object: z.string().optional(),
	data: z.array(z.unknown()),
})

export const parseIoIntelligenceModel = (model: IOIntelligenceModel): ModelInfo => ({
	maxTokens: model.max_tokens ?? ioIntelligenceDefaultModelInfo.maxTokens,
	contextWindow: model.context_window ?? model.max_model_len ?? ioIntelligenceDefaultModelInfo.contextWindow,
	supportsImages: model.input_modalities?.includes("image") ?? false,
	supportsPromptCache: model.supports_prompt_cache ?? false,
	...(model.input_token_price !== undefined ? { inputPrice: model.input_token_price * 1_000_000 } : {}),
	...(model.output_token_price !== undefined ? { outputPrice: model.output_token_price * 1_000_000 } : {}),
	...(model.cache_read_token_price !== undefined
		? { cacheReadsPrice: model.cache_read_token_price * 1_000_000 }
		: {}),
	...(model.name !== undefined ? { displayName: model.name } : {}),
	description: model.name ?? model.id,
})

/**
 * Fetches the public IO Intelligence (io.net) model catalog.
 *
 * The catalog can be listed without an API key, while a Bearer key scopes the
 * visible models for the account (io.net exposes per-tier access). Prices are
 * published per token and normalized to per-million-token units.
 */
export async function getIOIntelligenceModels(apiKey?: string): Promise<ModelRecord> {
	try {
		const response = await axios.get(`${IO_INTELLIGENCE_BASE_URL}/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			timeout: 10_000,
		})
		const responseResult = ioIntelligenceModelsResponseSchema.safeParse(response.data)
		if (!responseResult.success) {
			console.warn("IO Intelligence models response did not match the expected top-level schema")
			return {}
		}

		const models: ModelRecord = {}
		for (const rawModel of responseResult.data.data) {
			const modelResult = ioIntelligenceModelSchema.safeParse(rawModel)
			if (!modelResult.success) {
				console.warn("Skipping invalid IO Intelligence model entry")
				continue
			}

			// Zoo Code is agentic-first: io.net marks a few catalog models as not
			// supporting tools. An explicit false is authoritative; an omitted flag
			// remains unknown and therefore eligible (mirrors the NanoGPT fetcher).
			if (modelResult.data.supports_tools === false) {
				continue
			}

			models[modelResult.data.id] = parseIoIntelligenceModel(modelResult.data)
		}

		return models
	} catch (error) {
		console.error(`Error fetching IO Intelligence models: ${getSafeErrorMessage(error, apiKey)}`)
		return {}
	}
}
