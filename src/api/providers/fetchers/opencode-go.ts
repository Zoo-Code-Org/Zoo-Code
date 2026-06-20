import axios from "axios"
import { z } from "zod"

import type { ModelInfo } from "@roo-code/types"
import { opencodeGoDefaultModelInfo, getOpencodeGoModelInfo } from "@roo-code/types"

const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1"

// The Opencode Go `/models` endpoint follows the OpenAI `/models` shape. The
// `id` is the only guaranteed field; metadata is optional and best-effort, so
// the schema is intentionally permissive. Pricing is intentionally NOT parsed:
// the units returned by the endpoint aren't documented, and reporting a wrong
// cost is worse than reporting "unknown" — so cost stays sourced from the
// native registry (or undefined for unknown models) until the pricing shape is
// confirmed against the live endpoint.
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
 * The Go `/models` endpoint only reliably returns `id` and (sometimes)
 * `context_window`/`max_tokens`. It does NOT advertise capability flags
 * (`supportsReasoningEffort`, `preserveReasoning`, `supportsMaxTokens`,
 * `supportsPromptCache`) or pricing, all of which the extension needs to drive
 * reasoning controls, interleaved-thinking tool calls, the max-output-tokens
 * slider, and accurate cost reporting.
 *
 * Resolution order for a fully-populated {@link ModelInfo}:
 *   1. Start from the native registry ({@link getOpencodeGoModelInfo}) when the
 *      model ID is curated — this supplies correct context lengths, max tokens,
 *      capability flags, and pricing sourced from vendor specs.
 *   2. Override `contextWindow`, `maxTokens`, and `supportsImages` with values
 *      from the live `/models` payload when present, so the gateway stays the
 *      source of truth for those volatile fields.
 *   3. Fall back to {@link opencodeGoDefaultModelInfo} for any field still
 *      missing on an unknown (non-curated) model, ensuring downstream consumers
 *      always receive a fully-populated object.
 *
 * @param model - Validated model entry from the `/models` response.
 * @returns Normalised model metadata suitable for the model picker.
 */
export const parseOpencodeGoModel = (model: OpencodeGoModel): ModelInfo => {
	const native = getOpencodeGoModelInfo(model.id)

	// Live endpoint values take precedence over the registry for volatile fields.
	const liveContextWindow = model.context_window ?? model.context_length
	const liveMaxTokens = model.max_output_tokens ?? model.max_tokens
	const liveSupportsImages = model.supports_images

	if (native) {
		return {
			...native,
			...(liveContextWindow !== undefined && { contextWindow: liveContextWindow }),
			...(liveMaxTokens !== undefined && { maxTokens: liveMaxTokens }),
			...(liveSupportsImages !== undefined && { supportsImages: liveSupportsImages }),
			description: model.description ?? model.name ?? native.description,
		}
	}

	return {
		maxTokens: liveMaxTokens ?? opencodeGoDefaultModelInfo.maxTokens,
		contextWindow: liveContextWindow ?? opencodeGoDefaultModelInfo.contextWindow,
		supportsImages: liveSupportsImages ?? false,
		supportsPromptCache: false,
		description: model.description ?? model.name,
	}
}

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
