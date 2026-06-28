// npx vitest run src/core/tools/__tests__/fetchWebContentTool.spec.ts

import { FetchWebContentTool, htmlToText } from "../FetchWebContentTool"
import type { ToolCallbacks } from "../BaseTool"
import type { Task } from "../../task/Task"

// Mock formatResponse
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: (msg: string) => `Error: ${msg}`,
	},
}))

function createMockTask(overrides: Partial<Task> = {}): Task {
	return {
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		cwd: "/test/workspace",
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
		ask: vi.fn().mockResolvedValue(undefined),
		say: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as Task
}

function createMockCallbacks(): ToolCallbacks & {
	results: string[]
	approvals: string[]
	errors: string[]
} {
	const results: string[] = []
	const approvals: string[] = []
	const errors: string[] = []

	return {
		results,
		approvals,
		errors,
		askApproval: vi.fn().mockImplementation(async (_type: string, message: string) => {
			approvals.push(message)
			return true
		}),
		handleError: vi.fn().mockImplementation(async (context: string, error: Error) => {
			errors.push(`${context}: ${error.message}`)
		}),
		pushToolResult: vi.fn().mockImplementation((result: string) => {
			results.push(result)
		}),
	}
}

function createMockResponse(
	body: string,
	options: {
		status?: number
		statusText?: string
		contentType?: string
		ok?: boolean
	} = {},
): Response {
	const { status = 200, statusText = "OK", contentType = "text/plain", ok = true } = options

	const encoder = new TextEncoder()
	const encoded = encoder.encode(body)

	return {
		ok,
		status,
		statusText,
		headers: new Headers({ "content-type": contentType }),
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(encoded)
				controller.close()
			},
		}),
	} as unknown as Response
}

