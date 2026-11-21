import { OpenAI } from "openai"
import { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces/embedder"
import { MAX_BATCH_TOKENS, MAX_ITEM_TOKENS } from "../constants"
import { getDefaultModelId, getModelQueryPrefix } from "../../../shared/embeddingModels"
import { t } from "../../../i18n"
import { withValidationErrorHandling, HttpError, toEmbeddingError } from "../shared/validation-helpers"
import { TelemetryEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { handleOpenAIError } from "../../../api/providers/utils/error-handler"
import { makeRateLimitScope } from "../provider-pacer"

interface EmbeddingItem {
	embedding: string | number[]
	[key: string]: any
}

interface OpenAIEmbeddingResponse {
	data: EmbeddingItem[]
	usage?: {
		prompt_tokens?: number
		total_tokens?: number
	}
}

/**
 * OpenAI Compatible implementation of the embedder interface with batching and rate limiting.
 * This embedder allows using any OpenAI-compatible API endpoint by specifying a custom baseURL.
 */

export class OpenAICompatibleEmbedder implements IEmbedder {
	private embeddingsClient: OpenAI
	private readonly defaultModelId: string
	private readonly baseUrl: string
	private readonly apiKey: string
	private readonly isFullUrl: boolean
	private readonly maxItemTokens: number
	readonly rateLimitScope: string

	/**
	 * Creates a new OpenAI Compatible embedder
	 * @param baseUrl The base URL for the OpenAI-compatible API endpoint
	 * @param apiKey The API key for authentication
	 * @param modelId Optional model identifier (defaults to "text-embedding-3-small")
	 * @param maxItemTokens Optional maximum tokens per item (defaults to MAX_ITEM_TOKENS)
	 */
	constructor(baseUrl: string, apiKey: string, modelId?: string, maxItemTokens?: number) {
		if (!baseUrl) {
			throw new Error(t("embeddings:validation.baseUrlRequired"))
		}
		if (!apiKey) {
			throw new Error(t("embeddings:validation.apiKeyRequired"))
		}

		this.baseUrl = baseUrl
		this.apiKey = apiKey

		// Wrap OpenAI client creation to handle invalid API key characters
		try {
			// Retries are owned by the indexing retry policy; SDK retries would multiply its allowance.
			this.embeddingsClient = new OpenAI({
				baseURL: baseUrl,
				apiKey: apiKey,
				maxRetries: 0,
			})
		} catch (error) {
			// Use the error handler to transform ByteString conversion errors
			throw handleOpenAIError(error, "OpenAI Compatible")
		}

		this.defaultModelId = modelId || getDefaultModelId("openai-compatible")
		// Cache the URL type check for performance
		this.isFullUrl = this.isFullEndpointUrl(baseUrl)
		this.maxItemTokens = maxItemTokens || MAX_ITEM_TOKENS
		this.rateLimitScope = makeRateLimitScope("openai-compatible", baseUrl, apiKey)
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
		const queryPrefix = getModelQueryPrefix("openai-compatible", modelToUse)
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

				if (itemTokens > this.maxItemTokens) {
					console.warn(
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
				const batchResult = await this._embedBatch(currentBatch, modelToUse)
				allEmbeddings.push(...batchResult.embeddings)
				usage.promptTokens += batchResult.usage.promptTokens
				usage.totalTokens += batchResult.usage.totalTokens
			}
		}

		return { embeddings: allEmbeddings, usage }
	}

	/**
	 * Determines if the provided URL is a full endpoint URL or a base URL that needs the endpoint appended by the SDK.
	 * Uses smart pattern matching for known providers while accepting we can't cover all possible patterns.
	 * @param url The URL to check
	 * @returns true if it's a full endpoint URL, false if it's a base URL
	 */
	private isFullEndpointUrl(url: string): boolean {
		// Known patterns for major providers
		const patterns = [
			// Azure OpenAI: /deployments/{deployment-name}/embeddings
			/\/deployments\/[^/]+\/embeddings(\?|$)/,
			// Azure Databricks: /serving-endpoints/{endpoint-name}/invocations
			/\/serving-endpoints\/[^/]+\/invocations(\?|$)/,
			// Direct endpoints: ends with /embeddings (before query params)
			/\/embeddings(\?|$)/,
			// Some providers use /embed instead of /embeddings
			/\/embed(\?|$)/,
		]

		return patterns.some((pattern) => pattern.test(url))
	}

	/**
	 * Makes a direct HTTP request to the embeddings endpoint
	 * Used when the user provides a full endpoint URL (e.g., Azure OpenAI with query parameters)
	 * @param url The full endpoint URL
	 * @param batchTexts Array of texts to embed
	 * @param model Model identifier to use
	 * @returns Promise resolving to OpenAI-compatible response
	 */
	private async makeDirectEmbeddingRequest(
		url: string,
		batchTexts: string[],
		model: string,
	): Promise<OpenAIEmbeddingResponse> {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				// Azure OpenAI uses 'api-key' header, while OpenAI uses 'Authorization'
				// We'll try 'api-key' first for Azure compatibility
				"api-key": this.apiKey,
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				input: batchTexts,
				model: model,
				encoding_format: "base64",
			}),
		})

		if (!response || !response.ok) {
			const status = response?.status || 0
			let errorText = "No response"
			try {
				if (response && typeof response.text === "function") {
					errorText = await response.text()
				} else if (response) {
					errorText = `Error ${status}`
				}
			} catch {
				// Ignore text parsing errors
				errorText = `Error ${status}`
			}
			// Headers carry Retry-After for the shared rate-limit wait.
			throw Object.assign(new Error(`HTTP ${status}: ${errorText}`), {
				status: status || response?.status || 0,
				headers: response?.headers,
			})
		}

		try {
			return await response.json()
		} catch {
			const error = new Error(`Failed to parse response JSON`) as HttpError
			error.status = response.status
			throw error
		}
	}

	/**
	/** Sends one request; retries and rate-limit waits belong to the caller's retry policy and pacer. */
	private async _embedBatch(
		batchTexts: string[],
		model: string,
	): Promise<{ embeddings: number[][]; usage: { promptTokens: number; totalTokens: number } }> {
		try {
			const response: OpenAIEmbeddingResponse = this.isFullUrl
				? await this.makeDirectEmbeddingRequest(this.baseUrl, batchTexts, model)
				: ((await this.embeddingsClient.embeddings.create({
						input: batchTexts,
						model: model,
						// OpenAI package (as of v4.78.1) has a parsing issue that truncates embedding dimensions to 256
						// when processing numeric arrays, which breaks compatibility with models using larger dimensions.
						// By requesting base64 encoding, we bypass the package's parser and handle decoding ourselves.
						encoding_format: "base64",
					})) as OpenAIEmbeddingResponse)

			// Convert base64 embeddings to float32 arrays
			const processedEmbeddings = response.data.map((item: EmbeddingItem) => {
				if (typeof item.embedding === "string") {
					const buffer = Buffer.from(item.embedding, "base64")

					// Create Float32Array view over the buffer
					const float32Array = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)

					return {
						...item,
						embedding: Array.from(float32Array),
					}
				}
				return item
			})

			// Replace the original data with processed embeddings
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
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "OpenAICompatibleEmbedder:_embedBatch",
			})
			console.error("OpenAI Compatible embedder error:", error)
			throw toEmbeddingError(error)
		}
	}

	/**
	 * Validates the OpenAI-compatible embedder configuration by testing endpoint connectivity and API key
	 * @returns Promise resolving to validation result with success status and optional error message
	 */
	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return withValidationErrorHandling(async () => {
			try {
				// Test with a minimal embedding request
				const testTexts = ["test"]
				const modelToUse = this.defaultModelId

				let response: OpenAIEmbeddingResponse

				if (this.isFullUrl) {
					// Test direct HTTP request for full endpoint URLs
					response = await this.makeDirectEmbeddingRequest(this.baseUrl, testTexts, modelToUse)
				} else {
					// Test using OpenAI SDK for base URLs
					response = (await this.embeddingsClient.embeddings.create({
						input: testTexts,
						model: modelToUse,
						encoding_format: "base64",
					})) as OpenAIEmbeddingResponse
				}

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
					location: "OpenAICompatibleEmbedder:validateConfiguration",
				})
				throw error
			}
		}, "openai-compatible")
	}

	/**
	 * Returns information about this embedder
	 */
	get embedderInfo(): EmbedderInfo {
		return {
			name: "openai-compatible",
		}
	}
}
