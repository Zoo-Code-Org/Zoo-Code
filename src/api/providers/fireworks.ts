import {
	type FireworksModelId,
	fireworksDefaultModelId,
	fireworksModels,
	providerIdentifiers,
	type ModelRecord,
} from "@roo-code/types"

import type { ApiHandlerOptions, GetModelsOptions } from "../../shared/api"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"
import { getModelsFromCache } from "./fetchers/modelCache"
import type { ModelCacheScope } from "../index"

import { getFireworksModels } from "./fetchers/fireworks"

export class FireworksHandler extends BaseOpenAiCompatibleProvider<FireworksModelId> {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "Fireworks",
			baseURL: "https://api.fireworks.ai/inference/v1",
			apiKey: options.fireworksApiKey,
			defaultProviderModelId: fireworksDefaultModelId,
			providerModels: fireworksModels,
			defaultTemperature: 0.5,
		})
	}

	override getModel() {
		const requestedId = this.options.apiModelId

		// Curated static metadata (incl. pricing) wins for known models. For models
		// only discovered through the Fireworks /models endpoint, use the cached
		// API metadata (context length, image support) instead of generic defaults.
		if (requestedId && !(requestedId in this.providerModels)) {
			const cached = getModelsFromCache(
				{
					provider: providerIdentifiers.fireworks,
					apiKey: this.options.fireworksApiKey,
				},
				this,
			)
			const info = cached?.[requestedId]

			if (info) {
				return { id: requestedId as FireworksModelId, info }
			}
		}

		return super.getModel()
	}

	override getModelCacheScope(): ModelCacheScope {
		return { urlScoped: false, keyScoped: true, authScoped: false }
	}

	async fetchModels(options: GetModelsOptions, signal?: AbortSignal): Promise<ModelRecord> {
		const fetchOpts: [] | [{ signal: AbortSignal }] = signal ? [{ signal }] : []
		return getFireworksModels(options.apiKey, ...fetchOpts)
	}
}
