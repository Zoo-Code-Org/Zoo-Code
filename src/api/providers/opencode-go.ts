import { v7 as uuidv7 } from "uuid"
import { Anthropic, APIConnectionTimeoutError as AnthropicTimeoutError } from "@anthropic-ai/sdk"
import { CacheControlEphemeral } from "@anthropic-ai/sdk/resources"
import OpenAI, { APIConnectionTimeoutError } from "openai"

import {
	type ModelInfo,
	type ModelRecord,
	type ReasoningEffortExtended,
	opencodeGoDefaultModelId,
	opencodeGoDefaultModelInfo,
	OPENCODE_GO_DEFAULT_TEMPERATURE,
	isOpencodeGoAnthropicFormatModel,
	isOpencodeGoResponsesFormatModel,
	opencodeGoResponsesSupportsTemperature,
	providerIdentifiers,
} from "@roo-code/types"

import { ApiHandlerOptions, GetModelsOptions } from "../../shared/api"

import { ApiStream, type ApiStreamUsageChunk } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToR1Format } from "../transform/r1-format"
import { filterNonAnthropicBlocks } from "../transform/anthropic-filter"
import { getModelParams } from "../transform/model-params"
import { convertToResponsesApiInput } from "../transform/responses-api-input"
import { processResponsesApiStream } from "../transform/responses-api-stream"

import type {
	SingleCompletionHandler,
	ApiHandlerCreateMessageMetadata,
	CompletePromptOptions,
	ModelCacheScope,
} from "../index"
import { RouterProvider } from "./router-provider"
import { getOpencodeGoModels } from "./fetchers/opencode-go"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"
import { DEFAULT_HEADERS } from "./constants"
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../shared/cost"
import {
	convertOpenAIToolsToAnthropic,
	convertOpenAIToolChoiceToAnthropic,
} from "../../core/prompts/tools/native-tools/converters"
import {
	bridgeExternalAbortSignal,
	createAbortError,
	hasUsableTimeout,
	isRequestAborted,
	mergeAbortSignalAndTimeout,
	resolveModelWithAbort,
	toSdkTimeoutMs,
} from "./utils/abort-signal"

/**
 * The wire formats exposed by the Opencode Go gateway:
 *
 *   - `anthropic` — Anthropic Messages (`/v1/messages`)
 *   - `responses` — OpenAI Responses (`/v1/responses`)
 *   - `openai` — OpenAI Chat Completions (`/v1/chat/completions`, the default)
 */
type OpencodeGoFormat = "anthropic" | "openai" | "responses"

/**
 * API handler for the Opencode "Go" subscription plan.
 *
 * Routes requests through the OpenAI-compatible gateway at
 * `https://opencode.ai/zen/go/v1`, delegating model resolution and streaming
 * logic to the shared {@link RouterProvider} base class.
 *
 * Exposes the Go subscription's models as a first-class provider with a dynamic
 * model list (fetched from `/v1/models`) so users can switch models on the fly,
 * instead of configuring each one manually as a separate OpenAI-Compatible
 * provider (#172).
 *
 * Model metadata (context window, max tokens, capability flags, and pricing)
 * is sourced from the native registry in `@roo-code/types` and merged with the
 * live `/models` payload, so each curated model keeps its correct native
 * configuration — including `supportsReasoningEffort`, `preserveReasoning`,
 * `supportsMaxTokens`, and prompt-cache support — instead of falling back to a
 * single generic default.
 *
 * ## Wire-format routing
 *
 * The Go gateway exposes three wire formats and maps every model to exactly
 * one of them (see https://opencode.ai/docs/go):
 *
 *   - OpenAI-compatible chat completions (`/v1/chat/completions`, "oa-compat")
 *     — used by GLM, Kimi, DeepSeek, and MiMo models.
 *   - Anthropic Messages (`/v1/messages`) — used by Qwen (qwen3.8-max,
 *     qwen3.7-max, qwen3.7-plus, qwen3.6-plus) and MiniMax (minimax-m3,
 *     minimax-m2.7, minimax-m2.5) models.
 *   - OpenAI Responses (`/v1/responses`) — used by the models in
 *     `OPENCODE_GO_RESPONSES_FORMAT_MODELS` (GPT Luna, Grok, and Muse Spark),
 *     whose chat-completions adapters are not supported by the Go gateway.
 *
 * Sending an Anthropic-format model to the chat completions endpoint is
 * rejected with `401 Model <id> is not supported for format oa-compat`, so this
 * handler inspects {@link isOpencodeGoAnthropicFormatModel} and routes those
 * models through a dedicated Anthropic SDK client against `/v1/messages`.
 * Responses-format models are identified via
 * {@link isOpencodeGoResponsesFormatModel} and routed through the shared OpenAI
 * client's `responses` endpoint; there is deliberately no chat-completions
 * fallback for them.
 *
 * Supports text generation, reasoning content (GLM/DeepSeek), tool calls,
 * and non-streaming prompt completion.
 */
