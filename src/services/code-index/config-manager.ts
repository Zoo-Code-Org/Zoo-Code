import { ContextProxy } from "../../core/config/ContextProxy"
import type { CodebaseIndexConfig } from "@roo-code/types"
import { EmbedderProvider } from "./interfaces/manager"
import {
	CodeIndexConfig,
	CodeIndexConfigSnapshot,
	PreviousConfigSnapshot,
	freezeCodeIndexConfigSnapshot,
} from "./interfaces/config"
import { DEFAULT_SEARCH_MIN_SCORE, DEFAULT_MAX_SEARCH_RESULTS } from "./constants"
import { getDefaultModelId, getModelDimension, getModelScoreThreshold } from "../../shared/embeddingModels"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

/**
 * Manages configuration state and validation for the code indexing feature.
 * Handles loading, validating, and providing access to configuration values.
 */
export class CodeIndexConfigManager {
	private _isConfigurationLoaded = false
	private config: CodeIndexConfigSnapshot
	private readonly contextProxy: ContextProxy

	constructor(contextProxy: ContextProxy) {
		this.contextProxy = contextProxy
		// Initialize with current configuration to avoid false restart triggers
		this.config = this._readConfiguration()
	}

	/** Whether at least one full asynchronous configuration load has succeeded. */
	public get isConfigurationLoaded(): boolean {
		return this._isConfigurationLoaded
	}

	/**
	 * Gets the context proxy instance
	 */
	public getContextProxy(): ContextProxy {
		return this.contextProxy
	}

	/**
	 * Builds a complete immutable snapshot without changing the current configuration.
	 */
	private _readConfiguration(): CodeIndexConfigSnapshot {
		// Load configuration from storage
		const codebaseIndexConfig: Readonly<CodebaseIndexConfig> = this.contextProxy?.getGlobalState(
			"codebaseIndexConfig",
		) ?? {
			codebaseIndexEnabled: false,
			codebaseIndexQdrantUrl: "http://localhost:6333",
			codebaseIndexEmbedderProvider: providerIdentifiers.openai,
			codebaseIndexEmbedderBaseUrl: "",
			codebaseIndexEmbedderModelId: "",
			codebaseIndexSearchMinScore: undefined,
			codebaseIndexSearchMaxResults: undefined,
			codebaseIndexBedrockRegion: "us-east-1",
			codebaseIndexBedrockProfile: "",
		}

		const qdrantApiKey = this.contextProxy?.getSecret("codeIndexQdrantApiKey") ?? ""

		// Build locally so a failed read cannot partially update the published snapshot.
		const modelDimension = this._parseModelDimension(codebaseIndexConfig.codebaseIndexEmbedderModelDimension)

		// Set embedder provider with support for openai-compatible
		const embedderProvider = this._resolveEmbedderProvider(codebaseIndexConfig.codebaseIndexEmbedderProvider)

		const modelId = codebaseIndexConfig.codebaseIndexEmbedderModelId || undefined

		return freezeCodeIndexConfigSnapshot({
			codebaseIndexEnabled: codebaseIndexConfig.codebaseIndexEnabled ?? false,
			qdrantUrl: codebaseIndexConfig.codebaseIndexQdrantUrl,
			qdrantApiKey,
			searchMinScore: codebaseIndexConfig.codebaseIndexSearchMinScore,
			searchMaxResults: codebaseIndexConfig.codebaseIndexSearchMaxResults,
			embedderProvider,
			modelId,
			modelDimension,
			openAiOptions: this._readOpenAiOptions(),
			ollamaOptions: this._readOllamaOptions(),
			openAiCompatibleOptions: this._readOpenAiCompatibleOptions(),
			geminiOptions: this._readGeminiOptions(),
			mistralOptions: this._readMistralOptions(),
			vercelAiGatewayOptions: this._readVercelAiGatewayOptions(),
			bedrockOptions: this._readBedrockOptions(),
			openRouterOptions: this._readOpenRouterOptions(),
		})
	}

	private _readOpenAiOptions(): CodeIndexConfig["openAiOptions"] {
		return { openAiNativeApiKey: this.contextProxy?.getSecret("codeIndexOpenAiKey") ?? "" }
	}

	private _readOllamaOptions(): CodeIndexConfig["ollamaOptions"] {
		const config = this.contextProxy?.getGlobalState("codebaseIndexConfig")
		return { ollamaBaseUrl: config == null ? "" : config.codebaseIndexEmbedderBaseUrl }
	}

