import {
	fireworksDefaultModelId,
	fireworksUnknownModelInfo,
	providerIdentifiers,
	type ModelRecord,
	FIREWORKS_INFERENCE_BASE_URL,
} from "@roo-code/types"

import type { ApiHandlerOptions, GetModelsOptions } from "../../shared/api"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"
import { getModels, getModelsFromCache } from "./fetchers/modelCache"
import type { ModelCacheScope } from "../index"
import { rejectOnAbort } from "./utils/abort-signal"

import { getFireworksModels } from "./fetchers/fireworks"

export class FireworksHandler extends BaseOpenAiCompatibleProvider<string> {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "Fireworks",
			baseURL: FIREWORKS_INFERENCE_BASE_URL,
			apiKey: options.fireworksApiKey,
			defaultProviderModelId: fireworksDefaultModelId,
			// No hardcoded catalog: model metadata and pricing come from the Fireworks API
			// via the model cache (see fetchers/fireworks.ts).
			providerModels: {},
			defaultTemperature: 0.5,
		})
	}

	override getModel() {
		const id = this.options.apiModelId || fireworksDefaultModelId
		const cached = getModelsFromCache(
			{
				provider: providerIdentifiers.fireworks,
				apiKey: this.options.fireworksApiKey,
			},
			this,
		)

		return { id, info: cached?.[id] ?? fireworksUnknownModelInfo }
	}

	override getModelCacheScope(): ModelCacheScope {
		return { urlScoped: false, keyScoped: true, authScoped: false }
	}

	/**
	 * Load the keyed catalog before the first request so `getModel()` reports the real
	 * context window and prices instead of `fireworksUnknownModelInfo`. A warm cache that
	 * already describes the selection needs no network round-trip.
	 *
	 * The fetch is single-flighted inside `getModels`, so concurrent tasks share one
	 * request. `signal` only bounds this caller's wait: aborting detaches the waiter while
	 * the shared fetch may still populate the cache for others.
	 */
	async ensureModelFetched(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw signal.reason
		}

		const id = this.options.apiModelId || fireworksDefaultModelId
		const cacheOptions = { provider: providerIdentifiers.fireworks, apiKey: this.options.fireworksApiKey } as const

		if (getModelsFromCache(cacheOptions, this)?.[id]) {
			return
		}

		const fetch = getModels(signal ? { ...cacheOptions, signal } : cacheOptions, this)

		if (!signal) {
			await fetch
			return
		}

		await rejectOnAbort(fetch, signal, "Fireworks")
	}

	async fetchModels(options: GetModelsOptions, signal?: AbortSignal): Promise<ModelRecord> {
		const fetchOpts: [] | [{ signal: AbortSignal }] = signal ? [{ signal }] : []
		return getFireworksModels(options.apiKey, ...fetchOpts)
	}
}
