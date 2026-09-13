import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { Message, Ollama, Tool as OllamaTool, type Config as OllamaOptions } from "ollama"
import { ModelInfo, openAiModelInfoSaneDefaults, DEEP_SEEK_DEFAULT_TEMPERATURE } from "@roo-code/types"
import { ApiStream } from "../transform/stream"
import { BaseProvider } from "./base-provider"
import type { ApiHandlerOptions } from "../../shared/api"
import { getOllamaModels, isSecureOllamaEndpoint } from "./fetchers/ollama"
import { mergeAbortSignalAndTimeout } from "./utils/abort-signal"
import { TagMatcher } from "../../utils/tag-matcher"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"

interface OllamaChatOptions {
	temperature: number
	num_ctx?: number
}

// Narrow local types for non-Anthropic content blocks that may be carried in
// the conversation history. The Anthropic SDK union does not include the
// custom `reasoning` block (used by non-Anthropic protocols) or the
// Anthropic-protocol `thinking` block, so we declare them here to keep type
// checking intact for the rest of the union instead of falling back to `any`.
type ReasoningContentBlock = { type: "reasoning"; text: string }
type ThinkingContentBlock = { type: "thinking"; thinking: string }
type AssistantContentBlock = Anthropic.ContentBlock | ReasoningContentBlock | ThinkingContentBlock

/**
 * Creates the canonical abort error shared by every cancellation path so
 * callers can identify cancellations by `name === "AbortError"`.
 */
function createAbortError(): Error {
	const abortError = new Error("This operation was aborted")
	abortError.name = "AbortError"
	return abortError
}

/**
 * Races `pending` against `signal`: if the signal aborts before the promise
 * settles, the returned promise rejects with an AbortError instead of
 * resolving with a stale result. The Ollama model-discovery fetch accepts no
 * signal, so the underlying request is left to settle in the background
 * rather than being cancelled.
 */
export function raceWithAbortSignal<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) {
		return pending
	}
	if (signal.aborted) {
		return Promise.reject(createAbortError())
	}
	return new Promise<T>((resolve, reject) => {
		signal.addEventListener("abort", () => reject(createAbortError()))
		pending.then(resolve, reject)
	})
}

