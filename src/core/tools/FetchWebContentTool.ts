import { type ClineSayTool } from "@roo-code/types"
import * as cheerio from "cheerio"

import { Task } from "../task/Task"
import type { ToolUse } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"

import { BaseTool, ToolCallbacks } from "./BaseTool"

/**
 * Default timeout for fetch requests in milliseconds (30 seconds)
 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Maximum response size in bytes (5MB)
 */
const MAX_RESPONSE_BYTES = 5_000_000

/**
 * Maximum content length in characters for the output
 */
const MAX_CONTENT_CHARS = 50_000

interface FetchWebContentParams {
	url: string
	prompt?: string | null
}

/**
 * Tags whose entire subtree should be removed (non-visible or non-content).
 */
const REMOVE_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "embed", "head"])

/**
 * Block-level elements that should produce a newline boundary.
 */
const BLOCK_TAGS = new Set([
	"p",
	"div",
	"section",
	"article",
	"aside",
	"main",
	"header",
	"footer",
	"nav",
	"blockquote",
	"pre",
	"figure",
	"figcaption",
	"details",
	"summary",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
	"li",
	"dl",
	"dt",
	"dd",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"td",
	"th",
	"caption",
	"hr",
	"br",
	"address",
	"form",
	"fieldset",
])

/**
 * Extract text content from HTML by parsing it into a DOM tree with cheerio,
 * removing non-content elements, and extracting text with proper whitespace
 * handling for block vs inline elements.
 */
export function htmlToText(html: string): string {
	const $ = cheerio.load(html)

	// Remove non-content elements entirely
	for (const tag of REMOVE_TAGS) {
		$(tag).remove()
	}

	// Walk the DOM tree and extract text with block-level newline boundaries
	const parts: string[] = []

	function walk(nodes: cheerio.Cheerio<any>): void {
		nodes.contents().each((_, node) => {
			if (node.type === "comment") {
				return
			}

			if (node.type === "text") {
				const text = $(node).text()
				if (text.trim()) {
					parts.push(text)
				}
				return
			}

			if (node.type === "tag") {
				const tagName = node.name.toLowerCase()

				// Add newline before block elements
				if (BLOCK_TAGS.has(tagName)) {
					parts.push("\n")
				}

				// Recurse into children
				walk($(node))

				// Add newline after block elements
				if (BLOCK_TAGS.has(tagName)) {
					parts.push("\n")
				}
			}
		})
	}

	walk($.root())

	// Join and normalize whitespace
	return (
		parts
			.join("")
			// Collapse runs of spaces/tabs (but not newlines) into a single space
			.replace(/[^\S\n]+/g, " ")
			// Remove spaces at the start/end of lines
			.replace(/ *\n */g, "\n")
			// Collapse 3+ consecutive newlines into 2
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	)
}

export class FetchWebContentTool extends BaseTool<"fetch_web_content"> {
	readonly name = "fetch_web_content" as const

	async execute(params: FetchWebContentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const url = params.url
		const prompt = params.prompt || undefined

		// Validate url parameter is present
		if (!url) {
			task.consecutiveMistakeCount++
			task.recordToolError("fetch_web_content")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("fetch_web_content", "url"))
			return
		}

		// Validate URL format
		let parsedUrl: URL
		try {
			parsedUrl = new URL(url)
		} catch {
			task.consecutiveMistakeCount++
			task.recordToolError("fetch_web_content")
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(`Invalid URL: ${url}`))
			return
		}

		// Only allow http and https protocols
		if (!["http:", "https:"].includes(parsedUrl.protocol)) {
			task.consecutiveMistakeCount++
			task.recordToolError("fetch_web_content")
			task.didToolFailInCurrentTurn = true
			pushToolResult(
				formatResponse.toolError(`Invalid protocol: ${parsedUrl.protocol}. Only http and https are supported.`),
			)
			return
		}

		task.consecutiveMistakeCount = 0

		// Build the approval message
		const sharedMessageProps: ClineSayTool = {
			tool: "fetchWebContent",
			url: url,
		}

		const completeMessage = JSON.stringify(sharedMessageProps satisfies ClineSayTool)
		const didApprove = await askApproval("tool", completeMessage)

		if (!didApprove) {
			return
		}

		// Execute the fetch
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

		try {
			const response = await fetch(url, {
				method: "GET",
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; ZooCode/1.0.0)",
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
					"Accept-Language": "en-US,en;q=0.9",
				},
				redirect: "follow",
				signal: controller.signal,
			})

			clearTimeout(timeout)

			if (!response.ok) {
				pushToolResult(formatResponse.toolError(`HTTP ${response.status}: ${response.statusText}`))
				return
			}

			const contentType = response.headers.get("content-type") || ""

			// Read response body with size limit
			const reader = response.body?.getReader()
			if (!reader) {
				pushToolResult(formatResponse.toolError("Failed to read response body"))
				return
			}

			const chunks: Uint8Array[] = []
			let totalSize = 0

			while (true) {
				const { done, value } = await reader.read()
				if (done) break

				totalSize += value.length
				if (totalSize > MAX_RESPONSE_BYTES) {
					reader.cancel()
					pushToolResult(
						formatResponse.toolError(
							`Response too large: exceeded ${MAX_RESPONSE_BYTES} bytes (${Math.round(MAX_RESPONSE_BYTES / 1_000_000)}MB limit)`,
						),
					)
					return
				}

				chunks.push(value)
			}

			// Combine chunks and decode
			const buffer = new Uint8Array(totalSize)
			let offset = 0
			for (const chunk of chunks) {
				buffer.set(chunk, offset)
				offset += chunk.length
			}
			const text = new TextDecoder("utf-8").decode(buffer)

			// Process content based on type
			let content: string
			if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
				content = htmlToText(text)
			} else if (contentType.includes("application/json")) {
				try {
					const json = JSON.parse(text)
					content = JSON.stringify(json, null, 2)
				} catch {
					content = text
				}
			} else {
				content = text
			}

			// Format output with metadata
			const outputLines = [
				`URL: ${url}`,
				`Content-Type: ${contentType}`,
				`Size: ${totalSize} bytes`,
				``,
				`--- Content ---`,
				content.slice(0, MAX_CONTENT_CHARS),
			]

			if (content.length > MAX_CONTENT_CHARS) {
				outputLines.push(
					`\n[Content truncated: showing first ${MAX_CONTENT_CHARS} of ${content.length} characters]`,
				)
			}

			if (prompt) {
				outputLines.push(``, `--- Analysis Request ---`, `Prompt: ${prompt}`)
			}

			pushToolResult(outputLines.join("\n"))
		} catch (error) {
			clearTimeout(timeout)

			if (error instanceof Error && error.name === "AbortError") {
				pushToolResult(formatResponse.toolError(`Request timed out after ${DEFAULT_TIMEOUT_MS}ms`))
				return
			}

			await handleError("fetching web content", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"fetch_web_content">): Promise<void> {
		const url = block.params.url

		if (!this.hasPathStabilized(url)) {
			return
		}

		const sharedMessageProps: ClineSayTool = {
			tool: "fetchWebContent",
			url: url ?? "",
		}

		const partialMessage = JSON.stringify(sharedMessageProps satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const fetchWebContentTool = new FetchWebContentTool()
