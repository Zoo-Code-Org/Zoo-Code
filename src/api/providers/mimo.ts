import OpenAI from "openai"
import type { Anthropic } from "@anthropic-ai/sdk"

import { mimoModels, mimoDefaultModelId, MIMO_DEFAULT_TEMPERATURE, type ModelInfo } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { ApiStream } from "../transform/stream"
import { convertToR1Format } from "../transform/r1-format"
import { getModelParams } from "../transform/model-params"
import { calculateApiCostOpenAI } from "../../shared/cost"
import { handleProviderError } from "./utils/error-handler"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"

import { OpenAiHandler } from "./openai"
import type { ApiHandlerCreateMessageMetadata } from "../index"
import { sanitizeOpenAiCallId } from "../../utils/tool-id"

/**
 * Detects whether an API error is specifically caused by the endpoint
 * rejecting the `parallel_tool_calls` field. Some OpenAI-compatible
 * endpoints don't support this field and return a 400 Bad Request with
 * a message referencing the unrecognized parameter.
 */
function isParallelToolCallsRejected(error: unknown): boolean {
	if (error instanceof Error) {
		const message = error.message.toLowerCase()
		const status = (error as { status?: number }).status
		// OpenAI SDK APIError carries an HTTP status; some endpoints return 400
		if (message.includes("parallel_tool_calls") || (status === 400 && message.includes("unrecognized"))) {
			return true
		}
	}
	return false
}

/**
 * Filters a streamed delta so that only the FIRST tool call (index 0) survives.
 * MiMo v2.5 Pro ignores `parallel_tool_calls: false` and may emit multiple
 * parallel tool_calls in one turn. Downstream (ToolCallRetentionPolicy) is
 * configured for maxCallsPerTurn === 1; dropping extras here prevents the
 * "multiple-valid-calls-under-single-policy" rejection path that triggers the
 * error-interception retry loop.
 *
 * Confined to MimoHandler — no other provider is affected.
 */
function filterToFirstToolCall(
	delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta,
	state: { firstToolCallId: string | undefined },
): OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta {
	if (!delta.tool_calls || delta.tool_calls.length === 0) {
		return delta
	}

	const kept = delta.tool_calls.filter((toolCall) => {
		const index = toolCall.index ?? 0
		if (index > 0) {
			return false // parallel call — drop
		}
		if (toolCall.id) {
			if (state.firstToolCallId === undefined) {
				state.firstToolCallId = toolCall.id
				return true
			}
			// A second distinct id at index 0 is a disguised parallel call.
			return toolCall.id === state.firstToolCallId
		}
		// Argument-continuation fragment for the kept call.
		return true
	})

	if (kept.length === delta.tool_calls.length) {
		return delta
	}
	if (kept.length === 0) {
		const { tool_calls: _omit, ...rest } = delta
		return rest
	}
	return { ...delta, tool_calls: kept }
}

type MiMoCompletionParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
	extra_body: { thinking: { type: string } }
}

/**
 * MiMoHandler extends OpenAiHandler with MiMo-specific adaptations.
 *
 * CRITICAL: Per MiMo's official docs, reasoning_content MUST be passed back
 * in multi-turn conversations with tool calls. Without it, the API returns 400.
 *
 * Reference: https://platform.xiaomimimo.com/#/docs/usage-guide/passing-back-reasoning_content
 */
