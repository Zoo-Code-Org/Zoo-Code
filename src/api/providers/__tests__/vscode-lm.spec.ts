import type { Mock } from "vitest"

// Mocks must come first, before imports
vi.mock("vscode", () => {
	class MockLanguageModelTextPart {
		type = "text"
		constructor(public value: string) {}
	}

	class MockLanguageModelToolCallPart {
		type = "tool_call"
		constructor(
			public callId: string,
			public name: string,
			public input: object,
		) {}
	}

	class MockLanguageModelToolResultPart {
		type = "tool_result"
		constructor(
			public callId: string,
			public content: unknown[],
		) {}
	}

	return {
		workspace: {
			getConfiguration: vi.fn(() => ({
				get: vi.fn((key: string, defaultValue: unknown) => defaultValue),
			})),
			onDidChangeConfiguration: vi.fn((_callback) => ({
				dispose: vi.fn(),
			})),
		},
		CancellationTokenSource: vi.fn(function () {
			return {
				token: {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn(),
				},
				cancel: vi.fn(),
				dispose: vi.fn(),
			}
		}),
		CancellationError: class CancellationError extends Error {
			constructor() {
				super("Operation cancelled")
				this.name = "CancellationError"
			}
		},
		LanguageModelChatMessage: {
			Assistant: vi.fn((content) => ({
				role: "assistant",
				content: Array.isArray(content) ? content : [new MockLanguageModelTextPart(content)],
			})),
			User: vi.fn((content) => ({
				role: "user",
				content: Array.isArray(content) ? content : [new MockLanguageModelTextPart(content)],
			})),
		},
		LanguageModelTextPart: MockLanguageModelTextPart,
		LanguageModelToolCallPart: MockLanguageModelToolCallPart,
		LanguageModelToolResultPart: MockLanguageModelToolResultPart,
		lm: {
			selectChatModels: vi.fn(),
		},
	}
})

import * as vscode from "vscode"
import { VsCodeLmHandler, extractLeakedToolCalls, trailingPartialToolMarkerLength } from "../vscode-lm"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { Anthropic } from "@anthropic-ai/sdk"
import { openAiModelInfoSaneDefaults, vscodeLlmDefaultModelId, vscodeLlmModels } from "@roo-code/types"

import { normalizeToolSchema } from "../../../utils/json-schema"
import { getMcpServerTools } from "../../../core/prompts/tools/native-tools/mcp_server"
import type { McpHub } from "../../../services/mcp/McpHub"
import { clearAllMocks } from "../../../test-utils/reset"
import { collectStream } from "../../../test-utils/stream"

const mockLanguageModelChat = {
	id: "test-model",
	name: "Test Model",
	vendor: "test-vendor",
	family: "test-family",
	version: "1.0",
	maxInputTokens: 4096,
	sendRequest: vi.fn(),
	countTokens: vi.fn(),
}

