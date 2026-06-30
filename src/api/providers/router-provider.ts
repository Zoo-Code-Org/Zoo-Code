import OpenAI from "openai"

import { type ModelInfo, type ModelRecord } from "@roo-code/types"

import { ApiHandlerOptions, RouterName } from "../../shared/api"

import { BaseProvider } from "./base-provider"
import { getModels, getModelsFromCache } from "./fetchers/modelCache"

import { DEFAULT_HEADERS } from "./constants"

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
	protected readonly client: OpenAI

	constructor({
		options,
		name,
		baseURL,
		apiKey = "not-provided",
		modelId,
		defaultModelId,
		defaultModelInfo,
	}: RouterProviderOptions) {
		super()

		this.options = options
		this.name = name
		this.modelId = modelId
		this.defaultModelId = defaultModelId
		this.defaultModelInfo = defaultModelInfo

		this.client = new OpenAI({
			baseURL,
			apiKey,
			defaultHeaders: {
				...DEFAULT_HEADERS,
				...(options.openAiHeaders || {}),
			},
			timeout: this.timeoutMs,
		})
	}

	public async fetchModel() {
		this.models = await getModels({ provider: this.name, apiKey: this.client.apiKey, baseUrl: this.client.baseURL })
		return this.getModel()
	}

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
			return { id, info: this.models[id] }
		}

		// Fall back to global cache (synchronous disk/memory cache).
		// Pass the full options so URL-scoped providers (litellm, ollama, etc.)
		// resolve the same compound cache key that fetchModel() wrote under.
		const cachedModels = getModelsFromCache({
			provider: this.name,
			baseUrl: this.client.baseURL,
			apiKey: this.client.apiKey,
		})
		if (cachedModels?.[id]) {
			// Also populate instance models for future calls
			this.models = cachedModels
			return { id, info: cachedModels[id] }
		}

		// Last resort: preserve the configured model ID (falling back to the default
		// only when none is configured) so an as-yet-unfetched model isn't silently
		// swapped for the hardcoded default. info still comes from defaults since we
		// have no fetched or cached metadata for the configured model at this point.
		return { id, info: this.defaultModelInfo }
	}

	protected supportsTemperature(modelId: string): boolean {
		return !modelId.startsWith("openai/o3-mini")
	}
}
