// pnpm exec vitest run api/providers/__tests__/native-ollama.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

import { NativeOllamaHandler } from "../native-ollama"
import { ApiHandlerOptions } from "../../../shared/api"
import { getOllamaModels } from "../fetchers/ollama"

// Mock the ollama package
const mockChat = vitest.fn()
vitest.mock("ollama", () => {
	return {
		Ollama: vitest.fn().mockImplementation(function () {
			return {
				chat: mockChat,
			}
		}),
		Message: vitest.fn(),
	}
})

// Mock the getOllamaModels function
vitest.mock("../fetchers/ollama", () => ({
	getOllamaModels: vitest.fn(),
}))

const mockGetOllamaModels = vitest.mocked(getOllamaModels)

describe("NativeOllamaHandler", () => {
	let handler: NativeOllamaHandler

	beforeEach(() => {
		vitest.clearAllMocks()

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
				vitest.clearAllMocks()
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
	})
})
