// Use vi.hoisted to define mock functions that can be referenced in hoisted vi.mock() calls
const { mockStreamText, mockGenerateText } = vi.hoisted(() => ({
	mockStreamText: vi.fn(),
	mockGenerateText: vi.fn(),
}))

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>()
	return {
		...actual,
		streamText: mockStreamText,
		generateText: mockGenerateText,
	}
})

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn(function () {
		// Return a function that returns a mock language model
		return vi.fn(() => ({
			modelId: "test-model",
			provider: "openai-compatible",
		}))
	}),
}))

import type { Anthropic } from "@anthropic-ai/sdk"

import { OpenAICompatibleHandler, OpenAICompatibleConfig } from "../openai-compatible"
import type { ApiHandlerOptions } from "../../../shared/api"

// Concrete implementation for testing
class TestOpenAICompatibleHandler extends OpenAICompatibleHandler {
	constructor(options: ApiHandlerOptions, config: OpenAICompatibleConfig) {
		super(options, config)
	}

	override getModel() {
		return {
			id: this.config.modelId,
			info: this.config.modelInfo,
			maxTokens: this.config.modelMaxTokens,
			temperature: this.config.temperature,
		}
	}
}

describe("OpenAICompatibleHandler", () => {
	let handler: TestOpenAICompatibleHandler
	let mockOptions: ApiHandlerOptions
	let mockConfig: OpenAICompatibleConfig

	const systemPrompt = "You are a helpful assistant."
	const messages: Anthropic.Messages.MessageParam[] = [
		{
			role: "user",
			content: [{ type: "text", text: "Hello!" }],
		},
	]

	beforeEach(() => {
		mockOptions = {
			apiModelId: "test-model",
			apiKey: "test-api-key",
		}
		mockConfig = {
			providerName: "TestProvider",
			baseURL: "https://api.test.com/v1",
			apiKey: "test-api-key",
			modelId: "test-model",
			modelInfo: {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsImages: false,
				supportsPromptCache: true,
			},
		}
		handler = new TestOpenAICompatibleHandler(mockOptions, mockConfig)
		vi.clearAllMocks()
	})

	describe("constructor", () => {
		it("should initialize with provided options and config", () => {
			expect(handler).toBeInstanceOf(TestOpenAICompatibleHandler)
			expect(handler.getModel().id).toBe(mockConfig.modelId)
		})
	})

	describe("createMessage", () => {
		it("should handle streaming responses", async () => {
			async function* mockFullStream() {
				yield { type: "text-delta", text: "Test response" }
			}

			const mockUsage = Promise.resolve({
				inputTokens: 10,
				outputTokens: 5,
				details: {},
				raw: {},
			})

			mockStreamText.mockReturnValue({
				fullStream: mockFullStream(),
				usage: mockUsage,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")
		})

		it("should handle multiple stream parts and yield usage metrics", async () => {
			async function* mockFullStream() {
				yield { type: "text-delta", text: "First part" }
				yield { type: "text-delta", text: "Second part" }
				yield { type: "tool-call", toolCallId: "123", name: "test_tool", args: "{}" }
			}

			const mockUsage = Promise.resolve({
				inputTokens: 20,
				outputTokens: 10,
				details: {},
				raw: {},
			})

			mockStreamText.mockReturnValue({
				fullStream: mockFullStream(),
				usage: mockUsage,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(2)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(2)
			expect(textChunks[0].text).toBe("First part")
			expect(textChunks[1].text).toBe("Second part")

			const usageChunks = chunks.filter((chunk) => chunk.type === "usage")
			expect(usageChunks).toHaveLength(1)
		})

		it("should handle stream without usage metrics", async () => {
			async function* mockFullStream() {
				yield { type: "text-delta", text: "Test response" }
			}

			mockStreamText.mockReturnValue({
				fullStream: mockFullStream(),
				usage: Promise.resolve(undefined),
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const usageChunks = chunks.filter((chunk) => chunk.type === "usage")
			expect(usageChunks).toHaveLength(0)
		})

		it("should handle tool-call events in stream", async () => {
			async function* mockFullStream() {
				yield { type: "text-delta", text: "Calling tool" }
				yield { type: "tool-call-start", toolCallId: "tc_1", name: "read_file" }
				yield { type: "tool-call-delta", toolCallId: "tc_1", delta: '{"path":"test.ts"}' }
				yield { type: "tool-call-end", toolCallId: "tc_1" }
			}

			const mockUsage = Promise.resolve({
				inputTokens: 15,
				outputTokens: 8,
				details: {},
				raw: {},
			})

			mockStreamText.mockReturnValue({
				fullStream: mockFullStream(),
				usage: mockUsage,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
		})

		// Test 1: createMessage() with mock 429 response → verify thrown error has .status === 429 and provider name in message
		it("should throw error with .status 429 when API returns 429", async () => {
			const rateLimitError = new Error("Rate limited") as Error & { status: number }
			rateLimitError.status = 429

			mockStreamText.mockReturnValue({
				// eslint-disable-next-line require-yield
				fullStream: (async function* () {
					throw rateLimitError
				})(),
				usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, details: {}, raw: {} }),
			})

			let thrownError: any
			try {
				for await (const chunk of handler.createMessage(systemPrompt, messages)) {
					void chunk // Use void to satisfy no-unused-expressions rule
				}
			} catch (e: any) {
				thrownError = e
			}

			expect(thrownError).toBeInstanceOf(Error)
			expect(thrownError.status).toBe(429)
			expect(thrownError.message).toContain("TestProvider")
		})

		// Test 2: createMessage() with mock 500 response → verify error is properly tagged
		it("should throw error with .status 500 and provider name when API returns 500", async () => {
			const serverError = new Error("Internal Server Error") as Error & { status: number }
			serverError.status = 500

			mockStreamText.mockReturnValue({
				// eslint-disable-next-line require-yield
				fullStream: (async function* () {
					throw serverError
				})(),
				usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, details: {}, raw: {} }),
			})

			let thrownError: any
			try {
				for await (const chunk of handler.createMessage(systemPrompt, messages)) {
					void chunk
				}
			} catch (e: any) {
				thrownError = e
			}

			expect(thrownError).toBeInstanceOf(Error)
			expect(thrownError.status).toBe(500)
			expect(thrownError.message).toContain("TestProvider")
		})
	})

	describe("completePrompt", () => {
		it("should complete a prompt using generateText", async () => {
			mockGenerateText.mockResolvedValue({
				text: "Test completion",
			})

			const result = await handler.completePrompt("Test prompt")

			expect(result).toBe("Test completion")
			expect(mockGenerateText).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: "Test prompt",
				}),
			)
		})

		// Test 3: completePrompt() with mock 4xx/5xx → verify error carries .status and provider name
		it("should throw error with .status and provider name when generateText throws 400", async () => {
			const badRequestError = new Error("Bad Request") as Error & { status: number }
			badRequestError.status = 400

			mockGenerateText.mockRejectedValue(badRequestError)

			await expect(handler.completePrompt("Test prompt")).rejects.toThrow("TestProvider")

			let thrownError: any
			try {
				await handler.completePrompt("Test prompt")
			} catch (e: any) {
				thrownError = e
			}

			expect(thrownError).toBeInstanceOf(Error)
			expect((thrownError as any).status).toBe(400)
			expect(thrownError.message).toContain("TestProvider")
		})

		it("should throw error with .status and provider name when generateText throws 500", async () => {
			const serverError = new Error("Internal Server Error") as Error & { status: number }
			serverError.status = 500

			mockGenerateText.mockRejectedValue(serverError)

			let thrownError: any
			try {
				await handler.completePrompt("Test prompt")
			} catch (e: any) {
				thrownError = e
			}

			expect(thrownError).toBeInstanceOf(Error)
			expect((thrownError as any).status).toBe(500)
			expect(thrownError.message).toContain("TestProvider")
		})
	})
})
