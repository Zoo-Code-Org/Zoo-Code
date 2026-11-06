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

/**
 * Thrown inside `atomicReadAndUpdate` when the item already carries a title,
 * so the auto-title path can detect the conflict without performing a
 * pointless disk write of an unchanged record.
 */
export class SessionTitleConflictError extends Error {
	constructor(taskId: string) {
		super(`[session-title] task ${taskId} already has a title; keeping it`)
		this.name = "SessionTitleConflictError"
	}
}

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

/** First non-empty line of the sanitized message, capped at 42 characters. */
export function fallbackTitle(sanitized: string): string | undefined {
	const firstLine = sanitized
		.split("\n")
		.find((line) => line.trim().length > 0)
		?.trim()
	if (!firstLine) {
		return undefined
	}
	return firstLine.length > FALLBACK_TITLE_MAX_CHARS ? firstLine.slice(0, FALLBACK_TITLE_MAX_CHARS) : firstLine
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

/** One in-flight title generation per session (spec). */
const inFlightTitleTaskIds = new Set<string>()

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

	if (inFlightTitleTaskIds.has(taskId)) {
		return
	}
	inFlightTitleTaskIds.add(taskId)

	try {
		let title: string | undefined
		try {
			title = await completeTitleViaLlm(completePrompt, apiConfiguration, taskId, sanitized)
		} catch (error) {
			// LLM failure or timeout falls back to the message's first line.
			console.error(`[session-title] LLM call failed for task ${taskId}:`, error)
		}
		title ??= fallbackTitle(sanitized)
		if (!title) {
			return
		}
		await applyTitleWithRetry(provider, taskId, title)
	} catch (error) {
		// Best-effort by design: a failed title must never surface in the chat.
		console.error(`[session-title] generation failed for task ${taskId}:`, error)
	} finally {
		inFlightTitleTaskIds.delete(taskId)
	}
}

async function completeTitleViaLlm(
	completePrompt: CompletePromptFn,
	apiConfiguration: ProviderSettings,
	taskId: string,
	sanitized: string,
): Promise<string | undefined> {
	const controller = new AbortController()
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
		// Promise.race attaches handlers to both inputs, so the completion
		// rejecting after the timeout is already considered handled.
		const raw = await Promise.race([completion, timeout])
		return extractLlmTitle(raw)
	} finally {
		clearTimeout(timeoutId)
	}
}

async function applyTitleWithRetry(provider: ClineProvider, taskId: string, title: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await provider.applySessionTitle(taskId, title)
			// Both outcomes end the attempt: "applied" is done, and "conflict"
			// means the user named the session (or another generation applied
			// first) — the existing title always wins.
			return
		} catch (error) {
			if (attempt >= TITLE_WRITE_MAX_RETRIES) {
				console.error(`[session-title] giving up on task ${taskId} after ${attempt + 1} write attempts:`, error)
				return
			}
		}
	}
}