	private _readGeminiOptions(): CodeIndexConfig["geminiOptions"] {
		const apiKey = this.contextProxy?.getSecret("codebaseIndexGeminiApiKey") ?? ""
		if (!apiKey) {
			return undefined
		}

		return { apiKey }
	}

	private _readMistralOptions(): CodeIndexConfig["mistralOptions"] {
		const apiKey = this.contextProxy?.getSecret("codebaseIndexMistralApiKey") ?? ""
		if (!apiKey) {
			return undefined
		}

		return { apiKey }
	}

	private _readVercelAiGatewayOptions(): CodeIndexConfig["vercelAiGatewayOptions"] {
		const apiKey = this.contextProxy?.getSecret("codebaseIndexVercelAiGatewayApiKey") ?? ""
		if (!apiKey) {
			return undefined
		}

		return { apiKey }
	}

	private _readBedrockOptions(): CodeIndexConfig["bedrockOptions"] {
		const config = this.contextProxy?.getGlobalState("codebaseIndexConfig")
		const region = config?.codebaseIndexBedrockRegion ?? "us-east-1"
		if (!region) {
			return undefined
		}

		return { region, profile: config?.codebaseIndexBedrockProfile || undefined }
	}

	private _readOpenRouterOptions(): CodeIndexConfig["openRouterOptions"] {
		const apiKey = this.contextProxy?.getSecret("codebaseIndexOpenRouterApiKey") ?? ""
		if (!apiKey) {
			return undefined
		}

		const specificProvider =
			this.contextProxy?.getGlobalState("codebaseIndexConfig")?.codebaseIndexOpenRouterSpecificProvider
		return { apiKey, specificProvider: specificProvider || undefined }
	}

	private _readOpenAiCompatibleOptions(): CodeIndexConfig["openAiCompatibleOptions"] {
		const baseUrl =
			this.contextProxy?.getGlobalState("codebaseIndexConfig")?.codebaseIndexOpenAiCompatibleBaseUrl ?? ""
		const apiKey = this.contextProxy?.getSecret("codebaseIndexOpenAiCompatibleApiKey") ?? ""

		if (!baseUrl || !apiKey) {
			return undefined
		}

		return { baseUrl, apiKey }
	}

	private _resolveEmbedderProvider(provider: unknown): EmbedderProvider {
		switch (provider) {
			case providerIdentifiers.ollama:
			case "openai-compatible":
			case providerIdentifiers.gemini:
			case providerIdentifiers.mistral:
			case providerIdentifiers.vercelAiGateway:
			case providerIdentifiers.bedrock:
			case providerIdentifiers.openrouter:
			case "semble":
				return provider
			default:
				return providerIdentifiers.openai
		}
	}

	private _parseModelDimension(rawDimension: unknown): number | undefined {
		if (rawDimension === undefined || rawDimension === null) {
			return undefined
		}

		const dimension = Number(rawDimension)
		if (dimension > 0) {
			return dimension
		}

		console.warn(`Invalid codebaseIndexEmbedderModelDimension value: ${rawDimension}. Must be a positive number.`)
		return undefined
	}

	/**
	 * Loads persisted configuration from globalState.
	 */
	public async loadConfiguration(): Promise<{
		configSnapshot: PreviousConfigSnapshot
		currentConfig: CodeIndexConfig
		requiresRestart: boolean
	}> {
		// Capture the ACTUAL previous state before loading new configuration
		const previousConfigSnapshot = this._getRestartComparisonSnapshot()

		// Refresh secrets from VSCode storage to ensure we have the latest values
		await this.contextProxy.refreshSecrets()

		// Publish only after the complete snapshot has been built.
		this.config = this._readConfiguration()

		const requiresRestart = this.doesConfigChangeRequireRestart(previousConfigSnapshot)

		const result = {
			configSnapshot: previousConfigSnapshot,
			currentConfig: this.getConfig(),
			requiresRestart,
		}
		this._isConfigurationLoaded = true
		return result
	}

