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

import { ApiStream, ApiStreamChunk } from "../transform/stream"
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
 *
 * SCOPE: only the WRAPPED variant — an `<invoke>` inside an open `<function_calls>` wrapper — is
 * recovered. A bare, unwrapped `<invoke>` is deliberately left as text: we have no observation of
 * this backend emitting one, while quoted examples and prompt-injected file content routinely
 * contain bare markup, so passing it through is the safer default rather than a security boundary.
 * Widening to the bare case needs a reproduction first.
 */
/** Upper bound on an incomplete `<invoke ...` tail held back between chunks. */
const MAX_PARTIAL_INVOKE_CARRY = 64

/**
 * Left-to-right scan state behind the quoting heuristics: open code fence, current line start,
 * backticks seen on the current line, and whether a `<function_calls>` wrapper is open.
 *
 * State is threaded through the match loop and advanced only over newly consumed text. Rebuilding
 * each candidate's prefix and re-walking it was quadratic in message length on ordinary output.
 */
class QuotingScanState {
	private openFence: { marker: string; width: number } | null = null
	private wrapperOpen = false
	/** Text of the line now being scanned, up to the point the scan has reached. */
	sameLineBefore = ""

	/** Consumes the next contiguous span of the stream. Spans must not overlap or skip text. */
	advance(span: string): void {
		const lines = span.split("\n")
		for (const [index, line] of lines.entries()) {
			const lineStart = this.sameLineBefore.length
			const fenceBeforeLine = this.openFence
			this.sameLineBefore += line
			// A wrapper opener shown as an example must not arm wrapped-only recovery for a later
			// bare invoke, so tags are read in source order and only while outside quoted code.
			if (fenceBeforeLine === null && !/^ {0,3}(?:`{3,}|~{3,})/.test(this.sameLineBefore)) {
				// A wrapper tag admits only whitespace before its `>`, so it never straddles a span
				// boundary, which always falls on the `<` of an `<invoke>` marker.
				for (const wrapperTag of line.matchAll(/<(\/?)(?:antml:)?function_calls\s*>/gi)) {
					const textBeforeTag = this.sameLineBefore.slice(0, lineStart + wrapperTag.index)
					if (!this.insideInlineSpanAt(textBeforeTag)) {
						this.wrapperOpen = wrapperTag[1] === ""
					}
				}
			}
			if (index < lines.length - 1) {
				this.openFence = this.fenceAfterCurrentLine()
				this.sameLineBefore = ""
			}
		}
	}

	/** True when the stream so far ends inside an open Markdown code fence. */
	isInsideCodeFence(): boolean {
		return this.fenceAfterCurrentLine() !== null
	}

	/** True when the stream so far ends inside an inline code span. */
	hasOddBacktickCountOnLine(): boolean {
		return this.insideInlineSpanAt(this.sameLineBefore)
	}

	/** CommonMark: a code span closes only on a backtick run of the SAME width that opened it. */
	private insideInlineSpanAt(prefix: string): boolean {
		let activeWidth = 0
		for (const run of prefix.matchAll(/`+/g)) {
			const width = run[0].length
			if (activeWidth === 0) {
				activeWidth = width
			} else if (width === activeWidth) {
				activeWidth = 0
			}
		}
		return activeWidth !== 0
	}

	isInsideFunctionCallsWrapper(): boolean {
		return this.wrapperOpen
	}

	/** Fence state including the partial line now being scanned, which may itself open a fence. */
	private fenceAfterCurrentLine(): { marker: string; width: number } | null {
		// The scanned line never contains a newline, so the run's suffix is simply the rest of it.
		const fenceMatch = this.sameLineBefore.match(/^ {0,3}(`{3,}|~{3,})/)
		if (!fenceMatch) {
			return this.openFence
		}
		const marker = fenceMatch[1][0]
		const width = fenceMatch[1].length
		const suffix = this.sameLineBefore.slice(fenceMatch[0].length)
		if (!this.openFence) {
			// CommonMark: a backtick opening fence's info string may not contain a backtick.
			return marker === "`" && suffix.includes("`") ? null : { marker, width }
		}
		// CommonMark allows an info string only on an opening fence, never a closing one.
		const closesFence = marker === this.openFence.marker && width >= this.openFence.width && suffix.trim() === ""
		return closesFence ? null : this.openFence
	}
}

/**
 * Strips well-formed tags, including nested ones. Removing a tag can reassemble a live-looking tag
 * from the characters around it (`<<invoke>>`), so tags are matched with a single-pass stack rather
 * than by re-replacing until the text stops changing.
 */
function stripTagsCompletely(text: string): string {
	let output = ""
	// Bodies of `<` runs still awaiting a `>`; an unterminated one is never a tag, so it is emitted verbatim.
	const pendingTags: string[] = []
	for (let iter = 0; iter < text.length; iter += 1) {
		const character = text[iter]
		if (character === "<") {
			pendingTags.push("")
		} else if (character === ">" && pendingTags.length > 0) {
			pendingTags.pop()
		} else if (pendingTags.length > 0) {
			pendingTags[pendingTags.length - 1] += character
		} else {
			output += character
		}
	}
	for (const pending of pendingTags) {
		output += `<${pending}`
	}
	return output
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
 * Words that mark nearby markup as being talked about rather than invoked.
 */
const QUOTING_CUE_PATTERN =
	/\b(?:never|not|do not|don't|does not|doesn't|must not|mustn't|avoid|instead of|rather than|for example|e\.g\.|such as|like this|as follows)\b/gi

/**
 * True when a quoting cue falls in the unterminated final sentence of `sameLineBefore`. Pairing the
 * cue with a terminator-free tail in one pattern re-scanned that tail once per cue.
 */
function hasQuotingCue(sameLineBefore: string): boolean {
	const lastTerminator = Math.max(
		sameLineBefore.lastIndexOf("."),
		sameLineBefore.lastIndexOf("!"),
		sameLineBefore.lastIndexOf("?"),
	)
	for (const cue of sameLineBefore.matchAll(QUOTING_CUE_PATTERN)) {
		if (cue.index + cue[0].length > lastTerminator) {
			return true
		}
	}
	return false
}

/**
 * True when the block ending at `endIndex` is being quoted — inside a fenced code block, inside an
 * inline code span, or embedded mid-sentence in plain prose — rather than invoked.
 *
 * `scan` must already be advanced to the start of the block.
 */
function isQuotedAsCode(text: string, endIndex: number, scan: QuotingScanState): boolean {
	if (scan.isInsideCodeFence() || scan.hasOddBacktickCountOnLine()) {
		return true
	}
	// Narrative words after the block on the same line mean the markup is being talked about
	// (e.g. "never emit <invoke ...> directly"), which must not be replayed as a live call.
	const lineEnd = text.indexOf("\n", endIndex)
	const restOfLine = text.slice(endIndex, lineEnd === -1 ? undefined : lineEnd)
	if (stripTagsCompletely(restOfLine).trim().length > 0) {
		return true
	}
	// A quoted invoke that ENDS its line leaves no trailing text to judge, and a real leak is
	// commonly narrated too — keying off leading prose alone regressed genuine recoveries, so only
	// this narrow cue suppresses it.
	return hasQuotingCue(stripTagsCompletely(scan.sameLineBefore))
}

/**
 * JSON Schema (draft 2020-12 subset) for one tool's parameters, keyed by tool name. Supplied by
 * `createMessage` from the very schemas offered to the model, so recovery converts a leaked
 * parameter to the type the tool actually declares.
 */
export type LeakedToolSchemas = ReadonlyMap<string, Record<string, unknown> | undefined>

/**
 * Non-string JSON Schema types a leaked parameter may be converted into, each paired with the
 * check that a parsed value must satisfy. A null-only declaration is settled by its own branch in
 * `convertLeakedParamValue` and so has no entry here.
 */
function structuredParamCheck(declaredType: string): ((parsed: unknown) => boolean) | undefined {
	const checks: Record<string, (parsed: unknown) => boolean> = {
		object: (parsed) => typeof parsed === "object" && !Array.isArray(parsed),
		array: (parsed) => Array.isArray(parsed),
		number: (parsed) => Number.isFinite(parsed),
		integer: (parsed) => Number.isInteger(parsed),
		boolean: (parsed) => typeof parsed === "boolean",
	}
	// Own-property only: a schema declaring `"toString"` would otherwise inherit a live function
	// from Object.prototype and be treated as a supported type.
	return Object.hasOwn(checks, declaredType) ? checks[declaredType] : undefined
}

/** A resolved declaration, or `undefined` when the schema does not pin down a single type. */
type DeclaredType = { type: string; nullable: boolean }

/** Resolves a `["T","null"]` type union to `T` while reporting that null is permitted. */
function resolveTypeUnion(types: string[]): DeclaredType | undefined {
	const nullable = types.includes("null")
	const nonNullTypes = types.filter((entry) => entry !== "null")
	// A null-only union has no non-null member; leaving the type unresolved would fall back to the
	// raw string "null", so name the null type and let convertLeakedParamValue settle it.
	if (nonNullTypes.length === 0) {
		return nullable ? { type: "null", nullable } : undefined
	}
	// Two or more non-null members leave the intended type ambiguous; picking one would coerce the
	// value to a type the tool may not accept, so the raw string is kept instead.
	return nonNullTypes.length === 1 ? { type: nonNullTypes[0], nullable } : undefined
}

/**
 * Declared type of `paramName`, resolving a nullable `["T","null"]` union to `T` while reporting
 * that null is permitted, so an explicit null is not mistaken for a wrong-typed value.
 *
 * MCP schemas reach this provider already rewritten by `normalizeToolSchema`, which turns such a
 * union into typed `anyOf` branches. Without reading that form a declared array or object would
 * fall through to the raw string, and the tool would receive `'["a","b"]'` instead of a list.
 */
function declaredParamType(schema: Record<string, unknown> | undefined, paramName: string): DeclaredType | undefined {
	const properties = schema?.["properties"] as Record<string, unknown> | undefined
	const property = properties?.[paramName] as Record<string, unknown> | undefined
	const type = property?.["type"]
	if (typeof type === "string") {
		// A bare declaration permits null only when the type IS "null", which convertLeakedParamValue
		// settles on its own before reading this flag.
		return { type, nullable: false }
	}
	if (Array.isArray(type)) {
		return resolveTypeUnion(type.filter((entry): entry is string => typeof entry === "string"))
	}
	const alternatives = property?.["anyOf"]
	if (Array.isArray(alternatives)) {
		const branchTypes: string[] = []
		for (const alternative of alternatives) {
			const branchType = (alternative as Record<string, unknown> | null)?.["type"]
			// Any branch that is not a simple named type (nested composition, $ref, enum-only) makes
			// the union unsupported here; bail out rather than guess at a partial reading.
			if (typeof branchType !== "string") {
				return undefined
			}
			branchTypes.push(branchType)
		}
		return resolveTypeUnion(branchTypes)
	}
	return undefined
}

/**
 * Converts one leaked parameter's raw text to the type its schema declares.
 *
 * Leaked markup carries no types — every value arrives as text — so a tool declaring an object or
 * array (`update_todo_list.todos`, `read_file.indentation`) would otherwise receive a flat string
 * and fail downstream. Only declared non-string types are JSON-parsed; a declared (or unknown)
 * string stays literal, because parsing every value would silently turn the text `"123"` or
 * `"null"` into a number or null. A value that does not parse, or parses to the wrong type, is
 * reported as a failure so the caller can pass the block through as text rather than dispatch a
 * malformed call.
 */
function convertLeakedParamValue(raw: string, declared: DeclaredType | undefined): { value: unknown } | undefined {
	if (declared === undefined || declared.type === "string") {
		return { value: raw }
	}
	// A null-only declaration admits the literal null and nothing else, so no parse is needed.
	if (declared.type === "null") {
		return raw === "null" ? { value: null } : undefined
	}
	const matchesDeclaredType = structuredParamCheck(declared.type)
	if (!matchesDeclaredType) {
		return undefined
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return undefined
	}

	// Must precede the table, whose object check would otherwise accept a null.
	if (parsed === null) {
		return declared.nullable ? { value: null } : undefined
	}

	return matchesDeclaredType(parsed) ? { value: parsed } : undefined
}

/**
 * Parses the parameters of a leaked `<invoke>` body against the tool's schema. Returns `undefined`
 * when any parameter cannot be converted, so the whole block is failed closed to unchanged text.
 */
function parseLeakedInvokeParams(
	body: string,
	schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const input: Record<string, unknown> = {}
	const paramPattern = /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?parameter\s*>/gi
	let consumedUpTo = 0
	for (const match of body.matchAll(paramPattern)) {
		const name = match[1]
		// A `<parameter` token in the gap before this match is an opener the pattern could not
		// parse, so recovering would dispatch a call missing an argument the model wrote.
		if (/<(?:antml:)?parameter\b/i.test(body.slice(consumedUpTo, match.index ?? 0))) {
			return undefined
		}
		// A nested unclosed `<parameter` inside the captured value means the lazy pattern swallowed
		// markup as data and dropped the inner parameter, so fail closed rather than dispatch it.
		if (/<(?:antml:)?parameter\b/i.test(match[2])) {
			return undefined
		}
		const converted = convertLeakedParamValue(match[2].trim(), declaredParamType(schema, name))
		if (!converted) {
			return undefined
		}
		input[name] = converted.value
		consumedUpTo = (match.index ?? 0) + match[0].length
	}
	// An unclosed parameter tag is skipped by the pattern above, so recovering would dispatch a
	// call missing an argument the model wrote; fail closed instead.
	if (/<(?:antml:)?parameter\b/i.test(body.slice(consumedUpTo))) {
		return undefined
	}
	return input
}

/**
 * Extracts complete leaked `<invoke>` tool-call blocks from `text`. Only blocks whose name
 * is present in `validTools` are returned as calls; all other text (including `<invoke>`
 * blocks for unknown names) is returned as `leftoverText` so legitimate prose is preserved.
 *
 * `validTools` may be a bare name set (no schemas, so every parameter stays a literal string) or a
 * map from tool name to its parameter schema, which enables typed conversion.
 */
export function extractLeakedToolCalls(
	text: string,
	validTools: ReadonlySet<string> | LeakedToolSchemas,
	precedingText = "",
): { calls: Array<{ name: string; input: Record<string, unknown> }>; leftoverText: string } {
	const schemaFor = (name: string) =>
		validTools instanceof Map ? (validTools.get(name) as Record<string, unknown> | undefined) : undefined
	const calls: Array<{ name: string; input: Record<string, unknown> }> = []
	// Text outside recovered blocks, in stream order.
	let leftover = ""
	let lastIndex = 0

	// Quote detection needs the text streamed before the buffer, since a fence may have opened
	// there. Scanned once by state that only ever moves forward, not re-scanned per candidate.
	const scan = new QuotingScanState()
	scan.advance(precedingText)
	let scannedUpTo = 0

	const openPattern = /<(?:antml:)?invoke\s+name="([^"]+)"\s*>/gi
	const closePattern = /<\/(?:antml:)?invoke\s*>/gi
	for (let open = openPattern.exec(text); open !== null; open = openPattern.exec(text)) {
		const bodyStart = open.index + open[0].length
		closePattern.lastIndex = bodyStart
		const close = closePattern.exec(text)
		// With no closing tag after this open there is none after any later open either.
		if (!close) {
			break
		}
		const blockEnd = close.index + close[0].length
		leftover += text.slice(lastIndex, open.index)
		const name = open[1]
		scan.advance(text.slice(scannedUpTo, open.index))
		// Only text outside invoke bodies may move parser state, otherwise markup quoted in one
		// block could open a wrapper or fence that changes the verdict on a later block.
		scannedUpTo = blockEnd
		const recoverable =
			validTools.has(name) && scan.isInsideFunctionCallsWrapper() && !isQuotedAsCode(text, blockEnd, scan)
		// Parsing may still fail closed when a parameter doesn't match its declared type.
		const input = recoverable
			? parseLeakedInvokeParams(text.slice(bodyStart, close.index), schemaFor(name))
			: undefined
		if (input) {
			calls.push({ name, input })
		} else {
			// Not one of our tools, quoted as code, or un-convertible — keep the block as literal text.
			leftover += text.slice(open.index, blockEnd)
		}
		lastIndex = blockEnd
		openPattern.lastIndex = blockEnd
	}
	leftover += text.slice(lastIndex)

	// Once a call is recovered its `<function_calls>` wrapper is spent markup, so drop every wrapper
	// tag (cosmetic; also avoids re-teaching the model this format when the turn replays as history).
	// With nothing recovered the same tags are user-visible prose and must survive verbatim.
	if (calls.length > 0) {
		leftover = leftover.replace(/<\/?(?:antml:)?function_calls\s*>/gi, "")
	}

	return { calls, leftoverText: leftover }
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
