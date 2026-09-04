// npx vitest run src/api/providers/__tests__/vercel-ai-gateway.spec.ts

// Mock vscode first to avoid import errors
vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { APIConnectionTimeoutError, APIUserAbortError } from "openai"

import { VercelAiGatewayHandler } from "../vercel-ai-gateway"
import { makeApiHandlerOptions, makeCreateMessageMetadata } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { vercelAiGatewayDefaultModelId, VERCEL_AI_GATEWAY_DEFAULT_TEMPERATURE } from "@roo-code/types"

// Mock dependencies
vitest.mock("openai")
vitest.mock("delay", () => ({
	default: vitest.fn(function () {
		return Promise.resolve()
	}),
}))
vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(function () {
		return Promise.resolve({
			"anthropic/claude-sonnet-4": {
				maxTokens: 64000,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude Sonnet 4",
			},
			"anthropic/claude-fable-5": {
				maxTokens: 128000,
				contextWindow: 1000000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsTemperature: false,
				inputPrice: 10,
				outputPrice: 50,
				cacheWritesPrice: 12.5,
				cacheReadsPrice: 1,
				description: "Claude Fable 5",
			},
			"anthropic/claude-fable-5.1": {
				maxTokens: 128000,
				contextWindow: 1000000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsTemperature: false,
				inputPrice: 10,
				outputPrice: 50,
				cacheWritesPrice: 12.5,
				cacheReadsPrice: 0.25,
				description: "Claude Fable 5.1",
			},
			"anthropic/claude-sonnet-5": {
				maxTokens: 128000,
				contextWindow: 1000000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsTemperature: false,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude Sonnet 5",
			},
			"anthropic/claude-opus-5": {
				maxTokens: 128000,
				contextWindow: 1000000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsTemperature: false,
				inputPrice: 5,
				outputPrice: 25,
				cacheWritesPrice: 6.25,
				cacheReadsPrice: 0.5,
				description: "Claude Opus 5",
			},
			"anthropic/claude-3.5-haiku": {
				maxTokens: 32000,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 1,
				outputPrice: 5,
				cacheWritesPrice: 1.25,
				cacheReadsPrice: 0.1,
				description: "Claude 3.5 Haiku",
			},
			"openai/gpt-4o": {
				maxTokens: 16000,
				contextWindow: 128000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 2.5,
				outputPrice: 10,
				cacheWritesPrice: 3.125,
				cacheReadsPrice: 0.25,
				description: "GPT-4o",
			},
		})
	}),
	refreshModels: vitest.fn(async (options) => {
		const { getModels } = await import("../fetchers/modelCache")
		return getModels(options)
	}),
	getModelsFromCache: vitest.fn().mockReturnValue(undefined),
}))

vitest.mock("../../transform/caching/vercel-ai-gateway", () => ({
	addCacheBreakpoints: vitest.fn(),
}))

const mockCreate = vitest.fn()
const mockConstructor = vitest.fn()

;(OpenAI as any).mockImplementation(function () {
	return {
		chat: {
			completions: {
				create: mockCreate,
			},
		},
	}
})
;(OpenAI as any).mockImplementation = mockConstructor.mockReturnValue({
	chat: {
		completions: {
			create: mockCreate,
		},
	},
})

