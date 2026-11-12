import { codeIndexLog } from "../code-index-log"
import { makeRateLimitScope } from "../provider-pacer"
import { OpenAI } from "openai"
import { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces/embedder"
import { MAX_BATCH_TOKENS, MAX_ITEM_TOKENS } from "../constants"
import { getDefaultModelId, getModelQueryPrefix } from "../../../shared/embeddingModels"
import { t } from "../../../i18n"
import { withValidationErrorHandling, formatEmbeddingError } from "../shared/validation-helpers"
import { TelemetryEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { handleOpenAIError } from "../../../api/providers/utils/error-handler"

// Default provider name when no specific provider is selected
export const OPENROUTER_DEFAULT_PROVIDER_NAME = "[default]"

interface EmbeddingItem {
	embedding: string | number[]
}

interface OpenRouterEmbeddingResponse {
	data: EmbeddingItem[]
	usage?: {
		prompt_tokens?: number
		total_tokens?: number
	}
}

/**
 * OpenRouter implementation of the embedder interface with batching.
 * OpenRouter provides an OpenAI-compatible API that gives access to hundreds of models
 * through a single endpoint, automatically handling fallbacks and cost optimization.
 */
export class OpenRouterEmbedder implements IEmbedder {
	readonly rateLimitScope: string
	private embeddingsClient: OpenAI
	private readonly defaultModelId: string
	private readonly maxItemTokens: number
	private readonly baseUrl: string = "https://openrouter.ai/api/v1"
	private readonly specificProvider?: string

	/**
	 * Creates a new OpenRouter embedder
	 * @param apiKey The API key for authentication
	 * @param modelId Optional model identifier (defaults to "openai/text-embedding-3-large")
	 * @param maxItemTokens Optional maximum tokens per item (defaults to MAX_ITEM_TOKENS)
	 * @param specificProvider Optional specific provider to route requests to
	 */
	constructor(apiKey: string, modelId?: string, maxItemTokens?: number, specificProvider?: string) {
		if (!apiKey) {
			throw new Error(t("embeddings:validation.apiKeyRequired"))
		}

		this.rateLimitScope = makeRateLimitScope("openrouter", this.baseUrl, apiKey)

		// Only set specificProvider if it's not the default value
		this.specificProvider =
			specificProvider && specificProvider !== OPENROUTER_DEFAULT_PROVIDER_NAME ? specificProvider : undefined

		// Wrap OpenAI client creation to handle invalid API key characters
		try {
			this.embeddingsClient = new OpenAI({
				baseURL: this.baseUrl,
				maxRetries: 0,
				apiKey: apiKey,
				defaultHeaders: {
					"HTTP-Referer": "https://github.com/Zoo-Code-Org/Zoo-Code",
					"X-Title": "Zoo Code",
				},
			})
		} catch (error) {
			// Use the error handler to transform ByteString conversion errors
			throw handleOpenAIError(error, "OpenRouter")
		}

		this.defaultModelId = modelId || getDefaultModelId("openrouter")
		this.maxItemTokens = maxItemTokens || MAX_ITEM_TOKENS
	}

	/**
	 * Creates embeddings for the given texts with batching
	 * @param texts Array of text strings to embed
	 * @param model Optional model identifier
	 * @returns Promise resolving to embedding response
	 */
	async createEmbeddings(texts: string[], model?: string, signal?: AbortSignal): Promise<EmbeddingResponse> {
		signal?.throwIfAborted()
		const modelToUse = model || this.defaultModelId

		// Apply model-specific query prefix if required
		const queryPrefix = getModelQueryPrefix("openrouter", modelToUse)
		const processedTexts = queryPrefix
			? texts.map((text, index) => {
					// Prevent double-prefixing
					if (text.startsWith(queryPrefix)) {
						return text
					}
					const prefixedText = `${queryPrefix}${text}`
					const estimatedTokens = Math.ceil(prefixedText.length / 4)
					if (estimatedTokens > MAX_ITEM_TOKENS) {
						codeIndexLog.warn(
							t("embeddings:textWithPrefixExceedsTokenLimit", {
								index,
								estimatedTokens,
								maxTokens: MAX_ITEM_TOKENS,
							}),
						)
						// Return original text if adding prefix would exceed limit
						return text
					}
					return prefixedText
				})
			: texts

		const allEmbeddings: number[][] = []
		const usage = { promptTokens: 0, totalTokens: 0 }
		const remainingTexts = [...processedTexts]

		while (remainingTexts.length > 0) {
			signal?.throwIfAborted()
			const currentBatch: string[] = []
			let currentBatchTokens = 0
			const processedIndices: number[] = []

			for (let i = 0; i < remainingTexts.length; i++) {
				const text = remainingTexts[i]
				const itemTokens = Math.ceil(text.length / 4)

				if (itemTokens > this.maxItemTokens) {
					codeIndexLog.warn(
						t("embeddings:textExceedsTokenLimit", {
							index: i,
							itemTokens,
							maxTokens: this.maxItemTokens,
						}),
					)
					processedIndices.push(i)
					continue
				}

				if (currentBatchTokens + itemTokens <= MAX_BATCH_TOKENS) {
					currentBatch.push(text)
					currentBatchTokens += itemTokens
					processedIndices.push(i)
				} else {
					break
				}
			}

			// Remove processed items from remainingTexts (in reverse order to maintain correct indices)
			for (let i = processedIndices.length - 1; i >= 0; i--) {
				remainingTexts.splice(processedIndices[i], 1)
			}

			if (currentBatch.length > 0) {
				const batchResult = await this._embedBatch(currentBatch, modelToUse, signal)
				allEmbeddings.push(...batchResult.embeddings)
				usage.promptTokens += batchResult.usage.promptTokens
				usage.totalTokens += batchResult.usage.totalTokens
			}
		}

		return { embeddings: allEmbeddings, usage }
	}

	private async _embedBatch(
		batchTexts: string[],
		model: string,
		signal?: AbortSignal,
	): Promise<{ embeddings: number[][]; usage: { promptTokens: number; totalTokens: number } }> {
		try {
			signal?.throwIfAborted()
			const requestParams: OpenAI.EmbeddingCreateParams & {
				provider?: { order: string[]; only: string[]; allow_fallbacks: boolean }
			} = {
				input: batchTexts,
				model: model,
				// Base64 with local decoding bypasses the OpenAI v4.78.1 numeric-array parser's
				// 256-dimension truncation, which breaks larger models.
				encoding_format: "base64",
			}

			if (this.specificProvider) {
				requestParams.provider = {
					order: [this.specificProvider],
					only: [this.specificProvider],
					allow_fallbacks: false,
				}
			}

			const response = (await this.embeddingsClient.embeddings.create(
				requestParams,
				...(signal ? [{ signal }] : []),
			)) as OpenRouterEmbeddingResponse

			signal?.throwIfAborted()
			const processedEmbeddings = response.data.map((item: EmbeddingItem) => {
				if (typeof item.embedding === "string") {
					const buffer = Buffer.from(item.embedding, "base64")

					const float32Array = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)

					return {
						...item,
						embedding: Array.from(float32Array),
					}
				}
				return item
			})

			response.data = processedEmbeddings

			const embeddings = response.data.map((item) => item.embedding as number[])

			return {
				embeddings: embeddings,
				usage: {
					promptTokens: response.usage?.prompt_tokens || 0,
					totalTokens: response.usage?.total_tokens || 0,
				},
			}
		} catch (error) {
			signal?.throwIfAborted()
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "OpenRouterEmbedder:_embedBatch",
			})
			codeIndexLog.error("OpenRouter embedder error:", error)
			throw formatEmbeddingError(error)
		}
	}

	/**
	 * Validates the OpenRouter embedder configuration by testing API connectivity
	 * @returns Promise resolving to validation result with success status and optional error message
	 */
	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return withValidationErrorHandling(async () => {
			try {
				// Test with a minimal embedding request
				const testTexts = ["test"]
				const modelToUse = this.defaultModelId

				// Build the request parameters
				const requestParams: OpenAI.EmbeddingCreateParams & {
					provider?: { order: string[]; only: string[]; allow_fallbacks: boolean }
				} = {
					input: testTexts,
					model: modelToUse,
					encoding_format: "base64",
				}

				// Add provider routing if a specific provider is set
				if (this.specificProvider) {
					requestParams.provider = {
						order: [this.specificProvider],
						only: [this.specificProvider],
						allow_fallbacks: false,
					}
				}

				const response = (await this.embeddingsClient.embeddings.create(
					requestParams,
				)) as OpenRouterEmbeddingResponse

				// Check if we got a valid response
				if (!response?.data || response.data.length === 0) {
					return {
						valid: false,
						error: "embeddings:validation.invalidResponse",
					}
				}

				return { valid: true }
			} catch (error) {
				// Capture telemetry for validation errors
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "OpenRouterEmbedder:validateConfiguration",
				})
				throw error
			}
		}, "openrouter")
	}

	/**
	 * Returns information about this embedder
	 */
	get embedderInfo(): EmbedderInfo {
		return {
			name: "openrouter",
		}
	}
}
