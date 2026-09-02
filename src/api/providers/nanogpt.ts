import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	applyNanoGptRoutingPreference,
	NANOGPT_BASE_URL,
	nanoGptDefaultModelId,
	nanoGptDefaultModelInfo,
	providerIdentifiers,
	type NanoGptRoutingPreference,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import type { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"
import type { ApiHandlerCreateMessageMetadata, CompletePromptOptions, SingleCompletionHandler } from "../index"
import { RouterProvider } from "./router-provider"
import { handleProviderError } from "./utils/error-handler"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"

type NanoGptUsage = OpenAI.CompletionUsage & {
	cache_read_input_tokens?: number
	cache_creation_input_tokens?: number
	reasoning_tokens?: number
}

type NanoGptCachingRequest = { caching?: true }

const NANO_GPT_MERGED_TOOL_RESULT_MODELS = new Set(["meta/muse-spark-1.2-contributor"])

const OPENAI_REASONING_EFFORTS = ["low", "medium", "high"] as const
type OpenAiReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number]

function getReasoningEffort(options: ApiHandlerOptions, supported: unknown): OpenAiReasoningEffort | undefined {
	const effort = options.reasoningEffort
	const selectedEffort = OPENAI_REASONING_EFFORTS.find((candidate) => candidate === effort)
	if (!selectedEffort) {
		return undefined
	}

	if (supported === true || (Array.isArray(supported) && supported.includes(selectedEffort))) {
		return selectedEffort
	}

	return undefined
}

function mapNanoGptUsage(usage: NanoGptUsage): ApiStreamUsageChunk {
	return {
		type: "usage",
		inputTokens: usage.prompt_tokens ?? 0,
		outputTokens: usage.completion_tokens ?? 0,
		cacheReadTokens: usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens,
		cacheWriteTokens: usage.cache_creation_input_tokens,
		reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
	}
}

export class NanoGptHandler extends RouterProvider implements SingleCompletionHandler {
	constructor(options: ApiHandlerOptions) {
		super({
			options,
			name: providerIdentifiers.nanogpt,
			baseURL: NANOGPT_BASE_URL,
			apiKey: options.nanoGptApiKey,
			modelId: options.nanoGptModelId,
			defaultModelId: nanoGptDefaultModelId,
			defaultModelInfo: nanoGptDefaultModelInfo,
		})
	}

	private getRequestModelId(canonicalModelId: string): string {
		return applyNanoGptRoutingPreference(
			canonicalModelId,
			this.options.nanoGptRoutingPreference as NanoGptRoutingPreference | undefined,
		)
	}

	private createSafeError(operation: string, error: unknown): Error {
		return handleProviderError(error, "NanoGPT", {
			messagePrefix: operation,
			messageTransformer: (message) =>
				this.options.nanoGptApiKey
					? `NanoGPT ${operation} error: ${message.replaceAll(this.options.nanoGptApiKey, "[REDACTED]")}`
					: `NanoGPT ${operation} error: ${message}`,
		})
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: canonicalModelId, info } = await this.fetchModel()
		const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & NanoGptCachingRequest = {
			model: this.getRequestModelId(canonicalModelId),
			messages: [
				{ role: "system", content: systemPrompt },
				...convertToOpenAiMessages(messages, {
					mergeToolResultText: NANO_GPT_MERGED_TOOL_RESULT_MODELS.has(canonicalModelId),
				}),
			],
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: info.maxTokens ?? undefined,
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			...(this.options.nanoGptRoutingPreference === "caching" ? { caching: true } : {}),
		}

		if (this.options.modelTemperature !== undefined && this.supportsTemperature(canonicalModelId)) {
			body.temperature = this.options.modelTemperature
		}

		const reasoningEffort = getReasoningEffort(this.options, info.supportsReasoningEffort)
		if (reasoningEffort) {
			body.reasoning_effort = reasoningEffort
		}

		try {
			const completion = await this.client.chat.completions.create(body, { signal: metadata?.abortSignal })
			for await (const chunk of completion) {
				const delta = chunk.choices[0]?.delta
				if (delta?.content) {
					yield { type: "text", text: delta.content }
				}

				const reasoning = extractReasoningFromDelta(delta)
				if (reasoning) {
					yield { type: "reasoning", text: reasoning }
				}

				for (const toolCall of delta?.tool_calls ?? []) {
					yield {
						type: "tool_call_partial",
						index: toolCall.index,
						id: toolCall.id,
						name: toolCall.function?.name,
						arguments: toolCall.function?.arguments,
					}
				}

				if (chunk.usage) {
					yield mapNanoGptUsage(chunk.usage as NanoGptUsage)
				}
			}
		} catch (error) {
			throw this.createSafeError("streaming", error)
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		const { id: canonicalModelId, info } = await this.fetchModel()
		const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & NanoGptCachingRequest = {
			model: this.getRequestModelId(canonicalModelId),
			messages: [{ role: "user", content: prompt }],
			stream: false,
			max_tokens: info.maxTokens ?? undefined,
			...(this.options.nanoGptRoutingPreference === "caching" ? { caching: true } : {}),
		}

		if (this.options.modelTemperature !== undefined && this.supportsTemperature(canonicalModelId)) {
			body.temperature = this.options.modelTemperature
		}

		const reasoningEffort = getReasoningEffort(this.options, info.supportsReasoningEffort)
		if (reasoningEffort) {
			body.reasoning_effort = reasoningEffort
		}

		try {
			const response = await this.client.chat.completions.create(body, {
				signal: options?.abortSignal,
				timeout: options?.timeoutMs,
			})
			return response.choices[0]?.message.content ?? ""
		} catch (error) {
			throw this.createSafeError("completion", error)
		}
	}
}
