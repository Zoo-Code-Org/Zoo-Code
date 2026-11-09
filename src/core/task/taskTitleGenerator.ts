import type { ProviderSettings } from "@roo-code/types"

import { supportPrompt } from "../../shared/support-prompt"
import { singleCompletionHandler } from "../../utils/single-completion-handler"

export const MAX_INPUT_PROMPT_LENGTH = 1000
export const MAX_TITLE_LENGTH = 50
// Issue #2333: the model request for the title must be limited to 15 seconds.
export const DEFAULT_TITLE_TIMEOUT_MS = 15000
// Issue #2333: when generation fails or times out, the title falls back to the
// first 42 characters of the initial prompt.
export const FALLBACK_TITLE_MAX_LENGTH = 42

export interface GenerateTaskTitleOptions {
	abortSignal?: AbortSignal
	timeoutMs?: number
	taskId?: string
}

/**
 * Normalizes raw LLM output into a single-line, clean title.
 * Strips surrounding quotes, trailing punctuation, collapses whitespace,
 * and limits the length to MAX_TITLE_LENGTH characters.
 */
export function cleanGeneratedTitle(rawTitle: string): string {
	let cleaned = rawTitle.replace(/\s+/g, " ").trim()
	// Strip opening/closing quotes if present
	cleaned = cleaned.replace(/^["'`]|["'`]$/g, "").trim()
	// Strip trailing periods or exclamation marks
	cleaned = cleaned.replace(/[.!?]+$/, "").trim()

	if (cleaned.length > MAX_TITLE_LENGTH) {
		cleaned = cleaned.slice(0, MAX_TITLE_LENGTH).trim()
	}

	return cleaned
}

/**
 * Issue #2333 fallback: the first FALLBACK_TITLE_MAX_LENGTH characters of the
 * initial prompt, used when title generation fails, times out, or returns no
 * usable title.
 */
export function fallbackTaskTitle(prompt: string): string {
	const normalized = (prompt ?? "").replace(/\s+/g, " ").trim()
	return normalized.slice(0, FALLBACK_TITLE_MAX_LENGTH).trim()
}

/**
 * Generates a concise summary title for a task from its initial prompt.
 * Runs with a strict timeout and length limit to prevent hanging.
 * Returns undefined on error, timeout, or cancellation so callers safely fall back.
 */
export async function generateTaskTitle(
	prompt: string,
	apiConfiguration: ProviderSettings,
	options?: GenerateTaskTitleOptions,
): Promise<string | undefined> {
	const trimmedPrompt = prompt?.trim()
	if (!trimmedPrompt) {
		return undefined
	}

	if (options?.abortSignal?.aborted) {
		return undefined
	}

	if (!apiConfiguration || !apiConfiguration.apiProvider) {
		return undefined
	}

	const timeoutMs = options?.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS
	const controller = new AbortController()
	const parentSignal = options?.abortSignal

	const onParentAbort = () => {
		controller.abort()
	}

	if (parentSignal) {
		parentSignal.addEventListener("abort", onParentAbort, { once: true })
	}

	const timeoutId = setTimeout(() => {
		controller.abort()
	}, timeoutMs)

	try {
		const promptSnippet = trimmedPrompt.slice(0, MAX_INPUT_PROMPT_LENGTH)
		const titlePrompt = supportPrompt.create("TASK_TITLE", { userInput: promptSnippet })

		const rawTitle = await singleCompletionHandler(apiConfiguration, titlePrompt, {
			abortSignal: controller.signal,
			timeoutMs,
			taskId: options?.taskId,
		})

		if (controller.signal.aborted || parentSignal?.aborted) {
			return undefined
		}

		const cleaned = cleanGeneratedTitle(rawTitle)
		return cleaned.length > 0 ? cleaned : undefined
	} catch (error) {
		// All errors (timeout, cancellation, API errors) fall back gracefully
		console.debug("[taskTitleGenerator] Title generation failed or cancelled:", error)
		return undefined
	} finally {
		clearTimeout(timeoutId)
		if (parentSignal) {
			parentSignal.removeEventListener("abort", onParentAbort)
		}
	}
}