export class MimoHandler extends OpenAiHandler {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			openAiApiKey: options.mimoApiKey ?? "not-provided",
			openAiModelId: options.apiModelId ?? mimoDefaultModelId,
			openAiBaseUrl: options.mimoBaseUrl || "https://token-plan-sgp.xiaomimimo.com/v1",
			openAiStreamingEnabled: true,
			includeMaxTokens: false,
		})
	}

	/**
	 * Maps the configured model ID to its MiMo model info and parameters.
	 * Falls back to the default model (mimo-v2.5-pro) if the stored ID
	 * doesn't match any known model — this can happen when users manually
	 * type a model name in settings.
	 */
	override getModel() {
		const id = this.options.apiModelId ?? mimoDefaultModelId
		const info: ModelInfo = mimoModels[id as keyof typeof mimoModels] || mimoModels[mimoDefaultModelId]
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: MIMO_DEFAULT_TEMPERATURE,
		})
		return { id, info, ...params }
	}

	/**
	 * Streams a chat completion from MiMo's OpenAI-compatible API.
	 *
	 * Uses convertToR1Format (shared with DeepSeek/Z.ai) for message conversion
	 * with mergeToolResultText and normalizeToolCallId options enabled.
	 * MiMo-specific: enables thinking mode via extra_body.thinking.
	 *
	 * supportsPromptCache is false because MiMo doesn't support client-side
	 * cache_control injection. However, MiMo's server-side cache CAN return
	 * cached_tokens in usage, so cacheReadsPrice/cacheWritesPrice in the model
	 * definitions are correct for cost calculation.
	 */
	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: modelId, info: modelInfo } = this.getModel()

		// Use shared R1-format conversion with tool ID sanitization and text merging
		const convertedMessages = convertToR1Format(messages, {
			mergeToolResultText: true,
			normalizeToolCallId: sanitizeOpenAiCallId,
		})

		const tools = metadata?.tools

		// Build request per MiMo's OpenAI-compatible API
		// https://developer.puter.com/ai/xiaomi/mimo-v2.5-pro/
		// Note: temperature is omitted because MiMo forces it to 1.0 when thinking mode
		// is enabled, regardless of what is passed (see model-hyperparameters docs).
		const params: MiMoCompletionParams = {
			model: modelId,
			messages: [{ role: "system", content: systemPrompt }, ...convertedMessages],
			stream: true,
			stream_options: { include_usage: true },
			// MiMo requires thinking to be enabled via extra_body
			extra_body: { thinking: { type: "enabled" } },
		}

		if (tools && tools.length > 0) {
			params.tools = this.convertToolsForOpenAI(tools)
		}

		// Honor tool_choice from metadata (OpenAI-compatible passthrough)
		if (metadata?.tool_choice !== undefined) {
			params.tool_choice = metadata.tool_choice
		}

		// Send parallel_tool_calls based on resolved metadata policy.
		// Sub-task 1's resolver sets parallelToolCalls=false for MiMo to
		// prevent malformed parallel tool calls from MiMo v2.5 Pro.
		if (metadata?.parallelToolCalls !== undefined) {
			params.parallel_tool_calls = metadata.parallelToolCalls
		}

		let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
		try {
			stream = await this.client.chat.completions.create(params)
		} catch (error) {
			// Fallback: if the endpoint rejects the parallel_tool_calls field,
			// retry once without it. Some OpenAI-compatible endpoints don't
			// support this field and return a 400 Bad Request.
			if (params.parallel_tool_calls !== undefined && isParallelToolCallsRejected(error)) {
				const { parallel_tool_calls: _omit, ...paramsWithoutParallel } = params
				stream = await this.client.chat.completions.create(paramsWithoutParallel as MiMoCompletionParams)
			} else {
				throw handleProviderError(error, "MiMo")
			}
		}

		let lastUsage: OpenAI.CompletionUsage | undefined
		const activeToolCallIds = new Set<string>()
		const firstCallState: { firstToolCallId: string | undefined } = {
			firstToolCallId: undefined,
		}

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta ?? {}
			const finishReason = chunk.choices?.[0]?.finish_reason
			const filteredDelta = filterToFirstToolCall(delta, firstCallState)
			const sanitizedDelta = filteredDelta.tool_calls
				? {
						...filteredDelta,
						tool_calls: filteredDelta.tool_calls.map((toolCall) => ({
							...toolCall,
							id: toolCall.id ? sanitizeOpenAiCallId(toolCall.id) : toolCall.id,
						})),
					}
				: filteredDelta

			if (delta.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			const reasoningText = extractReasoningFromDelta(delta)
			if (reasoningText) {
				yield { type: "reasoning", text: reasoningText }
			}

			yield* this.processToolCalls(sanitizedDelta, finishReason, activeToolCallIds)

			if (chunk.usage) {
				lastUsage = chunk.usage
			}
		}

		if (lastUsage) {
			const inputTokens = lastUsage?.prompt_tokens || 0
			const outputTokens = lastUsage?.completion_tokens || 0
			const cacheWriteTokens =
				(lastUsage?.prompt_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens ||
				0
			const cacheReadTokens = lastUsage?.prompt_tokens_details?.cached_tokens || 0

			const { totalCost } = calculateApiCostOpenAI(
				modelInfo,
				inputTokens,
				outputTokens,
				cacheWriteTokens,
				cacheReadTokens,
			)

			yield {
				type: "usage",
				inputTokens,
				outputTokens,
				cacheWriteTokens: cacheWriteTokens || undefined,
				cacheReadTokens: cacheReadTokens || undefined,
				totalCost,
			}
		}
	}
}
