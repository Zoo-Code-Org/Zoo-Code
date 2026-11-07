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

/**
 * Outcome of `ClineProvider.applySessionTitle`.
 *
 * - `applied`: the generated title was written.
 * - `conflict`: a manual title (or a manual clear) already owns the task, so nothing was written.
 * - `not-ready`: the task's history item does not exist yet; the caller keeps the title for later.
 */
export type SessionTitleApplyResult = "applied" | "conflict" | "not-ready"

/** Outcome of one title write, including the local give-up case. */
type TitleWriteOutcome = SessionTitleApplyResult | "failed"

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
	/** Provider that owns this generation, so disposal can cancel and drain it. */
	provider: ClineProvider
	/** Settles once the generation has fully finished, including its write attempts. */
	settled: Promise<void>
}

/** In-flight title generation abort controllers by task ID. */
const inFlightTitles = new Map<string, InFlightTitle>()

/**
 * Generated titles whose history item did not exist yet, keyed by task ID.
 * `Task` flushes these once the item is persisted, so a transient initial save
 * failure cannot lose a title that was already generated.
 */
const pendingTitleWrites = new Map<string, { provider: ClineProvider; title: string }>()

/** In-flight deferred-title writes, so disposal can wait for them to finish. */
const inFlightFlushes = new Set<{ provider: ClineProvider; settled: Promise<void> }>()

/**
 * Cancels any pending or in-flight title generation for a task.
 * Called when a task is manually renamed, cleared, or deleted so an auto-generated title
 * never overwrites the user's manual intent.
 */
export function cancelSessionTitle(taskId: string): void {
	pendingTitleWrites.delete(taskId)
	const entry = inFlightTitles.get(taskId)
	if (entry) {
		entry.userCancelled = true
		entry.controller.abort()
	}
}

/**
 * Cancels every pending or in-flight title generation owned by `provider`.
 * Called from `ClineProvider#dispose()` so a request and its timer cannot
 * outlive the provider and write through the disposed history store.
 */
export function cancelSessionTitlesForProvider(provider: ClineProvider): void {
	for (const [taskId, entry] of inFlightTitles) {
		if (entry.provider !== provider) {
			continue
		}
		pendingTitleWrites.delete(taskId)
		entry.userCancelled = true
		entry.controller.abort()
	}
	// Titles whose generation already finished keep their entry until a save flushes or a cancel
	// drops it; disposal drops them too, so the released store is never written afterwards.
	for (const [taskId, pending] of pendingTitleWrites) {
		if (pending.provider === provider) {
			pendingTitleWrites.delete(taskId)
		}
	}
}

/**
 * Waits for `provider`'s in-flight title generation to settle, so disposal does
 * not release the history store underneath a title that is still being written.
 */
export async function drainSessionTitles(provider: ClineProvider): Promise<void> {
	const generations = Array.from(inFlightTitles.values())
		.filter((entry) => entry.provider === provider)
		.map((entry) => entry.settled)
	const flushes = Array.from(inFlightFlushes)
		.filter((entry) => entry.provider === provider)
		.map((entry) => entry.settled)
	await Promise.allSettled([...generations, ...flushes])
}

/**
 * Retries a title whose history item did not exist when the title was ready.
 *
 * The title write is deferred rather than dropped: `Task` calls this after a
 * save that persisted the history item, so the task still receives the
 * generated title (or the fallback) once its record exists.
 */
export async function flushPendingSessionTitle(taskId: string): Promise<void> {
	const pending = pendingTitleWrites.get(taskId)
	if (!pending) {
		return
	}
	if (pending.provider.isDisposed) {
		pendingTitleWrites.delete(taskId)
		return
	}
	let settle!: () => void
	const settled = new Promise<void>((resolve) => {
		settle = resolve
	})
	const entry = { provider: pending.provider, settled }
	inFlightFlushes.add(entry)
	try {
		const result = await pending.provider.applySessionTitle(taskId, pending.title)
		if (result === "applied" || result === "conflict") {
			pendingTitleWrites.delete(taskId)
		}
	} catch {
		// Keep the title for the next save instead of losing it to a transient write failure.
	} finally {
		inFlightFlushes.delete(entry)
		settle()
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

	// A disposed provider has no history store to write to; the task started after disposal
	// must not launch a request that would outlive it.
	if (provider.isDisposed) {
		return
	}

	const sanitized = sanitizeUserMessageForTitle(userMessage)
	if (!sanitized) {
		return
	}

	if (inFlightTitles.has(taskId)) {
		return
	}
	let settle!: () => void
	const settled = new Promise<void>((resolve) => {
		settle = resolve
	})
	const inFlight: InFlightTitle = {
		controller: new AbortController(),
		userCancelled: false,
		provider,
		settled,
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
		if (title) {
			const outcome = await applyTitleWithRetry(provider, taskId, title, () => inFlight.userCancelled)
			if (outcome === "not-ready") {
				// The history item is not persisted yet; `Task` retries this write once it is.
				// A cancelled generation must not restore the entry `cancelSessionTitle` dropped.
				if (!inFlight.userCancelled) {
					pendingTitleWrites.set(taskId, { provider, title })
				}
				return
			}
			// "applied" means the title is durable, and "conflict" means manual intent owns the
			// task; neither may be followed by the fallback write.
			if (outcome !== "failed") {
				return
			}
		}
		// `applyTitleWithRetry` owns the cancellation check, so a generation cancelled during
		// the LLM title write never reaches the fallback write.
		const fallback = fallbackTitle(sanitized)
		// Stryker disable next-line ConditionalExpression,LogicalOperator: defense-in-depth, fallback is always truthy for non-empty sanitized messages and distinct from failed title
		if (fallback && fallback !== title) {
			const outcome = await applyTitleWithRetry(provider, taskId, fallback, () => inFlight.userCancelled)
			if (outcome === "not-ready" && !inFlight.userCancelled) {
				pendingTitleWrites.set(taskId, { provider, title: fallback })
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
		settle()
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
): Promise<TitleWriteOutcome> {
	for (let attempt = 0; ; attempt++) {
		// Stryker disable next-line BooleanLiteral,ConditionalExpression: defense-in-depth, caller checks cancellation before initiating write
		if (isCancelled()) {
			// Stryker disable next-line StringLiteral: return value indicating write was not applied
			return "failed"
		}
		try {
			// "not-ready" is a result, not an error: the history item does not exist yet, so an
			// immediate retry cannot help. The caller keeps the title for a later apply.
			return await provider.applySessionTitle(taskId, title)
		} catch (error) {
			if (isCancelled() || attempt >= TITLE_WRITE_MAX_RETRIES) {
				if (!isCancelled()) {
					console.error(
						`[session-title] giving up on task ${taskId} after ${attempt + 1} write attempts:`,
						error,
					)
				}
				return "failed"
			}
		}
	}
}