describe("VercelAiGatewayHandler", () => {
	const mockOptions = makeApiHandlerOptions({
		vercelAiGatewayApiKey: "test-key",
		vercelAiGatewayModelId: "anthropic/claude-sonnet-4",
	})

	beforeEach(() => {
		clearAllMocks()
		mockCreate.mockClear()
		mockConstructor.mockClear()
	})

	it("initializes with correct options", () => {
		const handler = new VercelAiGatewayHandler(mockOptions)
		expect(handler).toBeInstanceOf(VercelAiGatewayHandler)

		expect(OpenAI).toHaveBeenCalledWith({
			baseURL: "https://ai-gateway.vercel.sh/v1",
			apiKey: mockOptions.vercelAiGatewayApiKey,
			defaultHeaders: expect.objectContaining({
				"HTTP-Referer": "https://github.com/Zoo-Code-Org/Zoo-Code",
				"X-Title": "Zoo Code",
				"User-Agent": expect.stringContaining("ZooCode/"),
			}),
			timeout: expect.any(Number),
		})
	})

	describe("fetchModel", () => {
		it("returns correct model info when options are provided", async () => {
			const handler = new VercelAiGatewayHandler(mockOptions)
			const result = await handler.fetchModel()

			expect(result.id).toBe(mockOptions.vercelAiGatewayModelId)
			expect(result.info.maxTokens).toBe(64000)
			expect(result.info.contextWindow).toBe(200000)
			expect(result.info.supportsImages).toBe(true)
			expect(result.info.supportsPromptCache).toBe(true)
		})

		it("returns default model info when options are not provided", async () => {
			const handler = new VercelAiGatewayHandler({})
			const result = await handler.fetchModel()
			expect(result.id).toBe(vercelAiGatewayDefaultModelId)
			expect(result.info.supportsPromptCache).toBe(true)
		})

		it("uses vercel ai gateway default model when no model specified", async () => {
			const handler = new VercelAiGatewayHandler({ vercelAiGatewayApiKey: "test-key" })
			const result = await handler.fetchModel()
			expect(result.id).toBe("anthropic/claude-sonnet-4")
		})
	})

	describe("createMessage", () => {
		beforeEach(() => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: { content: "Test response" },
								index: 0,
							},
						],
						usage: null,
					},
					{
						choices: [
							{
								delta: {},
								index: 0,
							},
						],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							total_tokens: 15,
							cache_creation_input_tokens: 2,
							prompt_tokens_details: {
								cached_tokens: 3,
							},
							cost: 0.005,
						},
					},
				]),
			)
		})

		it("streams text content correctly", async () => {
			const handler = new VercelAiGatewayHandler(mockOptions)
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks = await collectStream(stream)

			expect(chunks).toHaveLength(2)
			expect(chunks[0]).toEqual({
				type: "text",
				text: "Test response",
			})
			expect(chunks[1]).toEqual({
				type: "usage",
				inputTokens: 10,
				outputTokens: 5,
				cacheWriteTokens: 2,
				cacheReadTokens: 3,
				totalCost: 0.005,
			})
		})

		it("throws the upstream reason when an in-stream error chunk is received", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						error: {
							message: "Too many requests, please wait before trying again",
							code: 429,
						},
					},
				]),
			)

			const handler = new VercelAiGatewayHandler(mockOptions)
			const stream = handler.createMessage("You are a helpful assistant.", [{ role: "user", content: "Hello" }])

			await expect(async () => {
				await collectStream(stream)
			}).rejects.toThrow("Too many requests, please wait before trying again")
		})

		it("throws a default message when an in-stream error chunk has no message", async () => {
			mockCreate.mockImplementation(async () => asyncStreamFrom([{ error: {} }]))

			const handler = new VercelAiGatewayHandler(mockOptions)
			const stream = handler.createMessage("You are a helpful assistant.", [{ role: "user", content: "Hello" }])

			await expect(async () => {
				await collectStream(stream)
			}).rejects.toThrow("Vercel AI Gateway stream error")
		})

		it("throws the default message when an in-stream error chunk has an empty message", async () => {
			// An empty message must not be forwarded — it would become
			// Error("") with no diagnostic at all.
			mockCreate.mockImplementation(async () => asyncStreamFrom([{ error: { message: "" } }]))

			const handler = new VercelAiGatewayHandler(mockOptions)
			const stream = handler.createMessage("You are a helpful assistant.", [{ role: "user", content: "Hello" }])

			await expect(async () => {
				await collectStream(stream)
			}).rejects.toThrow("Vercel AI Gateway stream error")
		})

		it("treats a present-but-undefined error key as no error", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([{ error: undefined, choices: [{ delta: { content: "hi" }, index: 0 }], index: 0 }]),
			)

			const handler = new VercelAiGatewayHandler(mockOptions)
			const stream = handler.createMessage("You are a helpful assistant.", [{ role: "user", content: "Hello" }])

			const chunks = await collectStream(stream)
			expect(chunks).toEqual([{ type: "text", text: "hi" }])
		})

		it("skips frames without a delta and tool calls without a function field", async () => {
			// Full-list assertion: a frame without choices[0], a choice without
			// a delta, and a tool call missing function must each contribute
			// nothing except the partial tool call with undefined name/arguments
			// (toEqual ignores undefined-valued keys).
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{ choices: [], index: 0 },
					{ choices: [{}], index: 0 },
					{ choices: [{ delta: { content: "hi" }, index: 0 }], index: 0 },
					{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1" }] }, index: 0 }], index: 0 },
				]),
			)

			const handler = new VercelAiGatewayHandler(mockOptions)
			const stream = handler.createMessage("You are a helpful assistant.", [{ role: "user", content: "Hello" }])

			const chunks = await collectStream(stream)
			expect(chunks).toEqual([
				{ type: "text", text: "hi" },
				{ type: "tool_call_partial", index: 0, id: "call_1" },
			])
		})

		it("uses correct temperature from options", async () => {
			const customTemp = 0.5
			const handler = new VercelAiGatewayHandler(
				makeApiHandlerOptions({
					...mockOptions,
					modelTemperature: customTemp,
				}),
			)

			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			await handler.createMessage(systemPrompt, messages).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: customTemp,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("uses default temperature when none provided", async () => {
			const handler = new VercelAiGatewayHandler(mockOptions)

			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			await handler.createMessage(systemPrompt, messages).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: VERCEL_AI_GATEWAY_DEFAULT_TEMPERATURE,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("omits temperature for Claude Fable 5", async () => {
			const handler = new VercelAiGatewayHandler(
				makeApiHandlerOptions({
					...mockOptions,
					vercelAiGatewayModelId: "anthropic/claude-fable-5",
				}),
			)

			await handler.createMessage("You are a helpful assistant.", [{ role: "user", content: "Hello" }]).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-fable-5",
					temperature: undefined,
					max_completion_tokens: 128000,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("omits temperature for Claude Fable 5.1", async () => {
			const handler = new VercelAiGatewayHandler(
				makeApiHandlerOptions({
					...mockOptions,
					vercelAiGatewayModelId: "anthropic/claude-fable-5.1",
				}),
			)

			await collectStream(handler.createMessage("system prompt", [{ role: "user", content: "test" }]))

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-fable-5.1",
					temperature: undefined,
				}),
			)
		})

		it("omits temperature for Claude Sonnet 5", async () => {
			const handler = new VercelAiGatewayHandler(
				makeApiHandlerOptions({
					...mockOptions,
					vercelAiGatewayModelId: "anthropic/claude-sonnet-5",
				}),
			)

			await handler.createMessage("You are a helpful assistant.", [{ role: "user", content: "Hello" }]).next()

			// Assert directly on the extracted call arg. `objectContaining({
			// temperature: undefined })` passes whether temperature is explicitly
			// undefined or simply absent, so it wouldn't catch a regression where the
			// handler stops consulting supportsTemperature.
			const call = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
			expect(call.model).toBe("anthropic/claude-sonnet-5")
			expect(call.temperature).toBeUndefined()
			expect(call.max_completion_tokens).toBe(128000)
		})

		it("omits temperature for Claude Opus 5", async () => {
			const handler = new VercelAiGatewayHandler(
				makeApiHandlerOptions({
					...mockOptions,
					vercelAiGatewayModelId: "anthropic/claude-opus-5",
				}),
			)

			await handler.createMessage("You are a helpful assistant.", [{ role: "user", content: "Hello" }]).next()

			// Assert directly on the extracted call arg. `objectContaining({
			// temperature: undefined })` passes whether temperature is explicitly
			// undefined or simply absent, so it wouldn't catch a regression where the
			// handler stops consulting supportsTemperature.
			const call = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
			expect(call.model).toBe("anthropic/claude-opus-5")
			expect(call.temperature).toBeUndefined()
			expect(call.max_completion_tokens).toBe(128000)
		})

		it("adds cache breakpoints for supported models", async () => {
			const { addCacheBreakpoints } = await import("../../transform/caching/vercel-ai-gateway")
			const handler = new VercelAiGatewayHandler(
				makeApiHandlerOptions({
					...mockOptions,
					vercelAiGatewayModelId: "anthropic/claude-3.5-haiku",
				}),
			)

			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			await handler.createMessage(systemPrompt, messages).next()

			expect(addCacheBreakpoints).toHaveBeenCalled()
		})

		it("sets correct max_completion_tokens", async () => {
			const handler = new VercelAiGatewayHandler(mockOptions)

			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			await handler.createMessage(systemPrompt, messages).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					max_completion_tokens: 64000, // max tokens for sonnet 4
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("handles usage info correctly with all Vercel AI Gateway specific fields", async () => {
			const handler = new VercelAiGatewayHandler(mockOptions)
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks = await collectStream(stream)

			const usageChunk = chunks.find((chunk) => chunk.type === "usage")
			expect(usageChunk).toEqual({
				type: "usage",
				inputTokens: 10,
				outputTokens: 5,
				cacheWriteTokens: 2,
				cacheReadTokens: 3,
				totalCost: 0.005,
			})
		})

		describe("native tool calling", () => {
			const testTools = [
				{
					type: "function" as const,
					function: {
						name: "test_tool",
						description: "A test tool",
						parameters: {
							type: "object",
							properties: {
								arg1: { type: "string" },
							},
							required: ["arg1"],
						},
					},
				},
			]

			beforeEach(() => {
				mockCreate.mockImplementation(async () =>
					asyncStreamFrom([
						{
							choices: [
								{
									delta: {},
									index: 0,
								},
							],
						},
					]),
				)
			})

			it("should include tools when provided", async () => {
				const handler = new VercelAiGatewayHandler(mockOptions)

				const messageGenerator = handler.createMessage("test prompt", [], {
					taskId: "test-task-id",
					tools: testTools,
				})
				await messageGenerator.next()

				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({
						tools: expect.arrayContaining([
							expect.objectContaining({
								type: "function",
								function: expect.objectContaining({
									name: "test_tool",
								}),
							}),
						]),
					}),
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				)
			})

			it("should include tool_choice when provided", async () => {
				const handler = new VercelAiGatewayHandler(mockOptions)

				const messageGenerator = handler.createMessage("test prompt", [], {
					taskId: "test-task-id",
					tools: testTools,
					tool_choice: "auto",
				})
				await messageGenerator.next()

				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({
						tool_choice: "auto",
					}),
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				)
			})

			it("should set parallel_tool_calls when parallelToolCalls is enabled", async () => {
				const handler = new VercelAiGatewayHandler(mockOptions)

				const messageGenerator = handler.createMessage("test prompt", [], {
					taskId: "test-task-id",
					tools: testTools,
					parallelToolCalls: true,
				})
				await messageGenerator.next()

				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({
						parallel_tool_calls: true,
					}),
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				)
			})

			it("should include parallel_tool_calls: true by default", async () => {
				const handler = new VercelAiGatewayHandler(mockOptions)

				const messageGenerator = handler.createMessage("test prompt", [], {
					taskId: "test-task-id",
					tools: testTools,
				})
				await messageGenerator.next()

				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({
						tools: expect.any(Array),
						parallel_tool_calls: true,
					}),
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				)
			})

			it("should yield tool_call_partial chunks when streaming tool calls", async () => {
				mockCreate.mockImplementation(async () =>
					asyncStreamFrom([
						{
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_123",
												function: {
													name: "test_tool",
													arguments: '{"arg1":',
												},
											},
										],
									},
									index: 0,
								},
							],
						},
						{
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												function: {
													arguments: '"value"}',
												},
											},
										],
									},
									index: 0,
								},
							],
						},
						{
							choices: [
								{
									delta: {},
									index: 0,
								},
							],
							usage: {
								prompt_tokens: 10,
								completion_tokens: 5,
							},
						},
					]),
				)

				const handler = new VercelAiGatewayHandler(mockOptions)

				const stream = handler.createMessage("test prompt", [], {
					taskId: "test-task-id",
					tools: testTools,
				})

				const chunks = await collectStream(stream)

				const toolCallChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
				expect(toolCallChunks).toHaveLength(2)
				expect(toolCallChunks[0]).toEqual({
					type: "tool_call_partial",
					index: 0,
					id: "call_123",
					name: "test_tool",
					arguments: '{"arg1":',
				})
				expect(toolCallChunks[1]).toEqual({
					type: "tool_call_partial",
					index: 0,
					id: undefined,
					name: undefined,
					arguments: '"value"}',
				})
			})

			it("should include stream_options with include_usage", async () => {
				const handler = new VercelAiGatewayHandler(mockOptions)

				const messageGenerator = handler.createMessage("test prompt", [], {
					taskId: "test-task-id",
				})
				await messageGenerator.next()

				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({
						stream_options: { include_usage: true },
					}),
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				)
			})
		})
	})

	describe("completePrompt", () => {
		beforeEach(() => {
			mockCreate.mockImplementation(async () => ({
				choices: [
					{
						message: { role: "assistant", content: "Test completion response" },
						finish_reason: "stop",
						index: 0,
					},
				],
				usage: {
					prompt_tokens: 8,
					completion_tokens: 4,
					total_tokens: 12,
				},
			}))
		})

		it("completes prompt correctly", async () => {
			const handler = new VercelAiGatewayHandler(mockOptions)
			const prompt = "Complete this: Hello"

			const result = await handler.completePrompt(prompt)

			expect(result).toBe("Test completion response")
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-sonnet-4",
					messages: [{ role: "user", content: prompt }],
					stream: false,
					temperature: VERCEL_AI_GATEWAY_DEFAULT_TEMPERATURE,
					max_completion_tokens: 64000,
				}),
				undefined,
			)
		})

		it("uses custom temperature for completion", async () => {
			const customTemp = 0.8
			const handler = new VercelAiGatewayHandler(
				makeApiHandlerOptions({
					...mockOptions,
					modelTemperature: customTemp,
				}),
			)

			await handler.completePrompt("Test prompt")

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: customTemp,
				}),
				undefined,
			)
		})

		it("handles completion errors correctly", async () => {
			const handler = new VercelAiGatewayHandler(mockOptions)
			const errorMessage = "API error"

			mockCreate.mockImplementation(function () {
				throw new Error(errorMessage)
			})

			await expect(handler.completePrompt("Test")).rejects.toThrow(
				`Vercel AI Gateway completion error: ${errorMessage}`,
			)
		})

		it("returns empty string when no content in response", async () => {
			const handler = new VercelAiGatewayHandler(mockOptions)

			mockCreate.mockImplementation(async () => ({
				choices: [
					{
						message: { role: "assistant", content: null },
						finish_reason: "stop",
						index: 0,
					},
				],
			}))

			const result = await handler.completePrompt("Test")
			expect(result).toBe("")
		})

		it("should pass abort signal through to client", async () => {
			const handler = new VercelAiGatewayHandler(mockOptions)
			const controller = new AbortController()
			mockCreate.mockImplementation(async () => ({
				choices: [
					{
						message: { role: "assistant", content: "response" },
						finish_reason: "stop",
						index: 0,
					},
				],
			}))

			await handler.completePrompt("test prompt", { abortSignal: controller.signal })
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ signal: controller.signal }),
			)
		})

		it("should pass timeout through to client", async () => {
			const handler = new VercelAiGatewayHandler(mockOptions)
			mockCreate.mockImplementation(async () => ({
				choices: [
					{
						message: { role: "assistant", content: "response" },
						finish_reason: "stop",
						index: 0,
					},
				],
			}))

			await handler.completePrompt("test prompt", { timeoutMs: 5000 })
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({ timeout: 5000 }),
			)
		})

		it("should omit the timeout option when timeoutMs is 0", async () => {
			// The OpenAI SDK treats timeout: 0 as an immediate abort, so the
			// "disabled" value must never be forwarded — assert the absence of
			// the option (a forwarded timeout: 0 would fail this assertion).
			const handler = new VercelAiGatewayHandler(mockOptions)
			mockCreate.mockImplementation(async () => ({
				choices: [
					{
						message: { role: "assistant", content: "response" },
						finish_reason: "stop",
						index: 0,
					},
				],
			}))

			await handler.completePrompt("test prompt", { timeoutMs: 0 })
			const call = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]
			const requestOptions = call[1] as { timeout?: number } | undefined
			// When no option is forwarded the provider omits the SDK options
			// argument entirely, so absence means: undefined arg OR an arg
			// without a timeout key.
			expect(Object.keys(requestOptions ?? {})).not.toContain("timeout")
		})

		it("should preserve abort identity when the caller aborts", async () => {
			// Emulate the OpenAI SDK: an aborted request signal rejects with
			// APIUserAbortError ("Request was aborted." — the trailing period would
			// fail task-level abort detection, so the provider must normalize it).
			mockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				if (options?.signal?.aborted) {
					throw new APIUserAbortError()
				}
				throw new Error("boom")
			})

			const handler = new VercelAiGatewayHandler(mockOptions)
			const controller = new AbortController()
			controller.abort()

			const error = await handler.completePrompt("test prompt", { abortSignal: controller.signal }).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Vercel AI Gateway request was aborted")
		})

		it("should surface request timeouts as an AbortError", async () => {
			// Emulate the OpenAI SDK: when the request timeout fires, the SDK
			// surfaces APIConnectionTimeoutError ("Request timed out.") once retries
			// are exhausted — verified against openai v5.23.2 against a hung server.
			mockCreate.mockImplementation(async (_params: unknown, options: { timeout?: number }) => {
				await new Promise((resolve) => setTimeout(resolve, options?.timeout ?? 50))
				throw new APIConnectionTimeoutError()
			})

			const handler = new VercelAiGatewayHandler(mockOptions)

			const error = await handler.completePrompt("test prompt", { timeoutMs: 50 }).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Vercel AI Gateway request was aborted")
		})

		it("should preserve abort identity when the signal is pre-aborted with a plain error", async () => {
			// The aborted-signal disjunct alone must normalize a plain
			// rejection (not just SDK abort classes) to the DOM-standard
			// AbortError.
			mockCreate.mockRejectedValueOnce(new Error("boom"))
			const controller = new AbortController()
			controller.abort()
			const handler = new VercelAiGatewayHandler(mockOptions)

			const error = await handler.completePrompt("test prompt", { abortSignal: controller.signal }).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Vercel AI Gateway request was aborted")
		})

		it("should preserve abort identity for a name-based AbortError rejection", async () => {
			// No aborted signal and no SDK abort class: only the DOM-standard
			// name === "AbortError" check marks a cancelled request.
			mockCreate.mockRejectedValueOnce(Object.assign(new Error("raw"), { name: "AbortError" }))
			const handler = new VercelAiGatewayHandler(mockOptions)

			const error = await handler.completePrompt("test prompt").then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Vercel AI Gateway request was aborted")
		})
		it("should work without options (backward compatible)", async () => {
			const handler = new VercelAiGatewayHandler(mockOptions)
			mockCreate.mockImplementation(async () => ({
				choices: [
					{
						message: { role: "assistant", content: "response" },
						finish_reason: "stop",
						index: 0,
					},
				],
			}))

			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("response")
		})
	})

	describe("createMessage abort signal bridging", () => {
		it("rejects with an AbortError when the external signal is already aborted", async () => {
			let capturedSignal: AbortSignal | undefined
			mockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
				throw new DOMException("The operation was aborted.", "AbortError")
			})

			const handler = new VercelAiGatewayHandler(mockOptions)
			const controller = new AbortController()
			controller.abort()

			const stream = handler.createMessage(
				"test prompt",
				[{ role: "user", content: "hello" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			// An already-aborted external signal must abort the INTERNAL
			// controller before the request starts.
			const error = await collectStream(stream).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(capturedSignal?.aborted).toBe(true)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Vercel AI Gateway request was aborted")
		})

		it("aborts the in-flight request when the external signal fires mid-stream", async () => {
			// The mock polls the INTERNAL controller signal (bounded 40x5ms)
			// instead of waiting for an "abort" event, so the test can never
			// hang if the bridge stops forwarding aborts.
			let capturedSignal: AbortSignal | undefined
			mockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
				return (async function* () {
					yield { choices: [{ delta: { content: "partial" }, index: 0 }], index: 0 }
					for (let i = 0; i < 40 && !capturedSignal?.aborted; i++) {
						await new Promise((resolve) => setTimeout(resolve, 5))
					}
					if (capturedSignal?.aborted) {
						throw new DOMException("The operation was aborted.", "AbortError")
					}
				})()
			})

			const handler = new VercelAiGatewayHandler(mockOptions)
			const controller = new AbortController()

			const consumed = collectStream(
				handler.createMessage(
					"test prompt",
					[{ role: "user", content: "hello" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			// Let the request start and the first chunk be yielded before aborting.
			await new Promise((resolve) => setTimeout(resolve, 25))
			controller.abort()

			const error = await consumed.then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(capturedSignal?.aborted).toBe(true)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Vercel AI Gateway request was aborted")
		})

		it("detaches the bridged abort listener when the request completes normally", async () => {
			// The listener is added with { once: true }, so it only detaches on
			// abort. A task-scoped signal spanning many requests must not
			// accumulate a listener per request: assert explicit removal after a
			// normal (non-aborted) completion.
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "ok" }, index: 0 }],
						index: 0,
					},
					{
						choices: [{ delta: {}, index: 0 }],
						index: 0,
						usage: { prompt_tokens: 2, completion_tokens: 3 },
					},
				]),
			)

			const handler = new VercelAiGatewayHandler(mockOptions)
			const controller = new AbortController()
			const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener")
			const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener")

			const stream = handler.createMessage(
				"test prompt",
				[{ role: "user", content: "hello" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const chunks = await collectStream(stream)
			expect(chunks).toContainEqual({ type: "text", text: "ok" })
			expect(removeListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function))
			// The listener is registered with { once: true } — assert the exact
			// options so a bridge that drops them (and relies on the finally
			// block alone for single-shot semantics) is caught.
			expect(addEventListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true })
			expect(controller.signal.aborted).toBe(false)
		})
	})

	describe("temperature support", () => {
		it("applies temperature for supported models", async () => {
			// Pin the response: a later describe's mock implementation may have
			// left the shared mock in a state this test does not expect.
			mockCreate.mockResolvedValueOnce({
				choices: [
					{
						message: { role: "assistant", content: "Test completion response" },
						finish_reason: "stop",
						index: 0,
					},
				],
				usage: {
					prompt_tokens: 8,
					completion_tokens: 4,
					total_tokens: 12,
				},
			})

			const handler = new VercelAiGatewayHandler(
				makeApiHandlerOptions({
					...mockOptions,
					vercelAiGatewayModelId: "anthropic/claude-sonnet-4",
					modelTemperature: 0.9,
				}),
			)

			await handler.completePrompt("Test")

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: 0.9,
				}),
				undefined,
			)
		})
	})
})
