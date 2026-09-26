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
import {
	VsCodeLmHandler,
	extractLeakedToolCalls,
	trailingPartialToolMarkerLength,
	middleOutTruncate,
	truncateToolResultsToFitWindow,
} from "../vscode-lm"
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

		it("returns the original registry name for a tool declared with an encoded name", async () => {
			const systemPrompt = "You are a helpful assistant"
			const originalName = `read\uD800file`

			// The model echoes the DECLARED name; dispatch must still see the registry name.
			mockLanguageModelChat.sendRequest.mockImplementationOnce(async (_messages, options) => {
				const declaredName = options.tools[0].name
				return {
					stream: (async function* () {
						yield new vscode.LanguageModelToolCallPart("call-1", declaredName, { a: 1 })
						return
					})(),
					text: (async function* () {
						yield ""
						return
					})(),
				}
			})

			const tools = [
				{
					type: "function" as const,
					function: { name: originalName, description: "d", parameters: { type: "object" } },
				},
			]

			const chunks = []
			for await (const chunk of handler.createMessage(systemPrompt, [{ role: "user", content: "hi" }], {
				taskId: "test-task",
				tools,
			})) {
				chunks.push(chunk)
			}

			const declaredName = mockLanguageModelChat.sendRequest.mock.calls[0][1].tools[0].name
			expect(declaredName).toBe("read_uD800file")
			expect(declaredName).toMatch(/^[\w-]+$/)

			const toolCall = chunks.find((chunk) => chunk.type === "tool_call") as { name: string }
			expect(Array.from({ length: toolCall.name.length }, (_, index) => toolCall.name.charCodeAt(index))).toEqual(
				Array.from({ length: originalName.length }, (_, index) => originalName.charCodeAt(index)),
			)
		})

		it("round-trips a surrogate-free name that looks like the encoding marker", async () => {
			const systemPrompt = "You are a helpful assistant"
			mockLanguageModelChat.sendRequest.mockImplementationOnce(async (_messages, options) => {
				const declaredName = options.tools[0].name
				return {
					stream: (async function* () {
						yield new vscode.LanguageModelToolCallPart("call-1", declaredName, {})
						return
					})(),
					text: (async function* () {
						yield ""
						return
					})(),
				}
			})

			const chunks = []
			for await (const chunk of handler.createMessage(systemPrompt, [{ role: "user", content: "hi" }], {
				taskId: "test-task",
				tools: [
					{
						type: "function" as const,
						function: { name: "get_uuid", description: "d", parameters: { type: "object" } },
					},
				],
			})) {
				chunks.push(chunk)
			}

			expect(mockLanguageModelChat.sendRequest.mock.calls[0][1].tools[0].name).toBe("get_uuuid")
			expect(chunks.find((chunk) => chunk.type === "tool_call")).toMatchObject({ name: "get_uuid" })
		})

		it("preserves an ordinary tool name end to end", async () => {
			const systemPrompt = "You are a helpful assistant"
			mockLanguageModelChat.sendRequest.mockImplementationOnce(async (_messages, options) => {
				const declaredName = options.tools[0].name
				return {
					stream: (async function* () {
						yield new vscode.LanguageModelToolCallPart("call-1", declaredName, {})
						return
					})(),
					text: (async function* () {
						yield ""
						return
					})(),
				}
			})

			const tools = [
				{
					type: "function" as const,
					function: { name: "get_user", description: "d", parameters: { type: "object" } },
				},
			]

			const chunks = []
			for await (const chunk of handler.createMessage(systemPrompt, [{ role: "user", content: "hi" }], {
				taskId: "test-task",
				tools,
			})) {
				chunks.push(chunk)
			}

			expect(mockLanguageModelChat.sendRequest.mock.calls[0][1].tools[0].name).toBe("get_user")
			expect(chunks.find((chunk) => chunk.type === "tool_call")).toMatchObject({ name: "get_user" })
		})

		it("preserves a tool name containing a non-marker u+hex sequence end to end", async () => {
			mockLanguageModelChat.sendRequest.mockImplementationOnce(async (_messages, options) => {
				const declaredName = options.tools[0].name
				return {
					stream: (async function* () {
						yield new vscode.LanguageModelToolCallPart("call-1", declaredName, {})
						return
					})(),
					text: (async function* () {
						yield ""
						return
					})(),
				}
			})

			const chunks = []
			for await (const chunk of handler.createMessage(
				"You are a helpful assistant",
				[{ role: "user", content: "hi" }],
				{
					taskId: "test-task",
					tools: [
						{
							type: "function" as const,
							function: { name: "queue1234", description: "d", parameters: { type: "object" } },
						},
					],
				},
			)) {
				chunks.push(chunk)
			}

			expect(mockLanguageModelChat.sendRequest.mock.calls[0][1].tools[0].name).toBe("queue1234")
			expect(chunks.find((chunk) => chunk.type === "tool_call")).toMatchObject({ name: "queue1234" })
		})

		describe("system prompt sanitization", () => {
			it("sanitizes lone surrogates in the system prompt", async () => {
				mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
					stream: (async function* () {
						yield new vscode.LanguageModelTextPart("ok")
						return
					})(),
					text: (async function* () {
						yield "ok"
						return
					})(),
				})
				const stream = handler.createMessage("sys\uD800tem", [{ role: "user" as const, content: "hi" }])
				for await (const _chunk of stream) {
					// drain
				}

				expect(vscode.LanguageModelChatMessage.Assistant).toHaveBeenCalledWith("sys\uFFFDtem")
			})

			it("sanitizes lone surrogates in tool names, descriptions and nested schema strings", async () => {
				mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
					stream: (async function* () {
						yield new vscode.LanguageModelTextPart("ok")
						return
					})(),
					text: (async function* () {
						yield "ok"
						return
					})(),
				})

				const stream = handler.createMessage("sys", [{ role: "user" as const, content: "hi" }], {
					taskId: "test-task",
					tools: [
						{
							type: "function" as const,
							function: {
								name: "read\uD800file",
								description: "desc\uDC00ription",
								parameters: {
									type: "object",
									properties: { path: { type: "string", description: "p\uD800ath" } },
								},
							},
						},
						{
							type: "function" as const,
							function: { name: "read\uD801file", description: "other" },
						},
					],
				})
				for await (const _chunk of stream) {
					// drain
				}

				// Index-based so a surrogate pair contributes BOTH of its code units to the assertion.
				const codeUnits = (value: string): number[] =>
					Array.from({ length: value.length }, (_, index) => value.charCodeAt(index))

				const requestOptions = mockLanguageModelChat.sendRequest.mock.calls[0][1]
				const sentTool = requestOptions.tools[0]
				// Copilot rejects declared tool names that do not match this pattern before sending.
				expect(sentTool.name).toMatch(/^[\w-]+$/)
				expect(codeUnits(sentTool.name)).toEqual(codeUnits("read_uD800file"))
				expect(requestOptions.tools[1].name).toBe("read_uD801file")
				expect(codeUnits(sentTool.description)).toEqual(codeUnits("desc\uFFFDription"))
				const schemaProperties = (
					sentTool.inputSchema as { properties: Record<string, { description: string }> }
				).properties
				expect(codeUnits(schemaProperties.path.description)).toEqual(codeUnits("p\uFFFDath"))
			})
		})

		it("still trims oversized tool_results when the system prompt consumes most of the budget", async () => {
			// A system prompt large enough to drive the raw budget negative; the clamp keeps trimming
			// active for the case where the request is most oversized.
			const systemPrompt = "S".repeat(handler.getCondenseContextWindow() * 3)
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [{ type: "text", text: "hi" }],
				},
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "t1", name: "some_tool", input: { a: 1 } }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "t1", content: "X".repeat(50_000) }],
				},
			]

			// No sendRequest response is queued: the request must be refused before it is sent, and a
			// queued-but-unconsumed response would leak into later tests.
			// The clamped floor cannot be met once the tool_result bottoms out at its minimum, so the
			// request must be refused rather than sent over-window (which orphans the tool_result).
			const stream = handler.createMessage(systemPrompt, messages, { taskId: "test-task" })
			await expect(
				(async () => {
					for await (const _chunk of stream) {
						// drain
					}
				})(),
			).rejects.toThrow(/too large for this model's context window/)
			expect(mockLanguageModelChat.sendRequest).not.toHaveBeenCalled()
		})

		it("refuses a request that exceeds a small positive raw budget below the trimming floor", async () => {
			// The clamp to MIN_TOOL_RESULT_CHARS only keeps trimming productive; admission must still
			// respect the raw budget, otherwise a conversation between the raw budget and the floor is
			// sent over-window. Sized so the remaining content exceeds the raw budget but stays under
			// the floor, and so no tool_result is large enough for trimming to shrink anything.
			const targetRawBudgetChars = 1000
			const systemPrompt = "S".repeat(
				Math.floor(handler.getCondenseContextWindow() * 0.8 * 3) - targetRawBudgetChars,
			)
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "t1", name: "some_tool", input: { a: 1 } }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "t1", content: "X".repeat(1500) }],
				},
			]

			// No sendRequest response is queued: refusal must happen before the request is sent.
			const stream = handler.createMessage(systemPrompt, messages, { taskId: "test-task" })
			await expect(
				(async () => {
					for await (const _chunk of stream) {
						// drain
					}
				})(),
			).rejects.toThrow(/too large for this model's context window/)
			expect(mockLanguageModelChat.sendRequest).not.toHaveBeenCalled()
		})

		it("sends a request that fits within a small positive raw budget", async () => {
			const targetRawBudgetChars = 1000
			const systemPrompt = "S".repeat(
				Math.floor(handler.getCondenseContextWindow() * 0.8 * 3) - targetRawBudgetChars,
			)
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [{ type: "text", text: "Y".repeat(500) }],
				},
			]

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("ok")
					return
				})(),
				text: (async function* () {
					yield "ok"
					return
				})(),
			})

			const stream = handler.createMessage(systemPrompt, messages, { taskId: "test-task" })
			const chunks = await collectStream(stream)

			expect(mockLanguageModelChat.sendRequest).toHaveBeenCalled()
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
		})

		it("sends the request when trimming brings the conversation back under budget", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "t1", name: "some_tool", input: { a: 1 } }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "t1", content: "X".repeat(500_000) }],
				},
			]

			mockLanguageModelChat.sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("ok")
					return
				})(),
				text: (async function* () {
					yield "ok"
					return
				})(),
			})

			const stream = handler.createMessage("system", messages, { taskId: "test-task" })
			for await (const _chunk of stream) {
				// drain
			}

			const sent = JSON.stringify(mockLanguageModelChat.sendRequest.mock.calls[0][0])
			expect(sent).toContain("characters truncated")
			expect(sent).not.toContain("X".repeat(400_000))
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

		it("does not let a wrapper marker quoted inside an unrecovered invoke body arm a later bare invoke", () => {
			// A wrapper tag is only real when it appears outside an invoke body, otherwise quoted
			// markup in one block can authorize recovery of an unwrapped block after it.
			const text =
				invoke("some_other_tool", `<function${"_calls"}>`) +
				"\n" +
				invoke("update_todo_list", param("todos", "[x] one"))

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("fails closed on an invoke whose parameter markup is left unclosed", () => {
			// Partially parsed parameters would dispatch a call missing arguments the model wrote.
			const text = wrap(invoke("update_todo_list", `<param${"eter"} name="todos">[x] one`))

			const { calls } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
		})

		it("fails closed on a malformed parameter opener before a well-formed parameter", () => {
			// The strict pattern skips the unquoted-attribute opener, so recovering `beta` alone
			// would dispatch a call missing `alpha`.
			const text = wrap(
				invoke("update_todo_list", `<param${"eter"} name=alpha>A</param${"eter"}>` + param("beta", "B")),
			)

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("fails closed on a malformed parameter opener between two well-formed parameters", () => {
			// The defect is any unparseable opener in an inter-match gap, not only a leading one.
			const text = wrap(
				invoke(
					"update_todo_list",
					param("alpha", "A") + `<param${"eter"} name=mid>M</param${"eter"}>` + param("beta", "B"),
				),
			)

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("still recovers an invoke whose multiple parameters are all well-formed", () => {
			const text = wrap(invoke("update_todo_list", param("alpha", "A") + param("beta", "B")))

			const { calls } = extractLeakedToolCalls(text, new Set(["update_todo_list"]))

			expect(calls).toEqual([{ name: "update_todo_list", input: { alpha: "A", beta: "B" } }])
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

			const { calls, leftoverText } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("suppresses an invoke inside a four-backtick fence containing a narrower fence", () => {
			const block = invoke("update_todo_list", param("todos", "[x] one"))
			const text = quoted("````\n```\n" + block + "\n```\n````")

			const { calls, leftoverText } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("does not treat an info-string fence line as a closing fence", () => {
			const block = invoke("update_todo_list", param("todos", "[x] one"))
			const text = quoted("```md\n```ts\n" + block + "\n```\n```")

			const { calls, leftoverText } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("treats a fence line with a whitespace-only suffix as a closing fence", () => {
			const text = quoted("```\nexample\n```   \n" + invoke("update_todo_list", param("todos", "[x] one")))

			const { calls } = extractLeakedToolCalls(text, tools)

			expect(calls).toEqual([{ name: "update_todo_list", input: { todos: "[x] one" } }])
		})

		it("recovers an invoke that follows a CLOSED fence, proving the fence guard reopens", () => {
			const text = quoted("```\nexample\n```\n" + invoke("update_todo_list", param("todos", "[x] one")))

			const { calls } = extractLeakedToolCalls(text, tools)

			expect(calls).toEqual([{ name: "update_todo_list", input: { todos: "[x] one" } }])
		})

		it("suppresses an invoke inside an inline code span", () => {
			const text = quoted("avoid `" + invoke("update_todo_list", param("todos", "x")) + "`")

			const { calls, leftoverText } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("suppresses an invoke introduced by a quoting cue that ends its line", () => {
			const text = quoted("You must never emit " + invoke("update_todo_list", param("todos", "x")))

			const { calls, leftoverText } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("suppresses an invoke followed by narrative text on the same line", () => {
			const text = quoted(invoke("update_todo_list", param("todos", "x")) + " is what you must not do.")

			const { calls, leftoverText } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("suppresses a bare invoke after a wrapper closer that appeared inside a fence", () => {
			const text =
				`<function${"_calls"}>\n` +
				"```md\n" +
				`</function${"_calls"}>\n` +
				"```\n" +
				invoke("write_to_file", param("path", "a.txt") + param("content", "hi"))

			const { calls, leftoverText } = extractLeakedToolCalls(text, new Set(["write_to_file"]))

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
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

describe("leaked tool-call parser contracts", () => {
	const invoke = (name: string, body: string) => `<in${"voke"} name="${name}">${body}</in${"voke"}>`
	const param = (name: string, value: string) => `<param${"eter"} name="${name}">${value}</param${"eter"}>`
	const wrap = (body: string) => `<function${"_calls"}>${body}</function${"_calls"}>`
	// The fence in a quoting fixture must begin a line, so the wrapper opens on its own line.
	const wrapLines = (body: string) => `<function${"_calls"}>\n${body}\n</function${"_calls"}>`

	const tools = new Set(["update_todo_list"])
	const callsOf = (text: string) => extractLeakedToolCalls(text, tools).calls
	const todo = (value = "x") => invoke("update_todo_list", param("todos", value))

	const schemaFor = (properties: Record<string, unknown>) =>
		new Map<string, Record<string, unknown> | undefined>([["update_todo_list", { properties }]])
	const convert = (properties: Record<string, unknown>, raw: string) =>
		extractLeakedToolCalls(wrap(invoke("update_todo_list", param("value", raw))), schemaFor(properties)).calls

	describe("wrapper discrimination", () => {
		it("requires whitespace between invoke and its name attribute", () => {
			const glued = `<function${"_calls"}><in${"voke"}name="update_todo_list"></in${"voke"}></function${"_calls"}>`

			expect(callsOf(glued)).toHaveLength(0)
		})

		it("tolerates a newline between invoke and its name attribute", () => {
			const spaced = wrap(`<in${"voke"}\n name="update_todo_list">${param("todos", "x")}</in${"voke"}>`)

			expect(callsOf(spaced)).toHaveLength(1)
		})

		it("does not recover an unterminated name attribute", () => {
			expect(callsOf(wrap(`<in${"voke"} name="update_todo_list>x</in${"voke"}>`))).toHaveLength(0)
		})

		it("does not recover an empty name attribute", () => {
			expect(callsOf(wrap(invoke("", param("todos", "x"))))).toHaveLength(0)
		})

		it("recovers after an unrelated closed wrapper", () => {
			expect(callsOf(`${wrap("")}\n${wrap(todo())}`)).toHaveLength(1)
		})

		it("does not let a wrapper opener inside a closed code fence arm a later bare invoke", () => {
			const text = ["```", `<function${"_calls"}>`, "```", "", todo()].join("\n")

			expect(callsOf(text)).toHaveLength(0)
		})

		it("does not let a wrapper opener inside an inline-code span arm a later bare invoke", () => {
			const text = [`Use \`<function${"_calls"}>\` to open a block.`, "", todo()].join("\n")

			expect(callsOf(text)).toHaveLength(0)
		})

		it("does not let a wrapper opener inside a double-backtick span arm a later bare invoke", () => {
			const text = [`Example: \`\`<function${"_calls"}>\`\``, "", todo()].join("\n")
			const { calls, leftoverText } = extractLeakedToolCalls(text, tools)

			expect(calls).toHaveLength(0)
			expect(leftoverText).toBe(text)
		})

		it("keeps a double-backtick span quoted when it nests a literal single backtick", () => {
			const text = [`Example: \`\`<function${"_calls"}> \` here\`\``, "", todo()].join("\n")

			expect(callsOf(text)).toHaveLength(0)
		})

		it("does not let a wrapper opener inside a four-backtick span arm a later bare invoke", () => {
			const text = [`Example: \`\`\`\`<function${"_calls"}>\`\`\`\``, "", todo()].join("\n")

			expect(callsOf(text)).toHaveLength(0)
		})

		it("does not close a double-backtick span with a wider backtick run", () => {
			const text = [`Example: \`\`quoted \`\`\` <function${"_calls"}>\`\``, "", todo()].join("\n")

			expect(callsOf(text)).toHaveLength(0)
		})

		it("does not close a double-backtick span with either a wider or a narrower backtick run", () => {
			const text = [`Example: \`\`a \`\`\` b \` c <function${"_calls"}>\`\``, "", todo()].join("\n")

			expect(callsOf(text)).toHaveLength(0)
		})

		it("arms on a wrapper opener that follows a closed double-backtick span", () => {
			const text = [`Example: \`\`quoted\`\` then <function${"_calls"}>`, todo()].join("\n")

			expect(callsOf(text)).toHaveLength(1)
		})

		it("still arms on a wrapper opener that is not inside any backtick span", () => {
			expect(callsOf(wrap(todo()))).toHaveLength(1)
		})

		it("does not leak an unterminated double-backtick span across a newline", () => {
			expect(callsOf(wrapLines("see ``\n" + todo()))).toHaveLength(1)
		})

		it("still arms on a real wrapper opener that follows a closed code fence", () => {
			const text = ["```", "example", "```", "", `<function${"_calls"}>`, todo()].join("\n")

			expect(callsOf(text)).toHaveLength(1)
		})

		it("arms on an opening wrapper tag carrying inner whitespace", () => {
			expect(callsOf(`<function${"_calls"} >${todo()}`)).toHaveLength(1)
		})

		it("disarms on a closing wrapper tag carrying inner whitespace", () => {
			expect(callsOf(`<function${"_calls"}></function${"_calls"} >${todo()}`)).toHaveLength(0)
		})
	})

	describe("fence and quote discrimination", () => {
		it("keeps a fence indented three spaces open", () => {
			expect(callsOf(wrapLines("   ```\n" + todo()))).toHaveLength(0)
		})

		it("does not open a fence indented four spaces", () => {
			expect(callsOf(wrapLines("    ```\n" + todo()))).toHaveLength(1)
		})

		it("requires a fence to begin its line", () => {
			expect(callsOf(wrapLines("text ```\n" + todo()))).toHaveLength(1)
		})

		it("does not arm a wrapper opener that shares a line with a fence opener", () => {
			// The invoke is placed AFTER the fence closes so the fence gate alone cannot
			// suppress it — only the missing wrapper can.  A mutation that drops the
			// opener guard would open the wrapper, recover the invoke, and fail this test.
			const text = `~~~ ` + `<function${"_calls"}>` + `\n~~~\n` + todo()
			expect(callsOf(text)).toHaveLength(0)
		})

		it("does not close a wide fence with a narrower one", () => {
			expect(callsOf(wrapLines("````\n```\n" + todo() + "\n"))).toHaveLength(0)
		})

		it("closes a fence of equal width", () => {
			expect(callsOf(wrapLines("```\ncode\n```\n" + todo()))).toHaveLength(1)
		})

		it("does not close a tilde fence with a backtick fence", () => {
			expect(callsOf(wrapLines("~~~\n```\n" + todo() + "\n"))).toHaveLength(0)
		})

		it("does not treat a closed inline-code run before the wrapper as a fence", () => {
			const text = "text ```x``` " + `<function${"_calls"}>` + "\n" + todo()

			expect(callsOf(text)).toHaveLength(1)
		})

		it("does not open a backtick fence whose info string contains a backtick", () => {
			expect(callsOf("```lang`value\nmore\n" + wrapLines(todo()))).toHaveLength(1)
		})

		it("still opens a tilde fence whose info string contains a backtick", () => {
			expect(callsOf("~~~lang`value\nmore\n" + wrapLines(todo()))).toHaveLength(0)
		})

		it("suppresses on an odd backtick count earlier in the line", () => {
			expect(callsOf(wrapLines("see `" + todo()))).toHaveLength(0)
		})

		it("does not suppress on an even backtick count", () => {
			expect(callsOf(wrapLines("see `x` " + todo()))).toHaveLength(1)
		})

		it("does not suppress on trailing whitespace alone", () => {
			expect(callsOf(wrapLines(todo() + "   "))).toHaveLength(1)
		})

		it("does not suppress on trailing residual tags alone", () => {
			expect(callsOf(wrapLines(todo() + "<<>>"))).toHaveLength(1)
		})

		it("stops applying a quoting cue after sentence punctuation", () => {
			expect(callsOf(wrapLines("Never do that. Now " + todo()))).toHaveLength(1)
		})

		it("does not suppress on ordinary narration", () => {
			expect(callsOf(wrapLines("Working on it now " + todo()))).toHaveLength(1)
		})
	})

	describe("schema-directed conversion boundaries", () => {
		it("rejects a float for a declared integer", () => {
			expect(convert({ value: { type: "integer" } }, "1.5")).toHaveLength(0)
		})

		it("rejects a non-finite number", () => {
			expect(convert({ value: { type: "number" } }, "1e400")).toHaveLength(0)
		})

		it("rejects an array for a declared object", () => {
			expect(convert({ value: { type: "object" } }, "[]")).toHaveLength(0)
		})

		it("leaves an ambiguous multi-type union literal", () => {
			expect(convert({ value: { type: ["array", "object"] } }, '["a"]')[0].input).toEqual({ value: '["a"]' })
		})

		it("fails a block closed for an unsupported declared type", () => {
			expect(convert({ value: { type: "date" } }, "x")).toHaveLength(0)
		})

		it("does not treat an inherited Object.prototype key as a supported type", () => {
			expect(convert({ value: { type: "toString" } }, "x")).toHaveLength(0)
		})

		it("bails out on a null anyOf branch", () => {
			expect(convert({ value: { anyOf: [null] } }, '["a"]')[0].input).toEqual({ value: '["a"]' })
		})

		it("trims a parameter value", () => {
			expect(callsOf(wrap(invoke("update_todo_list", param("todos", "  spaced  "))))[0].input).toEqual({
				todos: "spaced",
			})
		})

		it("parses a whitespace-padded JSON array", () => {
			expect(convert({ value: { type: "array" } }, '  ["a"]  ')[0].input).toEqual({ value: ["a"] })
		})

		it("rejects a number for a declared object", () => {
			expect(convert({ value: { type: "object" } }, "5")).toHaveLength(0)
		})

		it("fails closed on a nested unclosed parameter tag and passes the text through", () => {
			const schemas = schemaFor({ a: { type: "string" }, b: { type: "string" } })
			const body = `<param${"eter"} name="a">` + param("b", "1") + "\n"
			const text = wrapLines(`<in${"voke"} name="update_todo_list">\n${body}</in${"voke"}>`)
			const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([])
			expect(leftoverText).toBe(text)
		})

		it("fails closed when a value hides markup that would overwrite an earlier argument", () => {
			// The split block would otherwise re-bind `path`, dispatching an attacker-chosen target.
			const schemas = schemaFor({ path: { type: "string" }, content: { type: "string" } })
			const body =
				param("path", "safe.txt") +
				param("content", `harmless</param${"eter"}><param${"eter"} name="path">/evil`)
			const text = wrapLines(`<in${"voke"} name="update_todo_list">\n${body}\n</in${"voke"}>`)
			const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([])
			expect(leftoverText).toBe(text)
		})

		it("fails closed on a value whose markup repeats the same parameter name", () => {
			const schemas = schemaFor({ path: { type: "string" } })
			const body = param("path", `a</param${"eter"}><param${"eter"} name="path">b`)
			const text = wrapLines(`<in${"voke"} name="update_todo_list">\n${body}\n</in${"voke"}>`)
			const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([])
			expect(leftoverText).toBe(text)
		})

		it("fails closed when a value injects a parameter name absent from the schema", () => {
			// A different-name injection bypasses the same-name Object.hasOwn guard; the schema
			// allow-list check after the loop is what catches it.
			const schemas = schemaFor({ path: { type: "string" }, content: { type: "string" } })
			const body =
				param("path", "safe.txt") +
				param("content", `harmless</param${"eter"}><param${"eter"} name="injected">evil`)
			const text = wrapLines(`<in${"voke"} name="update_todo_list">\n${body}\n</in${"voke"}>`)
			const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([])
			expect(leftoverText).toBe(text)
		})

		it("fails closed when the schema declares no properties but a parameter is present", () => {
			const schemas = schemaFor({})
			const body = param("path", "safe.txt")
			const text = wrapLines(`<in${"voke"} name="update_todo_list">\n${body}\n</in${"voke"}>`)
			const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([])
			expect(leftoverText).toBe(text)
		})

		it("fails closed when the schema has no properties record despite having a type constraint", () => {
			// A schema like { type: "object", additionalProperties: false } has no properties key.
			// Without schema.properties to validate against, recovery cannot safely allow-list params.
			const schemas = new Map<string, Record<string, unknown> | undefined>([
				["update_todo_list", { type: "object", additionalProperties: false }],
			])
			const body = param("path", "safe.txt")
			const text = wrapLines(`<in${"voke"} name="update_todo_list">\n${body}\n</in${"voke"}>`)
			const { calls, leftoverText } = extractLeakedToolCalls(text, schemas)

			expect(calls).toEqual([])
			expect(leftoverText).toBe(text)
		})

		it("also rejects a declared-string value containing literal parameter markup", () => {
			// Deliberate narrowing: failing closed beats dispatching a wrongly-parsed argument.
			expect(convert({ value: { type: "string" } }, `see <param${"eter"} name="b">`)).toHaveLength(0)
		})

		it("rejects a number for a declared boolean", () => {
			expect(convert({ value: { type: "boolean" } }, "5")).toHaveLength(0)
		})

		it("fails a block closed when an unsupported declared type carries parseable JSON", () => {
			expect(convert({ value: { type: "date" } }, "5")).toHaveLength(0)
		})

		it("ignores a non-string member of a declared type union", () => {
			expect(convert({ value: { type: ["array", 5] } }, '["a"]')[0].input).toEqual({ value: ["a"] })
		})
	})

	describe("carry boundaries", () => {
		it("holds a generic fragment of exactly the carry bound", () => {
			expect(trailingPartialToolMarkerLength("<" + "a".repeat(63))).toBe(64)
		})

		it("drops a generic fragment one character past the bound", () => {
			expect(trailingPartialToolMarkerLength("<" + "a".repeat(64))).toBe(0)
		})

		it("holds an invoke tail of exactly the carry bound", () => {
			expect(trailingPartialToolMarkerLength("<invoke " + "x".repeat(56))).toBe(64)
		})

		it("drops an invoke tail one character past the bound", () => {
			expect(trailingPartialToolMarkerLength("<invoke " + "x".repeat(57))).toBe(0)
		})
	})

	describe("preceding text and leftover segments", () => {
		it("positions the quote window using preceding text", () => {
			const { calls } = extractLeakedToolCalls(todo(), tools, `<function${"_calls"}>`)

			expect(calls).toHaveLength(1)
		})

		it("suppresses on a fence opened in an earlier chunk", () => {
			const { calls } = extractLeakedToolCalls(todo(), tools, `<function${"_calls"}>\n\`\`\`\n`)

			expect(calls).toHaveLength(0)
		})

		it("keeps text that follows a recovered call", () => {
			expect(extractLeakedToolCalls(`${wrap(todo())}\nAfterwards.`, tools).leftoverText).toBe("\nAfterwards.")
		})

		it("strips a closing wrapper tag carrying inner whitespace", () => {
			const text = `<function${"_calls"}>${todo()}</function${"_calls"} >`

			expect(extractLeakedToolCalls(text, tools).leftoverText).toBe("")
		})

		it("recovers two calls from one wrapper", () => {
			const { calls } = extractLeakedToolCalls(wrap(`${todo("a")}\n${todo("b")}`), tools)

			expect(calls.map((call) => call.input.todos)).toEqual(["a", "b"])
		})

		// Two recoveries put a non-last placeholder segment in the middle of the array, where both the
		// placeholder seeding and the last-segment lookup can silently reorder or leak text.
		it("keeps interleaved text in order across two recovered calls", () => {
			const text = `${wrap(`${todo("a")}\nmid\n${todo("b")}`)}\ntail`

			const { calls, leftoverText } = extractLeakedToolCalls(text, tools)

			expect(calls.map((call) => call.input.todos)).toEqual(["a", "b"])
			expect(leftoverText).toBe("\nmid\n\ntail")
		})
	})

	// Tag shapes a real backend varies on: whitespace inside the tags, and the `antml:` prefix.
	describe("tag whitespace tolerance", () => {
		it("recovers an invoke whose opening tag has whitespace before the closing bracket", () => {
			const spaced = `<in${"voke"} name="update_todo_list" >${param("todos", "x")}</in${"voke"}>`

			expect(callsOf(wrap(spaced))[0].input).toEqual({ todos: "x" })
		})

		it("recovers an invoke whose closing tag has whitespace before the bracket", () => {
			const spaced = `<in${"voke"} name="update_todo_list">${param("todos", "x")}</in${"voke"} >`

			expect(callsOf(wrap(spaced))[0].input).toEqual({ todos: "x" })
		})

		it("keeps a parameter whose closing tag has whitespace before the bracket", () => {
			const body = `<param${"eter"} name="todos">x</param${"eter"} >`
			const text = wrap(`<in${"voke"} name="update_todo_list">${body}</in${"voke"}>`)

			expect(callsOf(text)[0].input).toEqual({ todos: "x" })
		})

		it("reads a parameter name separated by more than one whitespace character", () => {
			const body = `<param${"eter"}\t\tname="todos">x</param${"eter"}>`
			const text = wrap(`<in${"voke"} name="update_todo_list">${body}</in${"voke"}>`)

			expect(callsOf(text)[0].input).toEqual({ todos: "x" })
		})

		it("arms on a reopened wrapper whose tag carries inner whitespace", () => {
			const text = `${wrap("")}\n<function${"_calls"} >\n${todo()}`

			expect(callsOf(text)).toHaveLength(1)
		})

		it("treats a tilde run shorter than three characters as ordinary text, not a fence", () => {
			expect(callsOf(`<function${"_calls"}>\n~\n${todo()}`)).toHaveLength(1)
		})

		it("recovers an invoke inside an antml: prefixed wrapper and strips the wrapper from leftover", () => {
			const body = `<param${"eter"} name="todos">x</param${"eter"}>`
			const invoke = `<in${"voke"} name="update_todo_list">${body}</in${"voke"}>`
			const text = `<antml:function${"_calls"}>${invoke}</antml:function${"_calls"}>`
			const { calls, leftoverText } = extractLeakedToolCalls(text, tools)
			expect(calls[0].input).toEqual({ todos: "x" })
			expect(leftoverText).toBe("")
		})

		it("recovers an antml: prefixed invoke inside a regular wrapper", () => {
			const body = `<param${"eter"} name="todos">x</param${"eter"}>`
			const invoke = `<antml:in${"voke"} name="update_todo_list">${body}</antml:in${"voke"}>`
			expect(callsOf(wrap(invoke))[0].input).toEqual({ todos: "x" })
		})

		it("reads a parameter wrapped in antml: prefixed parameter tags", () => {
			const body = `<antml:param${"eter"} name="todos">x</antml:param${"eter"}>`
			const text = wrap(`<in${"voke"} name="update_todo_list">${body}</in${"voke"}>`)
			expect(callsOf(text)[0].input).toEqual({ todos: "x" })
		})

		it("holds back a trailing antml: prefixed partial invoke at a chunk boundary", () => {
			expect(trailingPartialToolMarkerLength(`leading <antml:in${"voke"} name="`)).toBe(20)
		})
	})

	describe("chunk-boundary positioning", () => {
		it("does not hold back an invoke tag that already closed earlier in the chunk", () => {
			expect(trailingPartialToolMarkerLength("mid <invoke tail> more")).toBe(0)
		})

		it("locates the quoting cue relative to the preceding chunk, not its mirror image", () => {
			// The window offset is preceding.length + match.index; subtracting instead lands on an
			// earlier, cue-free slice and wrongly recovers the quoted block.
			const { calls } = extractLeakedToolCalls(`see \`${todo()}`, tools, `<function${"_calls"}>`)

			expect(calls).toHaveLength(0)
		})
	})
})

describe("quoting heuristics on the incremental scanner", () => {
	const tools = new Set(["update_todo_list"])
	const open = `<function${"_calls"}>`
	const todo = () =>
		`<in${"voke"} name="update_todo_list"><param${"eter"} name="todos">x</param${"eter"}></in${"voke"}>`
	const callsOf = (text: string) => extractLeakedToolCalls(text, tools).calls
	const fence = "```"

	it("suppresses on an unterminated tag left after the block on the same line", () => {
		expect(callsOf(`${open}\n${todo()} <`)).toHaveLength(0)
	})

	it("suppresses on narrative words following the block on the same line", () => {
		expect(callsOf(`${open}\n${todo()} trailing words`)).toHaveLength(0)
	})

	it("suppresses on a stray closing angle bracket after the block", () => {
		expect(callsOf(`${open}\n${todo()} >`)).toHaveLength(0)
	})

	it("suppresses when an unterminated tag precedes the block after a quoting cue", () => {
		expect(callsOf(`${open}\nnever <${todo()}`)).toHaveLength(0)
	})

	it("recovers when a sentence terminator inside an unterminated tag ends the cue's sentence", () => {
		expect(callsOf(`${open}\nnever <a.b${todo()}`)).toHaveLength(1)
	})

	it("recovers when the terminator immediately closes the cue's sentence", () => {
		expect(callsOf(`${open}\nnever.${todo()}`)).toHaveLength(1)
	})

	it("treats a repeated non-fence character run as ordinary text", () => {
		expect(callsOf(`${open}\n---\n${todo()}`)).toHaveLength(1)
	})

	it("closes a fence whose run is bare", () => {
		expect(callsOf(`${open}\n${fence}\n${fence}\n${todo()}`)).toHaveLength(1)
	})

	it("closes a fence whose suffix is whitespace only", () => {
		expect(callsOf(`${open}\n${fence}\n${fence} \n${todo()}`)).toHaveLength(1)
	})

	it("keeps a fence open when its closing run carries a single-character info string", () => {
		expect(callsOf(`${open}\n${fence}\n${fence}j\n${todo()}`)).toHaveLength(0)
	})

	it("keeps a fence open when its closing run carries a space-separated info string", () => {
		expect(callsOf(`${open}\n${fence}\n${fence} j\n${todo()}`)).toHaveLength(0)
	})

	it("tracks the line start across a newline that follows an earlier block on its own line", () => {
		// The first block leaves the scanner mid-line; the newline after it arrives in a later span,
		// so the running offset must survive that hand-off for the second block's cue to be found.
		expect(callsOf(`${open}\n${todo()}\nnever ${todo()}`)).toHaveLength(1)
	})

	it("measures the cue window from the line start when the preceding chunk ends mid-line", () => {
		// The cue sits in the preceding chunk, so the line-start offset must carry across the
		// boundary; drifting it lands on a different slice and the quoted block is wrongly recovered.
		expect(extractLeakedToolCalls(todo(), tools, `${open}\nnever `).calls).toHaveLength(0)
	})
})

describe("leaked tool-call parser scaling", () => {
	const tools = new Set(["update_todo_list"])
	const todo = () =>
		`<in${"voke"} name="update_todo_list"><param${"eter"} name="todos">x</param${"eter"}></in${"voke"}>`

	/**
	 * Characters the parser copies out of the message while scanning. Wall-clock timing flaked on
	 * shared CI runners, so work performed is counted instead: it is exact and machine-independent.
	 */
	const charactersScanned = (run: () => void): number => {
		const originalSlice = String.prototype.slice
		let scanned = 0
		String.prototype.slice = function (this: string, start?: number, end?: number): string {
			const piece = originalSlice.call(this, start, end)
			scanned += piece.length
			return piece
		}
		try {
			run()
		} finally {
			String.prototype.slice = originalSlice
		}
		return scanned
	}

	/**
	 * Work at 4x input over work at 1x. Linear scanning lands near 4; the quadratic prefix re-scan
	 * this pins landed near 16. Only the ratio is asserted, never an absolute count.
	 */
	const growthFactor = (build: (size: number) => string, baseSize: number, run: (input: string) => void): number => {
		const small = build(baseSize)
		const large = build(baseSize * 4)
		return (
			charactersScanned(() => run(large)) /
			Math.max(
				charactersScanned(() => run(small)),
				1,
			)
		)
	}

	/** Linear work must grow with the input, so a collapsed ratio near 1 fails too. */
	const expectLinearGrowth = (growth: number) => {
		expect(growth).toBeGreaterThan(3)
		expect(growth).toBeLessThan(6)
	}

	it("scans ordinary wrapped output doing work linear in message length", () => {
		const build = (count: number) => `<function${"_calls"}>\n${`${todo()}\n`.repeat(count)}</function${"_calls"}>\n`

		expectLinearGrowth(growthFactor(build, 150, (input) => extractLeakedToolCalls(input, tools)))
		expect(extractLeakedToolCalls(build(150), tools).calls).toHaveLength(150)
	})

	it("scans unclosed markup, deep nesting, and repeated quoting cues without quadratic blowup", () => {
		const unclosed = (count: number) =>
			`<function${"_calls"}>\n${`<in${"voke"} name="update_todo_list">\n`.repeat(count)}`
		expectLinearGrowth(growthFactor(unclosed, 400, (input) => extractLeakedToolCalls(input, tools)))

		// Nested tags before the block exercise tag stripping; cues with a trailing terminator
		// exercise the quoting-cue scan. Both are read through the public entry point.
		const nested = (depth: number) =>
			`<function${"_calls"}>\n${"<".repeat(depth)}tag${">".repeat(depth)} ${todo()}\n`
		expectLinearGrowth(growthFactor(nested, 500, (input) => extractLeakedToolCalls(input, tools)))

		const cues = (count: number) => `<function${"_calls"}>\n${"never. ".repeat(count)}never ${todo()}\n`
		expectLinearGrowth(growthFactor(cues, 500, (input) => extractLeakedToolCalls(input, tools)))
		// The cue still suppresses recovery, so the fast path did not silently change the verdict.
		expect(extractLeakedToolCalls(cues(500), tools).calls).toHaveLength(0)
	})
})

describe("context-window tool_result truncation", () => {
	describe("middleOutTruncate", () => {
		it("returns text unchanged when within the limit", () => {
			expect(middleOutTruncate("hello world", 100)).toBe("hello world")
		})

		it("returns text unchanged when its length exactly equals the limit", () => {
			// Longer than the truncation marker, so `<=` is observable here: the marker-less
			// fallback for tiny limits would otherwise return the same text under either operator.
			const text = "A".repeat(200)
			expect(middleOutTruncate(text, 200)).toBe(text)
		})

		it("stays within a limit too small to hold the truncation marker", () => {
			const text = "A".repeat(500)
			for (const limit of [1, 5, 50]) {
				const result = middleOutTruncate(text, limit)
				expect(result).toBe("A".repeat(limit))
			}
		})

		it("does not end a marker-less truncation on a lone high surrogate", () => {
			// Index-based so a surrogate pair contributes BOTH of its code units to the assertion.
			const codeUnits = (value: string): number[] =>
				Array.from({ length: value.length }, (_, index) => value.charCodeAt(index))

			// The limit lands between the halves of the pair at index 3, which would otherwise be
			// emitted alone and make the payload un-encodable as UTF-8.
			const result = middleOutTruncate(`abc\uD83D\uDE00${"z".repeat(200)}`, 4)

			expect(codeUnits(result)).toEqual(codeUnits("abc"))
		})

		it("keeps the head and tail and inserts a truncation marker", () => {
			const text = "A".repeat(500) + "B".repeat(500)
			const result = middleOutTruncate(text, 200)

			expect(result.length).toBeLessThanOrEqual(200)
			expect(result).toContain("characters truncated to fit the model context window")
			expect(result.startsWith("A")).toBe(true)
			expect(result.endsWith("B")).toBe(true)
		})

		it("returns an empty string for a non-positive limit", () => {
			expect(middleOutTruncate("anything", 0)).toBe("")
		})

		// A lone surrogate cannot be encoded as UTF-8 and 400s the whole request.
		it("never splits a surrogate pair across the removed middle", () => {
			const pair = "\u{1F600}" // one astral char = high + low surrogate
			const text = pair.repeat(400)
			const result = middleOutTruncate(text, 200)

			expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(false)
		})
	})

	describe("truncateToolResultsToFitWindow", () => {
		const toolUseMessage = (id: string): Anthropic.Messages.MessageParam => ({
			role: "assistant",
			content: [
				{ type: "text", text: "Calling a tool." },
				{ type: "tool_use", id, name: "some_tool", input: { a: 1 } },
			],
		})

		const toolResultMessage = (id: string, content: string): Anthropic.Messages.MessageParam => ({
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: id, content },
				{ type: "text", text: "<environment_details>env</environment_details>" },
			],
		})

		const findBlock = (message: Anthropic.Messages.MessageParam, type: string) =>
			(message.content as unknown as Array<{ type: string; [key: string]: unknown }>).find(
				(block) => block.type === type,
			)!

		it("is a no-op when the conversation already fits the budget", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				toolUseMessage("t1"),
				toolResultMessage("t1", "small result"),
			]
			const before = JSON.parse(JSON.stringify(messages))

			truncateToolResultsToFitWindow(messages, 100_000)

			expect(messages).toEqual(before)
		})

		it("returns messages untouched when the budget is not a usable number", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				toolUseMessage("t1"),
				toolResultMessage("t1", "Y".repeat(50_000)),
			]
			const before = JSON.parse(JSON.stringify(messages))

			expect(truncateToolResultsToFitWindow(messages, 0)).toBe(messages)
			expect(truncateToolResultsToFitWindow(messages, Number.NaN)).toBe(messages)
			expect(messages).toEqual(before)
		})

		it("truncates array-form tool_result content and preserves non-text parts", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				toolUseMessage("t1"),
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [
								{ type: "text", text: "Z".repeat(50_000) },
								{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
							],
						},
					],
				} as unknown as Anthropic.Messages.MessageParam,
			]

			truncateToolResultsToFitWindow(messages, 10_000)

			const toolResult = findBlock(messages[1], "tool_result")
			const parts = toolResult.content as Array<{ type: string; text?: string }>
			expect(parts[0].text).toContain("characters truncated")
			// Exact shape: a surviving original text part would leave a third element behind.
			expect(parts.map((part) => part.type)).toEqual(["text", "image"])
		})

		it("ignores string content and skips messages that cannot hold tool_result blocks", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "a plain string turn" },
				toolUseMessage("t1"),
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "t1", content: "W".repeat(50_000) },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
					],
				} as unknown as Anthropic.Messages.MessageParam,
			]

			truncateToolResultsToFitWindow(messages, 10_000)

			expect(messages[0].content).toBe("a plain string turn")
			expect(String(findBlock(messages[2], "tool_result").content)).toContain("characters truncated")
		})

		it("ignores a tool_result whose content is neither string nor array", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				toolUseMessage("t1"),
				toolResultMessage("t1", "V".repeat(50_000)),
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "t2", content: undefined }],
				} as unknown as Anthropic.Messages.MessageParam,
			]

			truncateToolResultsToFitWindow(messages, 10_000)

			expect(findBlock(messages[2], "tool_result").content).toBeUndefined()
			expect(String(findBlock(messages[1], "tool_result").content)).toContain("characters truncated")
		})

		it("skips a tool_result already small enough to need no trimming", () => {
			// Overage is tiny, so the largest block's target lands at its current length.
			const messages: Anthropic.Messages.MessageParam[] = [
				toolUseMessage("t1"),
				toolResultMessage("t1", "U".repeat(3000)),
				toolUseMessage("t2"),
				toolResultMessage("t2", "T".repeat(2500)),
			]

			truncateToolResultsToFitWindow(messages, 5600)

			const first = String(findBlock(messages[1], "tool_result").content)
			const second = String(findBlock(messages[3], "tool_result").content)
			expect(first.length + second.length).toBeLessThanOrEqual(5600)
		})

		it("leaves a tool_result at or below the minimum size alone", () => {
			const shortResult = "S".repeat(1500)
			const messages: Anthropic.Messages.MessageParam[] = [
				toolUseMessage("t1"),
				toolResultMessage("t1", shortResult),
				toolUseMessage("t2"),
				toolResultMessage("t2", shortResult),
			]

			truncateToolResultsToFitWindow(messages, 100)

			expect(findBlock(messages[1], "tool_result").content).toBe(shortResult)
			expect(findBlock(messages[3], "tool_result").content).toBe(shortResult)
		})

		it("shrinks an oversized tool_result so the conversation fits the budget", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				toolUseMessage("t1"),
				toolResultMessage("t1", "X".repeat(50_000)),
			]

			truncateToolResultsToFitWindow(messages, 10_000)

			const toolResult = findBlock(messages[1], "tool_result")
			expect(toolResult.tool_use_id).toBe("t1") // pairing preserved
			expect(String(toolResult.content).length).toBeLessThanOrEqual(10_000)
			expect(String(toolResult.content)).toContain("characters truncated")
		})

		it("truncates the largest tool_result first and leaves small ones intact", () => {
			const small = "small but real result"
			const messages: Anthropic.Messages.MessageParam[] = [
				toolUseMessage("t1"),
				toolResultMessage("t1", "B".repeat(40_000)),
				toolUseMessage("t2"),
				toolResultMessage("t2", small),
			]

			truncateToolResultsToFitWindow(messages, 12_000)

			expect(String(findBlock(messages[1], "tool_result").content)).toContain("characters truncated")
			expect(findBlock(messages[3], "tool_result").content).toBe(small) // untouched
		})

		it("never truncates tool_use blocks, assistant text, or environment details", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				toolUseMessage("t1"),
				toolResultMessage("t1", "X".repeat(50_000)),
			]

			truncateToolResultsToFitWindow(messages, 8_000)

			expect(findBlock(messages[0], "text").text).toBe("Calling a tool.")
			expect(findBlock(messages[0], "tool_use")).toMatchObject({ id: "t1", name: "some_tool" })
			expect(findBlock(messages[1], "text").text).toBe("<environment_details>env</environment_details>")
		})

		it("handles array-form tool_result content and keeps it valid", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				toolUseMessage("t1"),
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [{ type: "text", text: "Y".repeat(40_000) }],
						},
					],
				},
			]

			truncateToolResultsToFitWindow(messages, 8_000)

			const toolResult = findBlock(messages[1], "tool_result")
			expect(toolResult.tool_use_id).toBe("t1")
			expect(Array.isArray(toolResult.content)).toBe(true)
			const parts = toolResult.content as Array<{ type: string; text?: string }>
			expect(parts[0].type).toBe("text")
			expect(String(parts[0].text)).toContain("characters truncated")
		})
	})
})