function convertToOllamaMessages(anthropicMessages: Anthropic.Messages.MessageParam[]): Message[] {
	const ollamaMessages: Message[] = []
	// Track tool use IDs to tool names so tool results can be sent with
	// Ollama's native "tool" role and tool_name field instead of "user".
	const toolUseIdToName = new Map<string, string>()

	for (const anthropicMessage of anthropicMessages) {
		if (typeof anthropicMessage.content === "string") {
			ollamaMessages.push({
				role: anthropicMessage.role,
				content: anthropicMessage.content,
			})
		} else {
			if (anthropicMessage.role === "user") {
				const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
					nonToolMessages: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]
					toolMessages: Anthropic.ToolResultBlockParam[]
				}>(
					(acc, part) => {
						if (part.type === "tool_result") {
							acc.toolMessages.push(part)
						} else if (part.type === "text" || part.type === "image") {
							acc.nonToolMessages.push(part)
						}
						return acc
					},
					{ nonToolMessages: [], toolMessages: [] },
				)

				// Process tool result messages FIRST since they must follow the tool use messages.
				// Images extracted from tool results are collected here and attached to the
				// adjacent user message, because Ollama's "tool" role only supports text
				// content (content + tool_name); attaching images there can invalidate the
				// request.
				const toolResultImages: string[] = []
				toolMessages.forEach((toolMessage) => {
					// The Anthropic SDK allows tool results to be a string or an array of text and image blocks, enabling rich and structured content. In contrast, the Ollama SDK only supports tool results as a single string, so we map the Anthropic tool result parts into one concatenated string to maintain compatibility.
					let content: string

					if (typeof toolMessage.content === "string") {
						content = toolMessage.content
					} else {
						// Collect this result's images in a local accumulator so they
						// cannot leak into sibling tool results, then fold them into
						// the shared accumulator for the adjacent user message.
						const resultImages: string[] = []
						content =
							toolMessage.content
								?.map((part) => {
									if (part.type === "image") {
										// Handle base64 images only (Anthropic SDK uses base64)
										// Ollama expects raw base64 strings, not data URLs
										if ("source" in part && part.source.type === "base64") {
											resultImages.push(part.source.data)
										}
										return "(see following user message for image)"
									}
									if (part.type === "text") {
										return part.text
									}
									return ""
								})
								.join("\n") ?? ""
						toolResultImages.push(...resultImages)
					}
					// Look up the tool name from the corresponding tool_use block.
					// When found, use Ollama's native "tool" role with tool_name so the
					// model can distinguish tool results from user messages. Tool messages
					// stay text-only; images are delivered via the adjacent user message.
					const toolName = toolUseIdToName.get(toolMessage.tool_use_id)
					ollamaMessages.push({
						role: toolName ? "tool" : "user",
						tool_name: toolName,
						content: content,
					})
				})

				// Process non-tool messages
				if (nonToolMessages.length > 0) {
					// Separate text and images for Ollama
					const textContent = nonToolMessages
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n")

					const imageData: string[] = []
					nonToolMessages.forEach((part) => {
						if (part.type === "image" && "source" in part && part.source.type === "base64") {
							// Ollama expects raw base64 strings, not data URLs
							imageData.push(part.source.data)
						}
					})
					// Attach images extracted from tool results to the adjacent user
					// message, the only role that supports images in Ollama's chat API.
					imageData.push(...toolResultImages)

					ollamaMessages.push({
						role: "user",
						content: textContent,
						images: imageData.length > 0 ? imageData : undefined,
					})
				} else if (toolResultImages.length > 0) {
					// No adjacent user message exists to carry tool-result images, so
					// emit a dedicated user message to ensure they still reach the model.
					ollamaMessages.push({
						role: "user",
						content: "",
						images: toolResultImages,
					})
				}
			} else if (anthropicMessage.role === "assistant") {
				// Assistant message conversion: only `text`, `tool_use`, and the
				// custom `reasoning`/`thinking` blocks are relevant here.
				//
				// Note on the removed `image` branch: the previous code checked
				// `block.type === "image"` and typed `nonToolMessages` as
				// `(Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]`. This
				// was removed because:
				//   1. The Anthropic API only accepts image blocks in *user*
				//      messages — assistants cannot produce or send images, so
				//      the branch was dead code (the original comment even said
				//      "impossible as the assistant cannot send images").
				//   2. `Anthropic.ContentBlock` (the response/output union) does
				//      not include an `image` variant, so the comparison
				//      `block.type === "image"` triggered TS2367 ("this comparison
				//      appears to be unintentional because the types have no
				//      overlap").
				//   3. Image handling for *user* messages (where images are
				//      actually sent to the model) is preserved unchanged in the
				//      `anthropicMessage.role === "user"` branch above.
				const { nonToolMessages, toolMessages, reasoningText } = anthropicMessage.content.reduce<{
					nonToolMessages: Anthropic.TextBlockParam[]
					toolMessages: Anthropic.ToolUseBlockParam[]
					reasoningText: string
				}>(
					(acc, part) => {
						// `part` is typed as an Anthropic content block, but the
						// conversation history may also carry custom `reasoning`
						// blocks (used by non-Anthropic protocols) or Anthropic
						// `thinking` blocks that are not part of the SDK union.
						// Cast to the augmented union to access them while
						// preserving type safety for the rest of the block.
						const block = part as AssistantContentBlock
						if (block.type === "tool_use") {
							acc.toolMessages.push(block)
						} else if (block.type === "text") {
							acc.nonToolMessages.push(block)
						} else if (block.type === "reasoning") {
							// Non-Anthropic protocols store reasoning as a block
							// with a `text` field. Pass it back so Ollama can
							// preserve thinking context across turns.
							if (block.text.length > 0) {
								acc.reasoningText += (acc.reasoningText ? "\n" : "") + block.text
							}
						} else if (block.type === "thinking") {
							// Anthropic-protocol thinking blocks carry `thinking`.
							if (block.thinking.length > 0) {
								acc.reasoningText += (acc.reasoningText ? "\n" : "") + block.thinking
							}
						} // assistant cannot send tool_result messages
						return acc
					},
					{ nonToolMessages: [], toolMessages: [], reasoningText: "" },
				)

				// Process non-tool messages
				let content: string = ""
				if (nonToolMessages.length > 0) {
					content = nonToolMessages.map((part) => part.text).join("\n")
				}

				// Convert tool_use blocks to Ollama tool_calls format
				const toolCalls =
					toolMessages.length > 0
						? toolMessages.map((tool) => {
								// Track tool use ID → name so tool results can use the "tool" role
								toolUseIdToName.set(tool.id, tool.name)
								return {
									function: {
										name: tool.name,
										arguments: tool.input as Record<string, unknown>,
									},
								}
							})
						: undefined

				ollamaMessages.push({
					role: "assistant",
					content,
					tool_calls: toolCalls,
					// Round-trip prior reasoning so multi-turn thinking is preserved.
					thinking: reasoningText || undefined,
				})
			}
		}
	}

	return ollamaMessages
}

