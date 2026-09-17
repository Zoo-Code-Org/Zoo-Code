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
	object: z.string().optional(),
	created: z.number().optional(),
	owned_by: z.string().optional(),
	root: z.string().nullable().optional(),
	parent: z.string().nullable().optional(),
	max_model_len: z.number().nullable().optional(),
})

export type IOIntelligenceModel = z.infer<typeof ioIntelligenceModelSchema>

const ioIntelligenceModelsResponseSchema = z.object({
	object: z.string().optional(),
	data: z.array(z.unknown()),
})

function getSafeErrorMessage(error: unknown, apiKey?: string): string {
	const message = error instanceof Error ? error.message : String(error)
	return apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message
}

export const parseIoIntelligenceModel = (model: IOIntelligenceModel): ModelInfo => ({
	maxTokens: ioIntelligenceDefaultModelInfo.maxTokens,
	contextWindow: model.max_model_len ?? ioIntelligenceDefaultModelInfo.contextWindow,
	supportsImages: false,
	supportsPromptCache: false,
	...(model.name !== undefined ? { displayName: model.name } : {}),
	description: model.name ?? model.id,
})

/**
 * Fetches IO Intelligence's public /models catalog, optionally scoped by a
 * Bearer key. Model ids are Hugging Face-style `org/name` identifiers.
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

			models[modelResult.data.id] = parseIoIntelligenceModel(modelResult.data)
		}

		return models
	} catch (error) {
		console.error(`Error fetching IO Intelligence models: ${getSafeErrorMessage(error, apiKey)}`)
		return {}
	}
}
