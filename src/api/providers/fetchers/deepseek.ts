import type { ModelRecord } from "@roo-code/types"
import { deepSeekModels, DEEP_SEEK_DEFAULT_TEMPERATURE } from "@roo-code/types"

import { DEFAULT_HEADERS } from "../constants"

/**
 * Fetches available models from the DeepSeek API and merges them with known specs.
 *
 * The DeepSeek /models endpoint only returns basic model IDs without pricing
 * or context window info, so we merge the API response with the static
 * `deepSeekModels` map for known models. Unknown models get sensible defaults.
 */
export async function getDeepSeekModels(baseUrl?: string, apiKey?: string): Promise<ModelRecord> {
	const normalizedBase = (baseUrl || "https://api.deepseek.com").replace(/\/?v1\/?$/, "")
	const url = `${normalizedBase}/models`
	const allowModelListFallback = process.env.E2E_MOCK_MODEL_LIST_FALLBACK === "true"

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...DEFAULT_HEADERS,
	}

	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`
	}

	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), 10000)

	try {
		const response = await fetch(url, {
			headers,
			signal: controller.signal,
		})

		if (!response.ok) {
			let errorBody = ""
			try {
				errorBody = await response.text()
			} catch {
				errorBody = "(unable to read response body)"
			}

			console.error(`[getDeepSeekModels] HTTP error:`, {
				status: response.status,
				statusText: response.statusText,
				url,
				body: errorBody,
			})

			// In mocked e2e environments, /models may be intentionally unimplemented.
			// Allow an explicit test-only fallback to static DeepSeek model metadata.
			if (allowModelListFallback && response.status === 404) {
				const models: ModelRecord = Object.create(null)
				for (const [modelId, modelInfo] of Object.entries(deepSeekModels)) {
					models[modelId] = { ...modelInfo }
				}
				return models
			}

			throw new Error(`HTTP ${response.status}: ${response.statusText}`)
		}

		const data = await response.json()

		if (!data?.data || !Array.isArray(data.data)) {
			console.error("[getDeepSeekModels] Unexpected response format:", data)
			throw new Error("Failed to fetch DeepSeek models: Unexpected response format.")
		}

		// Use null-prototype object to prevent prototype pollution
		const models: ModelRecord = Object.create(null)

		for (const model of data.data) {
			const modelId = typeof model.id === "string" && model.id ? model.id : null
			if (!modelId) continue

			const knownSpecs = deepSeekModels[modelId as keyof typeof deepSeekModels]

			if (knownSpecs) {
				models[modelId] = { ...knownSpecs }
			} else {
				models[modelId] = {
					maxTokens: 8192,
					contextWindow: 128_000,
					supportsImages: false,
					supportsPromptCache: true,
					inputPrice: 0.28,
					outputPrice: 0.42,
					cacheWritesPrice: 0.28,
					cacheReadsPrice: 0.028,
					defaultTemperature: DEEP_SEEK_DEFAULT_TEMPERATURE,
					description: `DeepSeek model: ${modelId}`,
				}
			}
		}

		return models
	} finally {
		clearTimeout(timeoutId)
	}
}
