import type { ModelRecord } from "@roo-code/types"
import { mimoModels } from "@roo-code/types"

import { DEFAULT_HEADERS } from "../constants"

// The /models endpoint also lists ASR/TTS families, which are not text chat
// models — they require modality-specific payloads this provider never
// builds, so discovery excludes them from the catalog.
const NON_TEXT_MODEL_ID = /-(asr|tts)(-|$)/i

/**
 * Fetches available models from the Xiaomi MiMo API and merges them with known specs.
 *
 * MiMo's OpenAI-compatible /models endpoint only returns basic model IDs without
 * pricing or context window info, so we merge the API response with the static
 * `mimoModels` map for known models. Unknown models get MiMo-family defaults with
 * `preserveReasoning` enabled — MiMo requires reasoning_content to be passed back
 * in multi-turn tool-calling conversations, so reasoning preservation is a
 * correctness requirement, not an optimization.
 */
export async function getMimoModels(
	baseUrl?: string,
	apiKey?: string,
	opts?: { signal?: AbortSignal },
): Promise<ModelRecord> {
	// MiMo API uses OpenAI-compatible /v1/models endpoint.
	// The base URL from settings already includes /v1 (e.g. https://token-plan-sgp.xiaomimimo.com/v1),
	// so we keep it as-is and append /models directly.
	const base = (baseUrl || "https://token-plan-sgp.xiaomimimo.com/v1").replace(/\/+$/, "")
	const url = new URL(`${base}/models`)

	// The settings schema only allows https:// endpoints, but this fetcher also
	// receives unsaved webview values — enforce the contract at the boundary so
	// the bearer key is never sent over plaintext HTTP.
	if (url.protocol !== "https:") {
		throw new Error(`MiMo model fetch requires an https:// base URL (received "${url.protocol}")`)
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...DEFAULT_HEADERS,
	}

	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`
	}

	const response = await fetch(url.toString(), {
		headers,
		signal: opts?.signal,
	})

	if (!response.ok) {
		let errorBody = ""
		try {
			errorBody = await response.text()
		} catch {
			errorBody = "(unable to read response body)"
		}

		console.error(`[getMimoModels] HTTP error:`, {
			status: response.status,
			statusText: response.statusText,
			url: url.toString(),
			body: errorBody,
		})

		throw new Error(`HTTP ${response.status}: ${response.statusText}`)
	}

	const data = await response.json()

	if (!data?.data || !Array.isArray(data.data)) {
		console.error("[getMimoModels] Unexpected response format:", data)
		throw new Error("Failed to fetch MiMo models: Unexpected response format.")
	}

	// Use null-prototype object to prevent prototype pollution
	const models: ModelRecord = Object.create(null)

	for (const model of data.data) {
		// Skip non-record elements so a single malformed entry cannot abort
		// the whole catalog.
		if (typeof model !== "object" || model === null) continue

		const modelId = typeof model.id === "string" && model.id ? model.id : null
		if (!modelId || NON_TEXT_MODEL_ID.test(modelId)) continue

		const knownSpecs = mimoModels[modelId as keyof typeof mimoModels]

		if (knownSpecs) {
			models[modelId] = { ...knownSpecs }
		} else {
			models[modelId] = {
				maxTokens: 16_000,
				contextWindow: 262_144,
				supportsImages: false,
				supportsPromptCache: false,
				preserveReasoning: true,
				description: `MiMo model: ${modelId}`,
			}
		}
	}

	return models
}
