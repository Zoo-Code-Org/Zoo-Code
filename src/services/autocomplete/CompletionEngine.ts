import type { ResolvedAutocompleteConfig } from "@roo-code/types"
import * as vscode from "vscode"

import type { AutocompleteLogger } from "./AutocompleteLogger"
import type { ContextGatherer } from "./context/ContextGatherer"
import { CompletionCache, makeCacheKey } from "./cache/CompletionCache"
import { windowDocument } from "./context/windowing"
import { PromptBuilder } from "./prompt/PromptBuilder"
import type { FimCompletionHandler, FimRequest } from "./providers/FimCompletionHandler"
import { StreamPostProcessor } from "./stream/StreamPostProcessor"
import { DEFAULT_TRANSFORMS } from "./stream/transforms"
import { MAX_DOCUMENT_BYTES } from "./constants"

export interface CompletionEngineOptions {
	getConfig: () => ResolvedAutocompleteConfig
	getApiKey: () => string | undefined
	handler: FimCompletionHandler
	cache?: CompletionCache
	promptBuilder?: PromptBuilder
	postProcessor?: StreamPostProcessor
	/** Optional diagnostics; omitted in tests and when debug logging is off. */
	logger?: AutocompleteLogger
	/** Cross-file context; omitted in tests that exercise the same-file path. */
	contextGatherer?: ContextGatherer
}

/** Per-document record of the last produced completion, for minCharsTyped gating. */
interface LastCompletion {
	readonly documentVersion: number
	readonly offset: number
	readonly textLength: number
}

/**
 * Orchestrates the inline completion pipeline:
 *
 * ```
 * debounce → cache → windowing → prompt → stream → postprocess → InlineCompletionItem
 * ```
 *
 * Phase 2 is same-file only (no cross-file snippet sources); the ContextGatherer
 * and SnippetSource pipeline arrive in Phase 4 and slot in before `promptBuilder.build`.
 */
export class CompletionEngine {
	private readonly getConfig: () => ResolvedAutocompleteConfig
	private readonly getApiKey: () => string | undefined
	private readonly handler: FimCompletionHandler
	private readonly cache: CompletionCache
	private readonly promptBuilder: PromptBuilder
	private readonly postProcessor: StreamPostProcessor
	private readonly logger: AutocompleteLogger | undefined
	private readonly contextGatherer: ContextGatherer | undefined
	private readonly lastCompletion = new Map<string, LastCompletion>()

