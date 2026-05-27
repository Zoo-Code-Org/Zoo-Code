import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	zooGatewayDefaultModelId,
	zooGatewayDefaultModelInfo,
	ZOO_GATEWAY_DEFAULT_TEMPERATURE,
	VERCEL_AI_GATEWAY_PROMPT_CACHING_MODELS,
} from "@roo-code/types"

import { ApiHandlerOptions } from "../../shared/api"
import { getZooCodeBaseUrl } from "../../services/zoo-code-auth"

import { ApiStream } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { addCacheBreakpoints } from "../transform/caching/vercel-ai-gateway"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { RouterProvider } from "./router-provider"

import { DEFAULT_HEADERS } from "./constants"

// Extend OpenAI's CompletionUsage to include Zoo Gateway specific fields (same as Vercel AI Gateway)
interface ZooGatewayUsage extends OpenAI.CompletionUsage {
	cache_creation_input_tokens?: number
	cost?: number
}

export class ZooGatewayHandler extends RouterProvider implements SingleCompletionHandler {
	constructor(options: ApiHandlerOptions) {
		const baseURL = options.zooGatewayBaseUrl ?? `${getZooCodeBaseUrl()}/api/gateway/v1`

		// Fail fast with a clear message instead of waiting for a 401.
		// The token is set automatically by handleZooCodeCallback() after the user
		// authenticates via the "Sign in with Zoo Code" flow in the extension.
		if (!options.zooSessionToken) {
			throw new Error("Zoo Gateway requires authentication. Please sign in to Zoo Code first.")
		}

		super({
			options,
			name: "zoo-gateway",
			baseURL,
			apiKey: options.zooSessionToken,
			modelId: options.zooGatewayModelId,
			defaultModelId: zooGatewayDefaultModelId,
			defaultModelInfo: zooGatewayDefaultModelInfo,
		})

		// Override the client to add Zoo-specific enrichment headers
		// These headers help with request tracking and analytics
		const enrichmentHeaders: Record<string, string> = {}

		// Note: These headers will be populated per-request in createMessage
		// For now we just set static headers that are always available
		if (typeof process !== "undefined" && process.env?.npm_package_version) {
			enrichmentHeaders["X-Zoo-Extension-Version"] = process.env.npm_package_version
		}
		enrichmentHeaders["X-Zoo-Editor"] = "vscode"

		// Recreate client with enrichment headers
		;(this as any).client = new OpenAI({
			baseURL,
			apiKey: options.zooSessionToken,
			defaultHeaders: {
				...DEFAULT_HEADERS,
				...enrichmentHeaders,
				...(options.openAiHeaders || {}),
			},
		})
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: modelId, info } = await this.fetchModel()

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// Apply prompt caching for models that support it
		// Zoo Gateway serves the same models as Vercel AI Gateway, so caching support is identical
		if (VERCEL_AI_GATEWAY_PROMPT_CACHING_MODELS.has(modelId) && info.supportsPromptCache) {
			addCacheBreakpoints(systemPrompt, openAiMessages)
		}

		// Build request headers with enrichment metadata
		const requestHeaders: Record<string, string> = {}
		if (metadata?.taskId) {
			requestHeaders["X-Zoo-Task-ID"] = metadata.taskId
		}
		if (metadata?.mode) {
			requestHeaders["X-Zoo-Mode"] = metadata.mode
		}

		const body: OpenAI.Chat.ChatCompletionCreateParams = {
			model: modelId,
			messages: openAiMessages,
			temperature: this.supportsTemperature(modelId)
				? (this.options.modelTemperature ?? ZOO_GATEWAY_DEFAULT_TEMPERATURE)
				: undefined,
			max_completion_tokens: info.maxTokens,
			stream: true,
			stream_options: { include_usage: true },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		const completion = await this.client.chat.completions.create(body, {
			headers: requestHeaders,
		})

		for await (const chunk of completion) {
			const delta = chunk.choices[0]?.delta
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			// Emit raw tool call chunks - NativeToolCallParser handles state management
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
				const usage = chunk.usage as ZooGatewayUsage
				yield {
					type: "usage",
					inputTokens: usage.prompt_tokens || 0,
					outputTokens: usage.completion_tokens || 0,
					cacheWriteTokens: usage.cache_creation_input_tokens || undefined,
					cacheReadTokens: usage.prompt_tokens_details?.cached_tokens || undefined,
					totalCost: usage.cost ?? 0,
				}
			}
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		const { id: modelId, info } = await this.fetchModel()

		try {
			const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}

			if (this.supportsTemperature(modelId)) {
				requestOptions.temperature = this.options.modelTemperature ?? ZOO_GATEWAY_DEFAULT_TEMPERATURE
			}

			requestOptions.max_completion_tokens = info.maxTokens

			const response = await this.client.chat.completions.create(requestOptions)
			return response.choices[0]?.message.content || ""
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`Zoo Gateway completion error: ${error.message}`)
			}
			throw error
		}
	}
}
