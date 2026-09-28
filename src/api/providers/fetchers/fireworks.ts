import type { ModelInfo, ModelRecord } from "@roo-code/types"
import { fireworksModels } from "@roo-code/types"

import { DEFAULT_HEADERS } from "../constants"
import { throwIfAborted } from "../utils/abort-signal"

export const FIREWORKS_MODELS_URL = "https://api.fireworks.ai/inference/v1/models"

// Fallbacks used for models that are not in the curated static map and whose
// API entry omits the corresponding field.
const FIREWORKS_FALLBACK_CONTEXT_WINDOW = 128_000
const FIREWORKS_FALLBACK_MAX_TOKENS = 16_384

type FireworksApiModel = {
	id?: unknown
	supports_chat?: unknown
	supports_image_input?: unknown
	supports_tools?: unknown
	context_length?: unknown
}

const isPositiveNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0

/**
 * Build ModelInfo for a model that is not in the curated static map, using the
 * capability fields returned by the Fireworks OpenAI-compatible /models endpoint.
 * Pricing is intentionally omitted: the endpoint does not return it, and guessing
 * would produce misleading cost reports.
 */
function parseFireworksModel(modelId: string, model: FireworksApiModel): ModelInfo {
	const contextWindow = isPositiveNumber(model.context_length)
		? model.context_length
		: FIREWORKS_FALLBACK_CONTEXT_WINDOW

	return {
		maxTokens: Math.min(FIREWORKS_FALLBACK_MAX_TOKENS, contextWindow),
		contextWindow,
		supportsImages: model.supports_image_input === true,
		supportsPromptCache: false,
		description: `Fireworks model: ${modelId}`,
	}
}

/**
 * Fetches the models available to the given API key from the Fireworks API.
 *
 * The Fireworks /inference/v1/models endpoint returns model IDs together with
 * capability metadata (context length, image and tool support) but no pricing.
 * Known models keep their curated static specs (including pricing); models that
 * are not in the static map are built from the API metadata. Non-chat models
 * (embeddings, rerankers) are skipped because they cannot back a chat task.
 */
export async function getFireworksModels(apiKey?: string, opts?: { signal?: AbortSignal }): Promise<ModelRecord> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...DEFAULT_HEADERS,
	}

	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`
	}

	const response = await fetch(FIREWORKS_MODELS_URL, {
		headers,
		signal: opts?.signal,
	})

	if (!response.ok) {
		throwIfAborted(opts?.signal)

		let errorBody = ""
		try {
			errorBody = await response.text()
		} catch {
			errorBody = "(unable to read response body)"
		}

		console.error(`[getFireworksModels] HTTP error:`, {
			status: response.status,
			statusText: response.statusText,
			url: FIREWORKS_MODELS_URL,
			body: errorBody,
		})

		throw new Error(`HTTP ${response.status}: ${response.statusText}`)
	}

	const data = await response.json()

	if (!data?.data || !Array.isArray(data.data)) {
		console.error("[getFireworksModels] Unexpected response format:", data)
		throw new Error("Failed to fetch Fireworks models: Unexpected response format.")
	}

	// Use null-prototype object to prevent prototype pollution
	const models: ModelRecord = Object.create(null)

	for (const model of data.data as FireworksApiModel[]) {
		const modelId = typeof model?.id === "string" && model.id ? model.id : null
		if (!modelId) continue

		// Embedding / reranker models report supports_chat: false.
		if (model.supports_chat === false) continue

		const knownSpecs = fireworksModels[modelId as keyof typeof fireworksModels]

		models[modelId] = knownSpecs ? { ...knownSpecs } : parseFireworksModel(modelId, model)
	}

	return models
}
