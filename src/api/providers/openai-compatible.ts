import type { ModelInfo } from "@roo-code/types"

/**
 * Configuration options for creating an OpenAI-compatible provider.
 *
 * @public
 */
export interface OpenAICompatibleConfig {
	/** Provider name for identification */
	providerName: string
	/** Base URL for the API endpoint */
	baseURL: string
	/** API key for authentication */
	apiKey: string
	/** Model ID to use */
	modelId: string
	/** Model information */
	modelInfo: ModelInfo
	/** Optional custom headers */
	headers?: Record<string, string>
	/** Whether to include max_tokens in requests (default: false uses max_completion_tokens) */
	useMaxTokens?: boolean
	/** User-configured max tokens override */
	modelMaxTokens?: number
	/** Temperature setting */
	temperature?: number
}
