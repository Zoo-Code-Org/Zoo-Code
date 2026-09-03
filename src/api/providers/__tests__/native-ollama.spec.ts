// pnpm exec vitest run api/providers/__tests__/native-ollama.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

import { NativeOllamaHandler } from "../native-ollama"
import { ApiHandlerOptions } from "../../../shared/api"
import { getOllamaModels } from "../fetchers/ollama"

import { makeCreateMessageMetadata } from "../../../test-utils/api"
import { clearAllMocks } from "../../../test-utils/reset"

// Mock the ollama package
const mockChat = vitest.fn()

// Use vi.hoisted to define mocks that can be referenced both inside and outside the hoisted vi.mock
const mockedOllama = vi.hoisted(() => ({
	OllamaMock: vitest.fn(),
}))

vitest.mock("ollama", () => {
	const { OllamaMock } = mockedOllama
	return {
		Ollama: OllamaMock.mockImplementation(function (options?: { host?: string }) {
			const instanceAbort = vitest.fn()
			return {
				chat: mockChat,
				abort: instanceAbort,
				_host: options?.host ?? "http://localhost:11434",
				_instanceAbort: instanceAbort,
			}
		}),
		Message: vitest.fn(),
	}
})

// Export OllamaMock for test access
const OllamaMock = mockedOllama.OllamaMock

// Mock only the model-list fetch. The real isSecureOllamaEndpoint is kept so
// the credential-gating assertions exercise the production predicate.
vitest.mock("../fetchers/ollama", async (importOriginal) => {
	// The factory's importOriginal is typed as unknown; recover the module's
	// real type so the production predicate can be spread without `any`.
	const actual = (await importOriginal()) as typeof import("../fetchers/ollama")
	return {
		...actual,
		getOllamaModels: vitest.fn(),
	}
})

const mockGetOllamaModels = vitest.mocked(getOllamaModels)

