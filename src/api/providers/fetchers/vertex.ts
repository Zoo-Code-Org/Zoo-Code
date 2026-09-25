import { GoogleGenAI } from "@google/genai"

import type { ModelRecord } from "@roo-code/types"
import { vertexModels } from "@roo-code/types"

import { parseVertexJsonCredentials } from "../utils/vertex-credentials"

// The publisher catalog also covers embedding, TTS, and Imagen families, which
// are not generative chat models. The catalog further lists Model Garden partner
// models (Claude, Llama, ...) that VertexHandler cannot call: it requests
// publishers/google/models/{id}, so partner models would 404 at request time
// (issue #785). Discovery therefore keeps only generative gemini-* models and
// excludes everything else from the catalog.
const NON_GENERATIVE_MODEL_ID = /embedding|tts|imagen/i

/**
 * Fetches available models from the Vertex AI publisher catalog via the
 * @google/genai SDK and merges them with known specs.
 *
 * Auth mirrors the GeminiHandler constructor chain: raw JSON service-account
 * credentials take precedence, then a key file path, then Application Default
 * Credentials (the SDK throws when no credential source is available).
 *
 * The list endpoint only returns resource names without pricing or context
 * window info, so we merge the API response with the static `vertexModels` map
 * for known models. Unknown models get Gemini-family defaults with no pricing
 * fields, so cost reporting shows "unknown" (vertexDefaultModelId is a Claude
 * model and is deliberately never used as an info fallback here).
 *
 * @param projectId The Google Cloud project ID (required — listing needs a project)
 * @param region The Google Cloud region; undefined lets the SDK apply its default
 * @param keyFile Optional path to a service-account key file
 * @param jsonCredentials Optional raw JSON contents of a service-account key file
 * @param opts Optional per-request controls; `signal` cancels the in-flight request.
 * @returns A promise that resolves to a record of model IDs to model info
 * @throws Will throw an error if the project ID is missing or the request fails.
 */
export async function getVertexModels(
	projectId?: string,
	region?: string,
	keyFile?: string,
	jsonCredentials?: string,
	opts?: { signal?: AbortSignal },
): Promise<ModelRecord> {
	if (!projectId) {
		throw new Error("Failed to fetch Vertex models: project ID is required.")
	}

	const parsedCredentials = parseVertexJsonCredentials(jsonCredentials)

	const client = parsedCredentials
		? new GoogleGenAI({
				vertexai: true,
				project: projectId,
				location: region,
				googleAuthOptions: {
					credentials: parsedCredentials,
				},
			})
		: keyFile
			? new GoogleGenAI({
					vertexai: true,
					project: projectId,
					location: region,
					googleAuthOptions: { keyFile },
				})
			: new GoogleGenAI({ vertexai: true, project: projectId, location: region })

	const pager = await client.models.list({
		config: {
			pageSize: 1000,
			abortSignal: opts?.signal,
		},
	})

	// Use null-prototype object to prevent prototype pollution
	const models: ModelRecord = Object.create(null)

	for await (const model of pager) {
		// Vertex resource names look like
		// "projects/{p}/locations/{r}/publishers/google/models/gemini-3.7-flash";
		// tuned models nest the id under a single "models/" segment either way,
		// so strip everything up to and including the LAST "/models/".
		const name = model.name
		const modelsIndex = name?.lastIndexOf("/models/") ?? -1
		if (!name || modelsIndex === -1) continue

		const modelId = name.slice(modelsIndex + "/models/".length)
		if (!modelId.startsWith("gemini-") || NON_GENERATIVE_MODEL_ID.test(modelId)) continue

		const knownSpecs = vertexModels[modelId as keyof typeof vertexModels]

		if (knownSpecs) {
			models[modelId] = { ...knownSpecs }
		} else {
			models[modelId] = {
				maxTokens: 65_536,
				contextWindow: 1_048_576,
				supportsImages: true,
				supportsPromptCache: true,
				description: `Vertex Gemini model: ${modelId}`,
			}
		}
	}

	return models
}