	constructor(options: CompletionEngineOptions) {
		this.getConfig = options.getConfig
		this.getApiKey = options.getApiKey
		this.handler = options.handler
		this.cache = options.cache ?? new CompletionCache()
		this.promptBuilder = options.promptBuilder ?? new PromptBuilder()
		this.postProcessor = options.postProcessor ?? new StreamPostProcessor(DEFAULT_TRANSFORMS)
		this.logger = options.logger
		this.contextGatherer = options.contextGatherer
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		const config = this.getConfig()

		// No model configured → nothing to complete.
		if (!config.modelId) {
			return undefined
		}

		// Debounce: wait, then bail if a newer keystroke cancelled us. Implemented
		// as `await delay` (not a trailing-edge timer) so the cancellation is cheap.
		await delay(config.debounceMs)

		if (token.isCancellationRequested) {
			return undefined
		}

		// minCharsTyped gate: don't re-trigger until enough has been typed since the last suggestion.
		if (!this.meetsMinCharsTyped(document, position, config.minCharsTyped)) {
			return undefined
		}

		// Large-file guard: never stream a huge document through the pipeline.
		if (document.getText().length > MAX_DOCUMENT_BYTES) {
			return undefined
		}

		const { prefix, suffix } = windowDocument(
			document,
			position,
			config.maxPrefixTokens * 4,
			config.maxSuffixTokens * 4,
		)
		const key = makeCacheKey(prefix, suffix, config.modelId)
		const cached = this.cache.get(key)

		if (cached) {
			this.recordCompletion(document, position, cached.text)
			return [this.toItem(cached.text, document, position)]
		}

		// Typed-prefix continuation: the user typed more; reuse the cached middle.
		const continuation = this.cache.getContinuation(prefix, suffix, config.modelId)

		if (continuation !== undefined) {
			this.cache.set(key, { prefix, suffix, text: continuation, modelId: config.modelId })
			this.recordCompletion(document, position, continuation)
			return [this.toItem(continuation, document, position)]
		}

		// Cross-file context. Raced against a wall-clock budget so a slow source
		// degrades the suggestion rather than delaying it.
		const snippets = this.contextGatherer
			? await this.contextGatherer.gather({ document, position, prefix, suffix }, config, CONTEXT_BUDGET_MS)
			: []

		if (token.isCancellationRequested) {
			return undefined
		}

		if (snippets.length > 0) {
			this.logger?.log("context", {
				snippets: snippets.length,
				sources: snippets.map((snippet) => snippet.source ?? "?").join(","),
			})
		}

		const built = this.promptBuilder.build({ prefix, suffix, snippets, config })

		const request: FimRequest = {
			modelId: config.modelId,
			baseUrl: config.baseUrl,
			apiKey: this.getApiKey(),
			prefix: built.prefix,
			suffix: built.suffix,
			renderedPrompt: built.renderedPrompt,
			stopSequences: built.stopSequences,
			temperature: config.temperature,
			maxOutputTokens: config.maxOutputTokens,
			contextLength: config.contextLength,
			requestTimeoutMs: config.requestTimeoutMs,
			// `instruct`/`none` templates have no FIM tokens: the handler must send
			// the rendered prompt and omit `suffix`, or the model free-runs.
			supportsFim: built.supportsFim,
			useChatEndpoint: built.useChatEndpoint,
			systemPrompt: built.systemPrompt,
			signal: toAbortSignal(token),
		}

		this.logger?.log("request", {
			model: config.modelId,
			template: built.templateId,
			chat: built.useChatEndpoint,
			fim: built.supportsFim,
			promptChars: built.promptChars,
			stops: built.stopSequences.length,
		})
		this.logger?.logPrompt("prompt", built.useChatEndpoint ? built.renderedPrompt : built.prefix)

		const startedAt = Date.now()
		let text = ""

		try {
			const stream = this.handler.streamFim(request)
			const processed = this.postProcessor.process(stream, {
				prefix,
				suffix,
				// A chat model routinely wraps its whole reply in a fence, so on that
				// path the fence is a container to unwrap — not a terminator. Leaving
				// "```" in the stop set truncated every fenced reply to nothing.
				stopSequences: built.useChatEndpoint
					? built.stopSequences.filter((stop) => stop !== "```")
					: built.stopSequences,
				// A *line* cap, not a token cap. `maxOutputTokens` (256) was being
				// passed here, which silently disabled the limit entirely.
				maxLines: config.multilineMode === "never" ? 1 : MAX_COMPLETION_LINES,
				isChatReply: built.useChatEndpoint,
			})

			for await (const chunk of processed) {
				if (token.isCancellationRequested) {
					return undefined
				}

				text += chunk
			}
		} catch (error) {
			if (isAbortError(error)) {
				this.logger?.log("aborted")
				return undefined
			}

			// VS Code discards provider rejections silently, so an unreachable
			// endpoint or a 401 is indistinguishable from "no suggestion" unless
			// it is logged here.
			this.logger?.log("error", { message: error instanceof Error ? error.message : String(error) })

			throw error
		}

		const rawText = text

		if (built.useChatEndpoint) {
			text = unwrapChatCodeReply(text, prefix)
		}

		text = text.replace(/\s+$/, "")

		this.logger?.log("response", {
			ms: Date.now() - startedAt,
			rawChars: rawText.length,
			chars: text.length,
			text,
		})

		if (text.length === 0) {
			// Distinguishes "the model returned nothing" from "post-processing
			// removed everything", which are very different bugs.
			this.logger?.log(rawText.length === 0 ? "empty-from-model" : "empty-after-postprocessing")
			return undefined
		}

		// A chat model asked to complete `def is_prime(n` may answer with the whole
		// function body, which is a valid *answer* but not a valid *continuation* of
		// the cursor line — splicing it in produced `def is_prime(nif n <= 1False…`.
		if (!isCoherentContinuation(text, prefix)) {
			this.logger?.log("rejected-incoherent", { text })
			return undefined
		}

		// A completion that re-declares something already in the buffer is the model
		// answering from the whole file rather than the cursor. Left in, it produced
		// duplicate `def calculate_mean(numbers):` blocks stacked on each other.
		const duplicate = findDuplicateDeclaration(text, prefix, suffix)

		if (duplicate) {
			this.logger?.log("rejected-duplicate", { declaration: duplicate })
			return undefined
		}

		this.cache.set(key, { prefix, suffix, text, modelId: config.modelId })
		this.recordCompletion(document, position, text)

		return [this.toItem(text, document, position)]
	}

