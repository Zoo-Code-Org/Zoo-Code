import type { ModelRecord } from "@roo-code/types"
import { deepSeekModels, DEEP_SEEK_DEFAULT_TEMPERATURE } from "@roo-code/types"

import { DEFAULT_HEADERS } from "../constants"

// Reserved keys that could be used for prototype pollution
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"])

/**
 * Validates and sanitizes a model ID to prevent prototype pollution.
 * Returns the sanitized string, or null if the key is invalid.
 */
function sanitizeModelId(raw: unknown): string | null {
	const id = String(raw)
	if (!id || RESERVED_KEYS.has(id)) {
		return null
	}
	return id
}

/**
 * Fetches available models from the DeepSeek API and merges them with known specs.
 *
 * The DeepSeek /models endpoint only returns basic model IDs without pricing
 * or context window info, so we merge the API response with the static
 * `deepSeekModels` map for known models. Unknown models get sensible defaults.
 *
 * @param baseUrl - The base URL for the DeepSeek API (default: https://api.deepseek.com)
 * @param apiKey - Optional API key for authentication
 * @returns A promise that resolves to a record of model IDs to model info
 */
export async function getDeepSeekModels(baseUrl?: string, apiKey?: string): Promise<ModelRecord> {
	const normalizedBase = (baseUrl || "https://api.deepseek.com").replace(/\/?v1\/?$/, "")
	const url = `${normalizedBase}/models`

	try {
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
				const modelId = sanitizeModelId(model.id)
				if (!modelId) continue

				// If we have known specs for this model, use them
				const knownSpecs = deepSeekModels[modelId as keyof typeof deepSeekModels]

				if (knownSpecs) {
					models[modelId] = { ...knownSpecs }
				} else {
					// Unknown model - use sensible defaults based on DeepSeek's typical specs
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
	} catch (error) {
		console.error(`[getDeepSeekModels] Failed to fetch models:`, error)
		throw error
	}
}