describe("VsCodeLmHandler", () => {
	let handler: VsCodeLmHandler
	const defaultOptions: ApiHandlerOptions = {
		vsCodeLmModelSelector: {
			vendor: "test-vendor",
			family: "test-family",
		},
	}

	beforeEach(() => {
		clearAllMocks()
		// Set up a default successful mock for selectChatModels before creating the handler
		const mockModels = [{ ...mockLanguageModelChat }]
		;(vscode.lm.selectChatModels as Mock).mockResolvedValue(mockModels)
		handler = new VsCodeLmHandler(defaultOptions)
	})

	afterEach(() => {
		handler.dispose()
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeDefined()
			expect(vscode.workspace.onDidChangeConfiguration).toHaveBeenCalled()
		})

		it("should handle configuration changes", () => {
			const callback = (vscode.workspace.onDidChangeConfiguration as Mock).mock.calls[0][0]
			callback({ affectsConfiguration: () => true })
			// Should reset client when config changes
			expect(handler["client"]).toBeNull()
		})

		it("should call initializeClient during construction", () => {
			// Constructor calls initializeClient() without await, so it starts async initialization.
			// Verify the handler is created and initializeClient was triggered.
			expect(handler).toBeDefined()
			// The constructor triggers initializeClient which calls selectChatModels
			expect(vscode.lm.selectChatModels).toHaveBeenCalled()
		})
	})

	describe("createClient", () => {
		it("should create client with selector", async () => {
			const mockModel = { ...mockLanguageModelChat }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([mockModel])

			const client = await handler["createClient"]({
				vendor: "test-vendor",
				family: "test-family",
			})

			expect(client).toBeDefined()
			expect(client.id).toBe("test-model")
			expect(vscode.lm.selectChatModels).toHaveBeenCalledWith({
				vendor: "test-vendor",
				family: "test-family",
			})
		})

		it("should return default client when no models available", async () => {
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([])

			const client = await handler["createClient"]({})

			expect(client).toBeDefined()
			expect(client.id).toBe("default-lm")
			expect(client.vendor).toBe("vscode")
		})

		it("should throw a Zoo Code branded error when selectChatModels fails", async () => {
			;(vscode.lm.selectChatModels as Mock).mockRejectedValueOnce(new Error("network down"))

			await expect(handler["createClient"]({ vendor: "test" })).rejects.toThrow(
				"Zoo Code <Language Model API>: Failed to select model: network down",
			)
		})
	})

	describe("createMessage", () => {
		beforeEach(() => {
			const mockModel = { ...mockLanguageModelChat }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([mockModel])
			mockLanguageModelChat.countTokens.mockResolvedValue(10)

			// Override the default client with our test client
			handler["client"] = mockLanguageModelChat
		})

		it("should stream text responses", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Hello",
				},
			]

			const responseText = "Hello! How can I help you?"
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart(responseText)
					return
				})(),
				text: (async function* () {
					yield responseText
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks).toHaveLength(2) // Text chunk + usage chunk
			expect(chunks[0]).toEqual({
				type: "text",
				text: responseText,
			})
			expect(chunks[1]).toMatchObject({
				type: "usage",
				inputTokens: expect.any(Number),
				outputTokens: expect.any(Number),
			})
		})

		it("should emit tool_call chunks when tools are provided", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Calculate 2+2",
				},
			]

			const toolCallData = {
				name: "calculator",
				arguments: { operation: "add", numbers: [2, 2] },
				callId: "call-1",
			}

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelToolCallPart(
						toolCallData.callId,
						toolCallData.name,
						toolCallData.arguments,
					)
					return
				})(),
				text: (async function* () {
					yield JSON.stringify({ type: "tool_call", ...toolCallData })
					return
				})(),
			})

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "calculator",
						description: "A simple calculator",
						parameters: {
							type: "object",
							properties: {
								operation: { type: "string" },
								numbers: { type: "array", items: { type: "number" } },
							},
						},
					},
				},
			]

			const stream = handler.createMessage(systemPrompt, messages, {
				taskId: "test-task",
				tools,
			})
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks).toHaveLength(2) // Tool call chunk + usage chunk
			expect(chunks[0]).toEqual({
				type: "tool_call",
				id: toolCallData.callId,
				name: toolCallData.name,
				arguments: JSON.stringify(toolCallData.arguments),
			})
		})

		describe("leaked tool-call recovery during streaming", () => {
			const salvageTools = [
				{
					type: "function" as const,
					function: {
						name: "calculator",
						description: "A simple calculator",
						parameters: { type: "object", properties: { operation: { type: "string" } } },
					},
				},
			]

			const streamTextParts = (parts: string[]) => {
				mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
					stream: (async function* () {
						for (const part of parts) {
							yield new vscode.LanguageModelTextPart(part)
						}
						return
					})(),
					text: (async function* () {
						yield parts.join("")
						return
					})(),
				})
			}

			const streamMixedParts = (parts: Array<string | { name: string; input: object }>) => {
				mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
					stream: (async function* () {
						for (const part of parts) {
							yield typeof part === "string"
								? new vscode.LanguageModelTextPart(part)
								: new vscode.LanguageModelToolCallPart("native-1", part.name, part.input)
						}
						return
					})(),
					text: (async function* () {
						yield ""
						return
					})(),
				})
			}

			const drain = async () => {
				const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }], {
					taskId: "test-task",
					tools: salvageTools,
				})
				const chunks = []
				for await (const chunk of stream) {
					chunks.push(chunk)
				}
				return chunks
			}

			const collect = async (parts: string[]) => {
				streamTextParts(parts)
				return drain()
			}

			it("recovers a tool call the model streamed as raw invoke XML", async () => {
				const chunks = await collect([
					"Thinking. ",
					'<function_calls><invoke name="calculator"><parameter name="operation">add</parameter></invoke></function_calls>',
				])

				expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([{ type: "text", text: "Thinking. " }])
				expect(chunks.filter((chunk) => chunk.type === "tool_call")).toEqual([
					{
						type: "tool_call",
						id: expect.stringContaining("vscodelm-salvaged-"),
						name: "calculator",
						arguments: JSON.stringify({ operation: "add" }),
					},
				])
			})

			it("detects a marker split across stream chunks", async () => {
				const chunks = await collect([
					"abc <function_calls><inv",
					'oke name="calculator"><parameter name="operation">sub</parameter></invoke></function_calls>',
				])

				expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([{ type: "text", text: "abc " }])
				expect(chunks.filter((chunk) => chunk.type === "tool_call")).toMatchObject([
					{ name: "calculator", arguments: JSON.stringify({ operation: "sub" }) },
				])
			})

			it("emits a carried tail as plain text when it never becomes a marker", async () => {
				const chunks = await collect(["hello <par"])

				expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
					{ type: "text", text: "hello " },
					{ type: "text", text: "<par" },
				])
				expect(chunks.some((chunk) => chunk.type === "tool_call")).toBe(false)
			})

			it("buffers across chunks that arrive after the marker", async () => {
				const chunks = await collect([
					'prose <function_calls><invoke name="calculator">',
					'<parameter name="operation">',
					"mul</parameter>",
					"</invoke></function_calls>",
				])

				expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([{ type: "text", text: "prose " }])
				expect(chunks.filter((chunk) => chunk.type === "tool_call")).toMatchObject([
					{ name: "calculator", arguments: JSON.stringify({ operation: "mul" }) },
				])
			})

			it("recovers a null-only declared parameter as JSON null through createMessage", async () => {
				mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
					stream: (async function* () {
						yield new vscode.LanguageModelTextPart(
							'<function_calls><invoke name="nuller"><parameter name="cursor">null</parameter></invoke></function_calls>',
						)
						return
					})(),
					text: (async function* () {
						yield ""
						return
					})(),
				})

				const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }], {
					taskId: "test-task",
					tools: [
						{
							type: "function" as const,
							function: {
								name: "nuller",
								description: "",
								parameters: { type: "object", properties: { cursor: { type: "null" } } },
							},
						},
					],
				})
				const chunks = []
				for await (const chunk of stream) {
					chunks.push(chunk)
				}

				expect(chunks.filter((chunk) => chunk.type === "tool_call")).toMatchObject([
					{ name: "nuller", arguments: JSON.stringify({ cursor: null }) },
				])
			})

			it("keeps an invoke block for an unknown tool as literal text", async () => {
				const block = '<invoke name="not_our_tool"><parameter name="a">1</parameter></invoke>'
				const chunks = await collect([block])

				expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([{ type: "text", text: block }])
				expect(chunks.some((chunk) => chunk.type === "tool_call")).toBe(false)
			})

			it("emits prose before the recovered tool call", async () => {
				const chunks = await collect([
					"Thinking. ",
					'<function_calls><invoke name="calculator"><parameter name="operation">add</parameter></invoke></function_calls>',
				])

				expect(chunks.map((chunk) => chunk.type)).toEqual(["text", "tool_call", "usage"])
			})

			it("flushes buffered text before a native tool call so no text follows a tool_use", async () => {
				streamMixedParts([
					'partial <invoke name="calculator">',
					{ name: "calculator", input: { operation: "div" } },
				])
				const chunks = await drain()

				// The ordering comparison is only meaningful once both kinds of chunk exist: a
				// silently broken flush emits no text at all, and -1 < firstToolCall would still hold.
				expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
					{ type: "text", text: "partial " },
					{ type: "text", text: '<invoke name="calculator">' },
				])
				const types = chunks.map((chunk) => chunk.type)
				const lastText = types.lastIndexOf("text")
				const firstToolCall = types.indexOf("tool_call")
				expect(lastText).toBeGreaterThanOrEqual(0)
				expect(firstToolCall).toBeGreaterThanOrEqual(0)
				expect(firstToolCall).toBeGreaterThan(lastText)
			})

			it("does not latch buffering on prose that merely mentions the tag", async () => {
				const chunks = await collect(["never emit <invoke> markup as text. ", "Streaming continues."])

				expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
					{ type: "text", text: "never emit <invoke> markup as text. " },
					{ type: "text", text: "Streaming continues." },
				])
				expect(chunks.some((chunk) => chunk.type === "tool_call")).toBe(false)
			})

			it("does not recover an invoke block quoted inside a fenced code block", async () => {
				const block = '<invoke name="calculator"><parameter name="operation">add</parameter></invoke>'
				const chunks = await collect(["Do NOT do this:\n```\n" + block + "\n```\n"])

				expect(chunks.some((chunk) => chunk.type === "tool_call")).toBe(false)
			})

			it("flushes an over-long never-closing invoke as plain text before the stream ends", async () => {
				// Defect 4: without a cap the buffer is only drained once the stream finishes, so the
				// user sees nothing until then. Releasing it at the end looks identical in content —
				// only the timing distinguishes the fix, so track how much of the source has been
				// produced at the moment each text chunk reaches the consumer.
				const filler = "x".repeat(5000)
				const parts = ['<invoke name="calculator">', filler, filler, filler, filler]
				let partsProduced = 0

				mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
					stream: (async function* () {
						for (const part of parts) {
							partsProduced++
							yield new vscode.LanguageModelTextPart(part)
						}
						return
					})(),
					text: (async function* () {
						yield ""
						return
					})(),
				})

				const stream = handler.createMessage("system", [{ role: "user" as const, content: "hi" }], {
					taskId: "test-task",
					tools: salvageTools,
				})

				let sawTextBeforeStreamEnd = false
				let streamedText = ""
				for await (const chunk of stream) {
					if (chunk.type === "text") {
						streamedText += chunk.text
						if (partsProduced < parts.length) {
							sawTextBeforeStreamEnd = true
						}
					}
				}

				expect(sawTextBeforeStreamEnd).toBe(true)
				expect(streamedText).toContain('<invoke name="calculator">')
				expect(streamedText).toContain(filler)
			})
		})

		it("should handle native tool calls when tools are provided", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Calculate 2+2",
				},
			]

			const toolCallData = {
				name: "calculator",
				arguments: { operation: "add", numbers: [2, 2] },
				callId: "call-1",
			}

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "calculator",
						description: "A simple calculator",
						parameters: {
							type: "object",
							properties: {
								operation: { type: "string" },
								numbers: { type: "array", items: { type: "number" } },
							},
						},
					},
				},
			]

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelToolCallPart(
						toolCallData.callId,
						toolCallData.name,
						toolCallData.arguments,
					)
					return
				})(),
				text: (async function* () {
					yield JSON.stringify({ type: "tool_call", ...toolCallData })
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages, {
				taskId: "test-task",
				tools,
			})
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks).toHaveLength(2) // Tool call chunk + usage chunk
			expect(chunks[0]).toEqual({
				type: "tool_call",
				id: toolCallData.callId,
				name: toolCallData.name,
				arguments: JSON.stringify(toolCallData.arguments),
			})
		})

		it("should pass tools to request options when tools are provided", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Calculate 2+2",
				},
			]

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "calculator",
						description: "A simple calculator",
						parameters: {
							type: "object",
							properties: {
								operation: { type: "string" },
							},
						},
					},
				},
			]

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Result: 4")
					return
				})(),
				text: (async function* () {
					yield "Result: 4"
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages, {
				taskId: "test-task",
				tools,
			})
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify sendRequest was called with tools in options
			// Note: normalizeToolSchema adds additionalProperties: false for JSON Schema 2020-12 compliance
			expect(mockLanguageModelChat.sendRequest).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					tools: [
						{
							name: "calculator",
							description: "A simple calculator",
							inputSchema: {
								type: "object",
								properties: {
									operation: { type: "string" },
								},
								additionalProperties: false,
							},
						},
					],
				}),
				expect.anything(),
			)
		})

		it("should handle errors", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Hello",
				},
			]

			mockLanguageModelChat.sendRequest.mockRejectedValueOnce(new Error("API Error"))

			await expect(handler.createMessage(systemPrompt, messages).next()).rejects.toThrow("API Error")
		})

		it("should brand the LM authorization justification as Zoo Code", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Hello",
				},
			]

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Hi")
					return
				})(),
				text: (async function* () {
					yield "Hi"
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream) {
				// drain
			}

			expect(mockLanguageModelChat.sendRequest).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					justification:
						"Zoo Code would like to use 'Test Model' from 'test-vendor', Click 'Allow' to proceed.",
				}),
				expect.anything(),
			)
		})

		it("should throw a Zoo Code branded error when request is cancelled", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Hello",
				},
			]

			mockLanguageModelChat.sendRequest.mockRejectedValueOnce(new vscode.CancellationError())

			await expect(handler.createMessage(systemPrompt, messages).next()).rejects.toThrow(
				"Zoo Code <Language Model API>: Request cancelled by user",
			)
		})

		it("should throw a Zoo Code branded error on stream error with error-like object", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user" as const,
					content: "Hello",
				},
			]

			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			mockLanguageModelChat.sendRequest.mockRejectedValueOnce({ code: "STREAM_ERROR", details: "broken" })

			await expect(handler.createMessage(systemPrompt, messages).next()).rejects.toThrow(
				"Zoo Code <Language Model API>: Response stream error:",
			)

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Stream error object:",
				expect.stringContaining("STREAM_ERROR"),
			)

			consoleErrorSpy.mockRestore()
		})
		it("should log Zoo Code branded warning for unknown chunk type in stream", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "Hello" }]

			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					// Yield an unknown chunk type (not TextPart, not ToolCallPart)
					yield { type: "unknown", foo: "bar" } as unknown as vscode.LanguageModelTextPart
					return
				})(),
				text: (async function* () {
					yield ""
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream) {
				// drain
			}

			expect(consoleWarnSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Unknown chunk type received:",
				expect.objectContaining({ type: "unknown" }),
			)

			consoleWarnSpy.mockRestore()
		})

		it("should log Zoo Code branded warning for invalid text part value", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "Hello" }]

			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			// Create a TextPart with a non-string value (number)
			const badTextPart = new vscode.LanguageModelTextPart(42 as unknown as string)
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield badTextPart
					return
				})(),
				text: (async function* () {
					yield ""
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream) {
				// drain
			}

			expect(consoleWarnSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Invalid text part value received:",
				42,
			)

			consoleWarnSpy.mockRestore()
		})

		it("should log Zoo Code branded warning for invalid tool callId", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "Hello" }]

			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			// Create a ToolCallPart with a non-string callId
			const badToolCall = new vscode.LanguageModelToolCallPart(123 as unknown as string, "valid-name", {})
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield badToolCall
					return
				})(),
				text: (async function* () {
					yield ""
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream) {
				// drain
			}

			expect(consoleWarnSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Invalid tool callId received:",
				123,
			)

			consoleWarnSpy.mockRestore()
		})

		it("should log Zoo Code branded warning for invalid tool input", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "Hello" }]

			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			// Create a ToolCallPart with a string input (not an object)
			const badToolCall = new vscode.LanguageModelToolCallPart(
				"call-1",
				"valid-name",
				"not-an-object" as unknown as object,
			)
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield badToolCall
					return
				})(),
				text: (async function* () {
					yield ""
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream) {
				// drain
			}

			expect(consoleWarnSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Invalid tool input received:",
				"not-an-object",
			)

			consoleWarnSpy.mockRestore()
		})

		it("should log Zoo Code branded error when tool call processing fails", async () => {
			const systemPrompt = "You are a helpful assistant"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "Hello" }]

			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			// Create a ToolCallPart with circular input that will throw on JSON.stringify
			const circularInput: Record<string, unknown> = { name: "circular" }
			circularInput.self = circularInput

			const badToolCall = new vscode.LanguageModelToolCallPart("call-1", "valid-name", circularInput)
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield badToolCall
					return
				})(),
				text: (async function* () {
					yield ""
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages, {
				taskId: "test-task",
				tools: [
					{
						type: "function" as const,
						function: { name: "test", description: "", parameters: { type: "object", properties: {} } },
					},
				],
			})
			for await (const _chunk of stream) {
				// drain
			}

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Failed to process tool call:",
				expect.any(Error),
			)

			consoleErrorSpy.mockRestore()
		})
	})

	describe("getClient", () => {
		it("should log Zoo Code branded debug when creating client with selector", async () => {
			const consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})
			const mockModel = { ...mockLanguageModelChat }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValue([mockModel])
			handler["client"] = null

			// @ts-ignore – access private method for coverage
			await handler["getClient"]()

			expect(consoleDebugSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Creating client with selector:",
				expect.any(Object),
			)

			consoleDebugSpy.mockRestore()
		})

		it("should throw a Zoo Code branded error when getClient fails to create client", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			;(vscode.lm.selectChatModels as Mock).mockRejectedValueOnce(new Error("network error"))
			handler["client"] = null

			// @ts-ignore – access private method for coverage
			await expect(handler["getClient"]()).rejects.toThrow(
				"Zoo Code <Language Model API>: Failed to create client:",
			)

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Client creation failed:",
				expect.stringContaining("network error"),
			)

			consoleErrorSpy.mockRestore()
		})
	})

	describe("initializeClient", () => {
		it("should log when client is already initialized", async () => {
			const consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})

			handler["client"] = mockLanguageModelChat
			await handler.initializeClient()

			expect(consoleDebugSpy).toHaveBeenCalledWith("Zoo Code <Language Model API>: Client already initialized")

			consoleDebugSpy.mockRestore()
		})

		it("should log success when client is initialized", async () => {
			const consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})
			const mockModel = { ...mockLanguageModelChat }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValue([mockModel])
			handler["client"] = null

			await handler.initializeClient()

			expect(consoleDebugSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Client initialized successfully",
			)

			consoleDebugSpy.mockRestore()
		})

		it("should throw a Zoo Code branded error when client initialization fails", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			;(vscode.lm.selectChatModels as Mock).mockRejectedValue(new Error("select failed"))
			handler["client"] = null

			// Catch the unhandled rejection that may occur from the constructor's async call
			const initPromise = handler.initializeClient()

			await expect(initPromise).rejects.toThrow("Zoo Code <Language Model API>: Failed to initialize client:")

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Client initialization failed:",
				expect.stringContaining("select failed"),
			)

			consoleErrorSpy.mockRestore()
		})
	})

	describe("getModel", () => {
		it("should return model info when client exists", async () => {
			const mockModel = { ...mockLanguageModelChat }
			// The handler starts async initialization in the constructor.
			// Make the test deterministic by explicitly (re)initializing here.
			;(vscode.lm.selectChatModels as Mock).mockResolvedValue([mockModel])
			handler["client"] = null
			await handler.initializeClient()

			const model = handler.getModel()
			expect(model.id).toBe("test-model")
			expect(model.info).toBeDefined()
			expect(model.info.contextWindow).toBe(4096)
		})

		it("should return fallback model info when no client exists", () => {
			const consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})

			// Clear the client first
			handler["client"] = null
			const model = handler.getModel()
			expect(model.id).toBe("test-vendor/test-family")
			expect(model.info).toBeDefined()
			expect(consoleDebugSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: No client available, using fallback model info",
			)

			consoleDebugSpy.mockRestore()
		})

		it("should return basic model info when client exists", async () => {
			const mockModel = { ...mockLanguageModelChat }
			// The handler starts async initialization in the constructor.
			// Make the test deterministic by explicitly (re)initializing here.
			;(vscode.lm.selectChatModels as Mock).mockResolvedValue([mockModel])
			handler["client"] = null
			await handler.initializeClient()

			const model = handler.getModel()
			expect(model.info).toBeDefined()
			expect(model.info.contextWindow).toBe(4096)
		})

		it("should return fallback model info when no client exists", () => {
			// Clear the client first
			handler["client"] = null
			const model = handler.getModel()
			expect(model.info).toBeDefined()
		})

		it("should use the full advertised maxInputTokens without an upper cap", async () => {
			// A large advertised window is surfaced as-is, not clamped to a smaller default.
			const mockModel = { ...mockLanguageModelChat, maxInputTokens: 936000 }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValue([mockModel])
			handler["client"] = null
			await handler.initializeClient()

			const model = handler.getModel()
			expect(model.info.contextWindow).toBe(936000)
		})

		it("should pass through a small maxInputTokens unchanged", async () => {
			const mockModel = { ...mockLanguageModelChat, maxInputTokens: 4096 }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValue([mockModel])
			handler["client"] = null
			await handler.initializeClient()

			const model = handler.getModel()
			expect(model.info.contextWindow).toBe(4096)
		})

		it("should fall back to sane defaults when maxInputTokens is not a number", async () => {
			const mockModel = { ...mockLanguageModelChat, maxInputTokens: undefined as unknown as number }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValue([mockModel])
			handler["client"] = null
			await handler.initializeClient()

			const model = handler.getModel()
			expect(model.info.contextWindow).toBe(openAiModelInfoSaneDefaults.contextWindow)
		})
	})

	describe("getCondenseContextWindow", () => {
		it("uses the static-table maxInputTokens for a known VS Code LM family", () => {
			const opusHandler = new VsCodeLmHandler({
				vsCodeLmModelSelector: { vendor: "copilot", family: "claude-opus-4.8" },
			})
			expect(opusHandler.getCondenseContextWindow()).toBe(vscodeLlmModels["claude-opus-4.8"].maxInputTokens)
			opusHandler.dispose()
		})

		it("falls back to the default-row maxInputTokens for an unknown family (catalog drift)", () => {
			// `test-family` isn't a curated row (e.g. a selector left over from a dropped model), so the
			// gate resolves the default row instead of the inflated live window.
			handler["client"] = mockLanguageModelChat as unknown as vscode.LanguageModelChat
			expect(handler.getCondenseContextWindow()).toBe(vscodeLlmModels[vscodeLlmDefaultModelId].maxInputTokens)
		})

		it("falls back to the default-row maxInputTokens when no family is resolvable (no client, no selector family)", () => {
			// No client and no selector family means `family` is undefined, so the gate uses the default
			// row's maxInputTokens rather than the live getModel().info.contextWindow.
			const noFamilyHandler = new VsCodeLmHandler({ vsCodeLmModelSelector: { vendor: "copilot" } })
			noFamilyHandler["client"] = null
			expect(noFamilyHandler.getCondenseContextWindow()).toBe(
				vscodeLlmModels[vscodeLlmDefaultModelId].maxInputTokens,
			)
			noFamilyHandler.dispose()
		})

		it("falls back to the derived window when the static row exists but maxInputTokens is non-positive", () => {
			// A curated row exists but its maxInputTokens is <= 0, so the `> 0` guard fails and the gate
			// falls back to getModel().info.contextWindow.
			const family = "claude-opus-4.8"
			const original = vscodeLlmModels[family].maxInputTokens
			try {
				;(vscodeLlmModels[family] as { maxInputTokens: number }).maxInputTokens = 0
				const guardHandler = new VsCodeLmHandler({
					vsCodeLmModelSelector: { vendor: "copilot", family },
				})
				// Leave the client unset so `family` resolves from the selector, forcing the zeroed
				// static row to be read instead of a live client's family.
				guardHandler["client"] = null
				expect(guardHandler.getCondenseContextWindow()).toBe(guardHandler.getModel().info.contextWindow)
				expect(guardHandler.getCondenseContextWindow()).toBe(openAiModelInfoSaneDefaults.contextWindow)
				guardHandler.dispose()
			} finally {
				;(vscodeLlmModels[family] as { maxInputTokens: number }).maxInputTokens = original
			}
		})
	})

	describe("countTokens", () => {
		beforeEach(() => {
			handler["client"] = mockLanguageModelChat
		})

		it("should count tokens when called outside of an active request", async () => {
			// Ensure no active request cancellation token exists
			handler["currentRequestCancellation"] = null

			mockLanguageModelChat.countTokens.mockResolvedValueOnce(42)

			const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Hello world" }]
			const result = await handler.countTokens(content)

			expect(result).toBe(42)
			expect(mockLanguageModelChat.countTokens).toHaveBeenCalledWith("Hello world", expect.any(Object))
		})

		it("should count tokens when called during an active request", async () => {
			// Simulate an active request with a cancellation token
			const mockCancellation = {
				token: { isCancellationRequested: false, onCancellationRequested: vi.fn() },
				cancel: vi.fn(),
				dispose: vi.fn(),
			}
			handler["currentRequestCancellation"] = mockCancellation as unknown as vscode.CancellationTokenSource

			mockLanguageModelChat.countTokens.mockResolvedValueOnce(50)

			const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Test content" }]
			const result = await handler.countTokens(content)

			expect(result).toBe(50)
			expect(mockLanguageModelChat.countTokens).toHaveBeenCalledWith("Test content", mockCancellation.token)
		})

		it("should return 0 when no client is available", async () => {
			handler["client"] = null
			handler["currentRequestCancellation"] = null

			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Hello" }]
			const result = await handler.countTokens(content)

			expect(result).toBe(0)
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: No client available for token counting",
			)

			consoleWarnSpy.mockRestore()
		})

		it("should handle image blocks with placeholder", async () => {
			handler["currentRequestCancellation"] = null
			mockLanguageModelChat.countTokens.mockResolvedValueOnce(5)

			const content: Anthropic.Messages.ContentBlockParam[] = [
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
			]
			const result = await handler.countTokens(content)

			expect(result).toBe(5)
			expect(mockLanguageModelChat.countTokens).toHaveBeenCalledWith("[IMAGE]", expect.any(Object))
		})

		it("should return 0 and log when empty text is provided to internalCountTokens", async () => {
			handler["currentRequestCancellation"] = null
			const consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})

			// @ts-ignore – access private method for coverage of line 234
			const result = await handler["internalCountTokens"]("")

			expect(result).toBe(0)
			expect(consoleDebugSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Empty text provided for token counting",
			)

			consoleDebugSpy.mockRestore()
		})

		it("should return 0 and log when non-numeric token count is received", async () => {
			handler["currentRequestCancellation"] = null
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			mockLanguageModelChat.countTokens.mockResolvedValueOnce("not-a-number" as unknown as number)

			const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "test" }]
			const result = await handler.countTokens(content)

			expect(result).toBe(0)
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Non-numeric token count received:",
				"not-a-number",
			)

			consoleWarnSpy.mockRestore()
		})

		it("should return 0 and log when negative token count is received", async () => {
			handler["currentRequestCancellation"] = null
			const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			mockLanguageModelChat.countTokens.mockResolvedValueOnce(-5)

			const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "test" }]
			const result = await handler.countTokens(content)

			expect(result).toBe(0)
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				"Zoo Code <Language Model API>: Negative token count received:",
				-5,
			)

			consoleWarnSpy.mockRestore()
		})
	})

	describe("completePrompt", () => {
		it("should complete single prompt", async () => {
			const mockModel = { ...mockLanguageModelChat }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([mockModel])

			const responseText = "Completed text"
			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart(responseText)
					return
				})(),
				text: (async function* () {
					yield responseText
					return
				})(),
			})

			// Override the default client with our test client to ensure it uses
			// the mock implementation rather than the default fallback
			handler["client"] = mockLanguageModelChat

			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe(responseText)
			expect(mockLanguageModelChat.sendRequest).toHaveBeenCalled()
		})

		it("should handle errors during completion", async () => {
			const mockModel = { ...mockLanguageModelChat }
			;(vscode.lm.selectChatModels as Mock).mockResolvedValueOnce([mockModel])

			mockLanguageModelChat.sendRequest.mockRejectedValueOnce(new Error("Completion failed"))

			// Make sure we're using the mock client
			handler["client"] = mockLanguageModelChat

			const promise = handler.completePrompt("Test prompt")
			await expect(promise).rejects.toThrow("VSCode LM completion error: Completion failed")
		})
	})

	describe("cleanMessageContent / deepClean", () => {
		it("passes through string content unchanged", () => {
			const result = handler["cleanMessageContent"]("hello")
			expect(result).toBe("hello")
		})

		it("returns falsy values as-is", () => {
			expect(handler["cleanMessageContent"]("")).toBe("")
		})

		it("recursively cleans array content", () => {
			const input: Anthropic.Messages.MessageParam["content"] = [{ type: "text", text: "hi" }]
			const result = handler["cleanMessageContent"](input)
			expect(result).toEqual([{ type: "text", text: "hi" }])
		})

		it("recursively cleans nested objects within array items", () => {
			const input: Anthropic.Messages.MessageParam["content"] = [
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			]
			const result = handler["cleanMessageContent"](input)
			expect(result).toEqual(input)
		})

		it("preserves primitive values other than strings inside objects", () => {
			// deepClean hits the final `return value` branch for non-string primitives
			// Exercise via a nested object whose property value is a number
			const input = [
				{ type: "text", text: "x", extra: 42 },
			] as unknown as Anthropic.Messages.MessageParam["content"]
			const result = handler["cleanMessageContent"](input) as unknown as Array<Record<string, unknown>>
			expect(result[0].extra).toBe(42)
		})
	})
})

