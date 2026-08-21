import OpenAI from "openai"

import { applyCustomModelInfo, type ModelInfo, type ModelRecord } from "@roo-code/types"

import { ApiHandlerOptions, RouterName } from "../../shared/api"

import { BaseProvider } from "./base-provider"
import { getModels, getModelsFromCache } from "./fetchers/modelCache"

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

	/**
	 * Apply user-supplied `customModelInfo` overrides for gateway providers.
	 *
	 * Only vercel-ai-gateway and zoo-gateway opt in here because the other
	 * RouterProvider subclasses (openrouter, requesty, unbound) apply overrides
	 * in their own `getModel()` methods — they need to merge with provider-
	 * specific logic (e.g. specific-provider endpoints, tool preferences) that
	 * runs before the overlay.  LiteLLM, Kenari, and OpenCode Go don't support
	 * `customModelInfo` because they have their own discovery mechanisms and
	 * are not exposed in the settings UI.
	 *
	 * See also: `customModelInfoProviders` in @roo-code/types for the full set
	 * of providers whose UI exposes the override panel.
	 */
	private resolveModelInfo(info: ModelInfo | undefined, fallback: ModelInfo): ModelInfo {
		if (this.name !== "vercel-ai-gateway" && this.name !== "zoo-gateway") {
			return info ?? fallback
		}

		const resolvedInfo = applyCustomModelInfo(info, this.options) ?? fallback

		// Gateway request builders forward `info.maxTokens` as max_completion_tokens.
		// Keep that value within the effective context window so a persisted override
		// cannot create a request the gateway will reject.
		if (
			typeof resolvedInfo.maxTokens === "number" &&
			Number.isFinite(resolvedInfo.maxTokens) &&
			resolvedInfo.maxTokens > 0 &&
			Number.isFinite(resolvedInfo.contextWindow) &&
			resolvedInfo.contextWindow > 0 &&
			resolvedInfo.maxTokens > resolvedInfo.contextWindow
		) {
			return { ...resolvedInfo, maxTokens: resolvedInfo.contextWindow }
		}

		return resolvedInfo
	}

	public async fetchModel() {
		if (Object.keys(this.models).length > 0) {
			return this.getModel()
		}

		if (!this.modelFetchPromise) {
			this.modelFetchPromise = getModels({
				provider: this.name,
				apiKey: this.apiKey,
				baseUrl: this.client.baseURL,
			})
				.then((models) => {
					this.models = models
					return this.getModel()
				})
				.finally(() => {
					this.modelFetchPromise = undefined
				})
		}

		return this.modelFetchPromise
	}

	async ensureModelFetched(): Promise<void> {
		await this.fetchModel()
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
			return { id, info: this.resolveModelInfo(this.models[id], this.models[id]) }
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
			return { id, info: this.resolveModelInfo(cachedModels[id], cachedModels[id]) }
		}

		// Last resort: preserve the configured model ID (falling back to the default
		// only when none is configured) so an as-yet-unfetched model isn't silently
		// swapped for the hardcoded default. info still comes from defaults since we
		// have no fetched or cached metadata for the configured model at this point.
		return { id, info: this.resolveModelInfo(undefined, this.defaultModelInfo) }
	}

	protected supportsTemperature(modelId: string): boolean {
		return !modelId.startsWith("openai/o3-mini")
	}
}