	/**
	 * Builds the InlineCompletionItem with a correct range.
	 *
	 * Pure insertion (cursor at a word boundary) → range collapses to the cursor.
	 * Mid-word (cursor inside a word) → the range covers the word, and the
	 * already-typed chars are folded into `insertText` so VS Code replaces rather
	 * than duplicates them (the #1 visible ghost-text bug).
	 */
	private toItem(
		text: string,
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.InlineCompletionItem {
		const lineText = document.lineAt(position.line).text
		const charAtCursor = lineText[position.character]

		// Cursor at the end of a word (or at a non-word char) is a pure insertion
		// point — the next char is not part of the word being completed.
		if (!charAtCursor || !WORD_CHAR.test(charAtCursor)) {
			return new vscode.InlineCompletionItem(text, new vscode.Range(position, position))
		}

		// Mid-word: walk back to the word start and include the typed chars.
		let wordStart = position.character

		while (wordStart > 0 && WORD_CHAR.test(lineText[wordStart - 1])) {
			wordStart--
		}

		const typed = lineText.slice(wordStart, position.character)
		const range = new vscode.Range(position.line, wordStart, position.line, position.character)

		return new vscode.InlineCompletionItem(typed + text, range)
	}

	private meetsMinCharsTyped(
		document: vscode.TextDocument,
		position: vscode.Position,
		minCharsTyped: number,
	): boolean {
		if (minCharsTyped <= 0) {
			return true
		}

		const last = this.lastCompletion.get(document.uri.toString())

		if (!last || last.documentVersion !== document.version) {
			return true
		}

		const typed = document.offsetAt(position) - last.offset

		return typed >= minCharsTyped
	}

	private recordCompletion(document: vscode.TextDocument, position: vscode.Position, text: string): void {
		this.lastCompletion.set(document.uri.toString(), {
			documentVersion: document.version,
			offset: document.offsetAt(position),
			textLength: text.length,
		})
	}
}

/**
 * Normalises a chat model's reply into raw insertable code.
 *
 * Chat-tuned models answer conversationally even under a strict system prompt.
 * The recurring shapes, each handled here:
 * - the whole answer wrapped in a ```lang fence;
 * - the answer restating the prefix (or its last line) before continuing;
 * - a leading newline where the cursor sits mid-line.
 */
export function unwrapChatCodeReply(text: string, prefix: string): string {
	let result = text

	// Whole-reply fence, with or without a language tag.
	const fenced = result.match(/^\s*```[\w+-]*\n([\s\S]*?)(?:\n```|```|$)/)

	if (fenced) {
		result = fenced[1]
	}

	// Any stray leading fence the regex above didn't span.
	result = result.replace(/^\s*```[\w+-]*\n?/, "")

	// The model echoed our own cursor marker. Truncating rather than deleting is
	// deliberate: everything after the marker is the model re-emitting context it
	// was shown, which is what produced runs of `<CURSOR><CURSOR><CURSOR>`.
	const marker = result.indexOf(CURSOR_MARKER)

	if (marker !== -1) {
		result = result.slice(0, marker)
	}

	// The model restated the code we already have. Compare on the trailing run of
	// the prefix, since that is all the model was shown of the current line.
	const lastLine = prefix.slice(prefix.lastIndexOf("\n") + 1)

	if (lastLine.trim().length > 0 && result.startsWith(lastLine)) {
		result = result.slice(lastLine.length)
	} else {
		const trimmedStart = result.replace(/^[ \t]*\n/, "")

		if (trimmedStart !== result && lastLine.trim().length > 0) {
			// A leading blank line before a mid-line cursor would push the
			// completion onto the next row, which reads as a duplicate.
			result = trimmedStart
		}
	}

	// The cursor already sits after the line's indentation, but a chat model
	// reproduces the indentation it inferred from the surrounding block. Emitting
	// both double-indents the first line — very visible in Python.
	if (/^[ \t]+$/.test(lastLine) && result.startsWith(lastLine)) {
		result = result.slice(lastLine.length)
	}

	return result
}

/**
 * Rejects a completion that does not continue the cursor line coherently.
 *
 * A chat model given `def is_prime(n` often answers with the *body* of the
 * function rather than the rest of that line. Splicing that in yields
 * `def is_prime(nif n <= 1FalseTrue` — syntactically destroyed code.
 *
 * The heuristic is narrow on purpose: it only fires when the cursor sits
 * mid-expression (an unclosed bracket, or immediately after an identifier
 * character) *and* the completion's first line begins with a token that cannot
 * legally follow there. Anything ambiguous is allowed through, because a false
 * rejection costs a suggestion while a false accept corrupts the buffer.
 */
export function isCoherentContinuation(text: string, prefix: string): boolean {
	const lastLine = prefix.slice(prefix.lastIndexOf("\n") + 1)
	const trailing = lastLine.trimEnd()

	// Cursor on a blank or indentation-only line: any block-level code is fine.
	if (trailing.length === 0) {
		return true
	}

	const firstLine = text.split("\n", 1)[0].trimStart()

	if (firstLine.length === 0) {
		return true
	}

	const endsMidToken = /[\w$]$/.test(trailing)
	const hasOpenBracket = countUnclosed(trailing) > 0

	if (!endsMidToken && !hasOpenBracket) {
		return true
	}

	// A statement keyword cannot continue an identifier or an open argument list.
	if (STATEMENT_START.test(firstLine)) {
		return false
	}

	// Mid-identifier the completion must continue *that* identifier. The tell is
	// spacing: a continuation is glued on (`_of_list():`, `():`), whereas a restart
	// begins its own word and then assigns or calls — which is how
	// `def calculate_mean` + `mean = sum(...)` fused into `calculate_meanmean = …`.
	//
	// `text` is used rather than `firstLine` because leading whitespace is the
	// signal here, and `firstLine` has already been trimmed.
	if (endsMidToken && !hasOpenBracket) {
		const glued = !/^\s/.test(text)

		return glued && !FRESH_STATEMENT.test(firstLine)
	}

	return true
}

/** Net count of unclosed brackets on a line, ignoring those inside strings. */
function countUnclosed(line: string): number {
	let depth = 0
	let quote: string | undefined

	for (let i = 0; i < line.length; i++) {
		const char = line[i]

		if (quote) {
			if (char === quote && line[i - 1] !== "\\") {
				quote = undefined
			}

			continue
		}

		if (char === '"' || char === "'" || char === "`") {
			quote = char
		} else if (char === "(" || char === "[" || char === "{") {
			depth++
		} else if (char === ")" || char === "]" || char === "}") {
			depth--
		}
	}

	return depth
}

/**
 * Returns the name of a declaration the completion re-introduces, if any.
 *
 * A chat model shown the whole file frequently answers with code it has already
 * seen — re-emitting `def calculate_mean(numbers):` below the real one. The
 * result compiles but is nonsense, and it is the most visible form of the
 * "mixing contexts" failure.
 */
export function findDuplicateDeclaration(text: string, prefix: string, suffix: string): string | undefined {
	const surrounding = `${prefix}\n${suffix}`

	for (const line of text.split("\n")) {
		const match = DECLARATION.exec(line.trim())

		if (!match) {
			continue
		}

		const name = match[2]
		// Word-boundary match on the declaring keyword so a mere *call* to the
		// function doesn't count as a redeclaration.
		const declared = new RegExp(`\\b${match[1]}\\s+${escapeRegExp(name)}\\b`)

		if (declared.test(surrounding)) {
			return name
		}
	}

	return undefined
}

/** `def name(`, `class Name`, `function name(` — the shapes worth de-duplicating. */
const DECLARATION = /^(def|class|function)\s+([A-Za-z_$][\w$]*)/

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * A completion that opens a *new* statement: an identifier followed by an
 * assignment, a call, or member access at the start of the line. Valid code, but
 * not a continuation of a half-typed identifier.
 */
const FRESH_STATEMENT = /^[A-Za-z_$][\w$]*\s+=[^=]|^[A-Za-z_$][\w$]*=[^=]/

/** Keywords that begin a statement and so cannot continue a partial expression. */
const STATEMENT_START =
	/^(if|for|while|return|def|class|import|from|elif|else|try|except|finally|with|raise|yield|pass|break|continue|const|let|var|function|public|private|switch|case)\b/

/** The cursor marker used by the instruct template; must never survive into ghost text. */
const CURSOR_MARKER = "<CURSOR>"

/** Word-constituent characters used for mid-word range detection. */
const WORD_CHAR = /[\w$]/

/**
 * Hard ceiling on completion lines.
 *
 * Ghost text longer than this is never useful: it is too much to read at a glance
 * and almost always means the model has started generating unrelated code.
 */
const MAX_COMPLETION_LINES = 12

/**
 * Wall-clock budget for all context sources combined.
 *
 * Deliberately tight: context that arrives after the user has typed another
 * character is worthless, so a straggling source is dropped rather than waited on.
 */
const CONTEXT_BUDGET_MS = 120

/** Converts a CancellationToken to an AbortSignal the fetch handler can race. */
function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController()

	if (token.isCancellationRequested) {
		controller.abort()
	} else {
		token.onCancellationRequested(() => controller.abort())
	}

	return controller.signal
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || (error as { code?: string }).code === "ABORT_ERR")
}

/** Debounce delay that respects cancellation. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