export class OpencodeGoHandler extends RouterProvider implements SingleCompletionHandler {
	/**
	 * Anthropic SDK client used for Go models that only accept the Anthropic
	 * Messages wire format (`/v1/messages`).
	 *
	 * The SDK appends `/v1/messages` to `baseURL`, so this is set to the Go
	 * gateway root (`https://opencode.ai/zen/go`) — NOT the `/v1` root used by
	 * the OpenAI client — to avoid a doubled `/v1` path segment.
	 */
	private readonly anthropicClient: Anthropic

	/**
	 * Stable per-handler session ID sent as `x-opencode-session` when no
	 * `metadata.taskId` is available, so every request carries operator-side
	 * session affinity (mirrors the OpenAiNativeHandler fallback pattern).
	 */
	private readonly sessionId: string

	/** Creates a new handler bound to the user's Go API key and selected model. */
	constructor(options: ApiHandlerOptions) {
		super({
			options,
			name: providerIdentifiers.opencodeGo,
			baseURL: "https://opencode.ai/zen/go/v1",
			apiKey: options.opencodeGoApiKey,
			modelId: options.opencodeGoModelId,
			defaultModelId: opencodeGoDefaultModelId,
			defaultModelInfo: opencodeGoDefaultModelInfo,
		})

		this.sessionId = uuidv7()

		this.anthropicClient = new Anthropic({
			baseURL: "https://opencode.ai/zen/go",
			apiKey: options.opencodeGoApiKey,
			defaultHeaders: {
				...DEFAULT_HEADERS,
				...(options.openAiHeaders || {}),
				// completePrompt has no taskId metadata, so the per-handler
				// session id provides operator-side session affinity here;
				// streaming requests override it with taskId when available.
				"x-opencode-session": this.sessionId,
			},
		})
	}

	override getModelCacheScope(): ModelCacheScope {
		return { urlScoped: false, keyScoped: false, authScoped: false }
	}

	async fetchModels(options: GetModelsOptions, signal?: AbortSignal): Promise<ModelRecord> {
		const fetchOpts: [] | [{ signal: AbortSignal }] = signal ? [{ signal }] : []
		return getOpencodeGoModels(options.apiKey, ...fetchOpts)
	}

	/**
	 * Resolves the configured model and computes model parameters
	 * (max tokens, temperature, reasoning effort) from the merged model info.
	 *
	 * The wire format is derived from the model ID via the format registries in
	 * `@roo-code/types`: Anthropic-format models
	 * ({@link isOpencodeGoAnthropicFormatModel}) compute parameters with the
	 * `anthropic` format so reasoning is mapped to the Anthropic-style controls;
	 * Responses-format models ({@link isOpencodeGoResponsesFormatModel}) and
	 * everything else use the `openai` format, whose `reasoningEffort` maps to
	 * `reasoning.effort` on the Responses wire and `reasoning_effort` on Chat
	 * Completions.
	 *
	 * Fetches the live model list first so the merged native + `/models`
	 * metadata (context window, capability flags, pricing) is available before
	 * parameter computation — mirroring the original `fetchModel()` flow.
	 */
	private async resolveModel() {
		const { id, info } = await this.fetchModel()
		// Resolution order: Anthropic Messages → OpenAI Responses → OpenAI Chat
		// Completions (default). Unknown model IDs keep the Chat Completions
		// fallback, matching the gateway's default routing.
		const format: OpencodeGoFormat = isOpencodeGoAnthropicFormatModel(id)
			? "anthropic"
			: isOpencodeGoResponsesFormatModel(id)
				? "responses"
				: "openai"
		// getModelParams is overloaded on a literal `format`, so branch the call
		// rather than passing a union — this keeps the returned params typed as a
		// single concrete shape per branch. Responses-format models share the
		// `openai` parameter computation with Chat Completions.
		const params =
			format === "anthropic"
				? getModelParams({
						format: "anthropic",
						modelId: id,
						model: info,
						settings: this.options,
						defaultTemperature: OPENCODE_GO_DEFAULT_TEMPERATURE,
					})
				: getModelParams({
						format: "openai",
						modelId: id,
						model: info,
						settings: this.options,
						defaultTemperature: OPENCODE_GO_DEFAULT_TEMPERATURE,
					})
		return {
			id,
			info,
			format,
			maxTokens: params.maxTokens,
			temperature: params.temperature,
			reasoningEffort: params.reasoningEffort,
		}
	}

