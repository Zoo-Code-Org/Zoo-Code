import type { ProviderSettings } from "@roo-code/types"

import { supportPrompt } from "../../shared/support-prompt"
import { mergeAbortSignalAndTimeout, settleOnAbort } from "../../api/providers/utils/abort-signal"
import { singleCompletionHandler } from "../../utils/single-completion-handler"
import type { CompletePromptOptions } from "../../api"

export const TASK_TITLE_TIMEOUT_MS = 15_000
export const TASK_TITLE_MAX_INPUT_CHARS = 1_000
export const TASK_TITLE_MAX_CHARS = 50
export const TASK_TITLE_FALLBACK_CHARS = 42

const CODE_BLOCK_MAX_LINES = 8

export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

function truncateCodeBlocks(text: string): string {
	return text.replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, (block: string, body: string) => {
		const lines = body.split("\n")
		if (lines.length <= CODE_BLOCK_MAX_LINES) {
			return block
		}
		return "```\n" + lines.slice(0, CODE_BLOCK_MAX_LINES).join("\n") + "\n...\n```"
	})
}

/** The prompt text sent to the model: code blocks shortened, then capped at 1,000 characters. */
export function buildTitleInput(prompt: string): string {
	return Array.from(truncateCodeBlocks(prompt)).slice(0, TASK_TITLE_MAX_INPUT_CHARS).join("")
}

const QUOTE_PAIRS: Array<[string, string]> = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["“", "”"],
	["‘", "’"],
	["「", "」"],
	["『", "』"],
]

function stripSurroundingQuotes(text: string): string {
	let current = text
	for (let changed = true; changed;) {
		changed = false
		for (const [open, close] of QUOTE_PAIRS) {
			if (current.length >= 2 && current.startsWith(open) && current.endsWith(close)) {
				current = current.slice(open.length, current.length - close.length).trim()
				changed = true
			}
		}
	}
	return current
}

/**
 * Remove markdown emphasis markers that wrap text, leaving markers inside identifiers such as
 * `snake_case` or `a*b` untouched.
 */
function stripEmphasis(text: string): string {
	return text.replace(
		/(^|[^\p{L}\p{N}*_])(\*{1,3}|_{1,3})(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}*_]|\.[\p{L}\p{N}])/gu,
		"$1$3",
	)
}

/**
 * Turn raw model output into a display title. Returns `undefined` when nothing usable remains or
 * the result merely repeats the prompt, so callers fall back to {@link fallbackTitle}.
 */
export function cleanTitle(raw: string, originalPrompt: string): string | undefined {
	const withoutThinking = raw
		.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")
		.replace(/<(think|thinking)>[\s\S]*$/i, "")

	const firstLine = withoutThinking
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0)
	if (!firstLine) {
		return undefined
	}

	let title = stripEmphasis(firstLine)
		.replace(/^(?:[#>*\-\s]+)/, "")
		.replace(/^(?:title|subject|제목)\s*[:：]\s*/i, "")
		.trim()
	title = stripSurroundingQuotes(title)
	title = title.replace(/[\s.。!?…,;:，；：]+$/u, "").trim()
	title = stripSurroundingQuotes(title)

	title = normalizeWhitespace(title)
	if (!title || title === normalizeWhitespace(originalPrompt)) {
		return undefined
	}
	return Array.from(title).slice(0, TASK_TITLE_MAX_CHARS).join("").trim()
}

/** First 42 characters of the whitespace-normalized prompt: the free title used when generation is skipped or fails. */
export function fallbackTitle(prompt: string): string {
	return Array.from(normalizeWhitespace(prompt)).slice(0, TASK_TITLE_FALLBACK_CHARS).join("").trim()
}

export type CompleteFn = (
	apiConfiguration: ProviderSettings,
	promptText: string,
	options?: CompletePromptOptions,
) => Promise<string>

export interface GenerateTaskTitleOptions {
	profile: ProviderSettings
	prompt: string
	customSupportPrompts?: Record<string, string | undefined>
	signal?: AbortSignal
	timeoutMs?: number
	complete?: CompleteFn
}

/**
 * Ask the model for a title. Rejects on provider failure, timeout, or abort; resolves `undefined`
 * when the model output is unusable.
 */
export async function generateTaskTitle(options: GenerateTaskTitleOptions): Promise<string | undefined> {
	const { profile, prompt, customSupportPrompts, signal, timeoutMs = TASK_TITLE_TIMEOUT_MS } = options
	const complete = options.complete ?? singleCompletionHandler

	const request = supportPrompt.create("TASK_TITLE", { userInput: buildTitleInput(prompt) }, customSupportPrompts)
	const merged = mergeAbortSignalAndTimeout(signal, timeoutMs)

	const raw = await settleOnAbort(
		complete(profile, request, { abortSignal: merged, timeoutMs }),
		merged,
		"task title",
	)
	return cleanTitle(raw, prompt)
}
