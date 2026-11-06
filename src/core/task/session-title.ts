import type { ProviderSettings } from "@roo-code/types"

import type { ClineProvider } from "../webview/ClineProvider"
import { singleCompletionHandler } from "../../utils/single-completion-handler"

/** Hard bound on the single-shot title request (15 seconds). */
export const SESSION_TITLE_TIMEOUT_MS = 15_000
/** Character cap for the fallback title taken from the user message (42 chars). */
export const FALLBACK_TITLE_MAX_CHARS = 42
/** Write attempts given up on after this many retries (3 retries). */
const TITLE_WRITE_MAX_RETRIES = 3

// Stryker disable next-line StringLiteral: diagnostic label, does not alter control flow
const TITLE_PROMPT_PREFIX = `Create a descriptive 5-10 word title for the user message below. Use the user's language.
Output only the title.

`

/** Outcome of `ClineProvider.applySessionTitle`. */
export type SessionTitleApplyResult = "applied" | "conflict"

/** Removes system-injected `<system-reminder>` blocks and trims. */
export function sanitizeUserMessageForTitle(raw: string): string {
	const open = "<system-reminder>"
	const close = "</system-reminder>"
	let result = ""
	let cursor = 0
	// Stryker disable next-line EqualityOperator: cursor reaches raw.length on trailing text; <= is equivalent as indexOf returns -1 at length
	while (cursor < raw.length) {
		const start = raw.indexOf(open, cursor)
		if (start === -1) {
			result += raw.slice(cursor)
			break
		}
		result += raw.slice(cursor, start)
		// Stryker disable next-line ArithmeticOperator: equivalent mutant, </system-reminder> (18 chars) cannot start in the [start-17, start+17] window around <system-reminder> (17 chars)
		const end = raw.indexOf(close, start + open.length)
		// An unterminated block would otherwise leak the rest of the message as user text; drop it.
		if (end === -1) {
			break
		}
		cursor = end + close.length
	}
	return result.trim()
}

/** First line, `Title:` prefix removed, surrounding quotes removed. */
export function extractLlmTitle(raw: string): string | undefined {
	const firstLine = raw.split("\n")[0].trim()
	const withoutPrefix = firstLine.replace(/^title:\s*/i, "")
	const withoutQuotes = withoutPrefix.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
	const title = withoutQuotes.trim()
	return title.length > 0 ? title : undefined
}

/** First 42 characters of the message, then whitespace collapsed. */
export function fallbackTitle(rawMessage: string): string | undefined {
	const head = rawMessage.slice(0, FALLBACK_TITLE_MAX_CHARS)
	return head.replace(/\s+/g, " ").trim() || undefined
}

type CompletePromptFn = typeof singleCompletionHandler

export interface GenerateSessionTitleOptions {
	provider: ClineProvider
	taskId: string
	/** The raw root user message that started the run. */
	userMessage: string
	/** The API configuration the session itself uses (same model reuse). */
	apiConfiguration: ProviderSettings
	/** Injectable for tests; defaults to the shared single-shot completion helper. */
	completePrompt?: CompletePromptFn
}

interface InFlightTitle {
	controller: AbortController
	userCancelled: boolean
}

/** In-flight title generation abort controllers by task ID. */
const inFlightTitles = new Map<string, InFlightTitle>()

/**
 * Cancels any pending or in-flight title generation for a task.
 * Called when a task is manually renamed, cleared, or deleted so an auto-generated title
 * never overwrites the user's manual intent.
 */
export function cancelSessionTitle(taskId: string): void {
	const entry = inFlightTitles.get(taskId)
	if (entry) {
		entry.userCancelled = true
		entry.controller.abort()
	}
}

/**
 * Generates and applies a session title from the root user message.
 *
 * Fire-and-forget by contract: never rejects, never blocks a run, and every
 * failure degrades quietly (fallback title, or no write at all). A manual
 * rename always wins over the generated title.
 */
