import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import OpenAI from "openai"

import {
	type ModelInfo,
	openAiModelInfoSaneDefaults,
	providerIdentifiers,
	vscodeLlmDefaultModelId,
	vscodeLlmModels,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { SELECTOR_SEPARATOR, stringifyVsCodeLmModelSelector } from "../../shared/vsCodeSelectorUtils"
import { normalizeToolSchema } from "../../utils/json-schema"

import { ApiStream } from "../transform/stream"
import { convertToVsCodeLmMessages, extractTextCountFromMessage } from "../transform/vscode-lm-format"

import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"

/**
 * Converts OpenAI-format tools to VSCode Language Model tools.
 * Normalizes the JSON Schema to draft 2020-12 compliant format required by
 * GitHub Copilot's backend, converting type: ["T", "null"] to anyOf format.
 * @param tools Array of OpenAI ChatCompletionTool definitions
 * @returns Array of VSCode LanguageModelChatTool definitions
 */
function convertToVsCodeLmTools(tools: OpenAI.Chat.ChatCompletionTool[]): vscode.LanguageModelChatTool[] {
	return tools
		.filter((tool) => tool.type === "function")
		.map((tool) => ({
			name: tool.function.name,
			description: tool.function.description || "",
			inputSchema: tool.function.parameters
				? normalizeToolSchema(tool.function.parameters as Record<string, unknown>)
				: undefined,
		}))
}

/**
 * Handles interaction with VS Code's Language Model API for chat-based operations.
 * This handler extends BaseProvider to provide VS Code LM specific functionality.
 *
 * @extends {BaseProvider}
 *
 * @remarks
 * The handler manages a VS Code language model chat client and provides methods to:
 * - Create and manage chat client instances
 * - Stream messages using VS Code's Language Model API
 * - Retrieve model information
 *
 * @example
 * ```typescript
 * const options = {
 *   vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-4" }
 * };
 * const handler = new VsCodeLmHandler(options);
 *
 * // Stream a conversation
 * const systemPrompt = "You are a helpful assistant";
 * const messages = [{ role: "user", content: "Hello!" }];
 * for await (const chunk of handler.createMessage(systemPrompt, messages)) {
 *   console.log(chunk);
 * }
 * ```
 */
/**
 * Context-window safety for Copilot's backend
 * -------------------------------------------
 * Copilot's backend enforces its own context window and, for third-party `sendRequest` callers,
 * trims an over-window request in a way that is NOT tool-pair-aware: it can drop the assistant
 * message holding a `tool_use` while keeping the matching `tool_result`, after which Anthropic
 * rejects the request with "unexpected tool_use_id". To keep trimming on OUR side â€” where
 * pairing is preserved â€” we shrink oversized `tool_result` payloads before sending. Only
 * `tool_result` text is truncated (never `tool_use`, assistant text, summaries, or environment
 * details), and only when the request would otherwise exceed the budget.
 */

/**
 * Conservative characters-per-token ratio used to turn a token window into a character budget.
 *
 * `client.countTokens` is the model's real tokenizer, but it counts only a string: it cannot price
 * the tool schemas, image placeholders, or per-message framing the backend adds, so it cannot give
 * the true total for the request we are about to send. It is also an async, per-call RPC, and the
 * budget is needed for every message on every turn. We therefore keep a character estimate here
 * and stay deliberately conservative â€” 3 chars/token rather than the ~4 typical of English â€”
 * because the token-dense JSON, logs, and code that dominate oversized tool results tokenize to
 * fewer characters per token than prose. Under-counting biases toward trimming too early, which is
 * recoverable; over-counting sends an over-window request, which is not.
 */
const VSCODE_LM_BUDGET_CHARS_PER_TOKEN = 3

/**
 * Fraction of the context window the *entire* input (system prompt + tool schemas + conversation)
 * is allowed to occupy. The remaining headroom absorbs char/token estimation variance and any
 * output/overhead the backend reserves.
 */
const VSCODE_LM_INPUT_BUDGET_FRACTION = 0.8

/** A tool_result is never shrunk below this many characters, so a truncated result stays useful. */
const MIN_TOOL_RESULT_CHARS = 2000

/**
 * Length charged for an image block. VS Code LM cannot carry image data, so
 * `convertToVsCodeLmMessages` replaces each image with a sentence-long textual placeholder; this
 * is that placeholder's approximate length.
 */
const IMAGE_PLACEHOLDER_CHARS = 64

function readToolResultText(block: Anthropic.Messages.ContentBlockParam): string | undefined {
	if (!block || (block as { type?: string }).type !== "tool_result") {
		return undefined
	}
	const content = (block as Anthropic.Messages.ToolResultBlockParam).content
	if (typeof content === "string") {
		return content
	}
	if (Array.isArray(content)) {
		return content
			.filter((part): part is Anthropic.Messages.TextBlockParam => (part as { type?: string })?.type === "text")
			.map((part) => part.text ?? "")
			.join("")
	}
	return undefined
}

function writeToolResultText(block: Anthropic.Messages.ContentBlockParam, text: string): void {
	const toolResult = block as Anthropic.Messages.ToolResultBlockParam
	const content = toolResult.content
	if (Array.isArray(content)) {
		// Preserve any non-text parts (e.g. images) and collapse the text into one truncated part.
		const nonText = content.filter((part) => (part as { type?: string })?.type !== "text")
		toolResult.content = [{ type: "text", text }, ...nonText] as typeof content
		return
	}
	toolResult.content = text
}

/**
 * Middle-out truncate `text` to at most `maxChars`, keeping the head and tail and replacing the
 * middle with a marker noting how many characters were removed. Head/tail are preserved because
 * logs and file dumps carry the most signal at their start (structure) and end (recent output).
 */
export function middleOutTruncate(text: string, maxChars: number): string {
	if (maxChars <= 0) {
		return ""
	}
	if (text.length <= maxChars) {
		return text
	}

	const buildMarker = (removed: number) =>
		`\n\n[... ${removed.toLocaleString("en-US")} characters truncated to fit the model context window ...]\n\n`

	// Reserve room for the marker, sized against the original length so the result never grows.
	const reservedMarkerLength = buildMarker(text.length).length
	const keep = Math.max(0, maxChars - reservedMarkerLength)
	const headLength = Math.ceil(keep / 2)
	const tailLength = keep - headLength
	let head = text.slice(0, headLength)
	// Don't end the head on a lone high surrogate â€” its low half is in the removed middle, and a lone
	// surrogate cannot be encoded as UTF-8 (the backend 400s the whole request). Drop the split half.
	if (head.length > 0 && (head.charCodeAt(head.length - 1) & 0xfc00) === 0xd800) {
		head = head.slice(0, -1)
	}
	let tail = tailLength > 0 ? text.slice(text.length - tailLength) : ""
	// Likewise, don't start the tail on a lone low surrogate (its high half is in the removed middle).
	if (tail.length > 0 && (tail.charCodeAt(0) & 0xfc00) === 0xdc00) {
		tail = tail.slice(1)
	}
	const removed = text.length - head.length - tail.length
	return `${head}${buildMarker(removed)}${tail}`
}

/** Estimated character cost of a whole conversation, using the same accounting as truncation. */
export function estimateMessagesChars(messages: Anthropic.Messages.MessageParam[]): number {
	return messages.reduce((sum, message) => sum + estimateContentChars(message.content), 0)
}

function estimateContentChars(content: Anthropic.Messages.MessageParam["content"]): number {
	if (typeof content === "string") {
		return content.length
	}
	if (!Array.isArray(content)) {
		return 0
	}
	let total = 0
	for (const block of content) {
		const type = (block as { type?: string })?.type
		if (type === "text") {
			total += (block as Anthropic.Messages.TextBlockParam).text?.length ?? 0
		} else if (type === "tool_result") {
			total += readToolResultText(block)?.length ?? 0
		} else if (type === "tool_use") {
			total += JSON.stringify((block as Anthropic.Messages.ToolUseBlockParam).input ?? {}).length
		} else if (type === "image") {
			// VS Code LM cannot send image data; convertToVsCodeLmMessages substitutes a textual
			// placeholder, so charge that placeholder's real length rather than a token-sized guess.
			total += IMAGE_PLACEHOLDER_CHARS
		}
	}
	return total
}

/**
 * Shrinks oversized `tool_result` payloads (largest first, middle-out) until the conversation fits
 * `budgetChars`. Mutates the tool_result blocks of the supplied messages in place â€” callers pass a
 * cloned array (see `createMessage`) so stored history is never mutated. A no-op when the
 * conversation already fits.
 */
export function truncateToolResultsToFitWindow(
	messages: Anthropic.Messages.MessageParam[],
	budgetChars: number,
): Anthropic.Messages.MessageParam[] {
	if (!Number.isFinite(budgetChars) || budgetChars <= 0) {
		return messages
	}

	let total = messages.reduce((sum, message) => sum + estimateContentChars(message.content), 0)
	if (total <= budgetChars) {
		return messages
	}

	// Collect every truncatable tool_result block, largest first.
	const toolResultBlocks: Anthropic.Messages.ContentBlockParam[] = []
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue
		}
		for (const block of message.content) {
			if (readToolResultText(block) !== undefined) {
				toolResultBlocks.push(block)
			}
		}
	}
	toolResultBlocks.sort((a, b) => (readToolResultText(b)?.length ?? 0) - (readToolResultText(a)?.length ?? 0))

	for (const block of toolResultBlocks) {
		if (total <= budgetChars) {
			break
		}
		const text = readToolResultText(block)
		if (text === undefined || text.length <= MIN_TOOL_RESULT_CHARS) {
			continue
		}

		const overage = total - budgetChars
		const target = Math.max(MIN_TOOL_RESULT_CHARS, text.length - overage)
		if (target >= text.length) {
			continue
		}

		const truncated = middleOutTruncate(text, target)
		total -= text.length - truncated.length
		writeToolResultText(block, truncated)
	}

	return messages
}