	private _getRestartComparisonSnapshot(): PreviousConfigSnapshot {
		return {
			enabled: this.config.codebaseIndexEnabled,
			configured: this.isConfigured(),
			embedderProvider: this.config.embedderProvider,
			modelId: this.config.modelId,
			modelDimension: this.config.modelDimension,
			openAiKey: this.config.openAiOptions?.openAiNativeApiKey ?? "",
			ollamaBaseUrl: this.config.ollamaOptions?.ollamaBaseUrl ?? "",
			openAiCompatibleBaseUrl: this.config.openAiCompatibleOptions?.baseUrl ?? "",
			openAiCompatibleApiKey: this.config.openAiCompatibleOptions?.apiKey ?? "",
			geminiApiKey: this.config.geminiOptions?.apiKey ?? "",
			mistralApiKey: this.config.mistralOptions?.apiKey ?? "",
			vercelAiGatewayApiKey: this.config.vercelAiGatewayOptions?.apiKey ?? "",
			bedrockRegion: this.config.bedrockOptions?.region ?? "",
			bedrockProfile: this.config.bedrockOptions?.profile ?? "",
			openRouterApiKey: this.config.openRouterOptions?.apiKey ?? "",
			openRouterSpecificProvider: this.config.openRouterOptions?.specificProvider ?? "",
			qdrantUrl: this.config.qdrantUrl ?? "",
			qdrantApiKey: this.config.qdrantApiKey ?? "",
		}
	}

	/**
	 * Checks if the service is properly configured based on the embedder type.
	 */
	public isConfigured(): boolean {
		if (this.config.embedderProvider === "semble") {
			// Semble requires no API keys or Qdrant.
			return true
		}

		if (!this.config.qdrantUrl) {
			return false
		}

		switch (this.config.embedderProvider) {
			case providerIdentifiers.openai:
				return !!this.config.openAiOptions?.openAiNativeApiKey
			case providerIdentifiers.ollama:
				// The model ID has a default, so only the base URL is required.
				return !!this.config.ollamaOptions?.ollamaBaseUrl
			case "openai-compatible":
				return !!(this.config.openAiCompatibleOptions?.baseUrl && this.config.openAiCompatibleOptions?.apiKey)
			case providerIdentifiers.gemini:
				return !!this.config.geminiOptions?.apiKey
			case providerIdentifiers.mistral:
				return !!this.config.mistralOptions?.apiKey
			case providerIdentifiers.vercelAiGateway:
				return !!this.config.vercelAiGatewayOptions?.apiKey
			case providerIdentifiers.bedrock:
				// The profile is optional.
				return !!this.config.bedrockOptions?.region
			case providerIdentifiers.openrouter:
				return !!this.config.openRouterOptions?.apiKey
			default:
				return false
		}
	}

	/**
	 * Determines if a configuration change requires restarting the indexing process.
	 * Simplified logic: only restart for critical changes that affect service functionality.
	 *
	 * CRITICAL CHANGES (require restart):
	 * - Provider changes (openai -> ollama, etc.)
	 * - Authentication changes (API keys, base URLs)
	 * - Vector dimension changes (model changes that affect embedding size)
	 * - Qdrant connection changes (URL, API key)
	 * - Feature enable/disable transitions
	 *
	 * MINOR CHANGES (no restart needed):
	 * - Search minimum score adjustments
	 * - UI-only settings
	 * - Non-functional configuration tweaks
	 */
	doesConfigChangeRequireRestart(prev: PreviousConfigSnapshot): boolean {
		const current = this._getRestartComparisonSnapshot()
		const wasEnabled = prev?.enabled ?? false
		const wasReady = wasEnabled && (prev?.configured ?? false)
		const isReady = current.enabled && current.configured

		if (!wasReady && isReady) {
			return true
		}

		if (wasEnabled && !current.enabled) {
			return true
		}

		if (!current.enabled || (!wasReady && !isReady)) {
			return false
		}

		const previousProvider = prev?.embedderProvider ?? providerIdentifiers.openai
		if (previousProvider !== current.embedderProvider || prev?.modelDimension !== current.modelDimension) {
			return true
		}

		return (
			this._hasConnectionSettingsChanged(prev, current) ||
			this._hasVectorDimensionChanged(previousProvider, prev?.modelId)
		)
	}

	private _hasConnectionSettingsChanged(prev: PreviousConfigSnapshot, current: PreviousConfigSnapshot): boolean {
		const keys = [
			"openAiKey",
			"ollamaBaseUrl",
			"openAiCompatibleBaseUrl",
			"openAiCompatibleApiKey",
			"geminiApiKey",
			"mistralApiKey",
			"vercelAiGatewayApiKey",
			"bedrockRegion",
			"bedrockProfile",
			"openRouterApiKey",
			"openRouterSpecificProvider",
			"qdrantUrl",
			"qdrantApiKey",
		] as const satisfies readonly (keyof PreviousConfigSnapshot)[]

		return keys.some((key) => (prev?.[key] ?? "") !== (current[key] ?? ""))
	}