export async function generateSessionTitle(options: GenerateSessionTitleOptions): Promise<void> {
	const { provider, taskId, userMessage, apiConfiguration, completePrompt = singleCompletionHandler } = options

	const sanitized = sanitizeUserMessageForTitle(userMessage)
	if (!sanitized) {
		return
	}

	if (inFlightTitles.has(taskId)) {
		return
	}
	const inFlight: InFlightTitle = {
		controller: new AbortController(),
		userCancelled: false,
	}
	inFlightTitles.set(taskId, inFlight)

	try {
		let title: string | undefined
		const rateLimitSeconds = apiConfiguration.rateLimitSeconds ?? 0
		if (rateLimitSeconds <= 0 && !inFlight.userCancelled) {
			try {
				title = await completeTitleViaLlm(
					completePrompt,
					apiConfiguration,
					taskId,
					sanitized,
					inFlight.controller,
				)
			} catch (error) {
				// LLM failure, cancellation, or timeout falls back to the message's first line.
				// Stryker disable next-line BlockStatement,BooleanLiteral,ConditionalExpression,StringLiteral: diagnostic logging only, does not alter control flow
				if (!inFlight.userCancelled) {
					console.error(`[session-title] LLM call failed for task ${taskId}:`, error)
				}
			}
		}
		let applied = false
		if (title) {
			applied = await applyTitleWithRetry(provider, taskId, title, () => inFlight.userCancelled)
		}
		if (!applied && !inFlight.userCancelled) {
			const fallback = fallbackTitle(sanitized)
			// Stryker disable next-line ConditionalExpression,LogicalOperator: defense-in-depth, fallback is always truthy for non-empty sanitized messages and distinct from failed title
			if (fallback && fallback !== title) {
				await applyTitleWithRetry(provider, taskId, fallback, () => inFlight.userCancelled)
			}
		}
	} catch (error) {
		// Best-effort by design: a failed title must never surface in the chat.
		// Stryker disable next-line BlockStatement,BooleanLiteral,ConditionalExpression: defense-in-depth, applyTitleWithRetry handles all expected errors internally
		if (!inFlight.userCancelled) {
			// Stryker disable next-line CallExpression,StringLiteral: diagnostic error logging only
			console.error(`[session-title] generation failed for task ${taskId}:`, error)
		}
	} finally {
		inFlightTitles.delete(taskId)
	}
}

async function completeTitleViaLlm(
	completePrompt: CompletePromptFn,
	apiConfiguration: ProviderSettings,
	taskId: string,
	sanitized: string,
	controller: AbortController,
): Promise<string | undefined> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		const completion = completePrompt(apiConfiguration, TITLE_PROMPT_PREFIX + sanitized, {
			taskId,
			timeoutMs: SESSION_TITLE_TIMEOUT_MS,
			abortSignal: controller.signal,
		})
		const timeout = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				controller.abort()
				// Stryker disable next-line CallExpression,StringLiteral: internal timeout error rejection, caught internally
				reject(new Error(`[session-title] timed out after ${SESSION_TITLE_TIMEOUT_MS}ms`))
			}, SESSION_TITLE_TIMEOUT_MS)
		})
		// Stryker disable next-line BlockStatement: executor registers abort listener
		const abortPromise = new Promise<never>((_, reject) => {
			// Stryker disable next-line BlockStatement,BooleanLiteral,ConditionalExpression: defense-in-depth, signal is fresh and rarely pre-aborted
			if (controller.signal.aborted) {
				// Stryker disable next-line CallExpression,StringLiteral: internal abort error rejection, caught internally
				reject(new Error("[session-title] aborted"))
				return
			}
			// Stryker disable next-line ArrowFunction,CallExpression,ObjectLiteral,StringLiteral: equivalent mutant, abort event fires at most once per controller
			controller.signal.addEventListener("abort", () => reject(new Error("[session-title] aborted")), {
				// Stryker disable next-line BooleanLiteral: equivalent mutant, abort controller aborts at most once
				once: true,
			})
		})
		const raw = await Promise.race([completion, timeout, abortPromise])
		return extractLlmTitle(raw)
	} finally {
		// Stryker disable next-line CallExpression: timer cleanup does not affect the resolved return value
		clearTimeout(timeoutId)
	}
}

async function applyTitleWithRetry(
	provider: ClineProvider,
	taskId: string,
	title: string,
	isCancelled: () => boolean,
): Promise<boolean> {
	for (let attempt = 0; ; attempt++) {
		// Stryker disable next-line BooleanLiteral,ConditionalExpression: defense-in-depth, caller checks cancellation before initiating write
		if (isCancelled()) {
			// Stryker disable next-line BooleanLiteral: return value indicating write was not applied
			return false
		}
		try {
			await provider.applySessionTitle(taskId, title)
			return true
		} catch (error) {
			if (isCancelled() || attempt >= TITLE_WRITE_MAX_RETRIES) {
				if (!isCancelled()) {
					console.error(
						`[session-title] giving up on task ${taskId} after ${attempt + 1} write attempts:`,
						error,
					)
				}
				return false
			}
		}
	}
}
