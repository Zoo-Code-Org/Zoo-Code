import { codeIndexLog } from "../code-index-log"
import { makeRateLimitScope } from "../provider-pacer"
import { BedrockRuntimeClient, InvokeModelCommand, InvokeModelCommandInput } from "@aws-sdk/client-bedrock-runtime"
import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { createProxyRoutingRequestHandler } from "../../../utils/networkProxy"
import { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces"
import { MAX_BATCH_TOKENS, MAX_ITEM_TOKENS } from "../constants"
import { getDefaultModelId } from "../../../shared/embeddingModels"
import { Package } from "../../../shared/package"
import { t } from "../../../i18n"
import { withValidationErrorHandling, formatEmbeddingError } from "../shared/validation-helpers"
import { TelemetryEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

/**
 * Amazon Bedrock implementation of the embedder interface with batching
 */
export class BedrockEmbedder implements IEmbedder {
	readonly rateLimitScope: string
	private bedrockClient: BedrockRuntimeClient
	private readonly defaultModelId: string

	/**
	 * Creates a new Amazon Bedrock embedder
	 * @param region AWS region for Bedrock service (required)
	 * @param profile AWS profile name for credentials (optional - uses default credential chain if not provided)
	 * @param modelId Optional model ID override
	 */
	constructor(
		private readonly region: string,
		private readonly profile?: string,
		modelId?: string,
	) {
		if (!region) {
			throw new Error("Region is required for AWS Bedrock embedder")
		}

		this.rateLimitScope = makeRateLimitScope(
			"bedrock",
			undefined,
			undefined,
			JSON.stringify([region, profile ?? ""]),
		)

		// Initialize the Bedrock client with credentials
		// If profile is specified, use it; otherwise use default credential chain
		const credentials = this.profile ? fromIni({ profile: this.profile }) : fromNodeProviderChain()

		// Behind a corporate proxy, Node resolves DNS locally and Bedrock endpoints fail with
		// ENOTFOUND. The handler tunnels through the proxy with CONNECT so the proxy resolves
		// the hostname, and connects directly to the destinations NO_PROXY excludes.
		const requestHandler = createProxyRoutingRequestHandler()

		this.bedrockClient = new BedrockRuntimeClient({
			userAgentAppId: `ZooCode#${Package.version}`,
			maxAttempts: 1,
			region: this.region,
			credentials,
			...(requestHandler && { requestHandler }),
		})

		this.defaultModelId = modelId || getDefaultModelId("bedrock")
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

		const allEmbeddings: number[][] = []
		const usage = { promptTokens: 0, totalTokens: 0 }
		const remainingTexts = [...texts]

		while (remainingTexts.length > 0) {
			signal?.throwIfAborted()
			const currentBatch: string[] = []
			let currentBatchTokens = 0
			const processedIndices: number[] = []

			for (let i = 0; i < remainingTexts.length; i++) {
				const text = remainingTexts[i]
				const itemTokens = Math.ceil(text.length / 4)

				if (itemTokens > MAX_ITEM_TOKENS) {
					codeIndexLog.warn(
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
			const embeddings: number[][] = []
			let totalPromptTokens = 0
			let totalTokens = 0

			// Amazon Titan models typically need one request per text.
			for (const text of batchTexts) {
				signal?.throwIfAborted()
				const embedding = await this._invokeEmbeddingModel(text, model, signal)
				embeddings.push(embedding.embedding)
				totalPromptTokens += embedding.inputTextTokenCount || 0
				totalTokens += embedding.inputTextTokenCount || 0
			}

			return {
				embeddings,
				usage: {
					promptTokens: totalPromptTokens,
					totalTokens,
				},
			}
		} catch (error) {
			signal?.throwIfAborted()
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "BedrockEmbedder:_embedBatch",
			})
			codeIndexLog.error("Bedrock embedder error:", error)
			throw formatEmbeddingError(error)
		}
	}

	/**
	 * Invokes the embedding model for a single text
	 * @param text The text to embed
	 * @param model The model identifier to use
	 * @returns Promise resolving to embedding and token count
	 */
	private async _invokeEmbeddingModel(
		text: string,
		model: string,
		signal?: AbortSignal,
	): Promise<{ embedding: number[]; inputTextTokenCount?: number }> {
		let requestBody: any
		const modelId = model

		// Prepare the request body based on the model
		if (model.startsWith("amazon.nova-2-multimodal")) {
			// Nova multimodal embeddings use a task-based format with embeddingParams
			// Reference: https://docs.aws.amazon.com/bedrock/latest/userguide/embeddings-nova.html
			requestBody = {
				taskType: "SINGLE_EMBEDDING",
				singleEmbeddingParams: {
					embeddingPurpose: "GENERIC_INDEX",
					embeddingDimension: 1024, // Nova supports 1024 or 3072
					text: {
						truncationMode: "END",
						value: text,
					},
				},
			}
		} else if (model.startsWith("amazon.titan-embed")) {
			requestBody = {
				inputText: text,
			}
		} else if (model.startsWith("cohere.embed-v4")) {
			// Cohere Embed v4 requires embedding_types parameter
			requestBody = {
				texts: [text],
				input_type: "search_document",
				embedding_types: ["float"],
			}
		} else if (model.startsWith("cohere.embed")) {
			// Cohere Embed v3 format
			requestBody = {
				texts: [text],
				input_type: "search_document",
			}
		} else {
			// Default to Titan format
			requestBody = {
				inputText: text,
			}
		}

		const params: InvokeModelCommandInput = {
			modelId,
			body: JSON.stringify(requestBody),
			contentType: "application/json",
			accept: "application/json",
		}

		const command = new InvokeModelCommand(params)

		signal?.throwIfAborted()
		const response = await this.bedrockClient.send(command, ...(signal ? [{ abortSignal: signal }] : []))
		signal?.throwIfAborted()

		// Parse the response
		const responseBody = JSON.parse(new TextDecoder().decode(response.body))

		// Extract embedding based on model type
		if (model.startsWith("amazon.nova-2-multimodal")) {
			// Nova multimodal returns { embeddings: [{ embedding: [...] }] }
			// Reference: AWS Bedrock documentation
			return {
				embedding: responseBody.embeddings?.[0]?.embedding || responseBody.embedding,
				inputTextTokenCount: responseBody.inputTextTokenCount,
			}
		} else if (model.startsWith("amazon.titan-embed")) {
			return {
				embedding: responseBody.embedding,
				inputTextTokenCount: responseBody.inputTextTokenCount,
			}
		} else if (model.startsWith("cohere.embed-v4")) {
			// Cohere Embed v4 returns { embeddings: { float: [[...]] } }
			return {
				embedding: responseBody.embeddings?.float?.[0] || responseBody.embeddings?.[0],
			}
		} else if (model.startsWith("cohere.embed")) {
			// Cohere Embed v3 returns { embeddings: [[...]] }
			return {
				embedding: responseBody.embeddings[0],
			}
		} else {
			// Default to Titan format
			return {
				embedding: responseBody.embedding,
				inputTextTokenCount: responseBody.inputTextTokenCount,
			}
		}
	}

	/**
	 * Validates the Bedrock embedder configuration by attempting a minimal embedding request
	 * @returns Promise resolving to validation result with success status and optional error message
	 */
	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return withValidationErrorHandling(async () => {
			try {
				// Test with a minimal embedding request
				const result = await this._invokeEmbeddingModel("test", this.defaultModelId)

				// Check if we got a valid response
				if (!result.embedding || result.embedding.length === 0) {
					return {
						valid: false,
						error: t("embeddings:bedrock.invalidResponseFormat"),
					}
				}

				return { valid: true }
			} catch (error: any) {
				// Check for specific AWS errors
				if (error.name === "UnrecognizedClientException") {
					return {
						valid: false,
						error: t("embeddings:bedrock.invalidCredentials"),
					}
				}

				if (error.name === "AccessDeniedException") {
					return {
						valid: false,
						error: t("embeddings:bedrock.accessDenied"),
					}
				}

				if (error.name === "ResourceNotFoundException") {
					return {
						valid: false,
						error: t("embeddings:bedrock.modelNotFound", { model: this.defaultModelId }),
					}
				}

				// Capture telemetry for validation errors
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "BedrockEmbedder:validateConfiguration",
				})
				throw error
			}
		}, "bedrock")
	}

	get embedderInfo(): EmbedderInfo {
		return {
			name: "bedrock",
		}
	}
}