	/**
	 * Checks if model changes result in vector dimension changes that require restart.
	 */
	private _hasVectorDimensionChanged(prevProvider: EmbedderProvider, prevModelId?: string): boolean {
		const currentProvider = this.config.embedderProvider
		const currentModelId = this.config.modelId ?? getDefaultModelId(currentProvider)
		const resolvedPrevModelId = prevModelId ?? getDefaultModelId(prevProvider)

		// If model IDs are the same and provider is the same, no dimension change
		if (prevProvider === currentProvider && resolvedPrevModelId === currentModelId) {
			return false
		}

		// Get vector dimensions for both models
		const prevDimension = getModelDimension(prevProvider, resolvedPrevModelId)
		const currentDimension = getModelDimension(currentProvider, currentModelId)

		// If we can't determine dimensions, be safe and restart
		if (prevDimension === undefined || currentDimension === undefined) {
			return true
		}

		// Only restart if dimensions actually changed
		return prevDimension !== currentDimension
	}

	/**
	 * Gets the current configuration state.
	 */
	public getConfig(): CodeIndexConfig {
		return Object.freeze({
			isConfigured: this.isConfigured(),
			embedderProvider: this.config.embedderProvider,
			modelId: this.config.modelId,
			modelDimension: this.config.modelDimension,
			openAiOptions: this.config.openAiOptions,
			ollamaOptions: this.config.ollamaOptions,
			openAiCompatibleOptions: this.config.openAiCompatibleOptions,
			geminiOptions: this.config.geminiOptions,
			mistralOptions: this.config.mistralOptions,
			vercelAiGatewayOptions: this.config.vercelAiGatewayOptions,
			bedrockOptions: this.config.bedrockOptions,
			openRouterOptions: this.config.openRouterOptions,
			qdrantUrl: this.config.qdrantUrl,
			qdrantApiKey: this.config.qdrantApiKey,
			searchMinScore: this.currentSearchMinScore,
			searchMaxResults: this.currentSearchMaxResults,
		})
	}

	/**
	 * Gets whether the code indexing feature is enabled
	 */
	public get isFeatureEnabled(): boolean {
		return this.config.codebaseIndexEnabled
	}

	/**
	 * Gets whether the code indexing feature is properly configured
	 */
	public get isFeatureConfigured(): boolean {
		return this.isConfigured()
	}

	/**
	 * Gets the current embedder provider
	 */
	public get currentEmbedderProvider(): EmbedderProvider {
		return this.config.embedderProvider
	}

	/**
	 * Gets the current Qdrant configuration
	 */
	public get qdrantConfig(): { url?: string; apiKey?: string } {
		return {
			url: this.config.qdrantUrl,
			apiKey: this.config.qdrantApiKey,
		}
	}

	/**
	 * Gets the current model ID being used for embeddings.
	 */
	public get currentModelId(): string | undefined {
		return this.config.modelId
	}

	/**
	 * Gets the current model dimension being used for embeddings.
	 * Returns the model's built-in dimension if available, otherwise falls back to custom dimension.
	 */
	public get currentModelDimension(): number | undefined {
		// First try to get the model-specific dimension
		const modelId = this.config.modelId ?? getDefaultModelId(this.config.embedderProvider)
		const modelDimension = getModelDimension(this.config.embedderProvider, modelId)

		// Only use custom dimension if model doesn't have a built-in dimension
		if (!modelDimension && this.config.modelDimension && this.config.modelDimension > 0) {
			return this.config.modelDimension
		}

		return modelDimension
	}

	/**
	 * Gets the configured minimum search score based on user setting, model-specific threshold, or fallback.
	 * Priority: 1) User setting, 2) Model-specific threshold, 3) Default DEFAULT_SEARCH_MIN_SCORE constant.
	 */
	public get currentSearchMinScore(): number {
		// First check if user has configured a custom score threshold
		if (this.config.searchMinScore !== undefined) {
			return this.config.searchMinScore
		}

		// Fall back to model-specific threshold
		const currentModelId = this.config.modelId ?? getDefaultModelId(this.config.embedderProvider)
		const modelSpecificThreshold = getModelScoreThreshold(this.config.embedderProvider, currentModelId)
		return modelSpecificThreshold ?? DEFAULT_SEARCH_MIN_SCORE
	}

	/**
	 * Gets the configured maximum search results.
	 * Returns user setting if configured, otherwise returns default.
	 */
	public get currentSearchMaxResults(): number {
		return this.config.searchMaxResults ?? DEFAULT_MAX_SEARCH_RESULTS
	}
}
