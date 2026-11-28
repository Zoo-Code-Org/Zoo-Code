import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { AzureOpenAI } from "openai"
import axios from "axios"

import {
	type ModelInfo,
	providerIdentifiers,
	azureOpenAiDefaultApiVersion,
	isAzureAiInferenceBaseUrl,
	isAzureOpenAiBaseUrl,
	openAiModelInfoSaneDefaults,
	DEEP_SEEK_DEFAULT_TEMPERATURE,
	DEFAULT_OPEN_AI_STRICT_TOOL_SCHEMAS,
	OPENAI_AZURE_AI_INFERENCE_PATH,
	parseOpenAiExtraBody,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { TagMatcher } from "../../utils/tag-matcher"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { sanitizeSurrogates } from "../transform/sanitize-surrogates"
import { convertToR1Format } from "../transform/r1-format"
import { isOSeriesModelId } from "./utils/is-o-series-model"
import { buildResponsesRequest } from "./utils/openai-compatible-responses"
import { resolveOpenAiCompatibleMaxTokens } from "./utils/openai-compatible-max-tokens"
import { processResponsesApiStream, createUsageNormalizer } from "../transform/responses-api-stream"
import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { assertResponsesApiSuccess } from "../transform/responses-api-error"
import {
	readResponsesReasoningItem,
	responsesReasoningScope,
	type ScopedResponsesReasoningItem,
} from "../transform/responses-api-reasoning"
import { OutputTokenLimitError } from "./utils/output-token-limit-error"
import { getModelParams } from "../transform/model-params"

import { DEFAULT_HEADERS, NOT_PROVIDED } from "./constants"
import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"
import { handleOpenAIError } from "./utils/error-handler"
import { applyThoughtSignatures, thoughtSignatureOrigin, ThoughtSignatureReader } from "./utils/thought-signature"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"
import {
	bridgeExternalAbortSignal,
	createAbortError,
	isRequestAborted,
	hasUsableTimeout,
	toSdkTimeoutMs,
} from "./utils/abort-signal"

function isAzureV1BaseUrl(baseUrl?: string): boolean {
	try {
		return /\/openai\/v1\/?$/.test(new URL(baseUrl ?? "").pathname)
	} catch {
		return false
	}
}

type OpenAiUsage =
	| {
			prompt_tokens?: number
			completion_tokens?: number
			cache_creation_input_tokens?: number
			cache_read_input_tokens?: unknown
			prompt_tokens_details?: { cached_tokens?: unknown } | null
	  }
	| null
	| undefined

// TODO: Rename this to OpenAICompatibleHandler. Also, I think the
// `OpenAINativeHandler` can subclass from this, since it's obviously
// compatible with the OpenAI API. We can also rename it to `OpenAIHandler`.
export class OpenAiHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	protected client: OpenAI
	readonly requiresThoughtSignatureDrain = true
	private readonly providerName = "OpenAI"
	private thoughtSignatureReader: ThoughtSignatureReader | undefined
	private signatureOrigin: string | undefined
	private readonly extraBody: Record<string, unknown>
	private responsesReasoning: OpenAI.Responses.ResponseReasoningItem[] = []

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.extraBody = parseOpenAiExtraBody(options.openAiExtraBody).data

		const baseURL = this.options.openAiBaseUrl || "https://api.openai.com/v1"
		const apiKey = this.options.openAiApiKey ?? NOT_PROVIDED
		const isAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
		const isAzureOpenAi = isAzureOpenAiBaseUrl(this.options.openAiBaseUrl, options.openAiUseAzure)

		const headers = {
			...DEFAULT_HEADERS,
			...(this.options.openAiHeaders || {}),
		}

		const isAzureV1 = isAzureV1BaseUrl(baseURL)
		if (isAzureAiInference && this.options.openAiUseResponsesApi) {
			throw new Error(
				"Responses API requires an /openai/v1 base URL for Azure AI Inference. Update the Base URL or disable Use Responses API.",
			)
		}
		if (isAzureV1 || (isAzureOpenAi && this.options.openAiUseResponsesApi && !this.options.azureApiVersion)) {
			// Azure's v1 API supports Responses without a dated api-version parameter.
			const responsesBaseURL = isAzureV1
				? baseURL
				: `${baseURL.replace(/\/openai\/?$/i, "").replace(/\/$/, "")}/openai/v1`
			this.client = new OpenAI({
				baseURL: responsesBaseURL,
				apiKey,
				defaultHeaders: headers,
				timeout: this.timeoutMs,
			})
		} else if (isAzureAiInference) {
			// Azure AI Inference Service (e.g., for DeepSeek) uses a different path structure
			this.client = new OpenAI({
				baseURL,
				apiKey,
				defaultHeaders: headers,
				defaultQuery: { "api-version": this.options.azureApiVersion || "2024-05-01-preview" },
				timeout: this.timeoutMs,
			})
		} else if (isAzureOpenAi) {
			// Azure API shape slightly differs from the core API shape:
			// https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
			const azureBaseURL = `${baseURL.replace(/\/openai\/?$/i, "").replace(/\/$/, "")}/openai`
			this.client = new AzureOpenAI({
				baseURL: azureBaseURL,
				apiKey,
				apiVersion: this.options.azureApiVersion || azureOpenAiDefaultApiVersion,
				defaultHeaders: headers,
				timeout: this.timeoutMs,
			})
		} else {
			this.client = new OpenAI({
				baseURL,
				apiKey,
				defaultHeaders: headers,
				timeout: this.timeoutMs,
			})
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Each generator owns its reader. An older usage drain cannot change the current signature.
		const signatureReader = new ThoughtSignatureReader()
		this.thoughtSignatureReader = signatureReader
		this.signatureOrigin = thoughtSignatureOrigin(
			this.options.openAiBaseUrl || "https://api.openai.com/v1",
			this.options.openAiModelId ?? "",
		)
		const modelId = this.options.openAiModelId ?? ""
		// Opt-in Responses API path: some OpenAI-compatible endpoints (e.g. Azure
		// OpenAI deployments of reasoning models behind corporate gateways) reject
		// `reasoning_effort` combined with function tools on /chat/completions and
		// require /responses instead.
		if (this.options.openAiUseResponsesApi) {
			yield* this.handleResponsesApiMessage(systemPrompt, messages, metadata)
			return
		}

		const { info: modelInfo, reasoning } = this.getModel()
		const modelUrl = this.options.openAiBaseUrl ?? ""
		// Stryker disable next-line LogicalOperator: equivalent. An unset option makes `&&`
		// yield undefined, which the parameter default in convertToolsForOpenAI turns back into
		// the same strict value as `??`.
		const strictToolSchemas = this.options.openAiStrictToolSchemas ?? DEFAULT_OPEN_AI_STRICT_TOOL_SCHEMAS
		const isAzureAiInference = this._isAzureAiInference(modelUrl)
		const deepseekReasoner = this.usesR1Format(modelId)

		if (isOSeriesModelId(modelId)) {
			yield* this.handleO3FamilyMessage(modelId, systemPrompt, messages, metadata)
			return
		}

		let systemMessage: OpenAI.Chat.ChatCompletionSystemMessageParam = {
			role: "system",
			// Sanitize lone UTF-16 surrogates: providers validating the JSON body
			// (e.g. DeepSeek) reject the whole request otherwise. See #461.
			content: sanitizeSurrogates(systemPrompt),
		}

		if (this.options.openAiStreamingEnabled ?? true) {
			let convertedMessages

			if (deepseekReasoner) {
				convertedMessages = convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
			} else {
				if (modelInfo.supportsPromptCache) {
					systemMessage = {
						role: "system",
						content: [
							{
								type: "text",
								text: sanitizeSurrogates(systemPrompt),
								// @ts-ignore-next-line
								cache_control: { type: "ephemeral" },
							},
						],
					}
				}

				convertedMessages = [systemMessage, ...convertToOpenAiMessages(messages)]

				if (modelInfo.supportsPromptCache) {
					// Note: the following logic is copied from openrouter:
					// Add cache_control to the last two user messages
					// (note: this works because we only ever add one user message at a time, but if we added multiple we'd need to mark the user message before the last assistant message)
					const lastTwoUserMessages = convertedMessages.filter((msg) => msg.role === "user").slice(-2)

					lastTwoUserMessages.forEach((msg) => {
						if (typeof msg.content === "string") {
							msg.content = [{ type: "text", text: msg.content }]
						}

						if (Array.isArray(msg.content)) {
							// NOTE: this is fine since env details will always be added at the end. but if it weren't there, and the user added a image_url type message, it would pop a text part before it and then move it after to the end.
							let lastTextPart = msg.content.filter((part) => part.type === "text").pop()

							if (!lastTextPart) {
								lastTextPart = { type: "text", text: "..." }
								msg.content.push(lastTextPart)
							}

							// @ts-ignore-next-line
							lastTextPart["cache_control"] = { type: "ephemeral" }
						}
					})
				}
			}

			const isGrokXAI = this._isGrokXAI(this.options.openAiBaseUrl)

			let requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
				model: modelId,
				// Some OpenAI-Compatible models (e.g. claude-opus-4-7, claude-opus-4-8) reject
				// `temperature` as deprecated/unsupported, so honor the model's `supportsTemperature`
				// flag and omit it when that flag is false. Beyond that, only send `temperature` when
				// the user set a custom value or the model needs a specific default (deepseek-reasoner);
				// otherwise omit it so the server's own default applies instead of forcing 0.
				...(modelInfo.supportsTemperature !== false &&
					(this.options.modelTemperature != null || deepseekReasoner) && {
						temperature: this.options.modelTemperature ?? DEEP_SEEK_DEFAULT_TEMPERATURE,
					}),
				messages: applyThoughtSignatures(messages, convertedMessages, { origin: this.signatureOrigin }),
				stream: true as const,
				...(isGrokXAI ? {} : { stream_options: { include_usage: true } }),
				...(reasoning && reasoning),
				tools: this.convertToolsForOpenAI(metadata?.tools, strictToolSchemas),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)
			requestOptions = this.withExtraBody(requestOptions)

			let stream
			try {
				stream = await this.client.chat.completions.create(requestOptions, {
					signal: metadata?.abortSignal,
					...(isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
				})
			} catch (error) {
				throw handleOpenAIError(error, this.providerName)
			}

			const matcher = new TagMatcher(
				["think", "thought"],
				(chunk) =>
					({
						type: chunk.matched ? "reasoning" : "text",
						text: chunk.data,
					}) as const,
			)

			let lastUsage
			const activeToolCallIds = new Set<string>()

			for await (const chunk of stream) {
				const delta = chunk.choices?.[0]?.delta ?? {}
				const finishReason = chunk.choices?.[0]?.finish_reason
				signatureReader.update(delta.tool_calls)

				const reasoningText = extractReasoningFromDelta(delta)
				if (reasoningText) {
					yield { type: "reasoning", text: reasoningText }
				}

				if (delta.content) {
					for (const chunk of matcher.update(delta.content)) {
						yield chunk
					}
				}

				yield* this.processToolCalls(delta, finishReason, activeToolCallIds)

				if (chunk.usage) {
					lastUsage = chunk.usage
				}
			}

			for (const chunk of matcher.final()) {
				yield chunk
			}

			if (lastUsage) {
				yield this.processUsageMetrics(lastUsage, modelInfo)
			}
		} else {
			let requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: modelId,
				messages: deepseekReasoner
					? convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
					: [systemMessage, ...convertToOpenAiMessages(messages)],
				...reasoning,
				// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)
				tools: this.convertToolsForOpenAI(metadata?.tools, strictToolSchemas),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			requestOptions.messages = applyThoughtSignatures(messages, requestOptions.messages, {
				origin: this.signatureOrigin,
			})
			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)
			requestOptions = this.withExtraBody(requestOptions)

			let response
			try {
				response = await this.client.chat.completions.create(requestOptions, {
					signal: metadata?.abortSignal,
					...(this._isAzureAiInference(modelUrl) ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
				})
			} catch (error) {
				throw handleOpenAIError(error, this.providerName)
			}

			const message = response.choices?.[0]?.message
			signatureReader.update(message?.tool_calls)

			if (message?.tool_calls) {
				for (const toolCall of message.tool_calls) {
					if (toolCall.type === "function") {
						yield {
							type: "tool_call",
							id: toolCall.id,
							name: toolCall.function.name,
							arguments: toolCall.function.arguments,
						}
					}
				}
			}

			yield {
				type: "text",
				text: message?.content || "",
			}

			yield this.processUsageMetrics(response.usage, modelInfo)
		}
	}

	/** Sends the opt-in Responses request through the shared input and stream transforms. */
	private async *handleResponsesApiMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		this.responsesReasoning = []
		const { info: modelInfo, reasoning } = this.getModel()
		// Stryker disable next-line LogicalOperator: equivalent. An unset option makes `&&`
		// yield undefined, which the parameter default in convertToolsForOpenAI turns back into
		// the same strict value as `??`.
		const strictToolSchemas = this.options.openAiStrictToolSchemas ?? DEFAULT_OPEN_AI_STRICT_TOOL_SCHEMAS

		const reasoningItems = new Map<string, OpenAI.Responses.ResponseReasoningItem>()
		const captureReasoning = (value: unknown) => {
			const item = readResponsesReasoningItem(value)
			if (item) reasoningItems.set(item.id, item)
		}
		const body = buildResponsesRequest({
			options: this.options,
			modelInfo,
			reasoning,
			systemPrompt,
			messages,
			metadata,
			tools: this.convertToolsForOpenAI(metadata?.tools, strictToolSchemas),
			extraBody: this.extraBody,
			reasoningScope: responsesReasoningScope(this.client.baseURL),
		})

		// Bridge the external abort signal only after every throw-prone part of
		// request construction has run, so a construction failure cannot leak a
		// listener on the caller's long-lived signal.
		const { signal: abortSignal, dispose: removeExternalAbortListener } = bridgeExternalAbortSignal(
			metadata?.abortSignal,
		)

		try {
			const requestOptions = abortSignal ? { signal: abortSignal } : undefined
			if (body.stream) {
				const stream = await this.client.responses.create({ ...body, stream: true }, requestOptions)
				let completed = false
				yield* processResponsesApiStream(stream, createUsageNormalizer(), {
					onOutputItem: captureReasoning,
					onCompleted: (output) => {
						completed = true
						if (output) {
							reasoningItems.clear()
							output.forEach(captureReasoning)
						}
					},
				})
				if (!completed) throw new Error("Responses API stream ended before a completed response")
			} else {
				const response = await this.client.responses.create({ ...body, stream: false }, requestOptions)
				assertResponsesApiSuccess(response)
				for (const item of response.output) {
					captureReasoning(item)
					if (item.type === "message") {
						for (const content of item.content) {
							if (content.type === "output_text") yield { type: "text", text: content.text }
						}
					} else if (item.type === "function_call") {
						yield { type: "tool_call", id: item.call_id, name: item.name, arguments: item.arguments }
					} else if (item.type === "reasoning") {
						for (const summary of item.summary ?? []) yield { type: "reasoning", text: summary.text }
					}
				}
				const usage = createUsageNormalizer()(response.usage)
				if (usage) yield usage
			}
			this.responsesReasoning = [...reasoningItems.values()]
		} catch (error) {
			if (error instanceof OutputTokenLimitError) throw error
			if (isRequestAborted(error, abortSignal)) throw createAbortError(this.providerName)
			throw handleOpenAIError(error, this.providerName)
		} finally {
			removeExternalAbortListener()
		}
	}

	getReasoningDetails(): ScopedResponsesReasoningItem[] | undefined {
		if (!this.options.openAiUseResponsesApi || !this.responsesReasoning.length) return undefined
		const endpoint = responsesReasoningScope(this.client.baseURL)
		return structuredClone(this.responsesReasoning).map((item) => ({
			...item,
			format: "openai-responses-v1" as const,
			provider: providerIdentifiers.openai,
			endpoint,
		}))
	}

	getThoughtSignature(): string | undefined {
		return this.thoughtSignatureReader?.signature
	}

	getThoughtSignatureOrigin(): string | undefined {
		return this.signatureOrigin
	}

	protected processUsageMetrics(usage: OpenAiUsage, _modelInfo?: ModelInfo): ApiStreamUsageChunk {
		const inputTokens = usage?.prompt_tokens || 0
		const reportedCacheReadTokens = usage?.cache_read_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens
		const cacheReadTokens =
			typeof reportedCacheReadTokens === "number" &&
			Number.isFinite(reportedCacheReadTokens) &&
			Number.isInteger(reportedCacheReadTokens) &&
			reportedCacheReadTokens >= 0 &&
			// Proxy-specific counters may exclude cache reads from prompt_tokens.
			// Only OpenAI's nested cached_tokens must be a subset of prompt_tokens.
			(usage?.cache_read_input_tokens != null || reportedCacheReadTokens <= inputTokens)
				? reportedCacheReadTokens || undefined
				: undefined

		return {
			type: "usage",
			inputTokens,
			outputTokens: usage?.completion_tokens || 0,
			cacheWriteTokens: usage?.cache_creation_input_tokens || undefined,
			cacheReadTokens,
		}
	}

	// Single gate for everything that depends on the R1 request format: message
	// conversion in createMessage() and reasoning retention in getModel(). Both
	// must agree, otherwise reasoning is converted for the request but stripped
	// from the follow-up context (or vice versa).
	private usesR1Format(modelId: string): boolean {
		return modelId.includes("deepseek-reasoner") || (this.options.openAiR1FormatEnabled ?? false)
	}

	override getModel() {
		const id = this.options.openAiModelId ?? ""
		const info: ModelInfo = this.options.openAiCustomModelInfo ?? openAiModelInfoSaneDefaults
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			// OpenAI Compatible edits effort in custom model info. The shared top-level
			// setting may be left over from another provider and must not override it.
			settings: { ...this.options, reasoningEffort: info.reasoningEffort },
			defaultTemperature: 0,
		})
		// Local OpenAI-compatible reasoning models (llama.cpp, LM Studio, Ollama)
		// stream reasoning_content, but Zoo Code strips it from the follow-up context
		// unless info.preserveReasoning is set. Whenever createMessage() treats the
		// model as R1 (deepseek-reasoner id or the R1 format toggle), also treat it
		// as preserving reasoning so the chain is fed back.
		return {
			id,
			info: this.usesR1Format(id) ? { ...info, preserveReasoning: true } : info,
			...params,
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		try {
			if (this.options.openAiUseResponsesApi) {
				const model = this.getModel()
				const body = buildResponsesRequest({
					options: { ...this.options, openAiStreamingEnabled: false },
					modelInfo: model.info,
					reasoning: model.reasoning,
					systemPrompt: "",
					messages: [{ role: "user", content: prompt }],
					tools: undefined,
					extraBody: this.extraBody,
					reasoningScope: responsesReasoningScope(this.client.baseURL),
				})
				const response = await this.client.responses.create(
					{ ...body, stream: false },
					{
						...(options?.abortSignal ? { signal: options.abortSignal } : {}),
						...(hasUsableTimeout(options?.timeoutMs) ? { timeout: toSdkTimeoutMs(options.timeoutMs) } : {}),
					},
				)
				assertResponsesApiSuccess(response)
				return response.output
					.flatMap((item) =>
						item.type === "message"
							? item.content
									.filter((content) => content.type === "output_text")
									.map((content) => content.text)
							: [],
					)
					.join("")
			}
			const isAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
			const model = this.getModel()
			const modelInfo = model.info

			let requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: model.id,
				messages: [{ role: "user", content: prompt }],
				...model.reasoning,
			}

			// Add max_tokens if needed
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)
			requestOptions = this.withExtraBody(requestOptions)

			let response
			try {
				response = await this.client.chat.completions.create(
					requestOptions,
					isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {},
				)
			} catch (error) {
				throw handleOpenAIError(error, this.providerName)
			}

			return response.choices?.[0]?.message.content || ""
		} catch (error) {
			if (error instanceof OutputTokenLimitError) throw error
			if (isRequestAborted(error, options?.abortSignal)) throw createAbortError(this.providerName)
			if (error instanceof Error) {
				const wrapped = new Error(`${this.providerName} completion error: ${error.message}`, { cause: error })
				const source = error as Error & { status?: number; errorDetails?: unknown; code?: unknown }
				const target = wrapped as Error & { status?: number; errorDetails?: unknown; code?: unknown }
				if (source.status !== undefined) target.status = source.status
				if (source.errorDetails !== undefined) target.errorDetails = source.errorDetails
				if (source.code !== undefined) target.code = source.code
				throw wrapped
			}

			throw error
		}
	}

	private async *handleO3FamilyMessage(
		modelId: string,
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { info: modelInfo, reasoning } = this.getModel()
		const methodIsAzureAiInference = this._isAzureAiInference(this.options.openAiBaseUrl)
		// Stryker disable next-line LogicalOperator: equivalent. An unset option makes `&&`
		// yield undefined, which the parameter default in convertToolsForOpenAI turns back into
		// the same strict value as `??`.
		const strictToolSchemas = this.options.openAiStrictToolSchemas ?? DEFAULT_OPEN_AI_STRICT_TOOL_SCHEMAS

		if (this.options.openAiStreamingEnabled ?? true) {
			const isGrokXAI = this._isGrokXAI(this.options.openAiBaseUrl)

			let requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
				model: modelId,
				messages: [
					{
						role: "developer",
						content: sanitizeSurrogates(`Formatting re-enabled\n${systemPrompt}`),
					},
					...convertToOpenAiMessages(messages),
				],
				stream: true,
				...(isGrokXAI ? {} : { stream_options: { include_usage: true } }),
				...reasoning,
				temperature: undefined,
				// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)
				tools: this.convertToolsForOpenAI(metadata?.tools, strictToolSchemas),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			// O3 family models do not support the deprecated max_tokens parameter
			// but they do support max_completion_tokens (the modern OpenAI parameter)
			// This allows O3 models to limit response length when includeMaxTokens is enabled
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)
			requestOptions = this.withExtraBody(requestOptions)

			let stream
			try {
				stream = await this.client.chat.completions.create(requestOptions, {
					signal: metadata?.abortSignal,
					...(methodIsAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
				})
			} catch (error) {
				throw handleOpenAIError(error, this.providerName)
			}

			yield* this.handleStreamResponse(stream)
		} else {
			let requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
				model: modelId,
				messages: [
					{
						role: "developer",
						content: sanitizeSurrogates(`Formatting re-enabled\n${systemPrompt}`),
					},
					...convertToOpenAiMessages(messages),
				],
				...reasoning,
				temperature: undefined,
				// Tools are always present (minimum ALWAYS_AVAILABLE_TOOLS)
				tools: this.convertToolsForOpenAI(metadata?.tools, strictToolSchemas),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			// O3 family models do not support the deprecated max_tokens parameter
			// but they do support max_completion_tokens (the modern OpenAI parameter)
			// This allows O3 models to limit response length when includeMaxTokens is enabled
			this.addMaxTokensIfNeeded(requestOptions, modelInfo)
			requestOptions = this.withExtraBody(requestOptions)

			let response
			try {
				response = await this.client.chat.completions.create(requestOptions, {
					signal: metadata?.abortSignal,
					...(methodIsAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {}),
				})
			} catch (error) {
				throw handleOpenAIError(error, this.providerName)
			}

			const message = response.choices?.[0]?.message
			if (message?.tool_calls) {
				for (const toolCall of message.tool_calls) {
					if (toolCall.type === "function") {
						yield {
							type: "tool_call",
							id: toolCall.id,
							name: toolCall.function.name,
							arguments: toolCall.function.arguments,
						}
					}
				}
			}

			yield {
				type: "text",
				text: message?.content || "",
			}
			yield this.processUsageMetrics(response.usage)
		}
	}

	private async *handleStreamResponse(stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>): ApiStream {
		const activeToolCallIds = new Set<string>()

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			const finishReason = chunk.choices?.[0]?.finish_reason

			if (delta) {
				if (delta.content) {
					yield {
						type: "text",
						text: delta.content,
					}
				}

				yield* this.processToolCalls(delta, finishReason, activeToolCallIds)
			}

			if (chunk.usage) {
				yield this.processUsageMetrics(chunk.usage)
			}
		}
	}

	/**
	 * Helper generator to process tool calls from a stream chunk.
	 * Tracks active tool call IDs and yields tool_call_partial and tool_call_end events.
	 * @param delta - The delta object from the stream chunk
	 * @param finishReason - The finish_reason from the stream chunk
	 * @param activeToolCallIds - Set to track active tool call IDs (mutated in place)
	 */
	protected *processToolCalls(
		delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta | undefined,
		finishReason: string | null | undefined,
		activeToolCallIds: Set<string>,
	): Generator<
		| { type: "tool_call_partial"; index: number; id?: string; name?: string; arguments?: string }
		| { type: "tool_call_end"; id: string }
	> {
		if (delta?.tool_calls) {
			for (const toolCall of delta.tool_calls) {
				if (toolCall.id) {
					activeToolCallIds.add(toolCall.id)
				}
				yield {
					type: "tool_call_partial",
					index: toolCall.index,
					id: toolCall.id,
					name: toolCall.function?.name,
					arguments: toolCall.function?.arguments,
				}
			}
		}

		// Emit tool_call_end events when finish_reason is "tool_calls"
		// This ensures tool calls are finalized even if the stream doesn't properly close
		if (finishReason === "tool_calls" && activeToolCallIds.size > 0) {
			for (const id of activeToolCallIds) {
				yield { type: "tool_call_end", id }
			}
			activeToolCallIds.clear()
		}
	}

	protected _getUrlHost(baseUrl?: string): string {
		try {
			return new URL(baseUrl ?? "").hostname
		} catch {
			return ""
		}
	}

	private _isGrokXAI(baseUrl?: string): boolean {
		const urlHost = this._getUrlHost(baseUrl)
		return urlHost === "api.x.ai" || urlHost.endsWith(".x.ai")
	}

	protected _isAzureAiInference(baseUrl?: string): boolean {
		return isAzureAiInferenceBaseUrl(baseUrl) && !isAzureV1BaseUrl(baseUrl)
	}

	/**
	 * Adds max_completion_tokens to the request body if needed based on provider configuration
	 * Note: max_tokens is deprecated in favor of max_completion_tokens as per OpenAI documentation
	 * O3 family models handle max_tokens separately in handleO3FamilyMessage
	 */
	protected addMaxTokensIfNeeded(
		requestOptions:
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
		modelInfo: ModelInfo,
	): void {
		// Only an explicit includeMaxTokens: false opts out; unset follows the checkbox default.
		// Using max_completion_tokens as max_tokens is deprecated
		const maxTokens = resolveOpenAiCompatibleMaxTokens(this.options, modelInfo)
		if (maxTokens !== undefined) {
			requestOptions.max_completion_tokens = maxTokens
		}
	}

	private withExtraBody<T extends object>(requestOptions: T): T {
		return { ...this.extraBody, ...requestOptions }
	}
}

export async function getOpenAiModels(baseUrl?: string, apiKey?: string, openAiHeaders?: Record<string, string>) {
	try {
		if (!baseUrl) {
			return []
		}

		// Trim whitespace from baseUrl to handle cases where users accidentally include spaces
		const trimmedBaseUrl = baseUrl.trim()

		if (!URL.canParse(trimmedBaseUrl)) {
			return []
		}

		const config: Record<string, any> = {}
		const headers: Record<string, string> = {
			...DEFAULT_HEADERS,
			...(openAiHeaders || {}),
		}

		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		if (Object.keys(headers).length > 0) {
			config["headers"] = headers
		}

		const response = await axios.get(`${trimmedBaseUrl}/models`, config)
		const modelsArray = response.data?.data?.map((model: any) => model.id) || []
		return [...new Set<string>(modelsArray)]
	} catch {
		return []
	}
}
