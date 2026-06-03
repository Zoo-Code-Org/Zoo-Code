// Tests for OpenAICompatibleHandler's abortSignal passing to streamText()
// Verifies that when createMessage() is called with metadata containing an abortSignal,
// the signal is passed through to AI SDK's streamText() so HTTP requests can be aborted.

const { mockStreamText } = vi.hoisted(() => ({
	mockStreamText: vi.fn(),
}))

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>()
	return {
		...actual,
		streamText: mockStreamText,
	}
})

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn(() => {
		return vi.fn(() => ({
			modelId: "test-model",
			provider: "test-provider",
		}))
	}),
}))

import type { Anthropic } from "@anthropic-ai/sdk"

import { OpenAICompatibleHandler, OpenAICompatibleConfig } from "../openai-compatible"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ModelInfo } from "@roo-code/types"

// Concrete test subclass of the abstract OpenAICompatibleHandler
class TestOpenAiCompatibleHandler extends OpenAICompatibleHandler {
	constructor(options: ApiHandlerOptions, config: OpenAICompatibleConfig) {
		super(options, config)
	}

	override getModel(): { id: string; info: ModelInfo } {
		return { id: this.config.modelId, info: this.config.modelInfo }
	}
}

describe("OpenAICompatibleHandler abort signal", () => {
	let handler: TestOpenAiCompatibleHandler
	const mockOptions: ApiHandlerOptions = {}
	const config: OpenAICompatibleConfig = {
		providerName: "test-provider",
		baseURL: "https://api.test.com/v1",
		apiKey: "test-key",
		modelId: "test-model",
		modelInfo: { maxTokens: 8192, contextWindow: 128000, supportsImages: false, supportsPromptCache: true },
	}

	beforeEach(() => {
		vi.clearAllMocks()
		handler = new TestOpenAiCompatibleHandler(mockOptions, config)
	})

	describe("createMessage abortSignal passing", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: [{ type: "text" as const, text: "Hello!" }] },
		]

		it("should pass abortSignal to streamText when provided in metadata", async () => {
			const controller = new AbortController()
			const mockAbortSignal = controller.signal

			async function* mockFullStream() {
				yield { type: "text-delta", text: "Test response" }
			}

			function createMockStream(yieldValue: any) {
				return {
					fullStream: (async function* () {
						yield yieldValue
					})(),
					usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
				}
			}

			const mockUsage = Promise.resolve({ inputTokens: 10, outputTokens: 5 })

			mockStreamText.mockReturnValue({
				fullStream: mockFullStream(),
				usage: mockUsage,
			})

			await handler
				.createMessage(systemPrompt, messages, {
					taskId: "test-task",
					abortSignal: mockAbortSignal,
				})
				.next()

			expect(mockStreamText).toHaveBeenCalledWith(
				expect.objectContaining({
					signal: mockAbortSignal,
				}),
			)
		})

		it("should pass undefined signal to streamText when abortSignal is not provided", async () => {
			async function* mockFullStream() {
				yield { type: "text-delta", text: "Test response" }
			}

			function createMockStream(yieldValue: any) {
				return {
					fullStream: (async function* () {
						yield yieldValue
					})(),
					usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
				}
			}

			const mockUsage = Promise.resolve({ inputTokens: 10, outputTokens: 5 })

			mockStreamText.mockReturnValue({
				fullStream: mockFullStream(),
				usage: mockUsage,
			})

			await handler
				.createMessage(systemPrompt, messages, {
					taskId: "test-task",
				})
				.next()

			expect(mockStreamText).toHaveBeenCalledWith(
				expect.objectContaining({
					signal: undefined,
				}),
			)
		})

		it("should pass signal to streamText when metadata is undefined", async () => {
			async function* mockFullStream() {
				yield { type: "text-delta", text: "Test response" }
			}

			function createMockStream(yieldValue: any) {
				return {
					fullStream: (async function* () {
						yield yieldValue
					})(),
					usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
				}
			}

			const mockUsage = Promise.resolve({ inputTokens: 10, outputTokens: 5 })

			mockStreamText.mockReturnValue({
				fullStream: mockFullStream(),
				usage: mockUsage,
			})

			await handler.createMessage(systemPrompt, messages).next()

			expect(mockStreamText).toHaveBeenCalledWith(
				expect.objectContaining({
					signal: undefined,
				}),
			)
		})

		it("should pass the correct signal when it fires during streaming", async () => {
			const controller = new AbortController()
			const mockAbortSignal = controller.signal

			let capturedOptions: any = null

			mockStreamText.mockImplementation((options) => {
				capturedOptions = options
				return {
					fullStream: (async function* () {
						yield { type: "text-delta", text: "Partial" }
					})(),
					usage: Promise.resolve({ inputTokens: 5, outputTokens: 3 }),
				}
			})

			const stream = handler.createMessage(systemPrompt, messages, {
				taskId: "test-task",
				abortSignal: mockAbortSignal,
			})

			// Verify the signal was captured before aborting
			expect(capturedOptions).toBeDefined()
			expect(capturedOptions.signal).toBe(mockAbortSignal)

			// Now abort - this should cause streamText to receive an aborted signal
			controller.abort()
			expect(controller.signal.aborted).toBe(true)
		})

		it("should pass all other request options alongside the signal", async () => {
			const controller = new AbortController()

			let capturedOptions: any = null

			mockStreamText.mockImplementation((options) => {
				capturedOptions = options
				return {
					fullStream: (async function* () {
						yield { type: "text-delta", text: "Test" }
					})(),
					usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
				}
			})

			await handler
				.createMessage(systemPrompt, messages, {
					taskId: "test-task",
					abortSignal: controller.signal,
				})
				.next()

			expect(capturedOptions).toHaveProperty("model")
			expect(capturedOptions).toHaveProperty("system", systemPrompt)
			expect(capturedOptions).toHaveProperty("messages")
			expect(capturedOptions).toHaveProperty("signal", controller.signal)
		})
	})
})