export class VsCodeLmHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: vscode.LanguageModelChat | null
	private disposable: vscode.Disposable | null
	private currentRequestCancellation: vscode.CancellationTokenSource | null

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.client = null
		this.disposable = null
		this.currentRequestCancellation = null

		try {
			// Listen for model changes and reset client
			this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("lm")) {
					try {
						this.client = null
						this.ensureCleanState()
					} catch (error) {
						console.error("Error during configuration change cleanup:", error)
					}
				}
			})
			this.initializeClient()
		} catch (error) {
			// Ensure cleanup if constructor fails
			this.dispose()

			throw new Error(
				`Zoo Code <Language Model API>: Failed to initialize handler: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}
	/**
	 * Initializes the VS Code Language Model client.
	 * This method is called during the constructor to set up the client.
	 * This useful when the client is not created yet and call getModel() before the client is created.
	 * @returns Promise<void>
	 * @throws Error when client initialization fails
	 */
	async initializeClient(): Promise<void> {
		try {
			// Check if the client is already initialized
			if (this.client) {
				console.debug("Zoo Code <Language Model API>: Client already initialized")
				return
			}
			// Create a new client instance
			this.client = await this.createClient(this.options.vsCodeLmModelSelector || {})
			console.debug("Zoo Code <Language Model API>: Client initialized successfully")
		} catch (error) {
			// Handle errors during client initialization
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.error("Zoo Code <Language Model API>: Client initialization failed:", errorMessage)
			throw new Error(`Zoo Code <Language Model API>: Failed to initialize client: ${errorMessage}`)
		}
	}
	/**
	 * Creates a language model chat client based on the provided selector.
	 *
	 * @param selector - Selector criteria to filter language model chat instances
	 * @returns Promise resolving to the first matching language model chat instance
	 * @throws Error when no matching models are found with the given selector
	 *
	 * @example
	 * const selector = { vendor: "copilot", family: "gpt-4o" };
	 * const chatClient = await createClient(selector);
	 */
	async createClient(selector: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat> {
		try {
			const models = await vscode.lm.selectChatModels(selector)

			// Use first available model or create a minimal model object
			if (models && Array.isArray(models) && models.length > 0) {
				return models[0]
			}

			// Create a minimal model if no models are available
			return {
				id: "default-lm",
				name: "Default Language Model",
				vendor: "vscode",
				family: "lm",
				version: "1.0",
				maxInputTokens: 8192,
				sendRequest: async (_messages, _options, _token) => {
					// Provide a minimal implementation
					return {
						stream: (async function* () {
							yield new vscode.LanguageModelTextPart(
								"Language model functionality is limited. Please check VS Code configuration.",
							)
						})(),
						text: (async function* () {
							yield "Language model functionality is limited. Please check VS Code configuration."
						})(),
					}
				},
				countTokens: async () => 0,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			throw new Error(`Zoo Code <Language Model API>: Failed to select model: ${errorMessage}`)
		}
	}

	/**
	 * Creates and streams a message using the VS Code Language Model API.
	 *
	 * @param systemPrompt - The system prompt to initialize the conversation context
	 * @param messages - An array of message parameters following the Anthropic message format
	 * @param metadata - Optional metadata for the message
	 *
	 * @yields {ApiStream} An async generator that yields either text chunks or tool calls from the model response
	 *
	 * @throws {Error} When vsCodeLmModelSelector option is not provided
	 * @throws {Error} When the response stream encounters an error
	 *
	 * @remarks
	 * This method handles the initialization of the VS Code LM client if not already created,
	 * converts the messages to VS Code LM format, and streams the response chunks.
	 * Tool calls handling is currently a work in progress.
	 */
	dispose(): void {
		if (this.disposable) {
			this.disposable.dispose()
		}

		if (this.currentRequestCancellation) {
			this.currentRequestCancellation.cancel()
			this.currentRequestCancellation.dispose()
		}
	}

	/**
	 * Implements the ApiHandler countTokens interface method
	 * Provides token counting for Anthropic content blocks
	 *
	 * @param content The content blocks to count tokens for
	 * @returns A promise resolving to the token count
	 */
	override async countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		// Convert Anthropic content blocks to a string for VSCode LM token counting
		let textContent = ""

		for (const block of content) {
			if (block.type === "text") {
				textContent += block.text || ""
			} else if (block.type === "image") {
				// VSCode LM doesn't support images directly, so we'll just use a placeholder
				textContent += "[IMAGE]"
			}
		}

		return this.internalCountTokens(textContent)
	}

	/**
	 * Private implementation of token counting used internally by VsCodeLmHandler
	 */
	private async internalCountTokens(text: string | vscode.LanguageModelChatMessage): Promise<number> {
		// Check for required dependencies
		if (!this.client) {
			console.warn("Zoo Code <Language Model API>: No client available for token counting")
			return 0
		}

		// Validate input
		if (!text) {
			console.debug("Zoo Code <Language Model API>: Empty text provided for token counting")
			return 0
		}

		// Create a temporary cancellation token if we don't have one (e.g., when called outside a request)
		let cancellationToken: vscode.CancellationToken
		let tempCancellation: vscode.CancellationTokenSource | null = null

		if (this.currentRequestCancellation) {
			cancellationToken = this.currentRequestCancellation.token
		} else {
			tempCancellation = new vscode.CancellationTokenSource()
			cancellationToken = tempCancellation.token
		}

		try {
			// Handle different input types
			let tokenCount: number

			if (typeof text === "string") {
				tokenCount = await this.client.countTokens(text, cancellationToken)
			} else if (text instanceof vscode.LanguageModelChatMessage) {
				// For chat messages, ensure we have content
				if (!text.content || (Array.isArray(text.content) && text.content.length === 0)) {
					console.debug("Zoo Code <Language Model API>: Empty chat message content")
					return 0
				}
				const countMessage = extractTextCountFromMessage(text)
				tokenCount = await this.client.countTokens(countMessage, cancellationToken)
			} else {
				console.warn("Zoo Code <Language Model API>: Invalid input type for token counting")
				return 0
			}

			// Validate the result
			if (typeof tokenCount !== "number") {
				console.warn("Zoo Code <Language Model API>: Non-numeric token count received:", tokenCount)
				return 0
			}

			if (tokenCount < 0) {
				console.warn("Zoo Code <Language Model API>: Negative token count received:", tokenCount)
				return 0
			}

			return tokenCount
		} catch (error) {
			// Handle specific error types
			if (error instanceof vscode.CancellationError) {
				console.debug("Zoo Code <Language Model API>: Token counting cancelled by user")
				return 0
			}

			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.warn("Zoo Code <Language Model API>: Token counting failed:", errorMessage)

			// Log additional error details if available
			if (error instanceof Error && error.stack) {
				console.debug("Token counting error stack:", error.stack)
			}

			return 0 // Fallback to prevent stream interruption
		} finally {
			// Clean up temporary cancellation token
			if (tempCancellation) {
				tempCancellation.dispose()
			}
		}
	}

	private async calculateTotalInputTokens(vsCodeLmMessages: vscode.LanguageModelChatMessage[]): Promise<number> {
		const messageTokens: number[] = await Promise.all(vsCodeLmMessages.map((msg) => this.internalCountTokens(msg)))

		return messageTokens.reduce((sum: number, tokens: number): number => sum + tokens, 0)
	}

	private ensureCleanState(): void {
		if (this.currentRequestCancellation) {
			this.currentRequestCancellation.cancel()
			this.currentRequestCancellation.dispose()
			this.currentRequestCancellation = null
		}
	}

	private async getClient(): Promise<vscode.LanguageModelChat> {
		if (!this.client) {
			console.debug("Zoo Code <Language Model API>: Getting client with options:", {
				vsCodeLmModelSelector: this.options.vsCodeLmModelSelector,
				hasOptions: !!this.options,
				selectorKeys: this.options.vsCodeLmModelSelector ? Object.keys(this.options.vsCodeLmModelSelector) : [],
			})

			try {
				// Use default empty selector if none provided to get all available models
				const selector = this.options?.vsCodeLmModelSelector || {}
				console.debug("Zoo Code <Language Model API>: Creating client with selector:", selector)
				this.client = await this.createClient(selector)
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error"
				console.error("Zoo Code <Language Model API>: Client creation failed:", message)
				throw new Error(`Zoo Code <Language Model API>: Failed to create client: ${message}`)
			}
		}

		return this.client
	}

	private cleanMessageContent(
		content: Anthropic.Messages.MessageParam["content"],
	): Anthropic.Messages.MessageParam["content"] {
		return this.deepClean(content) as Anthropic.Messages.MessageParam["content"]
	}

	private deepClean(value: unknown): unknown {
		if (!value) {
			return value
		}

		if (typeof value === "string") {
			return value
		}

		if (Array.isArray(value)) {
			return value.map((item) => this.deepClean(item))
		}

		if (typeof value === "object") {
			const cleaned: Record<string, unknown> = {}
			for (const [key, v] of Object.entries(value)) {
				cleaned[key] = this.deepClean(v)
			}
			return cleaned
		}

		return value
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Ensure clean state before starting a new request
		this.ensureCleanState()
		const client: vscode.LanguageModelChat = await this.getClient()

		// Process messages
		const cleanedMessages = messages.map((msg) => ({
			...msg,
			content: this.cleanMessageContent(msg.content),
		}))

		// Keep context-window trimming on OUR side. Copilot's backend trims an over-window request
		// without preserving tool_use/tool_result pairing, which orphans a tool_result and triggers a
		// 400 ("unexpected tool_use_id"). See truncateToolResultsToFitWindow.
		const contextWindowTokens = this.getCondenseContextWindow()
		if (Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
			const toolSchemaChars = metadata?.tools ? JSON.stringify(metadata.tools).length : 0
			const rawBudgetChars =
				contextWindowTokens * VSCODE_LM_INPUT_BUDGET_FRACTION * VSCODE_LM_BUDGET_CHARS_PER_TOKEN -
				systemPrompt.length -
				toolSchemaChars
			// A system prompt or tool schema large enough to consume the whole budget would leave a
			// non-positive budget, which disables trimming exactly when the request is most oversized.
			const messagesBudgetChars = Math.max(MIN_TOOL_RESULT_CHARS, rawBudgetChars)
			truncateToolResultsToFitWindow(cleanedMessages, messagesBudgetChars)

			// Shrinking tool_results cannot always reach the budget: each keeps MIN_TOOL_RESULT_CHARS,
			// and the excess may be non-tool content (a huge paste, tool_use inputs, or the system
			// prompt) that we must not touch. Dropping messages here would orphan a tool_result from
			// its tool_use — the exact 400 this guard exists to prevent — so fail loudly instead of
			// sending a request we already know is over the window.
			// Admission is judged against the RAW budget, not the clamped one: the clamp exists only
			// to keep trimming productive, so accepting up to it would send a request the window
			// genuinely cannot hold whenever the raw budget falls below MIN_TOOL_RESULT_CHARS.
			const remainingChars = estimateMessagesChars(cleanedMessages)
			if (remainingChars > rawBudgetChars) {
				throw new Error(
					"Zoo Code <Language Model API>: The request is too large for this model's context window " +
						`(estimated ${remainingChars.toLocaleString("en-US")} characters against a budget of ` +
						`${Math.max(0, Math.floor(rawBudgetChars)).toLocaleString("en-US")}), and it cannot be reduced further without ` +
						"breaking tool-call pairing. Condense the conversation or start a new task.",
				)
			}
		}

		// Convert Anthropic messages to VS Code LM messages
		const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.Assistant(systemPrompt),
			...convertToVsCodeLmMessages(cleanedMessages),
		]

		// Initialize cancellation token for the request
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		// Calculate input tokens before starting the stream
		const totalInputTokens: number = await this.calculateTotalInputTokens(vsCodeLmMessages)

		// Accumulate the text and count at the end of the stream to reduce token counting overhead.
		let accumulatedText: string = ""

		try {
			// Create the response stream with required options
			const requestOptions: vscode.LanguageModelChatRequestOptions = {
				justification: `Zoo Code would like to use '${client.name}' from '${client.vendor}', Click 'Allow' to proceed.`,
				tools: convertToVsCodeLmTools(metadata?.tools ?? []),
			}

			const response: vscode.LanguageModelChatResponse = await client.sendRequest(
				vsCodeLmMessages,
				requestOptions,
				this.currentRequestCancellation.token,
			)

			// Consume the stream and handle both text and tool call chunks
			for await (const chunk of response.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					// Validate text part value
					if (typeof chunk.value !== "string") {
						console.warn("Zoo Code <Language Model API>: Invalid text part value received:", chunk.value)
						continue
					}

					accumulatedText += chunk.value
					yield {
						type: "text",
						text: chunk.value,
					}
				} else if (chunk instanceof vscode.LanguageModelToolCallPart) {
					try {
						// Validate tool call parameters
						if (!chunk.name || typeof chunk.name !== "string") {
							console.warn("Zoo Code <Language Model API>: Invalid tool name received:", chunk.name)
							continue
						}

						if (!chunk.callId || typeof chunk.callId !== "string") {
							console.warn("Zoo Code <Language Model API>: Invalid tool callId received:", chunk.callId)
							continue
						}

						// Ensure input is a valid object
						if (!chunk.input || typeof chunk.input !== "object") {
							console.warn("Zoo Code <Language Model API>: Invalid tool input received:", chunk.input)
							continue
						}

						// Log tool call for debugging
						console.debug("Zoo Code <Language Model API>: Processing tool call:", {
							name: chunk.name,
							callId: chunk.callId,
							inputSize: JSON.stringify(chunk.input).length,
						})

						// Yield native tool_call chunk when tools are provided
						if (metadata?.tools?.length) {
							const argumentsString = JSON.stringify(chunk.input)
							accumulatedText += argumentsString
							yield {
								type: "tool_call",
								id: chunk.callId,
								name: chunk.name,
								arguments: argumentsString,
							}
						}
					} catch (error) {
						console.error("Zoo Code <Language Model API>: Failed to process tool call:", error)
						// Continue processing other chunks even if one fails
						continue
					}
				} else {
					console.warn("Zoo Code <Language Model API>: Unknown chunk type received:", chunk)
				}
			}

			// Count tokens in the accumulated text after stream completion
			const totalOutputTokens: number = await this.internalCountTokens(accumulatedText)

			// Report final usage after stream completion
			yield {
				type: "usage",
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
			}
		} catch (error: unknown) {
			this.ensureCleanState()

			if (error instanceof vscode.CancellationError) {
				throw new Error("Zoo Code <Language Model API>: Request cancelled by user")
			}

			if (error instanceof Error) {
				console.error("Zoo Code <Language Model API>: Stream error details:", {
					message: error.message,
					stack: error.stack,
					name: error.name,
				})

				// Return original error if it's already an Error instance
				throw error
			} else if (typeof error === "object" && error !== null) {
				// Handle error-like objects
				const errorDetails = JSON.stringify(error, null, 2)
				console.error("Zoo Code <Language Model API>: Stream error object:", errorDetails)
				throw new Error(`Zoo Code <Language Model API>: Response stream error: ${errorDetails}`)
			} else {
				// Fallback for unknown error types
				const errorMessage = String(error)
				console.error("Zoo Code <Language Model API>: Unknown stream error:", errorMessage)
				throw new Error(`Zoo Code <Language Model API>: Response stream error: ${errorMessage}`)
			}
		}
	}

	// Return model information based on the current client state
	override getModel(): { id: string; info: ModelInfo } {
		if (this.client) {
			// Validate client properties
			const requiredProps = {
				id: this.client.id,
				vendor: this.client.vendor,
				family: this.client.family,
				version: this.client.version,
				maxInputTokens: this.client.maxInputTokens,
			}

			// Log any missing properties for debugging
			for (const [prop, value] of Object.entries(requiredProps)) {
				if (!value && value !== 0) {
					console.warn(`Zoo Code <Language Model API>: Client missing ${prop} property`)
				}
			}

			// Construct model ID using available information
			const modelParts = [this.client.vendor, this.client.family, this.client.version].filter(Boolean)

			const modelId = this.client.id || modelParts.join(SELECTOR_SEPARATOR)

			// Build model info with conservative defaults for missing values
			const modelInfo: ModelInfo = {
				maxTokens: -1, // Unlimited tokens by default
				contextWindow:
					typeof this.client.maxInputTokens === "number"
						? Math.max(0, this.client.maxInputTokens)
						: openAiModelInfoSaneDefaults.contextWindow,
				supportsImages: false, // VSCode Language Model API currently doesn't support image inputs
				supportsPromptCache: true,
				inputPrice: 0,
				outputPrice: 0,
				description: `VSCode Language Model: ${modelId}`,
			}

			return { id: modelId, info: modelInfo }
		}

		// Fallback when no client is available
		const fallbackId = this.options.vsCodeLmModelSelector
			? stringifyVsCodeLmModelSelector(this.options.vsCodeLmModelSelector)
			: providerIdentifiers.vscodeLm

		console.debug("Zoo Code <Language Model API>: No client available, using fallback model info")

		return {
			id: fallbackId,
			info: {
				...openAiModelInfoSaneDefaults,
				description: `VSCode Language Model (Fallback): ${fallbackId}`,
			},
		}
	}

	/**
	 * Context window for auto-condense. The API's advertised `client.maxInputTokens` is far larger
	 * than usable, so relying on it stops auto-condense from firing; measure against the curated
	 * static table's `maxInputTokens` instead (the same value the bar uses). An unknown family (e.g.
	 * a selector left over from a model dropped from the catalog) resolves to the default row rather
	 * than the inflated live window; only a non-positive static `maxInputTokens` falls back to it.
	 */
	getCondenseContextWindow(): number {
		const family = this.client?.family ?? this.options.vsCodeLmModelSelector?.family
		const staticModel = family
			? (vscodeLlmModels[family as keyof typeof vscodeLlmModels] ?? vscodeLlmModels[vscodeLlmDefaultModelId])
			: vscodeLlmModels[vscodeLlmDefaultModelId]

		if (staticModel && typeof staticModel.maxInputTokens === "number" && staticModel.maxInputTokens > 0) {
			return staticModel.maxInputTokens
		}

		return this.getModel().info.contextWindow
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		try {
			const client = await this.getClient()
			const response = await client.sendRequest(
				[vscode.LanguageModelChatMessage.User(prompt)],
				{},
				new vscode.CancellationTokenSource().token,
			)
			let result = ""
			for await (const chunk of response.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					result += chunk.value
				}
			}
			return result
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`VSCode LM completion error: ${error.message}`)
			}
			throw error
		}
	}
}

// Static blacklist of VS Code Language Model IDs that should be excluded from the model list e.g. because they will never work
const VSCODE_LM_STATIC_BLACKLIST: string[] = ["claude-3.7-sonnet", "claude-3.7-sonnet-thought"]

export async function getVsCodeLmModels() {
	try {
		const models = (await vscode.lm.selectChatModels({})) || []
		return models.filter((model) => !VSCODE_LM_STATIC_BLACKLIST.includes(model.id))
	} catch (error) {
		console.error(
			`Error fetching VS Code LM models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)
		return []
	}
}
