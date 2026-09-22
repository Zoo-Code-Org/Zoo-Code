import { GoogleGenAI } from "@google/genai"

import type { ModelRecord } from "@roo-code/types"
import { geminiModels } from "@roo-code/types"

// The models.list catalog also covers embedding, TTS, and Imagen families, which
// are not generative chat models — the Gemini handler can only call generative
// gemini-* models, so surfacing them would create picker entries that fail at
// request time. Discovery excludes them from the catalog.
const NON_GENERATIVE_MODEL_ID = /embedding|tts|imagen/i

/**
 * Fetches available models from the Gemini API (ML Dev) via the @google/genai SDK
 * and merges them with known specs.
 *
 * The list endpoint only returns resource names without pricing or context window
 * info, so we merge the API response with the static `geminiModels` map for known
 * models. Unknown models get Gemini-family defaults with no pricing fields, so
 * cost reporting shows "unknown" instead of charging rates we can't verify
 * (mirroring the unknown-ID fallback in src/api/providers/gemini.ts getModel).
 *
 * @param apiKey The Gemini API key (required — listing is authenticated)
 * @param baseUrl Optional base URL override (e.g. a proxy), forwarded per call via httpOptions
 * @param opts Optional per-request controls; `signal` cancels the in-flight request.
 * @returns A promise that resolves to a record of model IDs to model info
 * @throws Will throw an error if the API key is missing or the request fails.
 */
export async function getGeminiModels(
	apiKey?: string,
	baseUrl?: string,
	opts?: { signal?: AbortSignal },
): Promise<ModelRecord> {
	if (!apiKey) {
		throw new Error("Failed to fetch Gemini models: API key is required.")
	}

	const client = new GoogleGenAI({ apiKey })

	const pager = await client.models.list({
		config: {
			pageSize: 1000,
			httpOptions: baseUrl ? { baseUrl } : undefined,
			abortSignal: opts?.signal,
		},
	})

	// Use null-prototype object to prevent prototype pollution
	const models: ModelRecord = Object.create(null)

	for await (const model of pager) {
		// ML Dev resource names look like "models/gemini-2.5-flash".
		const modelId = model.name?.replace(/^models\//, "")
		if (!modelId || !modelId.startsWith("gemini-") || NON_GENERATIVE_MODEL_ID.test(modelId)) continue

		const knownSpecs = geminiModels[modelId as keyof typeof geminiModels]

		if (knownSpecs) {
			models[modelId] = { ...knownSpecs }
		} else {
			models[modelId] = {
				maxTokens: 65_536,
				contextWindow: 1_048_576,
				supportsImages: true,
				supportsPromptCache: true,
				description: `Gemini model: ${modelId}`,
			}
		}
	}

	return models
}
