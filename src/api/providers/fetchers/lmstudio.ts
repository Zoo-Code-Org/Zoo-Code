import axios from "axios"
import { LLM, LLMInfo, LLMInstanceInfo, LMStudioClient } from "@lmstudio/sdk"

import { type ModelInfo, lMStudioDefaultModelInfo, providerIdentifiers } from "@roo-code/types"

import { flushModels, getModels } from "./modelCache"

const modelsWithLoadedDetails = new Set<string>()

export const hasLoadedFullDetails = (modelId: string): boolean => modelsWithLoadedDetails.has(modelId)

export const forceFullModelDetailsLoad = async (baseUrl: string, modelId: string, apiKey?: string): Promise<void> => {
	try {
		// Test the connection to LM Studio first
		// Crrors will be caught further down.
		const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
		await axios.get(`${baseUrl}/v1/models`, { headers })
		const lmsUrl = baseUrl.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://")

		const client = new LMStudioClient({ baseUrl: lmsUrl })
		await client.llm.model(modelId)
		// Flush and refresh cache to get updated model details
		await flushModels({ provider: providerIdentifiers.lmstudio, baseUrl, apiKey }, true)

		// Mark this model as having full details loaded.
		modelsWithLoadedDetails.add(modelId)
	} catch (error) {
		if (error.code === "ECONNREFUSED") {
			console.warn(`Error connecting to LMStudio at ${baseUrl}`)
		} else {
			console.error(
				`Error refreshing LMStudio model details: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)
		}
	}
}

export const parseLMStudioModel = (rawModel: LLMInstanceInfo | LLMInfo): ModelInfo => {
	// Handle both LLMInstanceInfo (from loaded models) and LLMInfo (from downloaded models)
	const contextLength = "contextLength" in rawModel ? rawModel.contextLength : rawModel.maxContextLength

	const modelInfo: ModelInfo = Object.assign({}, lMStudioDefaultModelInfo, {
		description: `${rawModel.displayName} - ${rawModel.path}`,
		contextWindow: contextLength,
		supportsPromptCache: true,
		supportsImages: rawModel.vision,
		maxTokens: contextLength,
	})

	return modelInfo
}

// Shape of entries returned by LM Studio's REST API (GET /api/v0/models). Unlike the
// @lmstudio/sdk websocket client used below, this plain HTTP endpoint honors the
// Authorization header, so it works against remote/tunneled servers that require an API key.
interface LMStudioRestModel {
	id: string
	type?: "llm" | "vlm" | "embeddings"
	publisher?: string
	arch?: string
	quantization?: string
	state?: "loaded" | "not-loaded"
	max_context_length?: number
	loaded_context_length?: number
}

const parseLMStudioRestModel = (rawModel: LMStudioRestModel): ModelInfo => {
	const contextLength = rawModel.loaded_context_length ?? rawModel.max_context_length

	return Object.assign({}, lMStudioDefaultModelInfo, {
		description:
			[rawModel.publisher, rawModel.arch, rawModel.quantization].filter(Boolean).join(" - ") || rawModel.id,
		contextWindow: contextLength ?? lMStudioDefaultModelInfo.contextWindow,
		supportsPromptCache: true,
		supportsImages: rawModel.type === "vlm",
		maxTokens: contextLength ?? lMStudioDefaultModelInfo.maxTokens,
	})
}

// Fetch models via LM Studio's plain REST API as a fallback for when the websocket SDK
// client returns nothing -- most commonly because it has no way to send the API key a
// remote/tunneled server requires (see getLMStudioModels below).
async function getModelsViaRestApi(
	baseUrl: string,
	headers: Record<string, string>,
): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	try {
		const response = await axios.get(`${baseUrl}/api/v0/models`, { headers })
		const data = response.data?.data

		if (Array.isArray(data)) {
			for (const rawModel of data as LMStudioRestModel[]) {
				if (!rawModel?.id || rawModel.type === "embeddings") {
					continue
				}

				models[rawModel.id] = parseLMStudioRestModel(rawModel)

				if (rawModel.state === "loaded") {
					modelsWithLoadedDetails.add(rawModel.id)
				}
			}
		}
	} catch (error) {
		console.warn(
			`[LMStudio] REST API fallback (/api/v0/models) failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	return models
}

export async function getLMStudioModels(
	baseUrl = "http://localhost:1234",
	apiKey?: string,
): Promise<Record<string, ModelInfo>> {
	// clear the set of models that have full details loaded
	modelsWithLoadedDetails.clear()
	// clearing the input can leave an empty string; use the default in that case
	baseUrl = baseUrl === "" ? "http://localhost:1234" : baseUrl

	const models: Record<string, ModelInfo> = {}
	// ws is required to connect using the LMStudio library
	const lmsUrl = baseUrl.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://")

	if (!URL.canParse(lmsUrl)) {
		return models
	}

	// Test the connection to LM Studio first. Unlike the best-effort model-detail
	// lookups below, a failure here (wrong URL, server not running, bad API key) must
	// propagate so callers can surface a real error instead of silently reporting an
	// empty model list as if the refresh had succeeded.
	const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
	try {
		await axios.get(`${baseUrl}/v1/models`, { headers })
	} catch (error) {
		if (error.code === "ECONNREFUSED") {
			throw new Error(`Unable to connect to LM Studio at ${baseUrl}. Is LM Studio's local server running?`)
		}
		if (error.response?.status === 401 || error.response?.status === 403) {
			throw new Error(`LM Studio rejected the request. Check that the API key is correct.`)
		}
		throw error instanceof Error ? error : new Error(String(error))
	}

	try {
		const client = new LMStudioClient({ baseUrl: lmsUrl })

		// First, try to get all downloaded models
		try {
			const downloadedModels = await client.system.listDownloadedModels("llm")
			for (const model of downloadedModels) {
				// Use the model path as the key since that's what users select
				models[model.path] = parseLMStudioModel(model)
			}
		} catch (error) {
			console.warn("Failed to list downloaded models, falling back to loaded models only")
		}

		// Get loaded models for their runtime info (context size)
		const loadedModels = (await client.llm.listLoaded().then((models: LLM[]) => {
			return Promise.all(models.map((m) => m.getModelInfo()))
		})) as Array<LLMInstanceInfo>

		// Deduplicate: For each loaded model, check if any downloaded model path contains the loaded model's key
		// This handles cases like loaded "llama-3.1" matching downloaded "Meta/Llama-3.1/Something"
		// If found, remove the downloaded version and add the loaded model (prefer loaded over downloaded for accurate runtime info)
		for (const lmstudioModel of loadedModels) {
			const loadedModelId = lmstudioModel.modelKey.toLowerCase()

			// Find if any downloaded model path contains the loaded model's key as a path segment
			// Use word boundaries or path separators to avoid false matches like "llama" matching "codellama"
			const existingKey = Object.keys(models).find((key) => {
				const keyLower = key.toLowerCase()
				// Check if the loaded model ID appears as a distinct segment in the path
				// This matches "llama-3.1" in "Meta/Llama-3.1/Something" but not "llama" in "codellama"
				return (
					keyLower.includes(`/${loadedModelId}/`) ||
					keyLower.includes(`/${loadedModelId}`) ||
					keyLower.startsWith(`${loadedModelId}/`) ||
					keyLower === loadedModelId
				)
			})

			if (existingKey) {
				// Remove the downloaded version
				delete models[existingKey]
			}

			// Add the loaded model (either as replacement or new entry)
			models[lmstudioModel.modelKey] = parseLMStudioModel(lmstudioModel)
			modelsWithLoadedDetails.add(lmstudioModel.modelKey)
		}
	} catch (error) {
		if (error.code === "ECONNREFUSED") {
			console.warn(`Error connecting to LMStudio at ${baseUrl}`)
		} else {
			console.error(
				`Error fetching LMStudio models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)
		}
	}

	// The websocket SDK client above has no way to authenticate with an API key, so it
	// silently returns nothing against remote/tunneled servers that require one even though
	// the initial REST connectivity check (and thus the user's key) succeeded. Fall back to
	// LM Studio's REST API, which honors the same Authorization header, before giving up.
	if (Object.keys(models).length === 0) {
		const restModels = await getModelsViaRestApi(baseUrl, headers)
		Object.assign(models, restModels)
	}

	return models
}
