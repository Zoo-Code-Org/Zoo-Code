import type { ProviderSettings } from "@roo-code/types"

import type { ClineProvider } from "../webview/ClineProvider"
import { singleCompletionHandler } from "../../utils/single-completion-handler"

/** Hard bound on the single-shot title request (spec: 15 seconds). */
export const SESSION_TITLE_TIMEOUT_MS = 15_000
/** Character cap for the fallback title taken from the user message (spec: 42). */
export const FALLBACK_TITLE_MAX_CHARS = 42
/** Write attempts given up on after this many retries (spec: 3 retries). */
const TITLE_WRITE_MAX_RETRIES = 3

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
	// Linear scan instead of a lazy regex: repeated unterminated openings made the regex quadratic.
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
	const firstLine = raw.trim().split("\n")[0]?.trim() ?? ""
	const withoutPrefix = firstLine.replace(/^title:\s*/i, "")
	const withoutQuotes = withoutPrefix.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
	const title = withoutQuotes.trim()
	return title.length > 0 ? title : undefined
}

/** First 42 characters of the sanitized message, then whitespace collapsed. */
export function fallbackTitle(sanitized: string): string | undefined {
	const head = sanitized.trim().slice(0, FALLBACK_TITLE_MAX_CHARS)
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

interface InFlightTitleGeneration {
	controller: AbortController
	cancelled: boolean
}

/** In-flight title generation controllers by task ID. */
const inFlightTitles = new Map<string, InFlightTitleGeneration>()

/**
 * Cancels any pending or in-flight title generation for a task.
 * Called when a task is manually renamed, cleared, or deleted so an auto-generated title
 * never overwrites the user's manual intent.
 */
export function cancelSessionTitle(taskId: string): void {
	const inFlight = inFlightTitles.get(taskId)
	if (inFlight) {
		inFlight.cancelled = true
		inFlight.controller.abort()
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
	const inFlight: InFlightTitleGeneration = {
		controller: new AbortController(),
		cancelled: false,
	}
	inFlightTitles.set(taskId, inFlight)

	try {
		let title: string | undefined
		const rateLimitSeconds = apiConfiguration.rateLimitSeconds ?? 0
		if (rateLimitSeconds <= 0 && !inFlight.cancelled) {
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
				if (!inFlight.cancelled) {
					console.error(`[session-title] LLM call failed for task ${taskId}:`, error)
				}
			}
		}
		if (inFlight.cancelled) {
			return
		}
		title ??= fallbackTitle(sanitized)
		if (!title || inFlight.cancelled) {
			return
		}
		await applyTitleWithRetry(provider, taskId, title, () => inFlight.cancelled)
	} catch (error) {
		// Best-effort by design: a failed title must never surface in the chat.
		if (!inFlight.cancelled) {
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
		// Both options are honored only by some providers, so the race below is
		// the hard bound; it also aborts the signal so honoring providers stop
		// the request instead of burning tokens after the deadline.
		const completion = completePrompt(apiConfiguration, TITLE_PROMPT_PREFIX + sanitized, {
			taskId,
			timeoutMs: SESSION_TITLE_TIMEOUT_MS,
			abortSignal: controller.signal,
		})
		const timeout = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				controller.abort()
				reject(new Error(`[session-title] timed out after ${SESSION_TITLE_TIMEOUT_MS}ms`))
			}, SESSION_TITLE_TIMEOUT_MS)
		})
		const abortPromise = new Promise<never>((_, reject) => {
			if (controller.signal.aborted) {
				reject(new Error("[session-title] aborted"))
			} else {
				controller.signal.addEventListener(
					"abort",
					() => {
						reject(new Error("[session-title] aborted"))
					},
					{ once: true },
				)
			}
		})
		// Promise.race attaches handlers to all inputs, so rejections after completion are considered handled.
		const raw = await Promise.race([completion, timeout, abortPromise])
		return extractLlmTitle(raw)
	} finally {
		clearTimeout(timeoutId)
	}
}

async function applyTitleWithRetry(
	provider: ClineProvider,
	taskId: string,
	title: string,
	isCancelled: () => boolean,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		if (isCancelled()) {
			return
		}
		try {
			await provider.applySessionTitle(taskId, title)
			// Both outcomes end the attempt: "applied" is done, and "conflict"
			// means the user named the session (or another generation applied
			// first) — the existing title always wins.
			return
		} catch (error) {
			if (isCancelled() || attempt >= TITLE_WRITE_MAX_RETRIES) {
				if (!isCancelled()) {
					console.error(
						`[session-title] giving up on task ${taskId} after ${attempt + 1} write attempts:`,
						error,
					)
				}
				return
			}
		}
	}
}
