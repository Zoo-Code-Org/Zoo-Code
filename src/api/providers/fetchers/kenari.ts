import axios from "axios"
import { z } from "zod"

import type { ModelInfo } from "@roo-code/types"
import { kenariDefaultModelInfo, KENARI_BASE_URL } from "@roo-code/types"

// The Kenari `/models` endpoint follows the OpenAI `/models` shape and is
// public (no key required). The `id` is the only guaranteed field; metadata is
// optional and best-effort, so the schema is intentionally permissive.
// Pricing is intentionally NOT parsed: Kenari returns prices in IDR
// (`micro_idr_per_1m_tokens`), and the ModelInfo price fields are USD per 1M
// tokens, so reporting a converted or raw value would be wrong. Cost stays
// undefined instead.
const kenariModelSchema = z.object({
	id: z.string(),
	name: z.string().optional(),
	description: z.string().optional(),
	context_window: z.number().optional(),
	context_length: z.number().optional(),
	max_tokens: z.number().optional(),
	max_output_tokens: z.number().optional(),
	modalities: z
		.object({
			input: z.array(z.string()).optional(),
			output: z.array(z.string()).optional(),
		})
		.optional(),
})

export type KenariModel = z.infer<typeof kenariModelSchema>

const kenariModelsResponseSchema = z.object({
	data: z.array(kenariModelSchema),
})

/**
 * Maps a raw Kenari model entry to the internal {@link ModelInfo} shape.
 *
 * Falls back to {@link kenariDefaultModelInfo} when the upstream payload
 * omits context-window or max-token fields, ensuring downstream consumers
 * always receive a fully-populated object.
 *
 * @param model - Validated model entry from the `/models` response.
 * @returns Normalised model metadata suitable for the model picker.
 */
export const parseKenariModel = (model: KenariModel): ModelInfo => ({
	maxTokens: model.max_output_tokens ?? model.max_tokens ?? kenariDefaultModelInfo.maxTokens,
	contextWindow: model.context_window ?? model.context_length ?? kenariDefaultModelInfo.contextWindow,
	supportsImages: model.modalities?.input?.includes("image") ?? false,
	supportsPromptCache: false,
	description: model.description ?? model.name,
})

/**
 * Fetches the list of available models from the Kenari `/models` endpoint.
 *
 * The endpoint shape mirrors the OpenAI `/models` response. A permissive Zod
 * schema is used so that unknown fields are silently dropped rather than
 * causing a hard failure. Invalid entries (e.g. missing `id`) are skipped
 * with a console warning rather than propagated to the UI.
 *
 * @param apiKey - Optional Bearer token; the endpoint is public but the key is
 *   sent when available.
 * @returns A record mapping model IDs to their normalised {@link ModelInfo}.
 */
export async function getKenariModels(apiKey?: string): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	try {
		const response = await axios.get(`${KENARI_BASE_URL}/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			timeout: 10_000,
		})

		const result = kenariModelsResponseSchema.safeParse(response.data)
		const rawData = result.success ? result.data.data : response.data?.data
		const data = Array.isArray(rawData) ? rawData : []

		if (!result.success) {
			console.warn(
				`Kenari models response did not match expected schema; falling back to per-item parsing: ${JSON.stringify(result.error.format())}`,
			)
		}

		for (const rawModel of data) {
			const parsed = kenariModelSchema.safeParse(rawModel)
			if (!parsed.success) {
				console.warn(`Skipping invalid Kenari model entry: ${JSON.stringify(rawModel)}`)
				continue
			}
			models[parsed.data.id] = parseKenariModel(parsed.data)
		}
	} catch (error) {
		console.error(`Error fetching Kenari models: ${error instanceof Error ? error.message : String(error)}`)
	}

	return models
}
