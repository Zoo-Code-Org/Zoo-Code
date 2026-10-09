import type { ReadFileParams } from "@roo-code/types"
import type { FileResult } from "./ReadFileTool"
import { clipUtf8 } from "./clipUtf8"

export type BatchFileResult = FileResult | { path: string; status: "budget_exhausted" }

const EXCERPT_MAX_BYTES = 180
const PATH_LABEL_MAX_BYTES = 256
const READER_TRUNCATION_NOTICE = "IMPORTANT: File content truncated."

interface RenderedContent {
	status: string
	content: string
	continuation: string
}

function clipExcerpt(text: string, maxBytes: number, notice: string): string {
	const clipped = clipUtf8(text, maxBytes)
	return clipped + (clipped !== text ? notice : "")
}

function getApprovedBody(entry: ReadFileParams, result: FileResult): { body: string; lineLimited: boolean } {
	const raw = result.nativeContent?.replace(`File: ${entry.path}\n`, "") ?? ""
	const lineLimited = raw.startsWith(READER_TRUNCATION_NOTICE)
	// A reader's original range warning becomes stale after aggregate clipping.
	const body = lineLimited ? raw.replace(/^IMPORTANT: File content truncated\.[\s\S]*?\n\s*\n\s*/, "") : raw
	return { body, lineLimited }
}

function clipCompleteLines(body: string, maxBytes: number): { content: string; budgetLimited: boolean } {
	const clipped = clipUtf8(body, maxBytes)
	if (clipped === body) return { content: body, budgetLimited: false }
	// Never present a partial line as complete or advance past undelivered text.
	return { content: clipped.slice(0, Math.max(0, clipped.lastIndexOf("\n"))), budgetLimited: true }
}

function formatContinuation(entry: ReadFileParams, content: string): string {
	const numbers = [...content.matchAll(/^\s*(\d+)\s*\|/gm)].map((match) => Number(match[1]))
	const requestedStart =
		entry.mode === "indentation" ? (entry.indentation?.anchor_line ?? entry.offset ?? 1) : (entry.offset ?? 1)
	const nextOffset = numbers.length ? Math.max(...numbers) + 1 : requestedStart
	return `\nContent clipped; structural blocks may be incomplete. Continue with read_file, path as requested, mode=slice, offset=${nextOffset}. Use a smaller batch/range or free context if no lines fit.`
}

function renderApprovedContent(entry: ReadFileParams, result: FileResult, maxBytes: number): RenderedContent {
	const { body, lineLimited } = getApprovedBody(entry, result)
	const { content, budgetLimited } = clipCompleteLines(body, maxBytes)
	const needsContinuation = budgetLimited || lineLimited
	const longLineNotice = result.longLinesTruncated
		? "\nLong lines clipped at 2000 characters (marked ...); line offsets cannot recover the omitted suffix."
		: ""
	const status = body.startsWith("Error:")
		? "error"
		: needsContinuation || result.longLinesTruncated
			? "truncated"
			: "success"
	return {
		status,
		content,
		continuation: (needsContinuation ? formatContinuation(entry, content) : "") + longLineNotice,
	}
}

function renderContent(entry: ReadFileParams, result: BatchFileResult, maxBytes: number): RenderedContent {
	if (result.status === "approved") return renderApprovedContent(entry, result, maxBytes)
	const content =
		"error" in result && result.error
			? clipExcerpt(result.error, Math.min(EXCERPT_MAX_BYTES, maxBytes), "... (error clipped)")
			: ""
	return { status: result.status, content, continuation: "" }
}

function formatFeedback(result: BatchFileResult): string {
	if (!("feedbackText" in result) || !result.feedbackText) return ""
	return `\nUser feedback: ${clipExcerpt(result.feedbackText, EXCERPT_MAX_BYTES, "... (feedback clipped)")}`
}

/** Pure per-entry rendering; byte consumption excludes the already reserved envelope. */
export function formatReadFileBatchEntry(
	entry: ReadFileParams,
	result: BatchFileResult,
	index: number,
	contentAllowance: number,
): { section: string; contentBytes: number } {
	const { status, content, continuation } = renderContent(entry, result, contentAllowance)
	const label = clipExcerpt(
		JSON.stringify(entry.path),
		PATH_LABEL_MAX_BYTES,
		"... (path abbreviated; see request index)",
	)
	return {
		section: `Entry ${index}: ${label}\nStatus: ${status}${content ? `\n${content}` : ""}${continuation}${formatFeedback(result)}`,
		contentBytes: Buffer.byteLength(content),
	}
}
