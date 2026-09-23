import axios from "axios"

import type { ModelInfo } from "@roo-code/types"

import { parseApiPrice } from "../../../shared/cost"
import { toRequestyServiceUrl } from "../../../shared/utils/requesty"

import { throwIfAborted } from "../utils/abort-signal"

export async function getRequestyModels(
	baseUrl?: string,
	apiKey?: string,
	opts?: { signal?: AbortSignal },
): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	try {
		const headers: Record<string, string> = {}

		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		const resolvedBaseUrl = toRequestyServiceUrl(baseUrl)
		const modelsUrl = new URL("v1/models", resolvedBaseUrl)

		const response = await axios.get(modelsUrl.toString(), { headers, signal: opts?.signal })
		const rawModels = response.data.data

		for (const rawModel of rawModels) {
			const reasoningBudget =
				rawModel.supports_reasoning &&
				(rawModel.id.includes("claude") ||
					rawModel.id.includes("coding/gemini-2.5") ||
					rawModel.id.includes("vertex/gemini-2.5"))
			const reasoningEffort =
				rawModel.supports_reasoning &&
				(rawModel.id.includes("openai") || rawModel.id.includes("google/gemini-2.5"))

			const modelInfo: ModelInfo = {
				maxTokens: rawModel.max_output_tokens,
				contextWindow: rawModel.context_window,
				supportsPromptCache: rawModel.supports_caching,
				supportsImages: rawModel.supports_vision,
				supportsReasoningBudget: reasoningBudget,
				supportsReasoningEffort: reasoningEffort,
				inputPrice: parseApiPrice(rawModel.input_price),
				outputPrice: parseApiPrice(rawModel.output_price),
				description: rawModel.description,
				cacheWritesPrice: parseApiPrice(rawModel.caching_price),
				cacheReadsPrice: parseApiPrice(rawModel.cached_price),
			}

			if (rawModel.id === "anthropic/claude-fable-5.1" || rawModel.id === "anthropic/claude-fable-5") {
				modelInfo.supportsReasoningBudget = true
				modelInfo.supportsReasoningBinary = true
				modelInfo.supportsTemperature = false
			}

			if (rawModel.id === "anthropic/claude-sonnet-5") {
				modelInfo.supportsReasoningBudget = true
				modelInfo.supportsReasoningBinary = true
				modelInfo.supportsTemperature = false
			}

			if (rawModel.id === "anthropic/claude-opus-5") {
				modelInfo.supportsReasoningBudget = true
				modelInfo.supportsReasoningBinary = true
				modelInfo.supportsTemperature = false
			}

			models[rawModel.id] = modelInfo
		}
	} catch (error) {
		// Surface cancellation as a rejection: logging and returning here would
		// present an aborted fetch to callers as a successful (partial) catalog.
		throwIfAborted(opts?.signal)

		console.error(`Error fetching Requesty models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
	}

	return models
}
