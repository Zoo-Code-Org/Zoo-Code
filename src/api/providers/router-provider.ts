import OpenAI from "openai"

import { type ModelInfo, type ModelRecord } from "@roo-code/types"

import { ApiHandlerOptions, RouterName } from "../../shared/api"

import { withDeclaredReasoningEffort } from "../model-capabilities"
import { BaseProvider } from "./base-provider"
import { getModels, getModelsFromCache, refreshModels } from "./fetchers/modelCache"

import { DEFAULT_HEADERS, NOT_PROVIDED } from "./constants"

type RouterProviderOptions = {
	name: RouterName
	baseURL: string
	apiKey?: string
	modelId?: string
	defaultModelId: string
	defaultModelInfo: ModelInfo
	options: ApiHandlerOptions
}

export abstract class RouterProvider extends BaseProvider {
	protected readonly options: ApiHandlerOptions
	protected readonly name: RouterName
	protected models: ModelRecord = {}
	protected readonly modelId?: string
	protected readonly defaultModelId: string
	protected readonly defaultModelInfo: ModelInfo
	protected readonly apiKey?: string
	protected readonly client: OpenAI

	constructor({ options, name, baseURL, apiKey, modelId, defaultModelId, defaultModelInfo }: RouterProviderOptions) {
		super()

		this.options = options
		this.name = name
		this.modelId = modelId
		this.defaultModelId = defaultModelId
		this.defaultModelInfo = defaultModelInfo
		this.apiKey = apiKey

		this.client = new OpenAI({
			baseURL,
			apiKey: apiKey ?? NOT_PROVIDED,
			defaultHeaders: {
				...DEFAULT_HEADERS,
				...(options.openAiHeaders || {}),
			},
			timeout: this.timeoutMs,
		})
	}

	private modelFetchPromise?: Promise<{ id: string; info: ModelInfo }>
	/** Last catalog refresh attempt per missing model id (ms), for negative caching. */
	private missingModelRefreshAt = new Map<string, number>()
	private static readonly MISSING_MODEL_RETRY_MS = 5 * 60 * 1000

	public async fetchModel() {
		// Refetch when the selected model is missing — a stale non-empty map
		// would otherwise keep serving defaultModelInfo prices for cost estimates.
		const id = this.modelId || this.defaultModelId
		if (this.models[id]) {
			return this.getModel()
		}

		// After a catalog fetch that still lacks this id, don't hammer getModels
		// on every createMessage; retry only after the negative-cache window.
		const lastMissingAttempt = this.missingModelRefreshAt.get(id)
		if (
			lastMissingAttempt !== undefined &&
			Date.now() - lastMissingAttempt < RouterProvider.MISSING_MODEL_RETRY_MS
		) {
			return this.getModel()
		}

		if (!this.modelFetchPromise) {
			const fetchOptions = {
				provider: this.name,
				apiKey: this.apiKey,
				baseUrl: this.client.baseURL,
			}

			this.modelFetchPromise = (async () => {
				let models = await getModels(fetchOptions)
				this.models = models

				// getModels may return a shared cached catalog that predates this
				// model. Force a provider refresh before recording a miss so
				// newly listed models are not blocked for MISSING_MODEL_RETRY_MS.
				// Auth-scoped providers already bypass that cache in getModels;
				// refreshModels is then a no-op extra live fetch only on true misses.
				if (!models[id]) {
					models = await refreshModels(fetchOptions)
					this.models = models
				}

				if (models[id]) {
					this.missingModelRefreshAt.delete(id)
				} else {
					this.missingModelRefreshAt.set(id, Date.now())
				}
				return this.getModel()
			})().finally(() => {
				this.modelFetchPromise = undefined
			})
		}

		return this.modelFetchPromise
	}

	async ensureModelFetched(): Promise<void> {
		await this.fetchModel()
	}

	/**
	 * Resolves the active model and its capability metadata.
	 *
	 * F7: fills in user-declared `supportedReasoningEfforts` (registry-wins)
	 * for self-hosted / OpenAI-compatible profiles that do not advertise the
	 * capability in the registry.
	 */
	override getModel(): { id: string; info: ModelInfo } {
		// Use `||` (not `??`) so an empty-string modelId also falls back to the default,
		// guaranteeing a non-empty id rather than forwarding "" to the API as an invalid
		// request. Note this guarantees non-empty, not viable: defaultModelId is provider-
		// supplied and may not be a model that actually exists on the user's server (e.g.
		// OpenAI-compatible have no inherent default), so a configured-but-empty selection
		// can still resolve to a model the server rejects.
		const id = this.modelId || this.defaultModelId

		// First check instance models (populated by fetchModel)
		if (this.models[id]) {
			// F7: fill in user-declared reasoning effort levels where the fetched
			// model does not advertise its own capability.
			return { id, info: withDeclaredReasoningEffort(this.models[id], this.options) }
		}

		// Fall back to global cache (synchronous disk/memory cache).
		// Pass the full options so URL-scoped providers (litellm, ollama, etc.)
		// resolve the same compound cache key that fetchModel() wrote under.
		const cachedModels = getModelsFromCache({
			provider: this.name,
			baseUrl: this.client.baseURL,
			apiKey: this.apiKey,
		})
		if (cachedModels?.[id]) {
			// Also populate instance models for future calls
			this.models = cachedModels
			return { id, info: withDeclaredReasoningEffort(cachedModels[id], this.options) }
		}

		// Last resort: keep the configured id so we don't swap models, but zero
		// prices so we don't bill the UI with defaultModelInfo's $/token rates.
		if (id !== this.defaultModelId) {
			return {
				id,
				info: withDeclaredReasoningEffort(
					{
						...this.defaultModelInfo,
						inputPrice: 0,
						outputPrice: 0,
						cacheWritesPrice: 0,
						cacheReadsPrice: 0,
					},
					this.options,
				),
			}
		}

		return { id, info: withDeclaredReasoningEffort(this.defaultModelInfo, this.options) }
	}

	/**
	 * Router/LiteLLM model ids are opaque, so temperature support is
	 * inferred: only the known openai/o3-mini ids reject temperature.
	 */
	protected supportsTemperature(modelId: string): boolean {
		return !modelId.startsWith("openai/o3-mini")
	}
}
