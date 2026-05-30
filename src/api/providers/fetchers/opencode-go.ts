import axios from "axios"
import { z } from "zod"

import type { ModelInfo } from "@roo-code/types"
import { opencodeGoDefaultModelInfo } from "@roo-code/types"

const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1"

// The Opencode Go `/models` endpoint follows the OpenAI `/models` shape. The
// `id` is the only guaranteed field; metadata is optional and best-effort, so
// the schema is intentionally permissive. Pricing is intentionally NOT parsed:
// the units returned by the endpoint aren't documented, and reporting a wrong
// cost is worse than reporting "unknown" — so cost stays undefined until the
// pricing shape is confirmed against the live endpoint.
const opencodeGoModelSchema = z.object({
	id: z.string(),
	name: z.string().optional(),
	description: z.string().optional(),
	context_window: z.number().optional(),
	context_length: z.number().optional(),
	max_tokens: z.number().optional(),
	max_output_tokens: z.number().optional(),
	supports_images: z.boolean().optional(),
})

export type OpencodeGoModel = z.infer<typeof opencodeGoModelSchema>

const opencodeGoModelsResponseSchema = z.object({
	data: z.array(opencodeGoModelSchema),
})

/**
 * Maps a raw Opencode Go model entry to the internal {@link ModelInfo} shape.
 *
 * Falls back to {@link opencodeGoDefaultModelInfo} when the upstream payload
 * omits context-window or max-token fields, ensuring downstream consumers
 * always receive a fully-populated object.
 *
 * @param model - Validated model entry from the `/models` response.
 * @returns Normalised model metadata suitable for the model picker.
 */
export const parseOpencodeGoModel = (model: OpencodeGoModel): ModelInfo => ({
	maxTokens: model.max_output_tokens ?? model.max_tokens ?? opencodeGoDefaultModelInfo.maxTokens,
	contextWindow: model.context_window ?? model.context_length ?? opencodeGoDefaultModelInfo.contextWindow,
	supportsImages: model.supports_images ?? false,
	supportsPromptCache: false,
	description: model.description ?? model.name,
})

/**
 * Fetches the list of available models from the Opencode Go `/models` endpoint.
 *
 * The endpoint shape mirrors the OpenAI `/models` response. A permissive Zod
 * schema is used so that unknown fields are silently dropped rather than
 * causing a hard failure. Invalid entries (e.g. missing `id`) are skipped
 * with a console warning rather than propagated to the UI.
 *
 * @param apiKey - Optional Bearer token for authenticated requests.
 * @returns A record mapping model IDs to their normalised {@link ModelInfo}.
 */
export async function getOpencodeGoModels(apiKey?: string): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	try {
		const response = await axios.get(`${OPENCODE_GO_BASE_URL}/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			timeout: 10_000,
		})

		const result = opencodeGoModelsResponseSchema.safeParse(response.data)
		const rawData = result.success ? result.data.data : response.data?.data
		const data = Array.isArray(rawData) ? rawData : []

		if (!result.success) {
			console.warn(
				`Opencode Go models response did not match expected schema; falling back to per-item parsing: ${JSON.stringify(result.error.format())}`,
			)
		}

		for (const rawModel of data) {
			const parsed = opencodeGoModelSchema.safeParse(rawModel)
			if (!parsed.success) {
				console.warn(`Skipping invalid Opencode Go model entry: ${JSON.stringify(rawModel)}`)
				continue
			}
			models[parsed.data.id] = parseOpencodeGoModel(parsed.data)
		}
	} catch (error) {
		console.error(`Error fetching Opencode Go models: ${error instanceof Error ? error.message : String(error)}`)
	}

	return models
}