describe("NativeOllamaHandler", () => {
	let handler: NativeOllamaHandler

	beforeEach(() => {
		clearAllMocks()

		// Default mock for getOllamaModels
		mockGetOllamaModels.mockResolvedValue({
			llama2: {
				contextWindow: 4096,
				maxTokens: 4096,
				supportsImages: false,
				supportsPromptCache: false,
			},
		})

		const options: ApiHandlerOptions = {
			apiModelId: "llama2",
			ollamaModelId: "llama2",
			ollamaBaseUrl: "http://localhost:11434",
		}

		handler = new NativeOllamaHandler(options)
	})

	describe("createMessage", () => {
		it("should stream messages from Ollama", async () => {
			// Mock the chat response as an async generator
			mockChat.mockImplementation(async function* () {
				yield {
					message: { content: "Hello" },
					eval_count: undefined,
					prompt_eval_count: undefined,
				}
				yield {
					message: { content: " world" },
					eval_count: 2,
					prompt_eval_count: 10,
				}
			})

			const systemPrompt = "You are a helpful assistant"
			const messages = [{ role: "user" as const, content: "Hi there" }]

			const stream = handler.createMessage(systemPrompt, messages)
			const results = []

			for await (const chunk of stream) {
				results.push(chunk)
			}

			expect(results).toHaveLength(3)
			expect(results[0]).toEqual({ type: "text", text: "Hello" })
			expect(results[1]).toEqual({ type: "text", text: " world" })
			expect(results[2]).toEqual({ type: "usage", inputTokens: 10, outputTokens: 2 })
		})

		it("should map tool_result array content to a concatenated string, flushing base64 images", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-1",
							content: [
								{ type: "text", text: "line one" },
								{
									type: "image",
									source: {
										type: "base64",
										media_type: "image/png",
										data: "imgdata",
									},
								},
								{ type: "text", text: "line two" },
							],
						},
					],
				},
			]

			const stream = handler.createMessage("System", messages)
			for await (const _ of stream) {
				// consume stream
			}

			// Text blocks are joined with "\n"; the image emits a placeholder.
			// Tool results are text-only in Ollama, so the image is flushed onto a
			// separate adjacent user message via the `images` field rather than
			// inlined into the tool result.
			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "user",
							content: "line one\n(see following user message for image)\nline two",
						}),
						expect.objectContaining({
							role: "user",
							images: ["imgdata"],
						}),
					]),
				}),
			)

			// The tool result message itself must not carry an images field.
			const callArgs = mockChat.mock.calls[0][0] as any
			const toolResultMessage = callArgs.messages.find(
				(m: any) => typeof m.content === "string" && m.content.includes("line one"),
			)
			expect(toolResultMessage.images).toBeUndefined()
		})

		it("should drop unknown block types in tool_result content (empty string contribution)", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-1",
							content: [
								{ type: "text", text: "before" },
								{ type: "document" } as any,
								{ type: "text", text: "after" },
							],
						},
					],
				},
			]

			const stream = handler.createMessage("System", messages)
			for await (const _ of stream) {
				// consume
			}

			// The unknown block contributes "" so the join produces "before\n\nafter"
			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "user",
							content: "before\n\nafter",
						}),
					]),
				}),
			)
		})

		it("should not include num_ctx by default", async () => {
			// Mock the chat response
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "Response" } }
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])

			// Consume the stream
			for await (const _ of stream) {
				// consume stream
			}

			// Verify that num_ctx was NOT included in the options
			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.not.objectContaining({
						num_ctx: expect.anything(),
					}),
				}),
			)
		})

		it("should include num_ctx when explicitly set via ollamaNumCtx", async () => {
			const options: ApiHandlerOptions = {
				apiModelId: "llama2",
				ollamaModelId: "llama2",
				ollamaBaseUrl: "http://localhost:11434",
				ollamaNumCtx: 8192, // Explicitly set num_ctx
			}

			handler = new NativeOllamaHandler(options)

			// Mock the chat response
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "Response" } }
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])

			// Consume the stream
			for await (const _ of stream) {
				// consume stream
			}

			// Verify that num_ctx was included with the specified value
			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.objectContaining({
						num_ctx: 8192,
					}),
				}),
			)
		})

		it("should handle DeepSeek R1 models with reasoning detection", async () => {
			const options: ApiHandlerOptions = {
				apiModelId: "deepseek-r1",
				ollamaModelId: "deepseek-r1",
				ollamaBaseUrl: "http://localhost:11434",
			}

			handler = new NativeOllamaHandler(options)

			// Mock response with thinking tags
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "<think>Let me think" } }
				yield { message: { content: " about this</think>" } }
				yield { message: { content: "The answer is 42" } }
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Question?" }])
			const results = []

			for await (const chunk of stream) {
				results.push(chunk)
			}

			// Should detect reasoning vs regular text
			expect(results.some((r) => r.type === "reasoning")).toBe(true)
			expect(results.some((r) => r.type === "text")).toBe(true)
		})

		it("should surface Ollama's native message.thinking field as reasoning", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "", thinking: "Reasoning step one" } }
				yield { message: { content: "", thinking: " step two" } }
				yield { message: { content: "The answer" } }
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Question?" }])
			const results = []

			for await (const chunk of stream) {
				results.push(chunk)
			}

			const reasoningChunks = results.filter((r) => r.type === "reasoning")
			expect(reasoningChunks).toHaveLength(2)
			expect(reasoningChunks[0]).toEqual({ type: "reasoning", text: "Reasoning step one" })
			expect(reasoningChunks[1]).toEqual({ type: "reasoning", text: " step two" })
			expect(results.some((r) => r.type === "text" && r.text === "The answer")).toBe(true)
		})

		it("should send think parameter when reasoningEffort is set", async () => {
			const options: ApiHandlerOptions = {
				apiModelId: "qwen3",
				ollamaModelId: "qwen3",
				ollamaBaseUrl: "http://localhost:11434",
				enableReasoningEffort: true,
				reasoningEffort: "high",
			}

			handler = new NativeOllamaHandler(options)

			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok", thinking: "hmm" } }
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Hi" }])
			for await (const _ of stream) {
				// consume
			}

			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					think: "high",
				}),
			)
		})

		it("should map reasoningEffort levels to Ollama think values", async () => {
			const cases: Array<
				[NonNullable<ApiHandlerOptions["reasoningEffort"]>, boolean | "high" | "medium" | "low"]
			> = [
				["low", "low"],
				["medium", "medium"],
				["high", "high"],
				["xhigh", "high"],
				["max", "high"],
				["none", true],
				["minimal", true],
				["disable", false],
			]

			for (const [effort, expected] of cases) {
				clearAllMocks()
				mockGetOllamaModels.mockResolvedValue({
					qwen3: { contextWindow: 4096, maxTokens: 4096, supportsImages: false, supportsPromptCache: false },
				})
				mockChat.mockImplementation(async function* () {
					yield { message: { content: "ok" } }
				})

				const options: ApiHandlerOptions = {
					apiModelId: "qwen3",
					ollamaModelId: "qwen3",
					ollamaBaseUrl: "http://localhost:11434",
					enableReasoningEffort: true,
					reasoningEffort: effort,
				}

				handler = new NativeOllamaHandler(options)
				const stream = handler.createMessage("System", [{ role: "user" as const, content: "Hi" }])
				for await (const _ of stream) {
					// consume
				}

				expect(mockChat).toHaveBeenCalledWith(
					expect.objectContaining({
						think: expected,
					}),
				)
			}
		})

		it("should not send think parameter when reasoningEffort is undefined", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Hi" }])
			for await (const _ of stream) {
				// consume
			}

			const callArgs = mockChat.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.think).toBeUndefined()
		})

		it("should not send think parameter when enableReasoningEffort is false", async () => {
			// When the Ollama UI checkbox is unchecked, enableReasoningEffort
			// is false. The handler must not send any think param (undefined),
			// leaving the model/Modelfile in control rather than forcing
			// thinking off. A stale reasoningEffort value must not override
			// the explicit opt-out.
			const options: ApiHandlerOptions = {
				apiModelId: "qwen3",
				ollamaModelId: "qwen3",
				ollamaBaseUrl: "http://localhost:11434",
				enableReasoningEffort: false,
				reasoningEffort: "high",
			}

			handler = new NativeOllamaHandler(options)

			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Hi" }])
			for await (const _ of stream) {
				// consume
			}

			const callArgs = mockChat.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.think).toBeUndefined()
		})

		it("should not send think parameter when enableReasoningEffort is undefined but reasoningEffort is set", async () => {
			// This guards against a stale reasoningEffort inherited from
			// another provider config. Without an explicit Ollama opt-in,
			// the handler must not emit a think param.
			const options: ApiHandlerOptions = {
				apiModelId: "qwen3",
				ollamaModelId: "qwen3",
				ollamaBaseUrl: "http://localhost:11434",
				// enableReasoningEffort intentionally undefined
				reasoningEffort: "high",
			}

			handler = new NativeOllamaHandler(options)

			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Hi" }])
			for await (const _ of stream) {
				// consume
			}

			const callArgs = mockChat.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.think).toBeUndefined()
		})

		it("should send think=false when reasoningEffort is disable and enableReasoningEffort is true", async () => {
			// The only way to explicitly force thinking off via the think
			// parameter is to set reasoningEffort to "disable" while opted in.
			const options: ApiHandlerOptions = {
				apiModelId: "qwen3",
				ollamaModelId: "qwen3",
				ollamaBaseUrl: "http://localhost:11434",
				enableReasoningEffort: true,
				reasoningEffort: "disable",
			}

			handler = new NativeOllamaHandler(options)

			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Hi" }])
			for await (const _ of stream) {
				// consume
			}

			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					think: false,
				}),
			)
		})

		it("should round-trip reasoning blocks as the thinking field on assistant messages", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "Prior reasoning", summary: [] } as any,
						{ type: "text", text: "Prior answer" },
					],
				},
				{ role: "user" as const, content: "Follow up" },
			]

			const stream = handler.createMessage("System", messages)
			for await (const _ of stream) {
				// consume
			}

			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "assistant",
							thinking: "Prior reasoning",
						}),
					]),
				}),
			)
		})
		it("should round-trip Anthropic-protocol thinking blocks as the thinking field on assistant messages", async () => {
			// Covers the `block.type === "thinking"` branch in the assistant
			// message converter. Anthropic-protocol thinking blocks carry the
			// reasoning text in a `thinking` field (not `text`).
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Anthropic thinking text" } as any,
						{ type: "text", text: "Prior answer" },
					],
				},
				{ role: "user" as const, content: "Follow up" },
			]

			const stream = handler.createMessage("System", messages)
			for await (const _ of stream) {
				// consume
			}

			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "assistant",
							thinking: "Anthropic thinking text",
						}),
					]),
				}),
			)
		})

		it("should concatenate multiple reasoning and thinking blocks into the thinking field", async () => {
			// Multiple reasoning/thinking blocks are joined with newlines so the
			// full thinking context is preserved across turns.
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "First reasoning", summary: [] } as any,
						{ type: "thinking", thinking: "Second thinking" } as any,
						{ type: "text", text: "Answer" },
					],
				},
				{ role: "user" as const, content: "Follow up" },
			]

			const stream = handler.createMessage("System", messages)
			for await (const _ of stream) {
				// consume
			}

			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "assistant",
							thinking: "First reasoning\nSecond thinking",
						}),
					]),
				}),
			)
		})

		it("should not set thinking field when assistant reasoning/thinking blocks are empty", async () => {
			// Covers the `block.text.length > 0` and `block.thinking.length > 0`
			// false branches, and the `reasoningText || undefined` falsy branch.
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "", summary: [] } as any,
						{ type: "thinking", thinking: "" } as any,
						{ type: "text", text: "Answer" },
					],
				},
				{ role: "user" as const, content: "Follow up" },
			]

			const stream = handler.createMessage("System", messages)
			for await (const _ of stream) {
				// consume
			}

			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "assistant",
							thinking: undefined,
						}),
					]),
				}),
			)
		})

		it("should not set thinking field on assistant messages without reasoning blocks", async () => {
			// Covers the `reasoningText || undefined` falsy branch for a plain
			// assistant text+tool_use message (no reasoning/thinking blocks).
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Answer" },
						{
							type: "tool_use",
							id: "tool-1",
							name: "get_weather",
							input: { location: "SF" },
						},
					],
				},
				{ role: "user" as const, content: "Follow up" },
			]

			const stream = handler.createMessage("System", messages)
			for await (const _ of stream) {
				// consume
			}

			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "assistant",
							thinking: undefined,
						}),
					]),
				}),
			)
		})

		it("should not send think parameter for an unknown reasoningEffort value", async () => {
			// Covers the `default` branch of getOllamaThinkParam's switch,
			// which returns undefined for unrecognized effort values.
			const options: ApiHandlerOptions = {
				apiModelId: "qwen3",
				ollamaModelId: "qwen3",
				ollamaBaseUrl: "http://localhost:11434",
				enableReasoningEffort: true,
				reasoningEffort: "bogus" as any,
			}

			handler = new NativeOllamaHandler(options)

			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Hi" }])
			for await (const _ of stream) {
				// consume
			}

			const callArgs = mockChat.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.think).toBeUndefined()
		})
	})

	it("should not send think parameter when enableReasoningEffort is true but reasoningEffort is undefined", async () => {
		// This is the state the UI checkbox would produce if it only set
		// enableReasoningEffort without a default reasoningEffort. The
		// handler must not send a think param in that case.
		const options: ApiHandlerOptions = {
			apiModelId: "qwen3",
			ollamaModelId: "qwen3",
			ollamaBaseUrl: "http://localhost:11434",
			enableReasoningEffort: true,
			// reasoningEffort intentionally undefined
		}

		handler = new NativeOllamaHandler(options)

		mockChat.mockImplementation(async function* () {
			yield { message: { content: "ok" } }
		})

		const stream = handler.createMessage("System", [{ role: "user" as const, content: "Hi" }])
		for await (const _ of stream) {
			// consume
		}

		const callArgs = mockChat.mock.calls[0][0] as Record<string, unknown>
		expect(callArgs.think).toBeUndefined()
	})

	describe("completePrompt", () => {
		// Shared capture for the per-request client's abort spy. The timeoutMs
		// and abortSignal tests below each override the OllamaMock constructor
		// and re-assign it inside their own mockImplementation.
		let capturedInstanceAbort: (() => void) | undefined

		it("should complete a prompt without streaming", async () => {
			mockChat.mockResolvedValue({
				message: { content: "This is the response" },
			})

			const result = await handler.completePrompt("Tell me a joke")

			expect(mockChat).toHaveBeenCalledWith({
				model: "llama2",
				messages: [{ role: "user", content: "Tell me a joke" }],
				stream: false,
				options: {
					temperature: 0,
				},
			})
			expect(result).toBe("This is the response")
		})

		it("should not include num_ctx in completePrompt by default", async () => {
			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			await handler.completePrompt("Test prompt")

			// Verify that num_ctx was NOT included in the options
			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.not.objectContaining({
						num_ctx: expect.anything(),
					}),
				}),
			)
		})

		it("should include num_ctx in completePrompt when explicitly set", async () => {
			const options: ApiHandlerOptions = {
				apiModelId: "llama2",
				ollamaModelId: "llama2",
				ollamaBaseUrl: "http://localhost:11434",
				ollamaNumCtx: 4096, // Explicitly set num_ctx
			}

			handler = new NativeOllamaHandler(options)

			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			await handler.completePrompt("Test prompt")

			// Verify that num_ctx was included with the specified value
			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.objectContaining({
						num_ctx: 4096,
					}),
				}),
			)
		})
		it("should use a request-local client when abortSignal is provided", async () => {
			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			const controller = new AbortController()
			await handler.completePrompt("Test prompt", { abortSignal: controller.signal })

			expect(OllamaMock).toHaveBeenCalledTimes(1)
			expect(OllamaMock).toHaveBeenCalledWith(expect.objectContaining({ host: "http://localhost:11434" }))
			// Ollama implementation only passes the payload, not a second options argument.
			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "llama2",
					messages: [{ role: "user", content: "Test prompt" }],
					stream: false,
					options: { temperature: 0 },
				}),
			)
			expect(mockChat).toHaveBeenCalledTimes(1)
			expect(mockChat.mock.calls[0]).toHaveLength(1)
		})

		it("should not include signal-related options when not provided", async () => {
			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			await handler.completePrompt("Test prompt")

			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "llama2",
					messages: [{ role: "user", content: "Test prompt" }],
					stream: false,
					options: { temperature: 0 },
				}),
			)
		})

		it("should work without options (backward compatible)", async () => {
			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("Response")
		})

		it("should call client.abort() when timeoutMs is reached", async () => {
			const testTimeout = 5000
			let capturedFn: (() => void) | undefined

			// Capture the per-request client's abort spy so the assertion targets
			// the actual abort() call rather than just the constructor call.
			OllamaMock.mockImplementation(function (options?: { host?: string }) {
				const instanceAbort = vitest.fn()
				capturedInstanceAbort = instanceAbort
				return {
					chat: mockChat,
					abort: instanceAbort,
					_host: options?.host ?? "http://localhost:11434",
					_instanceAbort: instanceAbort,
				}
			})

			// The timer id is never consumed (the callback is captured and fired
			// manually), so bridge the ambient setTimeout signature through unknown.
			vitest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
				if (ms === testTimeout) {
					capturedFn = fn
				}
				return 0
			}) as unknown as typeof setTimeout)

			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			await handler.completePrompt("Test prompt", { timeoutMs: testTimeout })

			expect(capturedFn).toBeDefined()
			if (capturedFn) capturedFn()
			// The timeout callback should have invoked client.abort() on the request-local instance
			expect(capturedInstanceAbort).toBeDefined()
			expect(capturedInstanceAbort).toHaveBeenCalledTimes(1)
		})

		it("should call instance.abort() when abortSignal is aborted", async () => {
			const controller = new AbortController()

			// Override the constructor to capture the instance abort spy
			OllamaMock.mockImplementation(function (options?: { host?: string }) {
				const instanceAbort = vitest.fn()
				capturedInstanceAbort = instanceAbort
				return {
					chat: mockChat,
					abort: instanceAbort,
					_host: options?.host ?? "http://localhost:11434",
					_instanceAbort: instanceAbort,
				}
			})

			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			const promise = handler.completePrompt("Test prompt", { abortSignal: controller.signal })
			controller.abort()
			await expect(promise).rejects.toThrow("This operation was aborted")

			expect(capturedInstanceAbort).toBeDefined()
			expect(capturedInstanceAbort).toHaveBeenCalledTimes(1)
		})

		it("should call instance.abort() immediately when abortSignal is already aborted", async () => {
			const controller = new AbortController()
			controller.abort()

			// Override the constructor to capture the instance abort spy
			OllamaMock.mockImplementation(function (options?: { host?: string }) {
				const instanceAbort = vitest.fn()
				capturedInstanceAbort = instanceAbort
				return {
					chat: mockChat,
					abort: instanceAbort,
					_host: options?.host ?? "http://localhost:11434",
					_instanceAbort: instanceAbort,
				}
			})

			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			await expect(handler.completePrompt("Test prompt", { abortSignal: controller.signal })).rejects.toThrow(
				"This operation was aborted",
			)

			expect(capturedInstanceAbort).toBeDefined()
			expect(capturedInstanceAbort).toHaveBeenCalledTimes(1)
		})

		it("should reject with AbortError without fetching models when abortSignal is already aborted", async () => {
			const controller = new AbortController()
			controller.abort()

			await expect(
				handler.completePrompt("Test prompt", { abortSignal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
			})

			// The pre-aborted check must short-circuit before any network call.
			expect(mockGetOllamaModels).not.toHaveBeenCalled()
			expect(mockChat).not.toHaveBeenCalled()
		})

		it("should not start a timeout timer for non-positive timeoutMs", async () => {
			const setTimeoutSpy = vitest.spyOn(global, "setTimeout")
			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			await handler.completePrompt("Test prompt", { timeoutMs: 0 })

			expect(setTimeoutSpy).not.toHaveBeenCalled()
			expect(OllamaMock).toHaveBeenCalledTimes(1)
			expect(OllamaMock).toHaveBeenCalledWith(expect.objectContaining({ host: "http://localhost:11434" }))
		})

		it("should remove abort listener and clear timeout when abortSignal fires", async () => {
			const controller = new AbortController()
			// The timer id is never consumed directly (clearTimeout is mocked in these
			// tests), so bridge the ambient setTimeout return type through unknown.
			const timeoutHandle = 1 as unknown as ReturnType<typeof setTimeout>
			const clearTimeoutSpy = vitest.spyOn(global, "clearTimeout").mockImplementation(() => {})
			vitest.spyOn(global, "setTimeout").mockImplementation(() => timeoutHandle)
			const removeEventListenerSpy = vitest.spyOn(controller.signal, "removeEventListener")
			const addEventListenerSpy = vitest.spyOn(controller.signal, "addEventListener")

			let resolveChat: (value: { message: { content: string } }) => void = () => {}
			mockChat.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveChat = resolve
					}),
			)

			const promise = handler.completePrompt("Test prompt", { abortSignal: controller.signal, timeoutMs: 5000 })
			for (let i = 0; i < 10 && mockChat.mock.calls.length === 0; i++) {
				await Promise.resolve()
			}

			controller.abort()
			resolveChat({ message: { content: "Response" } })

			await expect(promise).resolves.toBe("Response")
			expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle)
			// The listener removed in the finally block must be the exact function
			// that was registered, proving the same reference is detached.
			expect(addEventListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true })
			const registeredHandler = addEventListenerSpy.mock.calls[0]?.[1]
			expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", registeredHandler)
		})

		it("should clear timeoutId in finally block on success", async () => {
			let capturedDelay: number | undefined
			// The timer id is never consumed directly (clearTimeout is mocked in these
			// tests), so bridge the ambient setTimeout return type through unknown.
			const timeoutHandle = 1 as unknown as ReturnType<typeof setTimeout>

			vitest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
				if (ms === 5000) {
					capturedDelay = ms
				}
				return timeoutHandle
			}) as unknown as typeof setTimeout)

			const clearTimeoutSpy = vitest.spyOn(global, "clearTimeout").mockImplementation(() => {})

			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			await handler.completePrompt("Test prompt", { timeoutMs: 5000 })

			// setTimeout should have been called with the correct delay
			expect(capturedDelay).toBe(5000)
			expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle)
		})
	})

	it("should send think parameter in completePrompt when reasoningEffort is set", async () => {
		const options: ApiHandlerOptions = {
			apiModelId: "qwen3",
			ollamaModelId: "qwen3",
			ollamaBaseUrl: "http://localhost:11434",
			enableReasoningEffort: true,
			reasoningEffort: "high",
		}

		handler = new NativeOllamaHandler(options)

		mockChat.mockResolvedValue({
			message: { content: "Response" },
		})

		await handler.completePrompt("Test prompt")

		expect(mockChat).toHaveBeenCalledWith(
			expect.objectContaining({
				think: "high",
			}),
		)
	})

	it("should not send think parameter in completePrompt when reasoningEffort is undefined", async () => {
		mockChat.mockResolvedValue({
			message: { content: "Response" },
		})

		await handler.completePrompt("Test prompt")

		const callArgs = mockChat.mock.calls[0][0] as Record<string, unknown>
		expect(callArgs.think).toBeUndefined()
	})

	it("should not send think parameter in completePrompt when enableReasoningEffort is false", async () => {
		const options: ApiHandlerOptions = {
			apiModelId: "qwen3",
			ollamaModelId: "qwen3",
			ollamaBaseUrl: "http://localhost:11434",
			enableReasoningEffort: false,
			reasoningEffort: "high",
		}

		handler = new NativeOllamaHandler(options)

		mockChat.mockResolvedValue({
			message: { content: "Response" },
		})

		await handler.completePrompt("Test prompt")

		const callArgs = mockChat.mock.calls[0][0] as Record<string, unknown>
		expect(callArgs.think).toBeUndefined()
	})

	it("should wrap non-Error throws from completePrompt", async () => {
		// Covers the `throw error` branch when the rejected value is not an
		// Error instance (e.g. a plain object or string).
		mockChat.mockRejectedValue("boom")

		await expect(handler.completePrompt("Test prompt")).rejects.toBe("boom")
	})

	describe("error handling", () => {
		it("should handle connection refused errors", async () => {
			const error = new Error("ECONNREFUSED") as any
			error.code = "ECONNREFUSED"
			mockChat.mockRejectedValue(error)

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])

			await expect(async () => {
				for await (const _ of stream) {
					// consume stream
				}
			}).rejects.toThrow("Ollama service is not running")
		})

		it("should handle model not found errors", async () => {
			const error = new Error("Not found") as any
			error.status = 404
			mockChat.mockRejectedValue(error)

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])

			await expect(async () => {
				for await (const _ of stream) {
					// consume stream
				}
			}).rejects.toThrow("Model llama2 not found in Ollama")
		})

		it("should wrap stream processing errors with a descriptive message", async () => {
			// Covers the `catch (streamError)` branch: the chat() call
			// resolves and returns an async iterable, but iterating it throws.
			// The handler must wrap the error with "Ollama stream processing
			// error: ..." and rethrow.
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "partial" } }
				throw new Error("stream blew up")
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])

			await expect(async () => {
				for await (const _ of stream) {
					// consume stream
				}
			}).rejects.toThrow("Ollama stream processing error: stream blew up")
		})

		it("should wrap stream processing errors with unknown message fallback", async () => {
			// Covers the `streamError.message || "Unknown error"` fallback in
			// the stream processing catch block when the error has no message.
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "partial" } }
				throw {}
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])

			await expect(async () => {
				for await (const _ of stream) {
					// consume stream
				}
			}).rejects.toThrow("Ollama stream processing error: Unknown error")
		})

		it("should rethrow non-ECONNREFUSED non-404 errors from chat()", async () => {
			// Covers the fall-through `throw error` branch in the outer catch
			// when the error is neither ECONNREFUSED nor a 404.
			const error = new Error("something else") as any
			error.status = 500
			mockChat.mockRejectedValue(error)

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])

			await expect(async () => {
				for await (const _ of stream) {
					// consume stream
				}
			}).rejects.toThrow("something else")
		})
	})

	describe("getModel", () => {
		it("should return the configured model", () => {
			const model = handler.getModel()
			expect(model.id).toBe("llama2")
			expect(model.info).toBeDefined()
		})
	})

	describe("tool calling", () => {
		it("should include tools when tools are provided", async () => {
			// Model metadata should not gate tool inclusion; metadata.tools controls it.
			mockGetOllamaModels.mockResolvedValue({
				"llama3.2": {
					contextWindow: 128000,
					maxTokens: 4096,
					supportsImages: true,
					supportsPromptCache: false,
				},
			})

			const options: ApiHandlerOptions = {
				apiModelId: "llama3.2",
				ollamaModelId: "llama3.2",
				ollamaBaseUrl: "http://localhost:11434",
			}

			handler = new NativeOllamaHandler(options)

			// Mock the chat response
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "I will use the tool" } }
			})

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "get_weather",
						description: "Get the weather for a location",
						parameters: {
							type: "object",
							properties: {
								location: { type: "string", description: "The city name" },
							},
							required: ["location"],
						},
					},
				},
			]

			const stream = handler.createMessage(
				"System",
				[{ role: "user" as const, content: "What's the weather?" }],
				{ taskId: "test", tools },
			)

			// Consume the stream
			for await (const _ of stream) {
				// consume stream
			}

			// Verify tools were passed to the API
			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					tools: [
						{
							type: "function",
							function: {
								name: "get_weather",
								description: "Get the weather for a location",
								parameters: {
									type: "object",
									properties: {
										location: { type: "string", description: "The city name" },
									},
									required: ["location"],
								},
							},
						},
					],
				}),
			)
		})

		it("should include tools even when model metadata doesn't advertise tool support", async () => {
			// Model metadata should not gate tool inclusion; metadata.tools controls it.
			mockGetOllamaModels.mockResolvedValue({
				llama2: {
					contextWindow: 4096,
					maxTokens: 4096,
					supportsImages: false,
					supportsPromptCache: false,
				},
			})

			// Mock the chat response
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "Response without tools" } }
			})

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "get_weather",
						description: "Get the weather",
						parameters: { type: "object", properties: {} },
					},
				},
			]

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Test" }], {
				taskId: "test",
				tools,
			})

			// Consume the stream
			for await (const _ of stream) {
				// consume stream
			}

			// Verify tools were passed
			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					tools: expect.any(Array),
				}),
			)
		})

		it("should not include tools when no tools are provided", async () => {
			// Model metadata should not gate tool inclusion; metadata.tools controls it.
			mockGetOllamaModels.mockResolvedValue({
				"llama3.2": {
					contextWindow: 128000,
					maxTokens: 4096,
					supportsImages: true,
					supportsPromptCache: false,
				},
			})

			const options: ApiHandlerOptions = {
				apiModelId: "llama3.2",
				ollamaModelId: "llama3.2",
				ollamaBaseUrl: "http://localhost:11434",
			}

			handler = new NativeOllamaHandler(options)

			// Mock the chat response
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "Response" } }
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Test" }], {
				taskId: "test",
			})

			// Consume the stream
			for await (const _ of stream) {
				// consume stream
			}

			// Verify tools were NOT passed
			expect(mockChat).toHaveBeenCalledWith(
				expect.not.objectContaining({
					tools: expect.anything(),
				}),
			)
		})

		it("should yield tool_call_partial when model returns tool calls", async () => {
			// Model metadata should not gate tool inclusion; metadata.tools controls it.
			mockGetOllamaModels.mockResolvedValue({
				"llama3.2": {
					contextWindow: 128000,
					maxTokens: 4096,
					supportsImages: true,
					supportsPromptCache: false,
				},
			})

			const options: ApiHandlerOptions = {
				apiModelId: "llama3.2",
				ollamaModelId: "llama3.2",
				ollamaBaseUrl: "http://localhost:11434",
			}

			handler = new NativeOllamaHandler(options)

			// Mock the chat response with tool calls
			mockChat.mockImplementation(async function* () {
				yield {
					message: {
						content: "",
						tool_calls: [
							{
								function: {
									name: "get_weather",
									arguments: { location: "San Francisco" },
								},
							},
						],
					},
				}
			})

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "get_weather",
						description: "Get the weather for a location",
						parameters: {
							type: "object",
							properties: {
								location: { type: "string" },
							},
							required: ["location"],
						},
					},
				},
			]

			const stream = handler.createMessage(
				"System",
				[{ role: "user" as const, content: "What's the weather in SF?" }],
				{ taskId: "test", tools },
			)

			const results = []
			for await (const chunk of stream) {
				results.push(chunk)
			}

			// Should yield a tool_call_partial chunk
			const toolCallChunk = results.find((r) => r.type === "tool_call_partial")
			expect(toolCallChunk).toBeDefined()
			expect(toolCallChunk).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "ollama-tool-0",
				name: "get_weather",
				arguments: JSON.stringify({ location: "San Francisco" }),
			})
		})

		it("should yield tool_call_end events after tool_call_partial chunks", async () => {
			// Model metadata should not gate tool inclusion; metadata.tools controls it.
			mockGetOllamaModels.mockResolvedValue({
				"llama3.2": {
					contextWindow: 128000,
					maxTokens: 4096,
					supportsImages: true,
					supportsPromptCache: false,
				},
			})

			const options: ApiHandlerOptions = {
				apiModelId: "llama3.2",
				ollamaModelId: "llama3.2",
				ollamaBaseUrl: "http://localhost:11434",
			}

			handler = new NativeOllamaHandler(options)

			// Mock the chat response with multiple tool calls
			mockChat.mockImplementation(async function* () {
				yield {
					message: {
						content: "",
						tool_calls: [
							{
								function: {
									name: "get_weather",
									arguments: { location: "San Francisco" },
								},
							},
							{
								function: {
									name: "get_time",
									arguments: { timezone: "PST" },
								},
							},
						],
					},
				}
			})

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "get_weather",
						description: "Get the weather for a location",
						parameters: {
							type: "object",
							properties: { location: { type: "string" } },
							required: ["location"],
						},
					},
				},
				{
					type: "function" as const,
					function: {
						name: "get_time",
						description: "Get the current time in a timezone",
						parameters: {
							type: "object",
							properties: { timezone: { type: "string" } },
							required: ["timezone"],
						},
					},
				},
			]

			const stream = handler.createMessage(
				"System",
				[{ role: "user" as const, content: "What's the weather and time in SF?" }],
				{ taskId: "test", tools },
			)

			const results = []
			for await (const chunk of stream) {
				results.push(chunk)
			}

			// Should yield tool_call_partial chunks
			const toolCallPartials = results.filter((r) => r.type === "tool_call_partial")
			expect(toolCallPartials).toHaveLength(2)

			// Should yield tool_call_end events for each tool call
			const toolCallEnds = results.filter((r) => r.type === "tool_call_end")
			expect(toolCallEnds).toHaveLength(2)
			expect(toolCallEnds[0]).toEqual({ type: "tool_call_end", id: "ollama-tool-0" })
			expect(toolCallEnds[1]).toEqual({ type: "tool_call_end", id: "ollama-tool-1" })

			// tool_call_end should come after tool_call_partial
			// Find the last tool_call_partial index
			let lastPartialIndex = -1
			for (let i = results.length - 1; i >= 0; i--) {
				if (results[i].type === "tool_call_partial") {
					lastPartialIndex = i
					break
				}
			}
			const firstEndIndex = results.findIndex((r) => r.type === "tool_call_end")
			expect(firstEndIndex).toBeGreaterThan(lastPartialIndex)
		})

		it("should send tool results with role 'tool' and tool_name when preceded by a tool_use", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tool-abc",
							name: "apply_diff",
							input: {
								path: "foo.ts",
								diff: "SEARCH_REPLACE_DIFF_CONTENT",
							},
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-abc",
							content: "Diff applied successfully",
						},
					],
				},
			]

			const stream = handler.createMessage("System", messages)
			for await (const _ of stream) {
				// consume stream
			}

			// The tool result should use Ollama's native "tool" role with tool_name
			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "tool",
							tool_name: "apply_diff",
							content: "Diff applied successfully",
						}),
					]),
				}),
			)
		})

		it("should fall back to role 'user' for tool results when no matching tool_use is found", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "unknown-id",
							content: "orphan result",
						},
					],
				},
			]

			const stream = handler.createMessage("System", messages)
			for await (const _ of stream) {
				// consume stream
			}

			// No preceding tool_use -> fall back to "user" role
			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "user",
							content: "orphan result",
						}),
					]),
				}),
			)
		})

		it("should strip additionalProperties from tool schema parameters", async () => {
			mockGetOllamaModels.mockResolvedValue({
				"llama3.2": {
					contextWindow: 128000,
					maxTokens: 4096,
					supportsImages: true,
					supportsPromptCache: false,
				},
			})

			const options: ApiHandlerOptions = {
				apiModelId: "llama3.2",
				ollamaModelId: "llama3.2",
				ollamaBaseUrl: "http://localhost:11434",
			}

			handler = new NativeOllamaHandler(options)

			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "apply_diff",
						description: "Apply a diff",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string", description: "File path" },
								diff: { type: "string", description: "Diff content" },
							},
							required: ["path", "diff"],
							additionalProperties: false,
						},
					},
				},
			]

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Edit the file" }], {
				taskId: "test",
				tools,
			})

			for await (const _ of stream) {
				// consume stream
			}

			// additionalProperties should be stripped from the parameters
			expect(mockChat).toHaveBeenCalledWith(
				expect.objectContaining({
					tools: [
						{
							type: "function",
							function: {
								name: "apply_diff",
								description: "Apply a diff",
								parameters: {
									type: "object",
									properties: {
										path: { type: "string", description: "File path" },
										diff: { type: "string", description: "Diff content" },
									},
									required: ["path", "diff"],
								},
							},
						},
					],
				}),
			)

			// Explicitly verify additionalProperties is not present
			const callArgs = mockChat.mock.calls[0][0] as any
			expect(callArgs.tools[0].function.parameters).not.toHaveProperty("additionalProperties")
		})

		it("should recursively strip additionalProperties from nested tool schema parameters", async () => {
			mockGetOllamaModels.mockResolvedValue({
				"llama3.2": {
					contextWindow: 128000,
					maxTokens: 4096,
					supportsImages: true,
					supportsPromptCache: false,
				},
			})

			const options: ApiHandlerOptions = {
				apiModelId: "llama3.2",
				ollamaModelId: "llama3.2",
				ollamaBaseUrl: "http://localhost:11434",
			}

			handler = new NativeOllamaHandler(options)

			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const tools = [
				{
					type: "function" as const,
					function: {
						name: "apply_diff",
						description: "Apply a diff",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string", description: "File path" },
								options: {
									type: "object",
									properties: {
										dry_run: { type: "boolean" },
										backup: { type: "boolean" },
									},
									required: ["dry_run"],
									additionalProperties: false,
								},
							},
							required: ["path", "options"],
							additionalProperties: false,
						},
					},
				},
			]

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Edit the file" }], {
				taskId: "test",
				tools,
			})

			for await (const _ of stream) {
				// consume stream
			}

			const callArgs = mockChat.mock.calls[0][0] as any
			const params = callArgs.tools[0].function.parameters

			// Top-level additionalProperties stripped
			expect(params).not.toHaveProperty("additionalProperties")

			// Nested additionalProperties also stripped
			expect(params.properties.options).not.toHaveProperty("additionalProperties")
			expect(params.properties.options.properties.dry_run).toEqual({ type: "boolean" })
		})

		it("should keep tool results text-only and move images onto the adjacent user message", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tool-img",
							name: "read_file",
							input: { path: "foo.ts" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-img",
							content: [
								{ type: "text", text: "screenshot" },
								{
									type: "image",
									source: {
										type: "base64",
										media_type: "image/png",
										data: "imgdata",
									},
								},
							],
						},
						{ type: "text", text: "please continue" },
					],
				},
			]

			const stream = handler.createMessage("System", messages)
			for await (const _ of stream) {
				// consume stream
			}

			const callArgs = mockChat.mock.calls[0][0] as any

			// The tool result uses the native "tool" role and is text-only.
			const toolMessage = callArgs.messages.find((m: any) => m.role === "tool")
			expect(toolMessage).toBeDefined()
			expect(toolMessage.tool_name).toBe("read_file")
			expect(toolMessage.images).toBeUndefined()

			// The image is carried by the adjacent user message.
			const userMessage = callArgs.messages.find(
				(m: any) => m.role === "user" && Array.isArray(m.images) && m.images.includes("imgdata"),
			)
			expect(userMessage).toBeDefined()
		})

		it("should not leak images from one tool result into another", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "ok" } }
			})

			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "tool-a", name: "read_file", input: { path: "a.ts" } },
						{ type: "tool_use", id: "tool-b", name: "read_file", input: { path: "b.ts" } },
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-a",
							content: [
								{ type: "text", text: "a" },
								{
									type: "image",
									source: { type: "base64", media_type: "image/png", data: "img-a" },
								},
							],
						},
						{
							type: "tool_result",
							tool_use_id: "tool-b",
							content: [{ type: "text", text: "b" }],
						},
					],
				},
			]

			const stream = handler.createMessage("System", messages)
			for await (const _ of stream) {
				// consume stream
			}

			const callArgs = mockChat.mock.calls[0][0] as any
			const toolMessages = callArgs.messages.filter((m: any) => m.role === "tool")

			// Neither tool result should carry an images field.
			expect(toolMessages).toHaveLength(2)
			for (const m of toolMessages) {
				expect(m.images).toBeUndefined()
			}

			// The single image is delivered once via the adjacent user message.
			const userImageMessages = callArgs.messages.filter((m: any) => m.role === "user" && Array.isArray(m.images))
			expect(userImageMessages).toHaveLength(1)
			expect(userImageMessages[0].images).toEqual(["img-a"])
		})

		it("should reject with AbortError when the abort signal fires during model discovery", async () => {
			let resolveFetch: (() => void) | undefined

			// Hold model discovery open so the abort lands before the chat request.
			mockGetOllamaModels.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveFetch = () => resolve({})
					}),
			)

			const controller = new AbortController()
			const promise = handler.completePrompt("Test prompt", { abortSignal: controller.signal })

			// The discovery fetch is in flight; abort before it settles.
			controller.abort()
			resolveFetch?.()

			await expect(promise).rejects.toMatchObject({ name: "AbortError" })
			expect(mockGetOllamaModels).toHaveBeenCalledTimes(1)
			expect(mockChat).not.toHaveBeenCalled()
		})

		it("should reject with AbortError when timeoutMs fires during model discovery", async () => {
			const testTimeout = 5000
			let capturedFn: (() => void) | undefined
			let resolveFetch: (() => void) | undefined

			// Hold model discovery open so the timeout lands before the chat request.
			mockGetOllamaModels.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveFetch = () => resolve({})
					}),
			)

			// The timer id is never consumed (the callback is captured and fired
			// manually), so bridge the ambient setTimeout signature through unknown.
			vitest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
				if (ms === testTimeout) {
					capturedFn = fn
				}
				return 0
			}) as unknown as typeof setTimeout)

			const promise = handler.completePrompt("Test prompt", { timeoutMs: testTimeout })
			expect(capturedFn).toBeDefined()

			// Fire the timeout while discovery is still in flight. The discovery
			// race must reject on the timeout WITHOUT waiting for the held fetch
			// to settle.
			capturedFn?.()
			await expect(promise).rejects.toMatchObject({ name: "AbortError" })
			expect(mockChat).not.toHaveBeenCalled()

			// Settle the held fetch after the assertion so no promise is left
			// dangling.
			resolveFetch?.()
		})
	})

	describe("per-request client creation", () => {
		it("should create a new Ollama client for each completePrompt call (per-request pattern)", async () => {
			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			const handler = new NativeOllamaHandler({
				apiModelId: "llama2",
				ollamaModelId: "llama2",
				ollamaBaseUrl: "http://localhost:11434",
			})

			// First call
			await handler.completePrompt("Test prompt 1")

			// Second call - should create a new client each time (per-request pattern)
			await handler.completePrompt("Test prompt 2")

			// Verify the Ollama constructor was called twice (per-request pattern, not singleton)
			expect(OllamaMock).toHaveBeenCalledTimes(2)
		})

		it("should pass API key through constructor headers option", async () => {
			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			const handler = new NativeOllamaHandler({
				apiModelId: "llama2",
				ollamaModelId: "llama2",
				ollamaBaseUrl: "http://localhost:11434",
				ollamaApiKey: "test-api-key-123",
			})

			await handler.completePrompt("Test prompt")

			// Verify Ollama was constructed with headers containing the API key
			expect(OllamaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					headers: {
						Authorization: "Bearer test-api-key-123",
					},
				}),
			)
		})

		it("should work without API key (no headers)", async () => {
			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			const handler = new NativeOllamaHandler({
				apiModelId: "llama2",
				ollamaModelId: "llama2",
				ollamaBaseUrl: "http://localhost:11434",
			})

			await handler.completePrompt("Test prompt")

			// Verify Ollama was constructed without headers when no API key is provided
			expect(OllamaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					host: "http://localhost:11434",
				}),
			)
			// headers should not be present when no API key
			const callArgs = OllamaMock.mock.calls[0][0]
			expect(callArgs.headers).toBeUndefined()
		})

		it("should use custom baseUrl in client options", async () => {
			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			const handler = new NativeOllamaHandler({
				apiModelId: "llama2",
				ollamaModelId: "llama2",
				ollamaBaseUrl: "http://custom-ollama:11434",
			})

			await handler.completePrompt("Test prompt")

			expect(OllamaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					host: "http://custom-ollama:11434",
				}),
			)
		})

		it("should not attach the API key for a remote HTTP endpoint", async () => {
			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			const handler = new NativeOllamaHandler({
				apiModelId: "llama2",
				ollamaModelId: "llama2",
				ollamaBaseUrl: "http://ollama.example.com:11434",
				ollamaApiKey: "test-api-key-123",
			})

			await handler.completePrompt("Test prompt")

			// Plaintext HTTP to a remote host would leak the credential (CWE-319),
			// so the Authorization header must be omitted.
			const callArgs = OllamaMock.mock.calls[0][0]
			expect(callArgs.headers).toBeUndefined()
		})

		it("should attach the API key for an HTTPS endpoint", async () => {
			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			const handler = new NativeOllamaHandler({
				apiModelId: "llama2",
				ollamaModelId: "llama2",
				ollamaBaseUrl: "https://ollama.example.com:11434",
				ollamaApiKey: "test-api-key-123",
			})

			await handler.completePrompt("Test prompt")

			expect(OllamaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					host: "https://ollama.example.com:11434",
					headers: {
						Authorization: "Bearer test-api-key-123",
					},
				}),
			)
		})

		it("should attach the API key for a loopback IP endpoint", async () => {
			mockChat.mockResolvedValue({
				message: { content: "Response" },
			})

			const handler = new NativeOllamaHandler({
				apiModelId: "llama2",
				ollamaModelId: "llama2",
				ollamaBaseUrl: "http://127.0.0.1:11434",
				ollamaApiKey: "test-api-key-123",
			})

			await handler.completePrompt("Test prompt")

			expect(OllamaMock).toHaveBeenCalledWith(
				expect.objectContaining({
					host: "http://127.0.0.1:11434",
					headers: {
						Authorization: "Bearer test-api-key-123",
					},
				}),
			)
		})
	})

	describe("per-request abortable transport", () => {
		// The vi.fn() OllamaMock is untyped, so the constructor options read
		// from mock.calls need one documented narrow cast to reach the injected
		// per-request transport.
		type ConstructorOptions = {
			fetch?: (url: string, init?: RequestInit) => Promise<unknown>
		}

		// A held-open fetch: it rejects with an AbortError when the passed
		// signal aborts and stays pending otherwise.
		const heldOpenFetch = () =>
			vi.fn(async (_url: string, init?: RequestInit) => {
				if (init?.signal?.aborted) {
					throw new DOMException("This operation was aborted", "AbortError")
				}
				await new Promise((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("This operation was aborted", "AbortError")),
						{ once: true },
					)
				})
			})

		it("should make a held-open chat POST abortable via the per-request transport when the external signal aborts", async () => {
			const fetchSpy = heldOpenFetch()
			vi.stubGlobal("fetch", fetchSpy)

			let settleChat: ((value: object) => void) | undefined
			mockChat.mockImplementation(
				() =>
					new Promise((resolve) => {
						settleChat = resolve
					}),
			)

			const controller = new AbortController()
			const stream = handler.createMessage(
				"System",
				[{ role: "user" as const, content: "Test" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)
			const consume = (async () => {
				for await (const _ of stream) {
					// consume stream
				}
			})()

			// Spin until the mocked SDK chat() has been invoked (the mocked SDK
			// never uses the transport, so its chat() is held manually).
			for (let i = 0; i < 50 && mockChat.mock.calls.length === 0; i++) {
				await Promise.resolve()
			}
			expect(mockChat).toHaveBeenCalledTimes(1)

			const clientOptions = OllamaMock.mock.calls[0][0] as ConstructorOptions
			expect(clientOptions.fetch).toBeTypeOf("function")

			// Non-stream phase: the SDK passes no signal, so the transport must
			// still hand the per-request signal to fetch.
			const heldPost = clientOptions.fetch!("http://localhost:11434/api/chat", {})
			controller.abort()

			// The held POST is aborted with the response never released.
			await expect(heldPost).rejects.toMatchObject({ name: "AbortError" })

			// Prove the dispose path: a stream that resolves after cancellation
			// is disposed, not consumed.
			settleChat?.({
				message: { content: "late" },
				abort: vi.fn(),
				[Symbol.asyncIterator]: async function* () {},
			})
			await expect(consume).rejects.toMatchObject({ name: "AbortError" })

			vi.unstubAllGlobals()
		})

		it("should abort a held-open POST via the per-request transport when timeoutMs fires", async () => {
			// Earlier tests in this file leave a persistent global setTimeout mock
			// (vi.clearAllMocks does not restore spy implementations); the real
			// 100ms timer is the point of this test, so restore native timers.
			vi.restoreAllMocks()

			const fetchSpy = heldOpenFetch()
			vi.stubGlobal("fetch", fetchSpy)

			let rejectChat: ((reason: unknown) => void) | undefined
			mockChat.mockImplementation(
				() =>
					new Promise((_resolve, reject) => {
						rejectChat = reject
					}),
			)

			const promise = handler.completePrompt("Test prompt", { timeoutMs: 100 })

			// Spin until the mocked SDK chat() has been invoked.
			for (let i = 0; i < 50 && mockChat.mock.calls.length === 0; i++) {
				await Promise.resolve()
			}
			expect(mockChat).toHaveBeenCalledTimes(1)

			const clientOptions = OllamaMock.mock.calls[0][0] as ConstructorOptions
			const heldPost = clientOptions.fetch!("http://localhost:11434/api/chat", {})

			// The real 100ms timer aborts the per-request signal, which must
			// reject the held POST.
			await expect(heldPost).rejects.toMatchObject({ name: "AbortError" })

			// Mirror the real SDK: the in-flight POST rejects, and the
			// completion surfaces the AbortError unmodified.
			rejectChat?.(new DOMException("This operation was aborted", "AbortError"))
			await expect(promise).rejects.toMatchObject({ name: "AbortError" })

			vi.unstubAllGlobals()
		})

		it("should preserve the SDK stream signal when merging it with the per-request signal", async () => {
			let receivedSignal: AbortSignal | null | undefined
			const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
				receivedSignal = init?.signal
				if (init?.signal?.aborted) {
					throw new DOMException("This operation was aborted", "AbortError")
				}
				await new Promise((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("This operation was aborted", "AbortError")),
						{ once: true },
					)
				})
			})
			vi.stubGlobal("fetch", fetchSpy)

			mockChat.mockResolvedValue({ message: { content: "Response" } })

			// Drive a plain completePrompt so the per-request client is
			// constructed; the transport is attached even without an external
			// signal or timeout.
			await handler.completePrompt("Test prompt")

			const clientOptions = OllamaMock.mock.calls[0][0] as ConstructorOptions
			expect(clientOptions.fetch).toBeTypeOf("function")

			const sdkController = new AbortController()
			const post = clientOptions.fetch!("http://localhost:11434/api/chat", { signal: sdkController.signal })

			// The transport must merge, not replace: the SDK's own signal is
			// preserved as one side of the AbortSignal.any merge.
			expect(receivedSignal).toBeInstanceOf(AbortSignal)
			expect(receivedSignal).not.toBe(sdkController.signal)
			expect(receivedSignal?.aborted).toBe(false)

			// The SDK-side internal controller must still cancel the POST (the
			// preserved-signal side of the merge).
			sdkController.abort()
			await expect(post).rejects.toMatchObject({ name: "AbortError" })

			vi.unstubAllGlobals()
		})
	})

	describe("createMessage abort signal", () => {
		it("should reject with AbortError when external abortSignal is already aborted", async () => {
			const controller = new AbortController()
			controller.abort()

			const stream = handler.createMessage(
				"System",
				[{ role: "user" as const, content: "Test" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			await expect(async () => {
				for await (const _ of stream) {
					// consume stream
				}
			}).rejects.toMatchObject({ name: "AbortError" })
		})

		it("should abort the in-flight request when external abortSignal fires", async () => {
			let rejectChat: ((reason: unknown) => void) | undefined

			// Wire the per-request client's abort() to reject the in-flight chat
			// request, mirroring how the real Ollama SDK surfaces client.abort().
			OllamaMock.mockImplementation(function (options?: { host?: string }) {
				return {
					chat: mockChat,
					abort: () => {
						rejectChat?.(new DOMException("This operation was aborted", "AbortError"))
					},
					_host: options?.host ?? "http://localhost:11434",
				}
			})
			mockChat.mockImplementation(
				() =>
					new Promise((_, reject) => {
						rejectChat = reject
					}),
			)

			const controller = new AbortController()
			const stream = handler.createMessage(
				"System",
				[{ role: "user" as const, content: "Test" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const consume = (async () => {
				for await (const _ of stream) {
					// consume stream
				}
			})()

			// Wait until the in-flight request has actually started.
			for (let i = 0; i < 50 && mockChat.mock.calls.length === 0; i++) {
				await Promise.resolve()
			}
			expect(mockChat).toHaveBeenCalledTimes(1)

			controller.abort()

			await expect(consume).rejects.toMatchObject({ name: "AbortError" })
		})

		it("should reject with AbortError when the abort signal fires during model discovery", async () => {
			let resolveFetch: (() => void) | undefined
			let clientAborted = false

			// Hold model discovery open so the abort lands between fetchModel()
			// starting and the chat request being issued.
			mockGetOllamaModels.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveFetch = () => resolve({})
					}),
			)

			// Wire the per-request client's abort() so the bridge into the SDK
			// client can be observed; the chat request must never start.
			OllamaMock.mockImplementation(function (options?: { host?: string }) {
				return {
					chat: mockChat,
					abort: () => {
						clientAborted = true
					},
					_host: options?.host ?? "http://localhost:11434",
				}
			})

			const controller = new AbortController()
			const stream = handler.createMessage(
				"System",
				[{ role: "user" as const, content: "Test" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const consume = (async () => {
				for await (const _ of stream) {
					// consume stream
				}
			})()

			// Abort while the model list is still being fetched. The race must
			// reject the generator with AbortError before chat() is attempted.
			controller.abort()
			await expect(consume).rejects.toMatchObject({ name: "AbortError" })
			expect(mockChat).not.toHaveBeenCalled()
			expect(mockGetOllamaModels).toHaveBeenCalledTimes(1)
			expect(clientAborted).toBe(true)

			// Settle the held discovery fetch so no promise is left dangling.
			resolveFetch?.()
		})

		it("should dispose a stream that resolves after cancellation instead of consuming it", async () => {
			const controller = new AbortController()
			let streamAborted = false
			let consumed = false

			// The POST resolves exactly when the abort lands (response headers
			// first): the resolved iterator must be disposed, not consumed.
			mockChat.mockImplementation(() => {
				controller.abort()
				return Promise.resolve({
					message: { content: "late" },
					abort: () => {
						streamAborted = true
					},
					[Symbol.asyncIterator]: async function* () {
						consumed = true
						yield { message: { content: "late" } }
					},
				})
			})

			const stream = handler.createMessage(
				"System",
				[{ role: "user" as const, content: "Test" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const consume = (async () => {
				for await (const _ of stream) {
					// consume stream
				}
			})()

			await expect(consume).rejects.toMatchObject({ name: "AbortError" })
			expect(streamAborted).toBe(true)
			expect(consumed).toBe(false)
		})

		it("should surface an AbortError thrown by the stream body without wrapping it", async () => {
			// Mirror the real SDK: the chat() iterator is backed by the in-flight
			// POST, so an aborted request rejects the first next() with the
			// DOMException AbortError. The zero-item delegation satisfies
			// require-yield without emitting a part before the rejection.
			mockChat.mockImplementation(async function* () {
				yield* []
				throw new DOMException("This operation was aborted", "AbortError")
			})

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])

			await expect(async () => {
				for await (const _ of stream) {
					// consume stream
				}
			}).rejects.toMatchObject({ name: "AbortError" })
		})
	})
})
