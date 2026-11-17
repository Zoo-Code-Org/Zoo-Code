import { Anthropic } from "@anthropic-ai/sdk"
import { Mistral } from "@mistralai/mistralai"
import OpenAI from "openai"

import {
	type MistralModelId,
	mistralDefaultModelId,
	mistralModels,
	MISTRAL_DEFAULT_TEMPERATURE,
	ApiProviderError,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { ApiHandlerOptions } from "../../shared/api"

import { convertToMistralMessages } from "../transform/mistral-format"
import { ApiStream } from "../transform/stream"
import { createAbortError, isRequestAborted, mergeAbortSignalAndTimeout, throwIfAborted } from "./utils/abort-signal"
import { createTimeoutError } from "./utils/request-timeout"
import { RequestConfigBuilder } from "./config-builder/request-config-builder"

import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"

// Type helper to handle thinking chunks from Mistral API
// The SDK includes ThinkChunk but TypeScript has trouble with the discriminated union
type ContentChunkWithThinking = {
	type: string
	text?: string
	thinking?: Array<{ type: string; text?: string }>
}

// Type for Mistral tool calls in stream delta
type MistralToolCall = {
	id?: string
	type?: string
	function?: {
		name?: string
		arguments?: string
	}
}

// Type for Mistral tool definition - matches Mistral SDK Tool type
type MistralTool = {
	type: "function"
	function: {
		name: string
		description?: string
		parameters: Record<string, unknown>
	}
}

// The pinned @mistralai/mistralai (1.15.1) has no typed field for
// `prompt_tokens_details`; its `UsageInfo$inboundSchema` collects unknown keys
// into `additionalProperties`, so the documented cache-read count survives the
// SDK parse but only there. Mistral bills these tokens at 10% of the input
// price, and `prompt_tokens` already includes them, so the count is reported as
// `cacheReadTokens` and never added to `inputTokens`.
//
// The `cachedTokens <= promptTokens` subset guard mirrors the OpenAI sibling
// that reads the identical nested wire field (src/api/providers/openai.ts:304-313,
// `reportedCacheReadTokens <= inputTokens`): a malformed upstream value larger
// than the prompt total is dropped instead of billing reads at 0.1x and
// surfacing as cacheReads > tokensIn.
function readCachedPromptTokens(
	usage: { additionalProperties?: { [key: string]: unknown } },
	promptTokens: number,
): number | undefined {
	const details = usage.additionalProperties?.["prompt_tokens_details"]
	if (typeof details !== "object" || details === null) {
		return undefined
	}

	const cachedTokens = (details as { cached_tokens?: unknown }).cached_tokens
	if (
		typeof cachedTokens !== "number" ||
		!Number.isInteger(cachedTokens) ||
		cachedTokens <= 0 ||
		cachedTokens > promptTokens
	) {
		return undefined
	}

	return cachedTokens
}

export class MistralHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: Mistral
	private readonly providerName = "Mistral"

	constructor(options: ApiHandlerOptions) {
		super()

		if (!options.mistralApiKey) {
			throw new Error("Mistral API key is required")
		}

		// Set default model ID if not provided.
		const apiModelId = options.apiModelId || mistralDefaultModelId
		this.options = { ...options, apiModelId }

		this.client = new Mistral({
			serverURL: apiModelId.startsWith("codestral-")
				? this.options.mistralCodestralUrl || "https://codestral.mistral.ai"
				: "https://api.mistral.ai",
			apiKey: this.options.mistralApiKey,
		})
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: model, info, maxTokens, temperature } = this.getModel()

		// Build request options
		const requestOptions: {
			model: string
			messages: ReturnType<typeof convertToMistralMessages>
			maxTokens: number
			temperature: number
			tools?: MistralTool[]
			toolChoice?: "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } }
		} = {
			model,
			messages: [{ role: "system", content: systemPrompt }, ...convertToMistralMessages(messages)],
			maxTokens: maxTokens ?? info.maxTokens,
			temperature,
		}

		requestOptions.tools = this.convertToolsForMistral(metadata?.tools ?? [])
		// Always use "any" to require tool use
		requestOptions.toolChoice = "any"

		// Temporary debug log for QA
		// console.log("[MISTRAL DEBUG] Raw API request body:", requestOptions)

		// Fast-fail if the request was already aborted before building.
		throwIfAborted(metadata?.abortSignal)

		// The request-local controller is the provider-owned abort handle; the
		// fetch signal merges it with the external Task signal (AbortSignal.any
		// inside RequestConfigBuilder), so external aborts cancel the in-flight
		// request without manual listener management.
		const requestBuilder = new RequestConfigBuilder<{ signal?: AbortSignal }>()
		requestBuilder.addMergedSignal(new AbortController(), metadata)
		const requestSignal = requestBuilder.getOption("signal")

		// The try intentionally wraps both the stream open and the consumption loop:
		// a mid-stream non-abort failure must be reported once as a Mistral completion
		// error (and captured for telemetry) instead of escaping half-reported.
		let response
		try {
			response = await this.client.chat.stream(requestOptions, {
				fetchOptions: { signal: requestSignal },
			})

			for await (const event of response) {
				// Stop consuming buffered events once the request is aborted (the
				// SDK iterator may keep delivering buffered content after abort).
				if (requestSignal?.aborted) {
					break
				}

				const delta = event.data.choices[0]?.delta

				if (delta?.content) {
					if (typeof delta.content === "string") {
						// Handle string content as text (no pre-yield guard: this is
						// the first yield of the iteration — the top-of-loop check
						// runs without a suspension point before it).
						yield { type: "text", text: delta.content }
					} else if (Array.isArray(delta.content)) {
						// Handle array of content chunks
						// The SDK v1.9.18 supports ThinkChunk with type "thinking"
						for (const chunk of delta.content as ContentChunkWithThinking[]) {
							if (chunk.type === "thinking" && chunk.thinking) {
								// Handle thinking content as reasoning chunks
								// ThinkChunk has a 'thinking' property that contains an array of text/reference chunks
								for (const thinkingPart of chunk.thinking) {
									if (thinkingPart.type === "text" && thinkingPart.text) {
										throwIfAborted(requestSignal)
										yield { type: "reasoning", text: thinkingPart.text }
									}
								}
							} else if (chunk.type === "text" && chunk.text) {
								// Handle text content normally
								throwIfAborted(requestSignal)
								yield { type: "text", text: chunk.text }
							}
						}
					}
				}

				// Handle tool calls in stream
				// Mistral SDK provides tool_calls in delta similar to OpenAI format
				const toolCalls = (delta as { toolCalls?: MistralToolCall[] })?.toolCalls
				if (toolCalls) {
					for (let i = 0; i < toolCalls.length; i++) {
						const toolCall = toolCalls[i]
						throwIfAborted(requestSignal)
						yield {
							type: "tool_call_partial",
							index: i,
							id: toolCall.id,
							name: toolCall.function?.name,
							arguments: toolCall.function?.arguments,
						}
					}
				}

				if (event.data.usage) {
					throwIfAborted(requestSignal)
					const promptTokens = event.data.usage.promptTokens || 0
					yield {
						type: "usage",
						inputTokens: promptTokens,
						outputTokens: event.data.usage.completionTokens || 0,
						cacheReadTokens: readCachedPromptTokens(event.data.usage, promptTokens),
					}
				}
			}

			// An aborted request must surface as an AbortError, not as a normal
			// stream completion: the top-of-loop break (or a swallowed mid-stream
			// abort) ends the loop without throwing otherwise.
			throwIfAborted(requestSignal)
		} catch (error) {
			// Aborted request: covers both the external signal and SDK-native abort
			// errors that may surface before the SDK's signal flag propagates. Check
			// the merged request signal (not just the caller's) so a plain SDK error
			// arriving after a cancellation still surfaces as an AbortError.
			if (isRequestAborted(error, requestSignal)) {
				throw createAbortError("Mistral")
			}
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model, "createMessage")
			TelemetryService.instance.captureException(apiError)
			throw new Error(`Mistral completion error: ${errorMessage}`)
		}
	}

	/**
	 * Convert OpenAI tool definitions to Mistral format.
	 * Mistral uses the same format as OpenAI for function tools.
	 */
	private convertToolsForMistral(tools: OpenAI.Chat.ChatCompletionTool[]): MistralTool[] {
		return tools
			.filter((tool) => tool.type === "function")
			.map((tool) => ({
				type: "function" as const,
				function: {
					name: tool.function.name,
					description: tool.function.description,
					// Mistral SDK requires parameters to be defined, use empty object as fallback
					parameters: (tool.function.parameters as Record<string, unknown>) || {},
				},
			}))
	}

	override getModel() {
		const id = this.options.apiModelId ?? mistralDefaultModelId
		const info = mistralModels[id as MistralModelId] ?? mistralModels[mistralDefaultModelId]

		// @TODO: Move this to the `getModelParams` function.
		const maxTokens = this.options.includeMaxTokens ? info.maxTokens : undefined
		const temperature = this.options.modelTemperature ?? MISTRAL_DEFAULT_TEMPERATURE

		return { id, info, maxTokens, temperature }
	}
	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		// Fast-fail if the request was already aborted before building.
		throwIfAborted(options?.abortSignal)

		const { id: model, temperature } = this.getModel()
		const callerAbortSignal = options?.abortSignal
		// Build a single signal that combines the external abort with the per-request
		// timeout (timeoutMs <= 0 disables the timeout; see mergeAbortSignalAndTimeout).
		const requestAbortSignal = mergeAbortSignalAndTimeout(callerAbortSignal, options?.timeoutMs)

		try {
			// Build Mistral SDK RequestOptions
			const requestOptions: Parameters<typeof this.client.chat.complete>[1] = {}
			if (requestAbortSignal) {
				requestOptions.fetchOptions = { signal: requestAbortSignal }
			}

			const response = await this.client.chat.complete(
				{
					model,
					messages: [{ role: "user", content: prompt }],
					temperature,
				},
				Object.keys(requestOptions).length > 0 ? requestOptions : undefined,
			)

			const content = response.choices?.[0]?.message.content

			if (Array.isArray(content)) {
				// Only return text content, filter out thinking content for non-streaming
				return (content as ContentChunkWithThinking[])
					.filter((c) => c.type === "text" && c.text)
					.map((c) => c.text || "")
					.join("")
			}

			return content || ""
		} catch (error) {
			// The merged signal covers both the caller's abort and the per-request
			// timeout. A timeout the caller did not cause is the series' TimeoutError,
			// not a completion failure (the Mistral SDK throws RequestTimeoutError,
			// which does not match the abort-name checks on its own).
			if (isRequestAborted(error, requestAbortSignal)) {
				if (requestAbortSignal?.aborted) {
					// The merged signal keeps the FIRST abort reason: a timeout that fired before
					// the caller aborted must stay a TimeoutError even if the caller signal is
					// aborted by the time the catch runs.
					const abortedByTimeout =
						(requestAbortSignal.reason as { name?: string } | undefined)?.name === "TimeoutError"
					throw abortedByTimeout
						? createTimeoutError("Mistral", "completion request")
						: createAbortError("Mistral")
				}
				throw createAbortError("Mistral")
			}
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, model, "completePrompt")
			TelemetryService.instance.captureException(apiError)
			throw new Error(`Mistral completion error: ${errorMessage}`)
		}
	}
}
