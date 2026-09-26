import type { ModelInfo, ModelRecord } from "@roo-code/types"
import { fetchPoeModels, getModels } from "ai-sdk-provider-poe/code"

import { throwIfAborted } from "../utils/abort-signal"

export async function getPoeModels(
	apiKey?: string,
	baseURL?: string,
	opts?: { signal?: AbortSignal },
): Promise<ModelRecord> {
	try {
		// fetchPoeModels populates the internal model store, then getModels()
		// returns only code-capable models with camelCase fields.
		// The Poe SDK exposes no cancellation option, so the caller's signal
		// cannot reach the network here; an abort still releases the shared
		// cache entry and stops the waiters at the model-cache layer.
		throwIfAborted(opts?.signal)
		await fetchPoeModels({ apiKey, baseURL })
		throwIfAborted(opts?.signal)
		const poeModels = getModels()
		const models: ModelRecord = {}

		for (const m of poeModels) {
			// The library's applyReasoningFallbacks workaround sets
			// supportsReasoningEffort to boolean `true` for any model that
			// supports /v1/responses, even when the model has no actual
			// reasoning capability (e.g. Haiku 3/3.5). Only trust the value
			// when it is an explicit array of effort levels.
			const effort = Array.isArray(m.supportsReasoningEffort) ? m.supportsReasoningEffort : undefined
			const info: ModelInfo = {
				contextWindow: m.contextWindow,
				maxTokens: m.maxOutputTokens,
				supportsImages: m.supportsImages,
				supportsPromptCache: m.supportsPromptCache,
				...(m.supportsReasoningBudget && { supportsReasoningBudget: m.supportsReasoningBudget }),
				...(effort && {
					supportsReasoningEffort: effort as ModelInfo["supportsReasoningEffort"],
				}),
				...(m.pricing?.inputPerMillion != null && { inputPrice: m.pricing.inputPerMillion }),
				...(m.pricing?.outputPerMillion != null && { outputPrice: m.pricing.outputPerMillion }),
				...(m.pricing?.cacheReadPerMillion != null && { cacheReadsPrice: m.pricing.cacheReadPerMillion }),
				...(m.pricing?.cacheWritePerMillion != null && { cacheWritesPrice: m.pricing.cacheWritePerMillion }),
			}

			models[m.id] = info
		}

		return models
	} catch (error) {
		// Surface cancellation as a rejection: logging and returning here would
		// present an aborted fetch to callers as a successful (empty) catalog.
		throwIfAborted(opts?.signal)

		console.error(
			`[Poe] Error fetching models: ${JSON.stringify(error, Object.getOwnPropertyNames(error as object), 2)}`,
		)
		return {}
	}
}
