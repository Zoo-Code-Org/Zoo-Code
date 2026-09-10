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
		lm: {
			selectChatModels: vi.fn(),
		},
	}
})

import * as vscode from "vscode"
import { VsCodeLmHandler } from "../vscode-lm"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { Anthropic } from "@anthropic-ai/sdk"
import { openAiModelInfoSaneDefaults, vscodeLlmDefaultModelId, vscodeLlmModels } from "@roo-code/types"

import { clearAllMocks } from "../../../test-utils/reset"

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