	/**
	 * Streams a chat completion response, yielding typed chunks for text,
	 * reasoning, partial tool calls, and token usage.
	 *
	 * Anthropic-format models (Qwen/MiniMax) are streamed via
	 * {@link streamAnthropicMessage} against `/v1/messages`; Responses-format
	 * models ({@link isOpencodeGoResponsesFormatModel}) are streamed via
	 * {@link streamResponsesMessage} against `/v1/responses`; all other models
	 * use the OpenAI-compatible chat completions endpoint.
	 *
	 * For OpenAI-format models that require reasoning_content to be passed back
	 * during multi-turn tool calls (`preserveReasoning`), messages are
	 * converted with `convertToR1Format` so interleaved thinking is preserved
	 * across tool-call continuations. Reasoning effort is forwarded when the
	 * model advertises `supportsReasoningEffort`.
	 */
	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Establish the cancellation scope around model resolution: a
		// pre-aborted signal rejects before the lookup starts, and a signal
		// that fires while model metadata is loading settles on the
		// standardized AbortError; any other resolution failure propagates
		// unchanged.
		const externalAbortSignal = metadata?.abortSignal
		const resolved = await resolveModelWithAbort(() => this.resolveModel(), externalAbortSignal, "Opencode Go")
		const { id: modelId, info, format, temperature, reasoningEffort, maxTokens } = resolved

		// Per-request signal bridged from the caller's abort signal via the shared helper
		// (pre-aborted guard, once-only listener, retained cleanup): the request-local
		// signal is always defined for the streaming helpers, and dispose() detaches the
		// listener when the request ends instead of leaking one per completed request.
		const { signal: bridgedSignal, dispose: detachExternalAbortSignal } =
			bridgeExternalAbortSignal(externalAbortSignal)
		// The streaming helpers always forward a signal: keep the never-aborting fallback the
		// previous inline controller provided when the caller has no external signal.
		const requestSignal = bridgedSignal ?? new AbortController().signal

		if (format === "anthropic") {
			try {
				yield* this.streamAnthropicMessage(
					modelId,
					info,
					temperature,
					maxTokens,
					systemPrompt,
					messages,
					requestSignal,
					metadata,
				)
			} catch (error) {
				// Preserve abort identity (series standard): a cancellation that
				// surfaces mid-stream must normalize to the provider AbortError,
				// matching the OpenAI streaming branch.
				if (isRequestAborted(error, requestSignal)) {
					throw createAbortError("Opencode Go")
				}
				throw error
			} finally {
				detachExternalAbortSignal()
			}
			return
		}

		if (format === "responses") {
			try {
				yield* this.streamResponsesMessage(
					modelId,
					info,
					maxTokens,
					reasoningEffort,
					systemPrompt,
					messages,
					requestSignal,
					metadata,
				)
			} catch (error) {
				// Preserve abort identity (series standard): a cancellation that
				// surfaces mid-stream must normalize to the provider AbortError,
				// matching the OpenAI streaming branch.
				if (isRequestAborted(error, requestSignal)) {
					throw createAbortError("Opencode Go")
				}
				throw error
			} finally {
				detachExternalAbortSignal()
			}

			return
		}

		// preserveReasoning models (GLM/DeepSeek/MiMo/MiniMax/Qwen) require
		// reasoning_content to be carried across tool-call continuations.
		// The conversion and request construction run inside the cleanup
		// scope, like the Anthropic and Responses branches: a conversion
		// failure (e.g. an unstringifiable tool input) still detaches the
		// bridged abort listener.
		try {
			const preserveReasoning = info.preserveReasoning === true
			const convertedMessages = preserveReasoning
				? convertToR1Format(messages, { mergeToolResultText: true })
				: convertToOpenAiMessages(messages)

			const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
				{ role: "system", content: systemPrompt },
				...convertedMessages,
			]

			const body: OpenAI.Chat.ChatCompletionCreateParams = {
				model: modelId,
				messages: openAiMessages,
				temperature: this.supportsTemperature(modelId) ? temperature : undefined,
				max_completion_tokens:
					this.options.includeMaxTokens === true ? this.options.modelMaxTokens || maxTokens : maxTokens,
				stream: true,
				stream_options: { include_usage: true },
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
				...(reasoningEffort && {
					reasoning_effort: reasoningEffort as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"],
				}),
			}

			const completion = await this.client.chat.completions.create(body, {
				signal: requestSignal,
				headers: { "x-opencode-session": metadata?.taskId ?? this.sessionId },
			})

