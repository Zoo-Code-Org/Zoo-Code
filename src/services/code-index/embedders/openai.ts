import { OpenAI } from "openai"
import { OpenAiNativeHandler } from "../../../api/providers/openai-native"
import { ApiHandlerOptions } from "../../../shared/api"
import { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces"
import { MAX_BATCH_TOKENS, MAX_ITEM_TOKENS } from "../constants"
import { getModelQueryPrefix } from "../../../shared/embeddingModels"
import { t } from "../../../i18n"
import { withValidationErrorHandling, toEmbeddingError } from "../shared/validation-helpers"
import { makeRateLimitScope } from "../provider-pacer"
import { TelemetryEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { handleOpenAIError } from "../../../api/providers/utils/error-handler"

/**
 * OpenAI implementation of the embedder interface with batching and rate limiting
 */
export class OpenAiEmbedder extends OpenAiNativeHandler implements IEmbedder {
	private embeddingsClient: OpenAI
	private readonly defaultModelId: string
	readonly rateLimitScope: string

	/**
	 * Creates a new OpenAI embedder
	 * @param options API handler options
	 */
	constructor(options: ApiHandlerOptions & { openAiEmbeddingModelId?: string }) {
		super(options)
		const apiKey = this.options.openAiNativeApiKey ?? "not-provided"

		// Wrap OpenAI client creation to handle invalid API key characters
		try {
			// Retries are owned by the indexing retry policy; SDK retries would multiply its allowance.
			this.embeddingsClient = new OpenAI({ apiKey, maxRetries: 0 })
		} catch (error) {
			// Use the error handler to transform ByteString conversion errors
			throw handleOpenAIError(error, "OpenAI")
		}

		this.defaultModelId = options.openAiEmbeddingModelId || "text-embedding-3-small"
		this.rateLimitScope = makeRateLimitScope("openai", "https://api.openai.com/v1", apiKey)
	}

	/**
	 * Creates embeddings for the given texts with batching and rate limiting
	 * @param texts Array of text strings to embed
	 * @param model Optional model identifier
	 * @returns Promise resolving to embedding response
	 */
	async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
		const modelToUse = model || this.defaultModelId

		// Apply model-specific query prefix if required
		const queryPrefix = getModelQueryPrefix("openai", modelToUse)
		const processedTexts = queryPrefix
			? texts.map((text, index) => {
					// Prevent double-prefixing
					if (text.startsWith(queryPrefix)) {
						return text
					}
					const prefixedText = `${queryPrefix}${text}`
					const estimatedTokens = Math.ceil(prefixedText.length / 4)
					if (estimatedTokens > MAX_ITEM_TOKENS) {
						console.warn(
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
			const currentBatch: string[] = []
			let currentBatchTokens = 0
			const processedIndices: number[] = []

			for (let i = 0; i < remainingTexts.length; i++) {
				const text = remainingTexts[i]
				const itemTokens = Math.ceil(text.length / 4)

				if (itemTokens > MAX_ITEM_TOKENS) {
					console.warn(
						t("embeddings:textExceedsTokenLimit", {
							index: i,
							itemTokens,
							maxTokens: MAX_ITEM_TOKENS,
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
				const batchResult = await this._embedBatch(currentBatch, modelToUse)
				allEmbeddings.push(...batchResult.embeddings)
				usage.promptTokens += batchResult.usage.promptTokens
				usage.totalTokens += batchResult.usage.totalTokens
			}
		}

		return { embeddings: allEmbeddings, usage }
	}

	/** Sends one request; retries and rate-limit waits belong to the caller's retry policy and pacer. */
	private async _embedBatch(
		batchTexts: string[],
		model: string,
	): Promise<{ embeddings: number[][]; usage: { promptTokens: number; totalTokens: number } }> {
		try {
			const response = await this.embeddingsClient.embeddings.create({
				input: batchTexts,
				model: model,
			})

			return {
				embeddings: response.data.map((item) => item.embedding),
				usage: {
					promptTokens: response.usage?.prompt_tokens || 0,
					totalTokens: response.usage?.total_tokens || 0,
				},
			}
		} catch (error) {
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "OpenAiEmbedder:_embedBatch",
			})
			console.error("OpenAI embedder error:", error)
			throw toEmbeddingError(error)
		}
	}

	/**
	 * Validates the OpenAI embedder configuration by attempting a minimal embedding request
	 * @returns Promise resolving to validation result with success status and optional error message
	 */
	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return withValidationErrorHandling(async () => {
			try {
				// Test with a minimal embedding request
				const response = await this.embeddingsClient.embeddings.create({
					input: ["test"],
					model: this.defaultModelId,
				})

				// Check if we got a valid response
				if (!response.data || response.data.length === 0) {
					return {
						valid: false,
						error: t("embeddings:openai.invalidResponseFormat"),
					}
				}

				return { valid: true }
			} catch (error) {
				// Capture telemetry for validation errors
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "OpenAiEmbedder:validateConfiguration",
				})
				throw error
			}
		}, "openai")
	}

	get embedderInfo(): EmbedderInfo {
		return {
			name: "openai",
		}
	}
}