export class NativeOllamaHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	protected models: Record<string, ModelInfo> = {}

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
	}

	/**
	 * Creates a new Ollama client instance with the configured options.
	 * Uses constructor `headers` option for API key instead of mutating config.
	 * The per-request transport makes both the in-flight POST and the response
	 * body cancellable; see the inline rationale.
	 */
	private _createOllamaClient(requestSignal: AbortSignal): Ollama {
		const clientOptions: OllamaOptions = {
			host: this.options.ollamaBaseUrl || "http://localhost:11434",
			// Note: The ollama npm package handles timeouts internally
		}

		// Add API key if provided (for Ollama cloud or authenticated instances).
		// Use constructor `headers` option instead of mutating (request as any).config.
		// The credential is only attached when the endpoint is HTTPS or loopback;
		// sending it over plaintext HTTP to a remote host would leak it (CWE-319).
		if (this.options.ollamaApiKey && isSecureOllamaEndpoint(clientOptions.host)) {
			clientOptions.headers = {
				Authorization: `Bearer ${this.options.ollamaApiKey}`,
			}
		}

		// The Ollama SDK (0.6.x) only tracks streaming iterators after the POST
		// resolves and passes no signal for stream:false requests, so client
		// .abort() alone cannot cancel an in-flight POST. The client always
		// receives a per-request transport that merges the request signal into
		// the SDK's fetch calls while preserving the SDK's own stream signal when
		// present (AbortSignal.any honors either side).
		const baseFetch = globalThis.fetch
		clientOptions.fetch = (url, init) => {
			const signal = init?.signal ? AbortSignal.any([init.signal, requestSignal]) : requestSignal
			return baseFetch(url, { ...init, signal })
		}

		return new Ollama(clientOptions)
	}

	/**
	 * Recursively strips `additionalProperties` from a JSON schema (including
	 * nested `properties` objects and `items` arrays). `additionalProperties`
	 * is not part of Ollama's tool schema definition and can break tool-calling
	 * templates on some models, so it must be removed at every nesting level.
	 */
	private stripAdditionalProperties(schema: unknown): unknown {
		if (!schema || typeof schema !== "object") {
			return schema
		}
		if (Array.isArray(schema)) {
			return schema.map((item) => this.stripAdditionalProperties(item))
		}
		const result: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(schema)) {
			if (key === "additionalProperties") {
				continue
			}
			result[key] = this.stripAdditionalProperties(value)
		}
		return result
	}

	/**
	 * Converts OpenAI-format tools to Ollama's native tool format.
	 * This allows NativeOllamaHandler to use the same tool definitions
	 * that are passed to OpenAI-compatible providers.
	 */
	private convertToolsToOllama(tools: OpenAI.Chat.ChatCompletionTool[] | undefined): OllamaTool[] | undefined {
		if (!tools || tools.length === 0) {
			return undefined
		}

		return tools
			.filter((tool): tool is OpenAI.Chat.ChatCompletionTool & { type: "function" } => tool.type === "function")
			.map((tool) => {
				// Recursively strip additionalProperties from the parameters schema
				// (top-level and nested). This field is not part of Ollama's tool
				// schema definition and can cause issues with some models'
				// tool-calling templates.
				const rawParams = tool.function.parameters as Record<string, unknown> | undefined
				const parameters = rawParams ? this.stripAdditionalProperties(rawParams) : undefined
				return {
					type: tool.type,
					function: {
						name: tool.function.name,
						description: tool.function.description,
						parameters: parameters as OllamaTool["function"]["parameters"],
					},
				}
			})
	}

	/**
	 * Maps the configured reasoning effort setting to Ollama's native `think`
	 * request parameter (boolean | "high" | "medium" | "low").
	 *
	 * Requires an explicit Ollama opt-in (`enableReasoningEffort === true`)
	 * before translating `reasoningEffort`. This prevents inherited
	 * `apiConfiguration.reasoningEffort` values (left over from another
	 * provider) from silently emitting a `think` param when the Ollama UI
	 * checkbox is unchecked.
	 *
	 * Returns undefined when reasoning is not explicitly enabled, leaving
	 * the model/Modelfile in control (preserving prior behavior where models
	 * that emit think/thought tags in content are still handled by TagMatcher).
	 *
	 * Note: The Ollama API itself also accepts `"max"` (see
	 * https://docs.ollama.com/capabilities/thinking), but the installed
	 * `ollama` SDK (v0.6.x) only types `think` as
	 * `boolean | "high" | "medium" | "low"`. Until the SDK types catch up,
	 * "xhigh"/"max" efforts are clamped to "high".
	 *
	 * - enableReasoningEffort !== true -> undefined (no think param sent)
	 * - "disable" -> false (thinking off)
	 * - "none" / "minimal" -> true (enable thinking with default budget)
	 * - "low" / "medium" / "high" -> the matching effort level
	 * - "xhigh" / "max" -> "high" (highest level the SDK currently supports)
	 */
	private getOllamaThinkParam(): boolean | "high" | "medium" | "low" | undefined {
		// Require an explicit Ollama opt-in before mapping reasoningEffort.
		// Without this guard, a stale reasoningEffort inherited from another
		// provider config could still emit a think param when the UI checkbox
		// is unchecked.
		if (this.options.enableReasoningEffort !== true) {
			return undefined
		}

		const effort = this.options.reasoningEffort
		if (effort === undefined) {
			return undefined
		}

		switch (effort) {
			case "disable":
				return false
			case "none":
			case "minimal":
				return true
			case "low":
				return "low"
			case "medium":
				return "medium"
			case "high":
			case "xhigh":
			case "max":
				return "high"
			default:
				return undefined
		}
	}

	/**
	 * Builds the shared chat request options (temperature, num_ctx) and the
	 * conditional `think` parameter used by both `createMessage` and
	 * `completePrompt`. Centralizing this avoids drift between the streaming
	 * and single-shot request paths.
	 *
	 * Returns a tuple of `[chatOptions, thinkParam]` where `thinkParam` is
	 * `undefined` when no `think` field should be sent to Ollama.
	 */
	private buildChatRequestOptions(
		useR1Format: boolean,
	): [OllamaChatOptions, boolean | "high" | "medium" | "low" | undefined] {
		const chatOptions: OllamaChatOptions = {
			temperature: this.options.modelTemperature ?? (useR1Format ? DEEP_SEEK_DEFAULT_TEMPERATURE : 0),
		}

		// Only include num_ctx if explicitly set via ollamaNumCtx
		if (this.options.ollamaNumCtx !== undefined) {
			chatOptions.num_ctx = this.options.ollamaNumCtx
		}

		const thinkParam = this.getOllamaThinkParam()
		return [chatOptions, thinkParam]
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// The external abort signal drives both the per-request client and the
		// per-request transport for this request, since the Ollama SDK exposes
		// cancellation only through the client-level abort() and the fetch signal.
		const externalAbortSignal = metadata?.abortSignal
		if (externalAbortSignal?.aborted) {
			// The request is already cancelled: reject before allocating the
			// per-request client or transport so nothing is left to clean up.
			throw createAbortError()
		}

		const requestController = new AbortController()
		const client = this._createOllamaClient(requestController.signal)

		let onExternalAbort: (() => void) | undefined
		try {
			if (externalAbortSignal) {
				onExternalAbort = () => {
					requestController.abort()
					client.abort()
				}
				externalAbortSignal.addEventListener("abort", onExternalAbort)
			}

			// Race model discovery against the external signal: the SDK's model
			// fetch accepts no signal, so a request aborted during discovery must
			// reject instead of proceeding to chat() with a stale model.
			const { id: modelId } = await raceWithAbortSignal(this.fetchModel(), externalAbortSignal)
			// Stryker disable next-line MethodExpression,StringLiteral: DEEP_SEEK_DEFAULT_TEMPERATURE (0.0) is numerically equal to the 0 fallback, so the R1 check cannot change the emitted temperature
			const useR1Format = modelId.toLowerCase().includes("deepseek-r1")

			const ollamaMessages: Message[] = [
				{ role: "system", content: systemPrompt },
				...convertToOllamaMessages(messages),
			]

			const matcher = new TagMatcher(
				["think", "thought"],
				(chunk) =>
					({
						type: chunk.matched ? "reasoning" : "text",
						text: chunk.data,
					}) as const,
			)

			// Build the shared chat options and conditional think parameter.
			// Conditionally enabling Ollama's native think parameter lets
			// reasoning models (qwen3, deepseek-r1, etc.) emit thinking via
			// the dedicated message.thinking field instead of (or in addition
			// to) think/thought tags embedded in content.
			const [chatOptions, thinkParam] = this.buildChatRequestOptions(useR1Format)

			// Create the actual API request promise. The `stream: true` literal
			// is kept inline so TypeScript selects the streaming overload of
			// client.chat. The `think` parameter is spread conditionally to
			// avoid sending an explicit `think: undefined` to the runtime.
			const stream = await client.chat({
				model: modelId,
				messages: ollamaMessages,
				stream: true,
				options: chatOptions,
				tools: this.convertToolsToOllama(metadata?.tools),
				...(thinkParam !== undefined ? { think: thinkParam } : {}),
			})

			// The POST can resolve in the same instant the abort lands (response
			// headers arrived first). In that case the iterator must be disposed
			// instead of being consumed after cancellation.
			if (externalAbortSignal?.aborted) {
				stream.abort()
				throw createAbortError()
			}

			let totalInputTokens = 0
			let totalOutputTokens = 0
			// Track tool calls across chunks (Ollama may send complete tool_calls in final chunk)
			let toolCallIndex = 0
			// Track tool call IDs for emitting end events
			const toolCallIds: string[] = []

			try {
				for await (const chunk of stream) {
					// Process Ollama's native thinking field. When the think
					// parameter is enabled (or the model thinks by default),
					// Ollama streams reasoning via message.thinking separately
					// from message.content. Surface it as a reasoning chunk so
					// it is rendered and preserved like other providers.
					if (typeof chunk.message.thinking === "string" && chunk.message.thinking.length > 0) {
						yield {
							type: "reasoning",
							text: chunk.message.thinking,
						}
					}

					if (typeof chunk.message.content === "string" && chunk.message.content.length > 0) {
						// Process content through matcher for reasoning detection
						for (const matcherChunk of matcher.update(chunk.message.content)) {
							yield matcherChunk
						}
					}

					// Handle tool calls - emit partial chunks for NativeToolCallParser compatibility
					if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
						for (const toolCall of chunk.message.tool_calls) {
							// Generate a unique ID for this tool call
							const toolCallId = `ollama-tool-${toolCallIndex}`
							toolCallIds.push(toolCallId)
							yield {
								type: "tool_call_partial",
								index: toolCallIndex,
								id: toolCallId,
								name: toolCall.function.name,
								arguments: JSON.stringify(toolCall.function.arguments),
							}
							toolCallIndex++
						}
					}

					// Handle token usage if available
					if (chunk.eval_count !== undefined || chunk.prompt_eval_count !== undefined) {
						if (chunk.prompt_eval_count) {
							totalInputTokens = chunk.prompt_eval_count
						}
						if (chunk.eval_count) {
							totalOutputTokens = chunk.eval_count
						}
					}
				}

				// Yield any remaining content from the matcher
				for (const chunk of matcher.final()) {
					yield chunk
				}

				for (const toolCallId of toolCallIds) {
					yield {
						type: "tool_call_end",
						id: toolCallId,
					}
				}

				// Yield usage information if available
				if (totalInputTokens > 0 || totalOutputTokens > 0) {
					yield {
						type: "usage",
						inputTokens: totalInputTokens,
						outputTokens: totalOutputTokens,
					}
				}
			} catch (streamError: any) {
				// A body read aborted by the per-request transport surfaces as an
				// AbortError DOMException; keep its name unmodified (same contract
				// as the outer catch) so callers can identify cancellations.
				if (streamError instanceof Error && streamError.name === "AbortError") {
					throw streamError
				}
				console.error("Error processing Ollama stream:", streamError)
				throw new Error(`Ollama stream processing error: ${streamError.message || "Unknown error"}`)
			}
		} catch (error: any) {
			// Let AbortError surface unmodified so callers can identify cancellations
			// by `name === "AbortError"`; every other error keeps the historical wrap.
			if (error instanceof Error && error.name === "AbortError") {
				throw error
			}

			// Enhance error reporting
			const statusCode = error.status || error.statusCode
			const errorMessage = error.message || "Unknown error"

			if (error.code === "ECONNREFUSED") {
				throw new Error(
					`Ollama service is not running at ${this.options.ollamaBaseUrl || "http://localhost:11434"}. Please start Ollama first.`,
				)
			} else if (statusCode === 404) {
				throw new Error(
					`Model ${this.getModel().id} not found in Ollama. Please pull the model first with: ollama pull ${this.getModel().id}`,
				)
			}

			console.error(`Ollama API error (${statusCode || "unknown"}): ${errorMessage}`)
			throw error
		} finally {
			// Detach the external-signal listener so it cannot outlive this request,
			// including when model discovery rejects before the chat request starts.
			// Stryker disable next-line LogicalOperator: onExternalAbort is only assigned when externalAbortSignal is present, so || is equivalent
			if (onExternalAbort && externalAbortSignal) {
				externalAbortSignal.removeEventListener("abort", onExternalAbort)
			}
			// A consumer that stops iterating early (break/return) would otherwise
			// leave the in-flight response body open, and when metadata.abortSignal
			// is undefined no abort bridge exists at all. The per-request controller
			// drives the injected fetch transport, so aborting it here releases the
			// body; after normal completion the abort is a no-op.
			requestController.abort()
		}
	}

	async fetchModel() {
		this.models = await getOllamaModels(this.options.ollamaBaseUrl, this.options.ollamaApiKey)
		return this.getModel()
	}

	override getModel(): { id: string; info: ModelInfo } {
		const modelId = this.options.ollamaModelId || ""
		return {
			id: modelId,
			info: this.models[modelId] || openAiModelInfoSaneDefaults,
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		// Ollama native client cancellation calls client.abort(), so any request with
		// cancellation behavior must use a dedicated client instance to avoid aborting
		// unrelated requests sharing a provider-level client. The Ollama SDK has no
		// per-call signal, so every request uses a per-request client. The
		// per-request controller drives the abortable transport injected into the
		// client, so the in-flight POST itself is cancellable.
		const requestController = new AbortController()
		const client = this._createOllamaClient(requestController.signal)
		let timeoutId: ReturnType<typeof setTimeout> | undefined
		let onAbort: (() => void) | undefined
		const abortSignal = options?.abortSignal

		try {
			// Handle timeoutMs if provided (client already exists above, so the
			// timer can abort both the per-request transport and the client)
			if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
				timeoutId = setTimeout(() => {
					requestController.abort()
					client.abort()
				}, options.timeoutMs)
			}

			// Propagate abortSignal into the per-request client via client.abort()
			// and the per-request transport. Set this up before fetchModel() so an
			// already-aborted signal (or one that aborts during the model-list
			// fetch) is honored before the request proceeds.
			if (abortSignal) {
				if (abortSignal.aborted) {
					requestController.abort()
					client.abort()
					throw createAbortError()
				} else {
					onAbort = () => {
						requestController.abort()
						client.abort()
						// The per-request timeout is cleared by the finally block when this prompt
						// settles; an external abort always settles it promptly (the discovery race
						// or the injected transport rejects), so no timer clear is needed here.
					}
					abortSignal.addEventListener("abort", onAbort, { once: true })
				}
			}

			// Model discovery goes through Axios (getOllamaModels) and never touches
			// the Ollama client, so client.abort() alone cannot reject it. Race
			// discovery against the per-request signal (bridged from the external
			// abort) and the per-request timeout so a stalled discovery rejects
			// instead of hanging past the deadline.
			const discoverySignal = mergeAbortSignalAndTimeout(requestController.signal, options?.timeoutMs)
			const { id: modelId } = await raceWithAbortSignal(this.fetchModel(), discoverySignal)

			const useR1Format = modelId.toLowerCase().includes("deepseek-r1")

			// Reuse the shared request-option builder so single-shot
			// completions respect the same reasoning configuration as the
			// streaming path.
			const [chatOptions, thinkParam] = this.buildChatRequestOptions(useR1Format)

			const response = await client.chat({
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
				options: chatOptions,
				...(thinkParam !== undefined ? { think: thinkParam } : {}),
			})

			return response.message?.content || ""
		} catch (error) {
			// Let AbortError surface unmodified so callers can identify cancellations
			// by `name === "AbortError"`; every other error keeps the historical wrap.
			if (error instanceof Error && error.name !== "AbortError") {
				throw new Error(`Ollama completion error: ${error.message}`)
			}
			throw error
		} finally {
			clearTimeout(timeoutId)
			// Stryker disable next-line LogicalOperator: onAbort is only assigned when abortSignal is present, so || is equivalent
			if (onAbort && abortSignal) {
				abortSignal.removeEventListener("abort", onAbort)
			}
		}
	}
}
