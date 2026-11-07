import type { ApiHandler, CompletePromptOptions, SingleCompletionHandler } from "../../api"
import type { ApiStream } from "../../api/transform/stream"

/**
 * Session title generation
 *
 * When a new root task starts, the first user message is turned into a short
 * title (5 to 10 words, in the language of the user) with one single-shot
 * completion request. The request runs in the background: it never blocks the
 * task and its errors are never shown in the chat. When generation fails or
 * takes longer than 15 seconds, the first 42 characters of the cleaned message
 * become the fallback title.
 */

/** Hard time limit for the title generation request. */
export const SESSION_TITLE_TIMEOUT_MS = 15_000

/** Length limit for the fallback title taken from the first message. */
export const SESSION_TITLE_FALLBACK_LENGTH = 42

/** Cap on the message text sent to the model, to keep the request small. */
const TITLE_MESSAGE_MAX_CHARS = 2_000

const TITLE_SYSTEM_PROMPT =
	"You generate short titles for chat sessions. Write one title of five to ten words " +
	"in the language of the user message. Keep the most important words from the message. " +
	"Reply with the title only: no quotes, no period, no other text."

/**
 * Removes `<system-reminder>` blocks from a message so they never shape the
 * title. A block without a closing tag (for example a truncated paste) is
 * removed to the end of the message.
 */
export function stripSystemReminderBlocks(message: string): string {
	return message
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
		.replace(/<system-reminder>[\s\S]*$/i, "")
}

/**
 * Builds the fallback title: the first 42 characters of the cleaned message,
 * on one line. Returns an empty string when nothing usable remains.
 */
export function createSessionTitleFallback(message: string, maxLength = SESSION_TITLE_FALLBACK_LENGTH): string {
	const cleaned = stripSystemReminderBlocks(message).replace(/\s+/g, " ").trim()
	if (!cleaned) {
		return ""
	}
	return cleaned.length <= maxLength ? cleaned : cleaned.slice(0, maxLength).trimEnd()
}

/**
 * Cleans model output: drops reasoning tags, collapses whitespace, and strips
 * wrapping quotes or emphasis markers so the title reads as plain text.
 */
export function sanitizeGeneratedTitle(raw: string): string {
	return raw
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/<\/?think>/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^["'`*]+|["'`*]+$/g, "")
		.trim()
}

export interface GenerateSessionTitleOptions {
	/** Time limit for the request. Defaults to {@link SESSION_TITLE_TIMEOUT_MS}. */
	timeoutMs?: number
	/** Task ID for provider-side tracking of the completion. */
	taskId?: string
	/** Optional external abort signal (for example the task's abort). */
	signal?: AbortSignal
}

/**
 * Generates a session title from the first user message.
 *
 * This function never throws: when the request fails, returns nothing useful,
 * or exceeds the time limit, the fallback title is returned instead. An empty
 * first message returns an empty string, which callers treat as "no title".
 */
export async function generateSessionTitle(
	handler: ApiHandler,
	firstMessage: string,
	options: GenerateSessionTitleOptions = {},
): Promise<string> {
	const { timeoutMs = SESSION_TITLE_TIMEOUT_MS, taskId, signal } = options

	const fallback = createSessionTitleFallback(firstMessage)
	if (!fallback) {
		return ""
	}

	const message = stripSystemReminderBlocks(firstMessage).replace(/\s+/g, " ").trim()
	const prompt = `${TITLE_SYSTEM_PROMPT}\n\nUser message:\n${message.slice(0, TITLE_MESSAGE_MAX_CHARS)}`

	// The controller enforces the time limit and forwards an external abort to
	// the underlying request. The race below bounds how long this function can
	// wait, even when a provider ignores the abort signal.
	const controller = new AbortController()
	const abort = () => controller.abort()
	signal?.addEventListener("abort", abort, { once: true })

	const timer = setTimeout(() => controller.abort(), timeoutMs)
	const timeoutRejection = new Promise<never>((_, reject) => {
		if (controller.signal.aborted) {
			reject(new Error("session title generation was aborted or timed out"))
			return
		}
		controller.signal.addEventListener(
			"abort",
			() => reject(new Error("session title generation was aborted or timed out")),
			{ once: true },
		)
	})

	try {
		const raw = await Promise.race([requestSingleShotCompletion(handler, prompt, controller, taskId), timeoutRejection])
		return sanitizeGeneratedTitle(raw) || fallback
	} catch {
		return fallback
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener("abort", abort)
	}
}

/**
 * Runs one completion for the title prompt. Providers that implement
 * `SingleCompletionHandler` use their single-shot path; every other provider
 * drains a one-message `createMessage` stream. No provider file needs to
 * change for either path.
 */
async function requestSingleShotCompletion(
	handler: ApiHandler,
	prompt: string,
	controller: AbortController,
	taskId?: string,
): Promise<string> {
	const singleShot = handler as Partial<SingleCompletionHandler>
	if (typeof singleShot.completePrompt === "function") {
		const options: CompletePromptOptions = { abortSignal: controller.signal }
		if (taskId) {
			options.taskId = taskId
		}
		return singleShot.completePrompt(prompt, options)
	}

	const stream: ApiStream = handler.createMessage(
		prompt,
		[{ role: "user", content: prompt }],
		{ taskId: taskId ?? "", abortSignal: controller.signal },
	)

	let text = ""
	for await (const chunk of stream) {
		if (chunk.type === "text") {
			text += chunk.text
		}
	}
	return text
}