describe("leaked tool-call recovery", () => {
	// Builders keep the XML fixtures readable and prevent this file's own markup from being
	// mistaken for a real tool call.
	const invoke = (name: string, body: string) => `<in${"voke"} name="${name}">${body}</in${"voke"}>`
	const param = (name: string, value: string) => `<param${"eter"} name="${name}">${value}</param${"eter"}>`
	const wrap = (body: string) => `<function${"_calls"}>${body}</function${"_calls"}>`

	describe("extractLeakedToolCalls", () => {
		it("recovers a known-tool block and strips it from the leftover text", () => {
			const text = `Working on it.\n${wrap(invoke("update_todo_list", param("todos", "[x] one\n[ ] two")))}`

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toEqual([{ name: "update_todo_list", input: { todos: "[x] one\n[ ] two" } }])
			expect(leftoverText).toBe("Working on it.\n")
		})

		it("recovers a wrapped leak preceded by a stray token", () => {
			const text = `court\n${wrap(invoke("update_todo_list", param("todos", "[x] done")))}`

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toEqual([{ name: "update_todo_list", input: { todos: "[x] done" } }])
			expect(leftoverText).toBe("court\n")
		})

		it("does not recover a bare invoke block with no function_calls wrapper", () => {
			const text = `court\n${invoke("update_todo_list", param("todos", "[x] done"))}`

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("does not recover an invoke that follows an already-closed wrapper", () => {
			const text = `${wrap("")}\n${invoke("update_todo_list", param("todos", "[x] done"))}`

			const { calls } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
		})

		it("recovers multiple params and strips function-call wrapper tags", () => {
			const body = param("mode", "code") + param("message", "go")
			const text = `<function_calls>${invoke("new_task", body)}</function_calls>`

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["new_task"]))

			expect(calls).toEqual([{ name: "new_task", input: { mode: "code", message: "go" } }])
			expect(leftoverText).toBe("")
		})

		it("passes through invoke blocks for tools that were not offered", () => {
			const text = invoke("some_other_tool", param("x", "1"))

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toEqual([])
			expect(leftoverText).toBe(text)
		})

		it("returns no calls for ordinary text", () => {
			const { calls, leftoverText } = extractLeakedToolCalls("just a normal reply", new Set(["update_todo_list"]))

			expect(calls).toEqual([])
			expect(leftoverText).toBe("just a normal reply")
		})
	})

	describe("trailingPartialToolMarkerLength", () => {
		it("holds back a split marker prefix at the end of a chunk", () => {
			expect(trailingPartialToolMarkerLength("some text <in")).toBe(3)
		})

		it("returns 0 for plain text and complete tags", () => {
			expect(trailingPartialToolMarkerLength("hello world")).toBe(0)
			expect(trailingPartialToolMarkerLength("a < b")).toBe(0)
			expect(trailingPartialToolMarkerLength("text <function_calls>")).toBe(0)
		})

		it("holds back an invoke tag whose name attribute has not arrived", () => {
			expect(trailingPartialToolMarkerLength("text <invoke ")).toBe(8)
		})

		it("does not hold back an over-long trailing fragment", () => {
			expect(trailingPartialToolMarkerLength("<invoke " + "x".repeat(200))).toBe(0)
		})

		it("does not hold back an over-long generic tag fragment", () => {
			expect(trailingPartialToolMarkerLength("text <" + "a".repeat(200))).toBe(0)
		})
	})

	describe("quoted markup", () => {
		it("does not recover an invoke block inside a fenced code block", () => {
			const text = "```\n" + invoke("update_todo_list", param("todos", "[x] one")) + "\n```"

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("does not recover an invoke block inside an inline code span", () => {
			const text = "avoid `" + invoke("update_todo_list", param("todos", "x")) + "`"

			const { calls } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
		})

		it("does not recover an invoke block quoted in unfenced, backtick-free prose", () => {
			const text = "You must never emit " + invoke("update_todo_list", param("todos", "x")) + " directly."

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("does not recover a quoted invoke block that ends its line", () => {
			// Defect 3: an empty rest-of-line previously made this look like a genuine leak.
			const text = "You must never emit " + invoke("update_todo_list", param("todos", "x"))

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("does not recover an invoke block inside a tilde fence", () => {
			const text = "~~~\n" + invoke("update_todo_list", param("todos", "[x] one")) + "\n~~~"

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("does not recover an invoke inside a four-backtick fence containing a three-backtick fence", () => {
			// A narrower inner fence must not close the wider outer one, so the invoke stays quoted.
			const text = "````\n```\n" + invoke("update_todo_list", param("todos", "[x] one")) + "\n```\n````"

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("does not recover an invoke inside a tilde fence containing a backtick fence line", () => {
			const text = "~~~\n```\n" + invoke("update_todo_list", param("todos", "[x] one")) + "\n```\n~~~"

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("recovers an invoke block that follows a closed code fence", () => {
			const text = "```\nexample output\n```\n" + wrap(invoke("update_todo_list", param("todos", "[x] one")))

			const { calls } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toEqual([{ name: "update_todo_list", input: { todos: "[x] one" } }])
		})

		it("does not treat doubled angle brackets as trailing prose after stripping", () => {
			// Defect 1: a single strip pass turns `<<x>>` into a tag-looking `<x>`, so the
			// trailing-text check must strip repeatedly until stable.
			const text = wrap(invoke("update_todo_list", param("todos", "x")) + "<<script>>")

			const { calls } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toEqual([{ name: "update_todo_list", input: { todos: "x" } }])
		})

		it("keeps wrapper tags around a block that was not recovered", () => {
			const text = `<function_calls>${invoke("some_other_tool", param("x", "1"))}</function_calls>`

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})
	})

	// The bare-invoke cases above short-circuit at the wrapper check, so they never exercise the
	// quoting guards. These keep the wrapper open so each guard is actually reached.
	describe("quoted markup inside an open function_calls wrapper", () => {
		const tools = new Set(["update_todo_list"])
		const quoted = (body: string) => `<function${"_calls"}>\n${body}`

		it("suppresses an invoke inside a three-backtick fence", () => {
			const block = invoke("update_todo_list", param("todos", "[x] one"))
			const text = quoted("```\n" + block + "\n```")

			const { calls, leftoverText } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("suppresses an invoke inside a tilde fence", () => {
			const block = invoke("update_todo_list", param("todos", "[x] one"))
			const text = quoted("~~~\n" + block + "\n~~~")

			const { calls } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
		})

		it("suppresses an invoke inside a four-backtick fence containing a narrower fence", () => {
			const block = invoke("update_todo_list", param("todos", "[x] one"))
			const text = quoted("````\n```\n" + block + "\n```\n````")

			const { calls } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
		})

		it("recovers an invoke that follows a CLOSED fence, proving the fence guard reopens", () => {
			const text = quoted("```\nexample\n```\n" + invoke("update_todo_list", param("todos", "[x] one")))

			const { calls } = extractLeakedToolCalls(text, tools)

			expect(calls).toEqual([{ name: "update_todo_list", input: { todos: "[x] one" } }])
		})

		it("suppresses an invoke inside an inline code span", () => {
			const text = quoted("avoid `" + invoke("update_todo_list", param("todos", "x")) + "`")

			const { calls } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
		})

		it("suppresses an invoke introduced by a quoting cue that ends its line", () => {
			const text = quoted("You must never emit " + invoke("update_todo_list", param("todos", "x")))

			const { calls, leftoverText } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("suppresses an invoke followed by narrative text on the same line", () => {
			const text = quoted(invoke("update_todo_list", param("todos", "x")) + " is what you must not do.")

			const { calls } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
		})
	})

	describe("schema-aware recovered parameters", () => {
		const schemas = new Map<string, Record<string, unknown> | undefined>([
			[
				"update_todo_list",
				{ type: "object", properties: { todos: { type: "array" }, note: { type: "string" } } },
			],
			[
				"read_file",
				{
					type: "object",
					properties: {
						path: { type: "string" },
						indentation: { type: "object" },
						limit: { type: "integer" },
						ratio: { type: "number" },
						recursive: { type: "boolean" },
						optional: { type: ["object", "null"] },
						nullScalar: { type: "null" },
						nullUnion: { type: ["null"] },
					},
				},
			],
		])

		it("converts a declared array parameter into a real array", () => {
			const text = wrap(invoke("update_todo_list", param("todos", '["a","b"]')))

			const { calls } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([{ name: "update_todo_list", input: { todos: ["a", "b"] } }])
		})

		it("converts declared object, number, integer and boolean parameters", () => {
			const body =
				param("path", "src/app.ts") +
				param("indentation", '{"anchor_line":42}') +
				param("limit", "10") +
				param("ratio", "1.5") +
				param("recursive", "true")
			const { calls } = extractLeakedToolCalls(wrap(invoke("read_file", body)), schemas)

			expect(calls).toEqual([
				{
					name: "read_file",
					input: {
						path: "src/app.ts",
						indentation: { anchor_line: 42 },
						limit: 10,
						ratio: 1.5,
						recursive: true,
					},
				},
			])
		})

		it("resolves a nullable union to its non-null type", () => {
			const text = wrap(invoke("read_file", param("optional", '{"a":1}')))

			const { calls } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([{ name: "read_file", input: { optional: { a: 1 } } }])
		})

		it("accepts an explicit null for a nullable union parameter", () => {
			const text = wrap(invoke("read_file", param("optional", "null")))

			const { calls } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([{ name: "read_file", input: { optional: null } }])
			expect(Object.keys(calls[0].input)).toContain("optional")
			expect(calls[0].input.optional).toBeNull()
		})

		it("fails closed when a non-nullable object parameter is null", () => {
			const text = wrap(invoke("read_file", param("indentation", "null")))

			const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("accepts an explicit null for a scalar null-only parameter", () => {
			const text = wrap(invoke("read_file", param("nullScalar", "null")))

			const { calls } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([{ name: "read_file", input: { nullScalar: null } }])
			expect(calls[0].input.nullScalar).toBeNull()
		})

		it("accepts an explicit null for a single-entry null union parameter", () => {
			const text = wrap(invoke("read_file", param("nullUnion", "null")))

			const { calls } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([{ name: "read_file", input: { nullUnion: null } }])
			expect(calls[0].input.nullUnion).toBeNull()
		})

		it("fails closed when a scalar null-only parameter carries a non-null value", () => {
			const text = wrap(invoke("read_file", param("nullScalar", '{"a":1}')))

			const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("fails closed when a single-entry null union parameter carries a non-null value", () => {
			const text = wrap(invoke("read_file", param("nullUnion", "123")))

			const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("keeps a declared string parameter as the literal text null", () => {
			const text = wrap(invoke("read_file", param("path", "null")))

			const { calls } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([{ name: "read_file", input: { path: "null" } }])
		})

		it("keeps a declared string parameter literal even when it looks like JSON", () => {
			const text = wrap(invoke("update_todo_list", param("note", "123")))

			const { calls } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([{ name: "update_todo_list", input: { note: "123" } }])
		})

		it("keeps every parameter literal when no schemas are supplied", () => {
			const text = wrap(invoke("update_todo_list", param("todos", '["a"]')))

			const { calls } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toEqual([{ name: "update_todo_list", input: { todos: '["a"]' } }])
		})

		it("fails closed to unchanged text when a structured parameter is not valid JSON", () => {
			const text = wrap(invoke("update_todo_list", param("todos", "[x] not json")))

			const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("fails closed when a parsed value has the wrong type for its schema", () => {
			const text = wrap(invoke("update_todo_list", param("todos", '{"a":1}')))

			const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("still requires the function_calls wrapper for a schema-typed call", () => {
			const text = invoke("update_todo_list", param("todos", '["a"]'))

			const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})
	})
})

// The MCP path normalizes dynamic server schemas before they reach the provider, so these fixtures
// must come from the real normalizer rather than a hand-written guess at its output shape.
describe("recovered parameters for normalized MCP schemas", () => {
	const invoke = (name: string, body: string) => `<in${"voke"} name="${name}">${body}</in${"voke"}>`
	const param = (name: string, value: string) => `<param${"eter"} name="${name}">${value}</param${"eter"}>`
	const wrap = (body: string) => `<function${"_calls"}>${body}</function${"_calls"}>`

	const normalized = normalizeToolSchema({
		type: "object",
		properties: {
			tags: { type: ["array", "null"], items: { type: "string" } },
			options: { type: ["object", "null"], properties: { deep: { type: "string" } } },
			limit: { type: ["integer", "null"] },
			note: { type: ["string", "null"] },
		},
		required: ["tags"],
	}) as Record<string, unknown>

	const schemas = new Map<string, Record<string, unknown> | undefined>([["mcp_server_search", normalized]])

	const recover = (body: string) => extractLeakedToolCalls(wrap(invoke("mcp_server_search", body)), schemas).calls

	it("emits typed alternatives rather than a plain type for nullable properties", () => {
		const properties = normalized.properties as Record<string, Record<string, unknown>>
		expect(properties.tags.type).toBeUndefined()
		expect(properties.tags.anyOf).toEqual([{ type: "array", items: { type: "string" } }, { type: "null" }])
	})

	it("converts a nullable array parameter to a real array", () => {
		expect(recover(param("tags", '["a","b"]'))).toEqual([
			{ name: "mcp_server_search", input: { tags: ["a", "b"] } },
		])
	})

	it("converts a nullable object parameter to a real object", () => {
		expect(recover(param("options", '{"deep":"x"}'))).toEqual([
			{ name: "mcp_server_search", input: { options: { deep: "x" } } },
		])
	})

	it("converts a nullable integer parameter to a number", () => {
		expect(recover(param("limit", "5"))).toEqual([{ name: "mcp_server_search", input: { limit: 5 } }])
	})

	it("accepts an explicit null for a nullable alternative", () => {
		expect(recover(param("tags", "null"))).toEqual([{ name: "mcp_server_search", input: { tags: null } }])
	})

	it("keeps a nullable string alternative literal", () => {
		expect(recover(param("note", "123"))).toEqual([{ name: "mcp_server_search", input: { note: "123" } }])
	})

	it("rejects a malformed value for a nullable array alternative", () => {
		const text = wrap(invoke("mcp_server_search", param("tags", "[not json")))
		const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

		expect(calls).toHaveLength(0)
		expect(leftoverText).toBe(text)
	})

	it("rejects a well-formed value of the wrong type for a nullable array alternative", () => {
		expect(recover(param("tags", '{"a":1}'))).toHaveLength(0)
	})

	it("leaves a mixed non-null union unresolved so no alternative is guessed", () => {
		const mixed = normalizeToolSchema({
			type: "object",
			properties: { value: { type: ["array", "number"] } },
		}) as Record<string, unknown>
		const mixedSchemas = new Map<string, Record<string, unknown> | undefined>([["mcp_server_search", mixed]])
		const text = wrap(invoke("mcp_server_search", param("value", "[1]")))

		expect(extractLeakedToolCalls(text, mixedSchemas).calls).toEqual([
			{ name: "mcp_server_search", input: { value: "[1]" } },
		])
	})

	it("routes a schema built by the MCP tool builder through the same conversion", () => {
		const mcpHub = {
			getServers: () => [
				{
					name: "server",
					tools: [
						{
							name: "search",
							inputSchema: {
								type: "object",
								properties: { tags: { type: ["array", "null"], items: { type: "string" } } },
							},
						},
					],
				},
			],
		} as unknown as McpHub

		const [tool] = getMcpServerTools(mcpHub)
		if (tool.type !== "function") {
			throw new Error("expected a function tool")
		}
		const { name, parameters } = tool.function
		const builderSchemas = new Map<string, Record<string, unknown> | undefined>([
			[name, parameters as Record<string, unknown>],
		])
		const text = wrap(invoke(name, param("tags", '["a"]')))

		expect(extractLeakedToolCalls(text, builderSchemas).calls).toEqual([{ name, input: { tags: ["a"] } }])
	})
})
