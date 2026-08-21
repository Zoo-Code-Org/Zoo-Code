import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import axios from "axios"

import {
	type ModelInfo,
	openAiModelInfoSaneDefaults,
	LMSTUDIO_DEFAULT_TEMPERATURE,
	providerIdentifiers,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { NativeToolCallParser } from "../../core/assistant-message/NativeToolCallParser"
import { TagMatcher } from "../../utils/tag-matcher"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"

import { BaseProvider } from "./base-provider"
import { RequestConfigBuilder } from "./config-builder/request-config-builder"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"
import { getModelsFromCache } from "./fetchers/modelCache"
import {
	mergeAbortSignalAndTimeout,
	throwIfAborted,
	createAbortError,
	isRequestAborted,
	type OpenAiRequestOptions,
} from "./utils/abort-signal"
import { handleOpenAIError } from "./utils/error-handler"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"

export class LmStudioHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: OpenAI
	private readonly providerName = "LM Studio"

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options

		// LM Studio uses "noop" as a placeholder API key
		const apiKey = "noop"

		this.client = new OpenAI({
			baseURL: (this.options.lmStudioBaseUrl || "http://localhost:1234") + "/v1",
			apiKey: apiKey,
			timeout: this.timeoutMs,
		})
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Fast-fail if the caller’s stop signal already fired before we started.
		throwIfAborted(metadata?.abortSignal)

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// -------------------------
		// Track token usage
		// -------------------------
		const toContentBlocks = (
			blocks: Anthropic.Messages.MessageParam[] | string,
		): Anthropic.Messages.ContentBlockParam[] => {
			if (typeof blocks === "string") {
				return [{ type: "text", text: blocks }]
			}

			const result: Anthropic.Messages.ContentBlockParam[] = []
			for (const msg of blocks) {
				if (typeof msg.content === "string") {
					result.push({ type: "text", text: msg.content })
				} else if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "text") {
							result.push({ type: "text", text: part.text })
						}
					}
				}
			}
			return result
		}

		let inputTokens = 0
		try {
			inputTokens = await this.countTokens([{ type: "text", text: systemPrompt }, ...toContentBlocks(messages)])
		} catch (err) {
			console.error("[LmStudio] Failed to count input tokens:", err)
			inputTokens = 0
		}

		let assistantText = ""
		let reasoningOutput = ""

		// Request-local abort controller — a class field would outlive this
		// request and let concurrent requests abort each other.
		const requestController = new AbortController()
		const onExternalAbort = () => {
			requestController.abort()
		}
		const externalSignal = metadata?.abortSignal
		if (externalSignal) {
			externalSignal.addEventListener("abort", onExternalAbort)
		}

		try {
			const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming & { draft_model?: string } = {
				model: this.getModel().id,
				messages: openAiMessages,
				temperature: this.options.modelTemperature ?? LMSTUDIO_DEFAULT_TEMPERATURE,
				stream: true,
				tools: this.convertToolsForOpenAI(metadata?.tools),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			}

			if (this.options.lmStudioSpeculativeDecodingEnabled && this.options.lmStudioDraftModelId) {
				params.draft_model = this.options.lmStudioDraftModelId
			}

			// Bridge the request-local signal into the SDK request options so the
			// in-flight request can be cancelled.
			const createOptions = new RequestConfigBuilder<OpenAiRequestOptions>()
				.setOption("signal", requestController.signal)
				.build()

			let results
			try {
				results = await this.client.chat.completions.create(params, createOptions)
			} catch (error) {
				if (isRequestAborted(error, externalSignal)) {
					throw createAbortError("LM Studio")
				}
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

			for await (const chunk of results) {
				const delta = chunk.choices[0]?.delta
				const finishReason = chunk.choices[0]?.finish_reason

				if (delta?.content) {
					assistantText += delta.content
					for (const processedChunk of matcher.update(delta.content)) {
						yield processedChunk
					}
				}

				// Reasoning models served by LM Studio (Qwen3, DeepSeek-R1, QwQ, ...) stream
				// their thinking in a dedicated `reasoning_content`/`reasoning` delta field
				// rather than as <think> tags inside `content`, so TagMatcher never sees it.
				const reasoningText = extractReasoningFromDelta(delta)
				if (reasoningText) {
					reasoningOutput += reasoningText
					yield { type: "reasoning", text: reasoningText }
				}

				// Handle tool calls in stream - emit partial chunks for NativeToolCallParser
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

				// Process finish_reason to emit tool_call_end events
				if (finishReason) {
					const endEvents = NativeToolCallParser.processFinishReason(finishReason)
					for (const event of endEvents) {
						yield event
					}
				}
			}

			for (const processedChunk of matcher.final()) {
				yield processedChunk
			}

			let outputTokens = 0
			try {
				// Reasoning tokens are billed as output, so count them alongside the
				// visible text — otherwise thinking models under-report usage entirely.
				outputTokens = await this.countTokens([{ type: "text", text: reasoningOutput + assistantText }])
			} catch (err) {
				console.error("[LmStudio] Failed to count output tokens:", err)
				outputTokens = 0
			}

			yield {
				type: "usage",
				inputTokens,
				outputTokens,
			} as const
		} catch (error) {
			if (isRequestAborted(error, externalSignal)) {
				throw createAbortError("LM Studio")
			}
			throw new Error(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Zoo Code's prompts.",
			)
		} finally {
			// Cancel the in-flight SDK request if the consumer stopped iterating
			// early (break or return): the external signal may never fire in that
			// case, and only the request-local signal reaches the SDK.
			requestController.abort()
			if (externalSignal) {
				externalSignal.removeEventListener("abort", onExternalAbort)
			}
		}
	}

	override getModel(): { id: string; info: ModelInfo } {
		const models = getModelsFromCache({
			provider: providerIdentifiers.lmstudio,
			baseUrl: this.options.lmStudioBaseUrl,
		})
		if (models && this.options.lmStudioModelId && models[this.options.lmStudioModelId]) {
			return {
				id: this.options.lmStudioModelId,
				info: models[this.options.lmStudioModelId],
			}
		} else {
			return {
				id: this.options.lmStudioModelId || "",
				info: openAiModelInfoSaneDefaults,
			}
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		// Fast-fail if the caller’s stop signal already fired before we started.
		throwIfAborted(options?.abortSignal)

		// Merge the external stop signal with an optional per-call timeout. A
		// timeoutMs <= 0 means "no explicit timeout" inside the util, so zero
		// never reaches the SDK as an explicit timeout.
		const requestSignal = mergeAbortSignalAndTimeout(options?.abortSignal, options?.timeoutMs)

		try {
			// Create params object with optional draft model
			const params: any = {
				model: this.getModel().id,
				messages: [{ role: "user", content: prompt }],
				temperature: this.options.modelTemperature ?? LMSTUDIO_DEFAULT_TEMPERATURE,
				stream: false,
			}

			// Add draft model if speculative decoding is enabled and a draft model is specified
			if (this.options.lmStudioSpeculativeDecodingEnabled && this.options.lmStudioDraftModelId) {
				params.draft_model = this.options.lmStudioDraftModelId
			}

			// CompletePromptOptions is not createMessage metadata (no taskId), so
			// the generic builder takes the merged signal via setOption instead of
			// setAbortSignal(metadata).
			const createOptions = new RequestConfigBuilder<OpenAiRequestOptions>()
				.setOption("signal", requestSignal)
				.build()

			let response
			try {
				response = await this.client.chat.completions.create(params, createOptions)
			} catch (error) {
				if (isRequestAborted(error, requestSignal)) {
					throw createAbortError("LM Studio")
				}
				throw handleOpenAIError(error, this.providerName)
			}
			return response.choices[0]?.message.content || ""
		} catch (error) {
			if (isRequestAborted(error, requestSignal)) {
				throw createAbortError("LM Studio")
			}
			throw new Error(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Zoo Code's prompts.",
			)
		}
	}
}

export async function getLmStudioModels(baseUrl = "http://localhost:1234") {
	try {
		if (!URL.canParse(baseUrl)) {
			return []
		}

		const response = await axios.get(`${baseUrl}/v1/models`)
		const modelsArray = response.data?.data?.map((model: any) => model.id) || []
		return [...new Set<string>(modelsArray)]
	} catch (error) {
		return []
	}
}