describe("FetchWebContentTool", () => {
	let tool: FetchWebContentTool
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		tool = new FetchWebContentTool()
		originalFetch = globalThis.fetch
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	describe("execute", () => {
		it("should fetch plain text content successfully", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(createMockResponse("Hello, world!", { contentType: "text/plain" }))

			await tool.execute({ url: "https://example.com/text" }, task, callbacks)

			expect(globalThis.fetch).toHaveBeenCalledWith(
				"https://example.com/text",
				expect.objectContaining({ method: "GET" }),
			)
			expect(callbacks.results).toEqual([
				[
					"URL: https://example.com/text",
					"Content-Type: text/plain",
					"Size: 13 bytes",
					"",
					"--- Content ---",
					"Hello, world!",
				].join("\n"),
			])
		})

		it("should convert HTML to text", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()
			const html = "<html><body><h1>Title</h1><p>Paragraph</p><script>alert('x')</script></body></html>"

			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(createMockResponse(html, { contentType: "text/html; charset=utf-8" }))

			await tool.execute({ url: "https://example.com" }, task, callbacks)

			expect(callbacks.results).toEqual([
				[
					"URL: https://example.com",
					"Content-Type: text/html; charset=utf-8",
					"Size: 83 bytes",
					"",
					"--- Content ---",
					"Title\n\nParagraph",
				].join("\n"),
			])
		})

		it("should pretty-print JSON responses", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()
			const json = '{"key":"value","nested":{"a":1}}'

			globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(json, { contentType: "application/json" }))

			await tool.execute({ url: "https://api.example.com/data" }, task, callbacks)

			expect(callbacks.results).toEqual([
				[
					"URL: https://api.example.com/data",
					"Content-Type: application/json",
					"Size: 32 bytes",
					"",
					"--- Content ---",
					JSON.stringify(JSON.parse(json), null, 2),
				].join("\n"),
			])
		})

		it("should error on missing url parameter", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			await tool.execute({ url: "" }, task, callbacks)

			expect(task.consecutiveMistakeCount).toBe(1)
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(task.recordToolError).toHaveBeenCalledWith("fetch_web_content")
		})

		it("should error on invalid URL", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			await tool.execute({ url: "not-a-url" }, task, callbacks)

			expect(task.consecutiveMistakeCount).toBe(1)
			expect(callbacks.results).toEqual(["Error: Invalid URL: not-a-url"])
		})

		it("should reject non-http protocols", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			await tool.execute({ url: "file:///etc/passwd" }, task, callbacks)

			expect(task.consecutiveMistakeCount).toBe(1)
			expect(callbacks.results).toEqual(["Error: Invalid protocol: file:. Only http and https are supported."])
		})

		it("should reject javascript: protocol", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			await tool.execute({ url: "javascript:alert(1)" }, task, callbacks)

			expect(task.consecutiveMistakeCount).toBe(1)
			expect(callbacks.results).toEqual([
				"Error: Invalid protocol: javascript:. Only http and https are supported.",
			])
		})

		it("should handle HTTP errors", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			globalThis.fetch = vi.fn().mockResolvedValue(
				createMockResponse("Not Found", {
					status: 404,
					statusText: "Not Found",
					ok: false,
				}),
			)

			await tool.execute({ url: "https://example.com/missing" }, task, callbacks)

			expect(callbacks.results).toEqual(["Error: HTTP 404: Not Found"])
		})

		it("should handle fetch timeout (AbortError)", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			const abortError = new Error("The operation was aborted")
			abortError.name = "AbortError"
			globalThis.fetch = vi.fn().mockRejectedValue(abortError)

			await tool.execute({ url: "https://example.com/slow" }, task, callbacks)

			expect(callbacks.results).toEqual(["Error: Request timed out after 30000ms"])
		})

		it("should not fetch when user rejects approval", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()
			callbacks.askApproval = vi.fn().mockResolvedValue(false)

			globalThis.fetch = vi.fn()

			await tool.execute({ url: "https://example.com" }, task, callbacks)

			expect(globalThis.fetch).not.toHaveBeenCalled()
			expect(callbacks.results).toEqual([])
		})

		it("should include prompt in output when provided", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(createMockResponse("Some content", { contentType: "text/plain" }))

			await tool.execute({ url: "https://example.com", prompt: "Find the API key section" }, task, callbacks)

			expect(callbacks.results).toEqual([
				[
					"URL: https://example.com",
					"Content-Type: text/plain",
					"Size: 12 bytes",
					"",
					"--- Content ---",
					"Some content",
					"",
					"--- Analysis Request ---",
					"Prompt: Find the API key section",
				].join("\n"),
			])
		})

		it("should handle response with no readable body", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-type": "text/plain" }),
				body: null,
			})

			await tool.execute({ url: "https://example.com/nobody" }, task, callbacks)

			expect(callbacks.results).toEqual(["Error: Failed to read response body"])
		})

		it("should error when response exceeds size limit", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			// Create a response that exceeds MAX_RESPONSE_BYTES (5MB)
			const largeChunk = new Uint8Array(3_000_000) // 3MB per chunk
			let chunkCount = 0

			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-type": "text/plain" }),
				body: {
					getReader: () => ({
						read: vi.fn().mockImplementation(async () => {
							chunkCount++
							if (chunkCount <= 2) {
								return { done: false, value: largeChunk }
							}
							return { done: true, value: undefined }
						}),
						cancel: vi.fn(),
					}),
				},
			})

			await tool.execute({ url: "https://example.com/large" }, task, callbacks)

			expect(callbacks.results).toEqual(["Error: Response too large: exceeded 5000000 bytes (5MB limit)"])
		})

		it("should truncate content exceeding MAX_CONTENT_CHARS", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			// Create content that exceeds 50,000 chars
			const longContent = "A".repeat(60_000)

			globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(longContent, { contentType: "text/plain" }))

			await tool.execute({ url: "https://example.com/long" }, task, callbacks)

			expect(callbacks.results).toEqual([
				[
					"URL: https://example.com/long",
					"Content-Type: text/plain",
					"Size: 60000 bytes",
					"",
					"--- Content ---",
					"A".repeat(50_000),
					"\n[Content truncated: showing first 50000 of 60000 characters]",
				].join("\n"),
			])
		})

		it("should handle invalid JSON with application/json content type", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(createMockResponse("not valid json {{{", { contentType: "application/json" }))

			await tool.execute({ url: "https://api.example.com/broken" }, task, callbacks)

			expect(callbacks.results).toEqual([
				[
					"URL: https://api.example.com/broken",
					"Content-Type: application/json",
					"Size: 18 bytes",
					"",
					"--- Content ---",
					"not valid json {{{",
				].join("\n"),
			])
		})

		it("should handle XHTML content type as HTML", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()
			const xhtml = '<?xml version="1.0"?><html><body><h1>XHTML Title</h1><p>Content here</p></body></html>'

			globalThis.fetch = vi.fn().mockResolvedValue(
				createMockResponse(xhtml, {
					contentType: "application/xhtml+xml; charset=utf-8",
				}),
			)

			await tool.execute({ url: "https://example.com/xhtml" }, task, callbacks)

			expect(callbacks.results).toEqual([
				[
					"URL: https://example.com/xhtml",
					"Content-Type: application/xhtml+xml; charset=utf-8",
					"Size: 86 bytes",
					"",
					"--- Content ---",
					"XHTML Title\n\nContent here",
				].join("\n"),
			])
		})

		it("should handle generic fetch errors via handleError", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			const networkError = new Error("ECONNREFUSED")
			globalThis.fetch = vi.fn().mockRejectedValue(networkError)

			await tool.execute({ url: "https://example.com/down" }, task, callbacks)

			expect(callbacks.handleError).toHaveBeenCalledWith("fetching web content", networkError)
			// Should not push a tool result for generic errors (handleError does it)
			expect(callbacks.results).toEqual([])
		})

		it("should not include prompt section when prompt is null", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(createMockResponse("Some content", { contentType: "text/plain" }))

			await tool.execute({ url: "https://example.com", prompt: null }, task, callbacks)

			expect(callbacks.results).toEqual([
				[
					"URL: https://example.com",
					"Content-Type: text/plain",
					"Size: 12 bytes",
					"",
					"--- Content ---",
					"Some content",
				].join("\n"),
			])
		})

		it("should not include prompt section when prompt is undefined", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(createMockResponse("Some content", { contentType: "text/plain" }))

			await tool.execute({ url: "https://example.com" }, task, callbacks)

			expect(callbacks.results).toEqual([
				[
					"URL: https://example.com",
					"Content-Type: text/plain",
					"Size: 12 bytes",
					"",
					"--- Content ---",
					"Some content",
				].join("\n"),
			])
		})

		it("should include size in output metadata", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse("Hello!", { contentType: "text/plain" }))

			await tool.execute({ url: "https://example.com/size" }, task, callbacks)

			expect(callbacks.results).toEqual([
				[
					"URL: https://example.com/size",
					"Content-Type: text/plain",
					"Size: 6 bytes",
					"",
					"--- Content ---",
					"Hello!",
				].join("\n"),
			])
		})

		it("should reset consecutiveMistakeCount on valid URL", async () => {
			const task = createMockTask({ consecutiveMistakeCount: 3 })
			const callbacks = createMockCallbacks()

			globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse("content", { contentType: "text/plain" }))

			await tool.execute({ url: "https://example.com" }, task, callbacks)

			expect(task.consecutiveMistakeCount).toBe(0)
		})

		it("should send correct approval message with fetchWebContent tool type", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse("content", { contentType: "text/plain" }))

			await tool.execute({ url: "https://example.com/approve" }, task, callbacks)

			expect(callbacks.askApproval).toHaveBeenCalledWith("tool", expect.any(String))
			const approvalMessage = JSON.parse(callbacks.approvals[0])
			expect(approvalMessage.tool).toBe("fetchWebContent")
			expect(approvalMessage.url).toBe("https://example.com/approve")
		})

		it("should handle empty content-type header", async () => {
			const task = createMockTask()
			const callbacks = createMockCallbacks()

			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({}),
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("raw content"))
						controller.close()
					},
				}),
			})

			await tool.execute({ url: "https://example.com/noct" }, task, callbacks)

			expect(callbacks.results).toEqual([
				[
					"URL: https://example.com/noct",
					"Content-Type: ",
					"Size: 11 bytes",
					"",
					"--- Content ---",
					"raw content",
				].join("\n"),
			])
		})
	})

	describe("handlePartial", () => {
		it("should not call task.ask until url has stabilized", async () => {
			const task = createMockTask()

			// First call with a url - not stabilized yet (first time seen)
			await tool.handlePartial(task, {
				type: "tool_use",
				name: "fetch_web_content",
				params: { url: "https://example.com" },
				partial: true,
			} as any)

			expect(task.ask).not.toHaveBeenCalled()

			// Second call with same url - now stabilized
			await tool.handlePartial(task, {
				type: "tool_use",
				name: "fetch_web_content",
				params: { url: "https://example.com" },
				partial: true,
			} as any)

			expect(task.ask).toHaveBeenCalledWith("tool", expect.any(String), true)
		})

		it("should not call task.ask when url is still changing", async () => {
			const task = createMockTask()

			await tool.handlePartial(task, {
				type: "tool_use",
				name: "fetch_web_content",
				params: { url: "https://ex" },
				partial: true,
			} as any)

			await tool.handlePartial(task, {
				type: "tool_use",
				name: "fetch_web_content",
				params: { url: "https://example.com" },
				partial: true,
			} as any)

			expect(task.ask).not.toHaveBeenCalled()
		})

		it("should not call task.ask when url is undefined", async () => {
			const task = createMockTask()

			await tool.handlePartial(task, {
				type: "tool_use",
				name: "fetch_web_content",
				params: {},
				partial: true,
			} as any)

			await tool.handlePartial(task, {
				type: "tool_use",
				name: "fetch_web_content",
				params: {},
				partial: true,
			} as any)

			expect(task.ask).not.toHaveBeenCalled()
		})

		it("should include url in the partial message JSON", async () => {
			const task = createMockTask()

			// Stabilize the url
			await tool.handlePartial(task, {
				type: "tool_use",
				name: "fetch_web_content",
				params: { url: "https://docs.example.com/api" },
				partial: true,
			} as any)

			await tool.handlePartial(task, {
				type: "tool_use",
				name: "fetch_web_content",
				params: { url: "https://docs.example.com/api" },
				partial: true,
			} as any)

			expect(task.ask).toHaveBeenCalledTimes(1)
			const callArg = (task.ask as ReturnType<typeof vi.fn>).mock.calls[0][1]
			const parsed = JSON.parse(callArg)
			expect(parsed.tool).toBe("fetchWebContent")
			expect(parsed.url).toBe("https://docs.example.com/api")
		})

		it("should swallow errors from task.ask", async () => {
			const task = createMockTask({
				ask: vi.fn().mockRejectedValue(new Error("ask failed")),
			})

			// Stabilize the url
			await tool.handlePartial(task, {
				type: "tool_use",
				name: "fetch_web_content",
				params: { url: "https://example.com" },
				partial: true,
			} as any)

			// Should not throw
			await tool.handlePartial(task, {
				type: "tool_use",
				name: "fetch_web_content",
				params: { url: "https://example.com" },
				partial: true,
			} as any)
		})
	})

	describe("htmlToText", () => {
		it("should strip script tags and content", () => {
			expect(htmlToText('<p>Hello</p><script>alert("x")</script><p>World</p>')).toBe("Hello\n\nWorld")
		})

		it("should strip style tags and content", () => {
			expect(htmlToText("<p>Hello</p><style>.foo { color: red; }</style>")).toBe("Hello")
		})

		it("should strip noscript, template, svg, and iframe elements", () => {
			const html = [
				"<p>Visible</p>",
				"<noscript>Enable JS</noscript>",
				"<template><div>Template content</div></template>",
				'<svg><circle r="10"/></svg>',
				'<iframe src="ad.html"></iframe>',
			].join("")
			expect(htmlToText(html)).toBe("Visible")
		})

		it("should strip <head> content (meta, title, link tags)", () => {
			const html = [
				"<html><head>",
				"<title>Page Title</title>",
				'<meta name="description" content="A description">',
				'<link rel="stylesheet" href="style.css">',
				"</head><body><p>Body content</p></body></html>",
			].join("")
			expect(htmlToText(html)).toBe("Body content")
		})

		it("should decode HTML entities", () => {
			expect(htmlToText("&amp; &lt; &gt; &quot; &nbsp;")).toBe('& < > "')
		})

		it("should decode numeric HTML entities (decimal and hex)", () => {
			expect(htmlToText("&#65;&#66;&#67; &#x44;&#x45;&#x46;")).toBe("ABC DEF")
		})

		it("should decode named entities like &mdash; and &rsquo;", () => {
			expect(htmlToText("Hello&mdash;World it&rsquo;s fine")).toBe("Hello\u2014World it\u2019s fine")
		})

		it("should normalize whitespace", () => {
			expect(htmlToText("<p>  Hello   World  </p>")).toBe("Hello World")
		})

		it("should add newlines between block-level elements", () => {
			expect(htmlToText("<div>First</div><div>Second</div><p>Third</p>")).toBe("First\n\nSecond\n\nThird")
		})

		it("should keep inline elements on the same line", () => {
			expect(htmlToText("<p>Hello <strong>bold</strong> and <em>italic</em> text</p>")).toBe(
				"Hello bold and italic text",
			)
		})

		it("should handle nested structures correctly", () => {
			expect(
				htmlToText(
					'<div><h1>Title</h1><p>Paragraph with <a href="#">a link</a> inside.</p><ul><li>Item 1</li><li>Item 2</li></ul></div>',
				),
			).toBe("Title\n\nParagraph with a link inside.\n\nItem 1\n\nItem 2")
		})

		it("should collapse excessive newlines to at most two", () => {
			expect(htmlToText("<p>A</p><br><br><br><br><p>B</p>")).toBe("A\n\nB")
		})

		it("should handle malformed HTML gracefully", () => {
			expect(htmlToText("<p>Unclosed paragraph<div>Nested <b>bold</div></b>")).toBe(
				"Unclosed paragraph\n\nNested bold",
			)
		})

		it("should remove HTML comments", () => {
			expect(htmlToText("<p>Before</p><!-- This is a comment --><p>After</p>")).toBe("Before\n\nAfter")
		})
	})
})
