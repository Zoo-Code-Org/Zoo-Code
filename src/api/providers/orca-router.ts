import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	ORCA_ROUTER_BASE_URL,
	orcaRouterDefaultModelId,
	orcaRouterDefaultModelInfo,
	providerIdentifiers,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import type { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"
import type { ApiHandlerCreateMessageMetadata, CompletePromptOptions, SingleCompletionHandler } from "../index"
import { RouterProvider } from "./router-provider"
import { handleProviderError } from "./utils/error-handler"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"

type OrcaRouterUsage = OpenAI.CompletionUsage & {
	reasoning_tokens?: number
	cost?: number
}

function mapOrcaRouterUsage(usage: OrcaRouterUsage): ApiStreamUsageChunk {
	return {
		type: "usage",
		inputTokens: usage.prompt_tokens ?? 0,
		outputTokens: usage.completion_tokens ?? 0,
		cacheReadTokens: usage.prompt_tokens_details?.cached_tokens,
		reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
		totalCost: usage.cost,
	}
}

export class OrcaRouterHandler extends RouterProvider implements SingleCompletionHandler {
	constructor(options: ApiHandlerOptions) {
		super({
			options,
			name: providerIdentifiers.orcaRouter,
			baseURL: ORCA_ROUTER_BASE_URL,
			apiKey: options.orcaRouterApiKey,
			modelId: options.orcaRouterModelId,
			defaultModelId: orcaRouterDefaultModelId,
			defaultModelInfo: orcaRouterDefaultModelInfo,
		})
	}

	private createSafeError(operation: string, error: unknown): Error {
		return handleProviderError(error, "OrcaRouter", {
			messagePrefix: operation,
			messageTransformer: (message) =>
				this.options.orcaRouterApiKey
					? `OrcaRouter ${operation} error: ${message.replaceAll(this.options.orcaRouterApiKey, "[REDACTED]")}`
					: `OrcaRouter ${operation} error: ${message}`,
		})
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: modelId, info } = await this.fetchModel()
		const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
			model: modelId,
			messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: info.maxTokens ?? undefined,
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		if (this.options.modelTemperature !== undefined && this.supportsTemperature(modelId)) {
			body.temperature = this.options.modelTemperature
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
					yield mapOrcaRouterUsage(chunk.usage as OrcaRouterUsage)
				}
			}
		} catch (error) {
			throw this.createSafeError("streaming", error)
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		const { id: modelId, info } = await this.fetchModel()
		const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
			model: modelId,
			messages: [{ role: "user", content: prompt }],
			stream: false,
			max_tokens: info.maxTokens ?? undefined,
		}

		if (this.options.modelTemperature !== undefined && this.supportsTemperature(modelId)) {
			body.temperature = this.options.modelTemperature
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