			for await (const chunk of completion) {
				const delta = chunk.choices[0]?.delta

				// Several Go-plan models (GLM, DeepSeek) stream reasoning via this field.
				const reasoningText = extractReasoningFromDelta(delta)
				if (reasoningText) {
					yield { type: "reasoning", text: reasoningText }
				}

				if (delta?.content) {
					yield { type: "text", text: delta.content }
				}

				// Emit raw tool call chunks - NativeToolCallParser handles state management.
				if (delta?.tool_calls) {
					for (const toolCall of delta.tool_calls) {
						yield {
							type: "tool_call_partial",
							index: toolCall.index,
							id: toolCall.id,
							name: toolCall.function?.name,
							arguments: toolCall.function?.arguments,
						}
					}
				}

				if (chunk.usage) {
					yield {
						type: "usage",
						inputTokens: chunk.usage.prompt_tokens || 0,
						outputTokens: chunk.usage.completion_tokens || 0,
						cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens || undefined,
					}
				}
			}
		} catch (error) {
			// Preserve abort identity (series standard): surface a cancelled
			// request as a DOM-standard AbortError rather than leaking the
			// raw SDK abort error.
			if (isRequestAborted(error, requestSignal)) {
				throw createAbortError("Opencode Go")
			}
			throw error
		} finally {
			detachExternalAbortSignal()
		}
	}

	/**
	 * Returns the `temperature` field for a Responses request, or an empty
	 * object to omit it.
	 *
	 * Temperature is sent only when the user has set a custom value and the
	 * model accepts it for the effective reasoning effort
	 * ({@link opencodeGoResponsesSupportsTemperature}). The provider default is
	 * never sent, which keeps the gateway's own default when no custom value
	 * is set. A saved value for an unsupported configuration is kept in
	 * settings but not sent (Zoo-Code-Org/Zoo-Code#2055).
	 */
	private getResponsesTemperature(
		modelId: string,
		reasoningEffort: ReasoningEffortExtended | undefined,
	): { temperature?: number } {
		const temperature = this.options.modelTemperature
		return typeof temperature === "number" && opencodeGoResponsesSupportsTemperature(modelId, reasoningEffort)
			? { temperature }
			: {}
	}

	/**
	 * Streams an OpenAI Responses-format completion for Go models that only
	 * accept the `/v1/responses` endpoint
	 * ({@link isOpencodeGoResponsesFormatModel}).
	 *
	 * Follows the focused xAI handler pattern: the conversation is converted
	 * with the shared {@link convertToResponsesApiInput} transform, the system
	 * prompt is sent as top-level `instructions`, reasoning effort maps to
	 * `reasoning.effort`, and the event stream is processed by the shared
	 * {@link processResponsesApiStream} transform with cost computed via
	 * {@link calculateApiCostOpenAI}.
	 *
	 * There is deliberately no fallback to `/v1/chat/completions`: the
	 * gateway's chat-completions adapter for these models fails with an opaque
	 * HTTP 500 (Zoo-Code-Org/Zoo-Code#1431), so failures are surfaced as-is
	 * with the same `Opencode Go completion error:` prefix used by the other
	 * wire formats.
	 */
	private async *streamResponsesMessage(
		modelId: string,
		info: ModelInfo,
		maxTokens: number | undefined,
		reasoningEffort: ReasoningEffortExtended | undefined,
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		abortSignal: AbortSignal | undefined,
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const input = convertToResponsesApiInput(messages)

		// convertToolsForOpenAI returns Chat Completions-shaped tools
		// (`{ type: "function", function: { name, ... } }`); the Responses API
		// expects the function fields flattened onto the tool object.
		const responseTools = (this.convertToolsForOpenAI(metadata?.tools) ?? []).filter(
			(tool) => tool?.type === "function" && typeof tool.function?.name === "string",
		)

		// Map the Chat Completions tool_choice shape to the Responses shape:
		// string options pass through; named function choices flatten
		// `{ function: { name } }` to `{ name }`.
		const toolChoice = metadata?.tool_choice
		const responsesToolChoice: OpenAI.Responses.ResponseCreateParamsStreaming["tool_choice"] =
			typeof toolChoice === "string"
				? toolChoice
				: toolChoice?.type === "function"
					? { type: "function", name: toolChoice.function.name }
					: "auto"

		const requestBody: OpenAI.Responses.ResponseCreateParamsStreaming = {
			model: modelId,
			instructions: systemPrompt,
			input,
			stream: true,
			store: false,
			// The gateway accepts extended effort values ("none"/"xhigh"/"max")
			// that postdate the SDK's narrower ReasoningEffort union; the wire
			// value is a plain string, so this cast is safe.
			...(reasoningEffort
				? {
						reasoning: {
							effort: reasoningEffort,
						} as OpenAI.Responses.ResponseCreateParamsStreaming["reasoning"],
					}
				: {}),
			...this.getResponsesTemperature(modelId, reasoningEffort),
			// Honour the same includeMaxTokens/modelMaxTokens override logic as
			// the chat-completions and Anthropic streaming paths.
			...(maxTokens !== undefined
				? {
						max_output_tokens:
							this.options.includeMaxTokens === true
								? this.options.modelMaxTokens || maxTokens
								: maxTokens,
					}
				: {}),
			...(responseTools.length
				? {
						tools: responseTools.map((tool) => ({
							type: "function",
							name: tool.function.name,
							description: tool.function.description,
							parameters: tool.function.parameters,
							strict: tool.function.strict,
						})),
						tool_choice: responsesToolChoice,
						parallel_tool_calls: metadata?.parallelToolCalls ?? true,
					}
				: {}),
		}

		// Wrap pre-stream errors with the same "Opencode Go completion error:"
		// prefix used by completePrompt so the Responses-format path surfaces
		// failures consistently. Abort identity is preserved first (series
		// standard): a cancelled request must surface as a DOM-standard
		// AbortError, not a wrapped completion error. Mid-stream errors
		// propagate unchanged, matching the other streaming paths.
		let stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
		try {
			stream = await this.client.responses.create(requestBody, {
				signal: abortSignal,
				headers: { "x-opencode-session": metadata?.taskId ?? this.sessionId },
			})
		} catch (error) {
			// isRequestAborted covers the signal-aborted case plus the OpenAI
			// SDK's APIUserAbortError (name "APIUserAbortError" / "Request was
			// aborted.").
			if (isRequestAborted(error, abortSignal)) {
				throw createAbortError("Opencode Go")
			}
			if (error instanceof Error) {
				throw new Error(`Opencode Go completion error: ${error.message}`)
			}
			throw error
		}

		// Normalize the Responses usage payload locally so all reported token
		// categories, including cache writes, are passed to the cost calculator.
		const normalizeUsage = (usage: unknown): ApiStreamUsageChunk | undefined => {
			if (!usage) return undefined
			const data = usage as {
				input_tokens_details?: { cached_tokens?: number }
				prompt_tokens_details?: { cached_tokens?: number }
				input_tokens?: number
				output_tokens?: number
				cache_creation_input_tokens?: number
				cache_write_tokens?: number
				cache_read_input_tokens?: number
			}
			const inputTokens = data.input_tokens ?? 0
			const outputTokens = data.output_tokens ?? 0
			const cacheWriteTokens = data.cache_creation_input_tokens ?? data.cache_write_tokens ?? 0
			const inputDetails = data.input_tokens_details ?? data.prompt_tokens_details
			const cacheReadTokens = data.cache_read_input_tokens ?? inputDetails?.cached_tokens ?? 0
			const reasoningTokens = (usage as { output_tokens_details?: { reasoning_tokens?: number } })
				.output_tokens_details?.reasoning_tokens
			return {
				type: "usage",
				inputTokens,
				outputTokens,
				cacheWriteTokens,
				cacheReadTokens,
				...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
				totalCost: calculateApiCostOpenAI(info, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
					.totalCost,
			}
		}

		// Capture the iterator handle. If the consumer exits early (e.g., via a timeout
		// or cancellation), we must explicitly close this specific instance to release
		// the open HTTP connection and stop the provider from generating.
		const streamIterator = stream[Symbol.asyncIterator]()

		try {
			// Pass the captured iterator to ensure early cancellation triggers the finally block.
			yield* processResponsesApiStream({ [Symbol.asyncIterator]: () => streamIterator }, normalizeUsage)
		} finally {
			try {
				// Explicitly close the iterator to drop the connection and halt work.
				await streamIterator.return?.()
			} catch {
				// Swallow cleanup errors so they do not mask the primary stream or runtime error.
			}
		}
	}

	/**
	 * Streams an Anthropic Messages-format completion for Go models that only
	 * accept the `/v1/messages` endpoint (Qwen/MiniMax).
	 *
	 * Mirrors the Anthropic streaming protocol handled by the dedicated
	 * MiniMax handler: `message_start`/`message_delta` carry usage, content
	 * blocks carry text/thinking/tool_use, and a final cost chunk is emitted
	 * from the accumulated token counts. Prompt-cache breakpoints are applied
	 * to the system prompt and last two user messages when the model advertises
	 * `supportsPromptCache`, since the Go gateway honours server-side caching
	 * and reports cache tokens in usage.
	 */
	private async *streamAnthropicMessage(
		modelId: string,
		info: ModelInfo,
		temperature: number | undefined,
		maxTokens: number | undefined,
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		abortSignal: AbortSignal | undefined,
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const cacheControl: CacheControlEphemeral = { type: "ephemeral" }
		const supportsPromptCache = info.supportsPromptCache ?? false

		// Strip non-Anthropic blocks (reasoning, thoughtSignature, etc.) before
		// sending — the gateway rejects unknown content block types.
		const sanitizedMessages = filterNonAnthropicBlocks(messages)

		const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
			supportsPromptCache
				? { text: systemPrompt, type: "text", cache_control: cacheControl }
				: { text: systemPrompt, type: "text" },
		]

		// Only attach tools/tool_choice when the caller actually provides
		// tools — sending an empty tool list (or a tool_choice derived from an
		// empty set) forces some Anthropic-compatible gateways into a
		// tool-use-only mode and is wasteful for plain text turns.
		const tools = metadata?.tools && metadata.tools.length > 0 ? metadata.tools : undefined

		const requestParams: Anthropic.Messages.MessageCreateParams = {
			model: modelId,
			max_tokens:
				this.options.includeMaxTokens === true
					? this.options.modelMaxTokens || maxTokens || 16_384
					: (maxTokens ?? 16_384),
			temperature: this.supportsTemperature(modelId) ? (temperature ?? 1.0) : undefined,
			system: systemBlocks,
			messages: supportsPromptCache
				? this.addAnthropicCacheControl(sanitizedMessages, cacheControl)
				: sanitizedMessages,
			stream: true,
			...(tools
				? {
						tools: convertOpenAIToolsToAnthropic(tools),
						tool_choice: convertOpenAIToolChoiceToAnthropic(
							metadata?.tool_choice,
							metadata?.parallelToolCalls,
						),
					}
				: {}),
		}

		// Wrap pre-stream errors (401, 429, network) with the same
		// "Opencode Go completion error:" prefix used by completePrompt so the
		// Anthropic-format path surfaces failures consistently. Mid-stream
		// errors propagate unchanged, matching the OpenAI streaming path.
		let stream
		try {
			stream = await this.anthropicClient.messages.create(requestParams, {
				signal: abortSignal,
				headers: { "x-opencode-session": metadata?.taskId ?? this.sessionId },
			})
		} catch (error) {
			// Preserve abort identity (series standard): a cancelled request
			// must surface as a DOM-standard AbortError, not a wrapped
			// completion error. isRequestAborted also covers the Anthropic
			// SDK's APIUserAbortError (name "APIUserAbortError").
			if (isRequestAborted(error, abortSignal)) {
				throw createAbortError("Opencode Go")
			}
			if (error instanceof Error) {
				throw new Error(`Opencode Go completion error: ${error.message}`)
			}
			throw error
		}

		let inputTokens = 0
		let outputTokens = 0
		let cacheWriteTokens = 0
		let cacheReadTokens = 0

		for await (const chunk of stream) {
			switch (chunk.type) {
				case "message_start": {
					// Tells us cache reads/writes/input/output.
					const {
						input_tokens = 0,
						output_tokens = 0,
						cache_creation_input_tokens,
						cache_read_input_tokens,
					} = chunk.message.usage

					yield {
						type: "usage",
						inputTokens: input_tokens,
						outputTokens: output_tokens,
						cacheWriteTokens: cache_creation_input_tokens || undefined,
						cacheReadTokens: cache_read_input_tokens || undefined,
					}

					inputTokens += input_tokens
					outputTokens += output_tokens
					cacheWriteTokens += cache_creation_input_tokens || 0
					cacheReadTokens += cache_read_input_tokens || 0

					break
				}
				case "message_delta":
					// Tells us stop_reason, stop_sequence, and output tokens.
					// Anthropic streams the cumulative output token count in each
					// message_delta (the final event carries the total), so
					// accumulate it into the running total used for cost
					// calculation — otherwise the final cost only reflects the
					// (typically zero) message_start output tokens.
					outputTokens += chunk.usage.output_tokens || 0
					yield {
						type: "usage",
						inputTokens: 0,
						outputTokens: chunk.usage.output_tokens || 0,
					}

					break
				case "message_stop":
					// No usage data, just an indicator that the message is done.
					break
				case "content_block_start":
					switch (chunk.content_block.type) {
						case "thinking":
							// Yield thinking/reasoning content
							if (chunk.index > 0) {
								yield { type: "reasoning", text: "\n" }
							}

							yield { type: "reasoning", text: chunk.content_block.thinking }
							break
						case "text":
							// We may receive multiple text blocks
							if (chunk.index > 0) {
								yield { type: "text", text: "\n" }
							}

							yield { type: "text", text: chunk.content_block.text }
							break
						case "tool_use": {
							// Emit initial tool call partial with id and name
							yield {
								type: "tool_call_partial",
								index: chunk.index,
								id: chunk.content_block.id,
								name: chunk.content_block.name,
								arguments: undefined,
							}
							break
						}
					}
					break
				case "content_block_delta":
					switch (chunk.delta.type) {
						case "thinking_delta":
							yield { type: "reasoning", text: chunk.delta.thinking }
							break
						case "text_delta":
							yield { type: "text", text: chunk.delta.text }
							break
						case "input_json_delta": {
							// Emit tool call partial chunks as arguments stream in
							yield {
								type: "tool_call_partial",
								index: chunk.index,
								id: undefined,
								name: undefined,
								arguments: chunk.delta.partial_json,
							}
							break
						}
					}

					break
				case "content_block_stop":
					// Block is complete - no action needed, NativeToolCallParser handles completion
					break
			}
		}

		// Calculate and yield final cost
		if (inputTokens > 0 || outputTokens > 0 || cacheWriteTokens > 0 || cacheReadTokens > 0) {
			const { totalCost } = calculateApiCostAnthropic(
				info,
				inputTokens,
				outputTokens,
				cacheWriteTokens,
				cacheReadTokens,
			)

			yield {
				type: "usage",
				inputTokens: 0,
				outputTokens: 0,
				totalCost,
			}
		}
	}

	/**
	 * Adds ephemeral cache-control breakpoints to the last two user messages
	 * so the gateway can cache the system prompt + most recent turns
	 * server-side. Only applied when the model advertises prompt-cache support.
	 */
	private addAnthropicCacheControl(
		messages: Anthropic.Messages.MessageParam[],
		cacheControl: CacheControlEphemeral,
	): Anthropic.Messages.MessageParam[] {
		const userMsgIndices = messages.reduce(
			(acc, msg, index) => (msg.role === "user" ? [...acc, index] : acc),
			[] as number[],
		)

		const lastUserMsgIndex = userMsgIndices[userMsgIndices.length - 1] ?? -1
		const secondLastUserMsgIndex = userMsgIndices[userMsgIndices.length - 2] ?? -1

		return messages.map((message, index) => {
			if (index === lastUserMsgIndex || index === secondLastUserMsgIndex) {
				return {
					...message,
					content:
						typeof message.content === "string"
							? [{ type: "text", text: message.content, cache_control: cacheControl }]
							: message.content.map((content, contentIndex) =>
									contentIndex === message.content.length - 1
										? { ...content, cache_control: cacheControl }
										: content,
								),
				}
			}
			return message
		})
	}

	/**
	 * Performs a non-streaming chat completion and returns the full response text.
	 *
	 * Anthropic-format models are completed via the `/v1/messages` endpoint;
	 * Responses-format models via `/v1/responses`; all other
	 * models use the OpenAI-compatible chat completions endpoint.
	 *
	 * @param prompt - The user prompt to send as a single user message.
	 * @returns The model's reply text, or an empty string if no content is returned.
	 * @throws Error with an Opencode Go-specific prefix if the request fails.
	 */
	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		// Establish the cancellation scope around model resolution, matching
		// createMessage: a pre-aborted signal rejects before the /models lookup
		// starts, a signal that fires mid-lookup settles on the standardized
		// AbortError instead of the raw lookup failure, and the caller's per-request
		// timeout bounds this phase too (merged deadline passed to the resolver).
		const resolutionAbortSignal = mergeAbortSignalAndTimeout(options?.abortSignal, options?.timeoutMs)
		const {
			id: modelId,
			format,
			temperature,
			reasoningEffort,
			maxTokens,
		} = await resolveModelWithAbort(() => this.resolveModel(), resolutionAbortSignal, "Opencode Go")
		const timeoutMs = options?.timeoutMs

		if (format === "anthropic") {
			try {
				// Build request options with abortSignal and/or timeout handling.
				// hasUsableTimeout/toSdkTimeoutMs own the non-positive and non-finite
				// semantics: the SDKs treat timeout: 0 as an immediate abort and
				// throw on negative/non-finite values, so only a usable budget is
				// forwarded.
				const requestOptions: Anthropic.RequestOptions = {
					...(resolutionAbortSignal && { signal: resolutionAbortSignal }),
				}
				if (hasUsableTimeout(timeoutMs)) {
					requestOptions.timeout = toSdkTimeoutMs(timeoutMs)
				}

				const message = await this.anthropicClient.messages.create(
					{
						model: modelId,
						// Honour the same includeMaxTokens/modelMaxTokens override
						// logic as the streaming path so non-streaming completions
						// respect the user's max-output slider instead of always
						// falling back to the model default.
						max_tokens:
							this.options.includeMaxTokens === true
								? this.options.modelMaxTokens || maxTokens || 16_384
								: (maxTokens ?? 16_384),
						temperature: this.supportsTemperature(modelId) ? (temperature ?? 1.0) : undefined,
						messages: [{ role: "user", content: prompt }],
						stream: false,
					},
					Object.keys(requestOptions).length > 0 ? requestOptions : undefined,
				)

				const content = message.content.find(({ type }) => type === "text")
				return content?.type === "text" ? content.text : ""
			} catch (error) {
				// Preserve abort identity (series standard): caller-initiated
				// cancellations and request timeouts must surface as a
				// DOM-standard AbortError, not a wrapped completion error. The
				// Anthropic SDK reports both with messages ending in a period
				// ("Request was aborted.", "Request timed out."), which would not
				// match task-level abort detection (message ending in "aborted").
				// isRequestAborted covers the caller's signal plus the SDK abort
				// names/messages (AbortError, APIUserAbortError); the Anthropic
				// SDK timeout keeps its series-standard abort identity.
				if (isRequestAborted(error, options?.abortSignal) || error instanceof AnthropicTimeoutError) {
					throw createAbortError("Opencode Go")
				}
				if (error instanceof Error) {
					throw new Error(`Opencode Go completion error: ${error.message}`)
				}
				throw error
			}
		}

		if (format === "responses") {
			try {
				// Build request options with abortSignal and/or timeout (series
				// standard): hasUsableTimeout/toSdkTimeoutMs own the disabled and
				// non-finite semantics, so the SDK option is only set for a usable
				// budget.
				const createOptions: OpenAI.RequestOptions = {
					...(resolutionAbortSignal && { signal: resolutionAbortSignal }),
				}
				if (hasUsableTimeout(timeoutMs)) {
					createOptions.timeout = toSdkTimeoutMs(timeoutMs)
				}

				const response = await this.client.responses.create(
					{
						model: modelId,
						input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
						store: false,
						...this.getResponsesTemperature(modelId, reasoningEffort),
						// Honour the same includeMaxTokens/modelMaxTokens override
						// logic as the chat-completions path.
						...(maxTokens !== undefined
							? {
									max_output_tokens:
										this.options.includeMaxTokens === true
											? this.options.modelMaxTokens || maxTokens
											: maxTokens,
								}
							: {}),
						// The gateway accepts extended effort values ("none"/"xhigh"/
						// "max") that postdate the SDK's narrower ReasoningEffort
						// union; the wire value is a plain string, so this cast is safe.
						...(reasoningEffort
							? {
									reasoning: {
										effort: reasoningEffort,
									} as OpenAI.Responses.ResponseCreateParamsNonStreaming["reasoning"],
								}
							: {}),
					},
					{ ...createOptions, headers: { "x-opencode-session": this.sessionId } },
				)
				return response.output_text || ""
			} catch (error) {
				// Preserve abort identity (series standard): caller-initiated
				// cancellations and request timeouts must surface as a
				// DOM-standard AbortError, not a wrapped completion error. The
				// OpenAI SDK reports both with messages ending in a period
				// ("Request was aborted.", "Request timed out."), which would not
				// match task-level abort detection (message ending in "aborted").
				// SDK request timeouts are not aborts, but the series standard
				// maps them to the same AbortError identity as caller cancellations.
				if (isRequestAborted(error, options?.abortSignal) || error instanceof APIConnectionTimeoutError) {
					throw createAbortError("Opencode Go")
				}
				if (error instanceof Error) {
					throw new Error(`Opencode Go completion error: ${error.message}`)
				}
				throw error
			}
		}

		try {
			const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}

			if (this.supportsTemperature(modelId)) {
				requestOptions.temperature = temperature
			}

			requestOptions.max_completion_tokens =
				this.options.includeMaxTokens === true ? this.options.modelMaxTokens || maxTokens : maxTokens

			if (reasoningEffort) {
				requestOptions.reasoning_effort =
					reasoningEffort as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"]
			}

			// Build request options with abortSignal and/or timeout for the OpenAI
			// path: hasUsableTimeout/toSdkTimeoutMs own the disabled and non-finite
			// semantics.
			const createOptions: OpenAI.RequestOptions = {
				...(resolutionAbortSignal && { signal: resolutionAbortSignal }),
			}
			if (hasUsableTimeout(timeoutMs)) {
				createOptions.timeout = toSdkTimeoutMs(timeoutMs)
			}

			const response = await this.client.chat.completions.create(requestOptions, {
				...createOptions,
				headers: { "x-opencode-session": this.sessionId },
			})
			return response.choices[0]?.message.content || ""
		} catch (error) {
			// Preserve abort identity (series standard): caller-initiated
			// cancellations and request timeouts must surface as a
			// DOM-standard AbortError, not a wrapped completion error. The
			// OpenAI SDK reports both with messages ending in a period
			// ("Request was aborted.", "Request timed out."), which would not
			// match task-level abort detection (message ending in "aborted").
			// isRequestAborted covers the caller's signal plus the SDK abort
			// names/messages (AbortError, APIUserAbortError); the OpenAI SDK
			// timeout keeps its series-standard abort identity.
			if (isRequestAborted(error, options?.abortSignal) || error instanceof APIConnectionTimeoutError) {
				throw createAbortError("Opencode Go")
			}
			if (error instanceof Error) {
				throw new Error(`Opencode Go completion error: ${error.message}`)
			}
			throw error
		}
	}
}
