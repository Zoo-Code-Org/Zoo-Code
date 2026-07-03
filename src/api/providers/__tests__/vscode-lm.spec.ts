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
			public input: any,
		) {}
	}

	return {
		workspace: {
			getConfiguration: vi.fn(() => ({
				get: vi.fn((key: string, defaultValue: any) => defaultValue),
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
		vi.clearAllMocks()
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
			// Clear the client first
			handler["client"] = null
			const model = handler.getModel()
			expect(model.id).toBe("test-vendor/test-family")
			expect(model.info).toBeDefined()
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
			handler["currentRequestCancellation"] = mockCancellation as any

			mockLanguageModelChat.countTokens.mockResolvedValueOnce(50)

			const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Test content" }]
			const result = await handler.countTokens(content)

			expect(result).toBe(50)
			expect(mockLanguageModelChat.countTokens).toHaveBeenCalledWith("Test content", mockCancellation.token)
		})

		it("should return 0 when no client is available", async () => {
			handler["client"] = null
			handler["currentRequestCancellation"] = null

			const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Hello" }]
			const result = await handler.countTokens(content)

			expect(result).toBe(0)
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
})
