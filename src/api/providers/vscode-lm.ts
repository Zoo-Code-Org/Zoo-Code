import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import OpenAI from "openai"

import { type ModelInfo, openAiModelInfoSaneDefaults, vscodeLlmDefaultModelId, vscodeLlmModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { SELECTOR_SEPARATOR, stringifyVsCodeLmModelSelector } from "../../shared/vsCodeSelectorUtils"
import { normalizeToolSchema } from "../../utils/json-schema"

import { ApiStream, ApiStreamChunk } from "../transform/stream"
import {
	convertToVsCodeLmMessages,
	extractTextCountFromMessage,
	sanitizeSurrogates,
} from "../transform/vscode-lm-format"

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
 * Recovery for leaked tool calls
 * ------------------------------
 * Some VS Code LM backends — notably GitHub Copilot serving Anthropic Claude models —
 * intermittently stream a tool call as PLAIN TEXT using Anthropic's internal function-call
 * XML instead of emitting a structured `LanguageModelToolCallPart`. When this happens the
 * assistant turn contains no tool_use block, so Zoo reports "no tools used" and the task stalls
 * in a retry loop. The helpers below detect the leaked markup mid-stream and replay it as a real
 * tool call. Recovery is deliberately conservative: only `<invoke>` blocks whose name matches a
 * tool we actually offered this turn are treated as calls; everything else is passed through
 * unchanged as text.
 */
// Latching on a bare `<invoke` would let any prose mentioning the tag stop real-time streaming for
// the rest of the response, so the marker only counts once the `name="` attribute has arrived.
const LEAKED_TOOL_CALL_START = /<(?:antml:)?(?:function_calls\s*>|invoke\s+name=")/i
const LEAKED_INVOKE_BLOCK = /<(?:antml:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?invoke\s*>/gi
const LEAKED_INVOKE_PARAM = /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?parameter\s*>/gi

/** Upper bound on an incomplete `<invoke ...` tail held back between chunks. */
const MAX_PARTIAL_INVOKE_CARRY = 64

/**
 * Upper bound on buffered text held while waiting for a leaked `<invoke>` block to close. Markup
 * that never closes would otherwise withhold the whole response from the user until the stream
 * ended, so past this size the buffer is released as ordinary text.
 */
const MAX_SALVAGE_BUFFER_CHARS = 64 * MAX_PARTIAL_INVOKE_CARRY

/**
 * Same-line prose that introduces markup as an example rather than invoking it. This is a
 * deliberately narrow lexical cue: a quoted invoke that ENDS its line is otherwise
 * indistinguishable from a genuine leak, which is just as often preceded by prose.
 */
const QUOTING_CUE =
	/\b(?:never|not|do not|don't|does not|doesn't|must not|mustn't|avoid|instead of|rather than|for example|e\.g\.|such as|like this|as follows)\b[^.!?\n]*$/i

/**
 * True when `before` ends inside an open Markdown code fence. Tracks the fence character and its
 * width so tilde fences and fences of 4+ backticks (which may legally contain shorter fences) are
 * recognized, rather than counting three-backtick runs for parity.
 */
function isInsideCodeFence(before: string): boolean {
	let openFence: { marker: string; width: number } | null = null
	for (const line of before.split("\n")) {
		const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
		if (!fenceMatch) {
			continue
		}
		const marker = fenceMatch[1][0]
		const width = fenceMatch[1].length
		if (!openFence) {
			openFence = { marker, width }
		} else if (marker === openFence.marker && width >= openFence.width) {
			openFence = null
		}
	}
	return openFence !== null
}

/** True when `text` already contains a closed `<invoke>` block, so buffering is still productive. */
function hasCompleteInvokeBlock(text: string): boolean {
	LEAKED_INVOKE_BLOCK.lastIndex = 0
	const found = LEAKED_INVOKE_BLOCK.test(text)
	LEAKED_INVOKE_BLOCK.lastIndex = 0
	return found
}

/**
 * Strips well-formed tags repeatedly until the result stops changing. A single pass is unsafe:
 * `<<invoke>>` reassembles into a live-looking tag after one replacement.
 */
function stripTagsCompletely(text: string): string {
	let current = text
	for (;;) {
		const stripped = current.replace(/<[^<>]*>/g, "")
		if (stripped === current) {
			return stripped
		}
		current = stripped
	}
}

/**
 * Returns the length of a trailing fragment that might be the start of a leaked tool-call marker
 * split across stream chunks. Such a tail is held back until more text arrives so the marker can
 * be detected intact.
 */
export function trailingPartialToolMarkerLength(text: string): number {
	const partialTag = text.match(/<(?:antml:)?[a-zA-Z_]*$/)
	if (partialTag) {
		return partialTag[0].length <= MAX_PARTIAL_INVOKE_CARRY ? partialTag[0].length : 0
	}
	// An `<invoke` whose `name="` attribute hasn't arrived yet: hold it back so the marker can
	// latch on the next chunk, bounded so ordinary prose is never swallowed.
	const partialInvoke = text.match(/<(?:antml:)?invoke\b[^<>]*$/i)
	return partialInvoke && partialInvoke[0].length <= MAX_PARTIAL_INVOKE_CARRY ? partialInvoke[0].length : 0
}

/**
 * True when the block spanning `[index, endIndex)` is being quoted — inside a fenced code block,
 * inside an inline code span, or embedded mid-sentence in plain prose — rather than invoked.
 */
function isQuotedAsCode(text: string, index: number, endIndex: number): boolean {
	const before = text.slice(0, index)
	if (isInsideCodeFence(before)) {
		return true
	}
	const lineStart = before.lastIndexOf("\n") + 1
	const sameLineBefore = before.slice(lineStart)
	if ((sameLineBefore.match(/`/g)?.length ?? 0) % 2 === 1) {
		return true
	}
	// Narrative words after the block on the same line mean the markup is being talked about
	// (e.g. "never emit <invoke ...> directly"), which must not be replayed as a live call.
	const after = text.slice(endIndex)
	const lineEnd = after.indexOf("\n")
	const restOfLine = lineEnd === -1 ? after : after.slice(0, lineEnd)
	if (stripTagsCompletely(restOfLine).trim().length > 0) {
		return true
	}
	// A quoted invoke that ENDS its line leaves no trailing text to judge. Keying off the mere
	// presence of leading prose was tried and regressed genuine recoveries, because a real leak is
	// commonly preceded by narration too ("Working on it.\n"), so only an explicit quoting cue
	// immediately before the markup suppresses it. Heuristic: prose that quotes markup without
	// such a cue still reads as a live call.
	return QUOTING_CUE.test(stripTagsCompletely(sameLineBefore))
}

function parseLeakedInvokeParams(body: string): Record<string, string> {
	const input: Record<string, string> = {}
	LEAKED_INVOKE_PARAM.lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = LEAKED_INVOKE_PARAM.exec(body)) !== null) {
		input[match[1]] = match[2].trim()
	}
	return input
}

/**
 * Extracts complete leaked `<invoke>` tool-call blocks from `text`. Only blocks whose name
 * is present in `validToolNames` are returned as calls; all other text (including `<invoke>`
 * blocks for unknown names) is returned as `leftoverText` so legitimate prose is preserved.
 */
export function extractLeakedToolCalls(
	text: string,
	validToolNames: ReadonlySet<string>,
	precedingText = "",
): { calls: Array<{ name: string; input: Record<string, string> }>; leftoverText: string } {
	const calls: Array<{ name: string; input: Record<string, string> }> = []
	// Text between recovered/passed-through blocks, kept as segments so the wrapper cleanup below
	// only touches segments adjacent to a block that was actually recovered.
	const segments: Array<{ text: string; nearRecovery: boolean }> = []
	let pending = ""
	let lastIndex = 0

	LEAKED_INVOKE_BLOCK.lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = LEAKED_INVOKE_BLOCK.exec(text)) !== null) {
		pending += text.slice(lastIndex, match.index)
		const name = match[1]
		// Quote detection needs the text streamed before the buffer, since a fence may have opened there.
		if (
			validToolNames.has(name) &&
			!isQuotedAsCode(
				precedingText + text,
				precedingText.length + match.index,
				precedingText.length + match.index + match[0].length,
			)
		) {
			calls.push({ name, input: parseLeakedInvokeParams(match[2]) })
			segments.push({ text: pending, nearRecovery: true })
			pending = ""
			// The segment that follows a recovery also holds that call's closing wrapper.
			segments.push({ text: "", nearRecovery: true })
		} else {
			// Not one of our tools, or quoted as code — keep the block as literal text.
			pending += match[0]
		}
		lastIndex = match.index + match[0].length
	}
	pending += text.slice(lastIndex)
	const trailing =
		segments.length > 0 && segments[segments.length - 1].nearRecovery && segments[segments.length - 1].text === ""
	if (trailing) {
		segments[segments.length - 1].text = pending
	} else {
		segments.push({ text: pending, nearRecovery: false })
	}

	// Remove the wrapper tags belonging to a recovered call (cosmetic; also avoids re-teaching the
	// model this format when the turn is sent back as history). Wrappers around blocks that were
	// NOT recovered are user-visible text and must survive verbatim.
	const leftover = segments
		.map((segment) =>
			segment.nearRecovery ? segment.text.replace(/<\/?(?:antml:)?function_calls\s*>/gi, "") : segment.text,
		)
		.join("")

	return { calls, leftoverText: leftover }
}

/**
 * Context-window safety for Copilot's backend
 * -------------------------------------------
 * Copilot's backend enforces its own context window and, for third-party `sendRequest` callers,
 * trims an over-window request in a way that is NOT tool-pair-aware: it can drop the assistant
 * message holding a `tool_use` while keeping the matching `tool_result`, after which Anthropic
 * rejects the request with "unexpected tool_use_id". To keep trimming on OUR side — where
 * pairing is preserved — we shrink oversized `tool_result` payloads before sending. Only
 * `tool_result` text is truncated (never `tool_use`, assistant text, summaries, or environment
 * details), and only when the request would otherwise exceed the budget.
 */

/**
 * Conservative characters-per-token ratio used to turn a token window into a character budget.
 * The token-dense JSON, logs, and code that dominate oversized tool results tokenize to fewer
 * characters per token than prose, so we intentionally under-count (3, not the ~4 typical of
 * English) to keep the resulting budget on the safe side of the enforced window.
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
	// Don't end the head on a lone high surrogate — its low half is in the removed middle, and a lone
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
			total += 8 // "[IMAGE]" placeholder — VS Code LM drops image data anyway.
		}
	}
	return total
}

/**
 * Shrinks oversized `tool_result` payloads (largest first, middle-out) until the conversation fits
 * `budgetChars`. Mutates the tool_result blocks of the supplied messages in place — callers pass a
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
		}

		// Convert Anthropic messages to VS Code LM messages
		const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.Assistant(sanitizeSurrogates(systemPrompt)),
			...convertToVsCodeLmMessages(cleanedMessages),
		]

		// Initialize cancellation token for the request
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		// Calculate input tokens before starting the stream
		const totalInputTokens: number = await this.calculateTotalInputTokens(vsCodeLmMessages)

		// Accumulate the text and count at the end of the stream to reduce token counting overhead.
		let accumulatedText: string = ""

		// Leaked tool-call recovery state (see `extractLeakedToolCalls`). Only enabled when we
		// actually offered tools this turn, so it can never misfire on plain conversations.
		const providedToolNames = new Set(
			(metadata?.tools ?? [])
				.filter((tool) => tool.type === "function")
				.map((tool) => tool.function.name)
				.filter((name) => name.length > 0),
		)
		const salvageLeakedToolCalls = providedToolNames.size > 0
		let salvageBuffering = false
		let salvageBuffer = ""
		let salvageCarry = ""
		let salvageEmittedText = ""
		let salvagedToolCallIndex = 0

		// Drains the salvage state into ordered chunks: prose first, then any recovered calls. Must
		// run before a native tool_call is yielded — text after a tool_use block is rejected by
		// Anthropic once the turn is serialized back into history.
		const flushSalvage = (): ApiStreamChunk[] => {
			const flushed: ApiStreamChunk[] = []
			if (!salvageLeakedToolCalls) {
				return flushed
			}

			if (!salvageBuffering) {
				if (salvageCarry) {
					flushed.push({ type: "text", text: salvageCarry })
					salvageCarry = ""
				}
				return flushed
			}

			const buffered = salvageBuffer
			salvageBuffering = false
			salvageBuffer = ""
			if (!buffered) {
				return flushed
			}

			const { calls, leftoverText } = extractLeakedToolCalls(buffered, providedToolNames, salvageEmittedText)
			salvageEmittedText += buffered
			if (leftoverText) {
				flushed.push({ type: "text", text: leftoverText })
			}
			for (const call of calls) {
				console.warn(
					"Zoo Code <Language Model API>: Recovered a tool call the model emitted as text instead of a structured tool call:",
					{ name: call.name, params: Object.keys(call.input) },
				)
				flushed.push({
					type: "tool_call",
					id: `vscodelm-salvaged-${Date.now()}-${salvagedToolCallIndex++}`,
					name: call.name,
					arguments: JSON.stringify(call.input),
				})
			}
			return flushed
		}

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

					// Fast path: when we didn't offer any tools there is nothing to salvage, so
					// stream the text straight through exactly as before.
					if (!salvageLeakedToolCalls) {
						yield { type: "text", text: chunk.value }
						continue
					}

					// Once we've seen the start of a leaked tool-call block, buffer the rest of the
					// stream so the full markup can be parsed and replayed as a structured call.
					if (salvageBuffering) {
						salvageBuffer += chunk.value
						// Markup that never closes must not withhold the response indefinitely; past the
						// cap the buffer is released as plain text and buffering stops for the turn.
						if (salvageBuffer.length > MAX_SALVAGE_BUFFER_CHARS && !hasCompleteInvokeBlock(salvageBuffer)) {
							const overflowed = salvageBuffer
							salvageBuffering = false
							salvageBuffer = ""
							salvageEmittedText += overflowed
							yield { type: "text", text: overflowed }
						}
						continue
					}

					// Watch for the start of a leaked tool-call block, carrying a small tail across
					// chunks so a marker split across chunk boundaries is still detected.
					const combined = salvageCarry + chunk.value
					const markerMatch = combined.match(LEAKED_TOOL_CALL_START)
					if (markerMatch) {
						const before = combined.slice(0, markerMatch.index)
						if (before) {
							salvageEmittedText += before
							yield { type: "text", text: before }
						}
						salvageBuffering = true
						salvageBuffer = combined.slice(markerMatch.index)
						salvageCarry = ""
					} else {
						const carryLength = trailingPartialToolMarkerLength(combined)
						const emit = carryLength > 0 ? combined.slice(0, combined.length - carryLength) : combined
						salvageCarry = carryLength > 0 ? combined.slice(combined.length - carryLength) : ""
						if (emit) {
							salvageEmittedText += emit
							yield { type: "text", text: emit }
						}
					}
				} else if (chunk instanceof vscode.LanguageModelToolCallPart) {
					yield* flushSalvage()
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

			// Flush any leaked tool-call recovery state accumulated during streaming.
			yield* flushSalvage()

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
			: "vscode-lm"

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
