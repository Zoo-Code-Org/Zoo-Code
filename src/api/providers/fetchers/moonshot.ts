import type { ModelRecord } from "@roo-code/types"
import { moonshotModels } from "@roo-code/types"

import { DEFAULT_HEADERS } from "../constants"

/**
 * Fetches available models from the Moonshot API and merges them with known specs.
 *
 * The Moonshot /models endpoint only returns basic model IDs without pricing
 * or context window info, so we merge the API response with the static
 * `moonshotModels` map for known models. Unknown models get sensible defaults.
 */
export async function getMoonshotModels(baseUrl?: string, apiKey?: string): Promise<ModelRecord> {
	// Moonshot API uses OpenAI-compatible /v1/models endpoint.
	// The base URL from settings already includes /v1 (e.g. https://api.moonshot.ai/v1),
	// so we keep it as-is and append /models directly.
	const base = (baseUrl || "https://api.moonshot.ai/v1").replace(/\/+$/, "")
	const url = `${base}/models`

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

			console.error(`[getMoonshotModels] HTTP error:`, {
				status: response.status,
				statusText: response.statusText,
				url,
				body: errorBody,
			})

			throw new Error(`HTTP ${response.status}: ${response.statusText}`)
		}

		const data = await response.json()

		if (!data?.data || !Array.isArray(data.data)) {
			console.error("[getMoonshotModels] Unexpected response format:", data)
			throw new Error("Failed to fetch Moonshot models: Unexpected response format.")
		}

		// Use null-prototype object to prevent prototype pollution
		const models: ModelRecord = Object.create(null)

		for (const model of data.data) {
			const modelId = typeof model.id === "string" && model.id ? model.id : null
			if (!modelId) continue

			const knownSpecs = moonshotModels[modelId as keyof typeof moonshotModels]

			if (knownSpecs) {
				models[modelId] = { ...knownSpecs }
			} else {
				models[modelId] = {
					maxTokens: 16_000,
					contextWindow: 262_144,
					supportsImages: false,
					supportsPromptCache: true,
					description: `Moonshot model: ${modelId}`,
				}
			}
		}

		return models
	} finally {
		clearTimeout(timeoutId)
	}
}
