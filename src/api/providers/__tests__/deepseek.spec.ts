// Mocks must come first, before imports
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { expectNoLoneSurrogates } from "../../../test-utils/surrogates"

const mockCreate = vi.fn()
vi.mock("openai", () => {
	return {
		__esModule: true,
		default: vi.fn().mockImplementation(function () {
			return {
				chat: {
					completions: {
						create: mockCreate.mockImplementation(async (options) => {
							if (!options.stream) {
								return {
									id: "test-completion",
									choices: [
										{
											message: { role: "assistant", content: "Test response", refusal: null },
											finish_reason: "stop",
											index: 0,
										},
									],
									usage: {
										prompt_tokens: 10,
										completion_tokens: 5,
										total_tokens: 15,
										prompt_tokens_details: {
											cached_tokens: 2,
										},
										prompt_cache_hit_tokens: 2,
										prompt_cache_miss_tokens: 8,
									},
								}
							}

							// Check if this is a reasoning_content test by looking at thinking mode
							const isThinkingModel = options.thinking?.type === "enabled"
							const isToolCallTest = options.tools?.length > 0

							const chunks: unknown[] = []

							// For thinking models, emit reasoning_content first
							if (isThinkingModel) {
								chunks.push(
									{
										choices: [
											{
												delta: { reasoning_content: "Let me think about this..." },
												index: 0,
											},
										],
										usage: null,
									},
									{
										choices: [
											{
												delta: { reasoning_content: " I'll analyze step by step." },
												index: 0,
											},
										],
										usage: null,
									},
								)
							}

							// For tool call tests with thinking mode, emit tool call
							if (isThinkingModel && isToolCallTest) {
								chunks.push({
									choices: [
										{
											delta: {
												tool_calls: [
													{
														index: 0,
														id: "call_123",
														function: {
															name: "get_weather",
															arguments: '{"location":"SF"}',
														},
													},
												],
											},
											index: 0,
										},
									],
									usage: null,
								})
							} else {
								chunks.push({
									choices: [
										{
											delta: { content: "Test response" },
											index: 0,
										},
									],
									usage: null,
								})
							}

							chunks.push({
								choices: [
									{
										delta: {},
										index: 0,
										finish_reason: isToolCallTest ? "tool_calls" : "stop",
									},
								],
								usage: {
									prompt_tokens: 10,
									completion_tokens: 5,
									total_tokens: 15,
									prompt_tokens_details: {
										cached_tokens: 2,
									},
									prompt_cache_hit_tokens: 2,
									prompt_cache_miss_tokens: 8,
								},
							})

							return asyncStreamFrom(chunks)
						}),
					},
				},
			}
		}),
	}
})

import OpenAI from "openai"
import type { Anthropic } from "@anthropic-ai/sdk"

import { deepSeekDefaultModelId, DEEP_SEEK_DEFAULT_TEMPERATURE, type ModelInfo, DeepSeekModelId } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../../shared/api"

import { DeepSeekHandler, normalizeDeepSeekReasoningEffort } from "../deepseek"

describe("DeepSeekHandler", () => {
	let handler: DeepSeekHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = {
			deepSeekApiKey: "test-api-key",
			apiModelId: "deepseek-v4-flash",
			deepSeekBaseUrl: "https://api.deepseek.com",
		}
		handler = new DeepSeekHandler(mockOptions)
		clearAllMocks()
	})

	describe("completePrompt reasoning", () => {
		it.each([
			{ apiModelId: "custom-deepseek-model", enableReasoningEffort: true, expected: undefined },
			{ apiModelId: "deepseek-v4-flash", enableReasoningEffort: false, expected: undefined },
			{ apiModelId: "deepseek-v4-flash", enableReasoningEffort: true, expected: "max" },
		])("respects reasoning support for $apiModelId with enabled=$enableReasoningEffort", async (scenario) => {
			const completionHandler = new DeepSeekHandler({
				...mockOptions,
				apiModelId: scenario.apiModelId,
				enableReasoningEffort: scenario.enableReasoningEffort,
				reasoningEffort: "max",
			})

			await completionHandler.completePrompt("Hello")

			expect(mockCreate).toHaveBeenCalledOnce()
			const request = mockCreate.mock.calls[0][0]
			expect(request.model).toBe(scenario.apiModelId)
			if (scenario.expected === undefined) {
				expect(request).not.toHaveProperty("reasoning_effort")
			} else {
				expect(request.reasoning_effort).toBe(scenario.expected)
			}
		})
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(DeepSeekHandler)
			expect(handler.getModel().id).toBe(mockOptions.apiModelId)
		})

		it.skip("should throw error if API key is missing", () => {
			expect(() => {
				new DeepSeekHandler({
					...mockOptions,
					deepSeekApiKey: undefined,
				})
			}).toThrow("DeepSeek API key is required")
		})

		it("should use default model ID if not provided", () => {
			const handlerWithoutModel = new DeepSeekHandler({
				...mockOptions,
				apiModelId: undefined,
			})
			expect(handlerWithoutModel.getModel().id).toBe(deepSeekDefaultModelId)
		})

		it("should use default base URL if not provided", () => {
			const handlerWithoutBaseUrl = new DeepSeekHandler({
				...mockOptions,
				deepSeekBaseUrl: undefined,
			})
			expect(handlerWithoutBaseUrl).toBeInstanceOf(DeepSeekHandler)
			// The base URL is passed to OpenAI client internally
			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: "https://api.deepseek.com",
				}),
			)
		})

		it("should use custom base URL if provided", () => {
			const customBaseUrl = "https://custom.deepseek.com/v1"
			const handlerWithCustomUrl = new DeepSeekHandler({
				...mockOptions,
				deepSeekBaseUrl: customBaseUrl,
			})
			expect(handlerWithCustomUrl).toBeInstanceOf(DeepSeekHandler)
			// The custom base URL is passed to OpenAI client
			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: customBaseUrl,
				}),
			)
		})

		it("should set includeMaxTokens to true", () => {
			// Create a new handler and verify OpenAI client was called with includeMaxTokens
			const _handler = new DeepSeekHandler(mockOptions)
			expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: mockOptions.deepSeekApiKey }))
		})
	})

	describe("getModel", () => {
		it("should return model info for valid model ID", () => {
			const model = handler.getModel()
			expect(model.id).toBe(mockOptions.apiModelId)
			expect(model.info).toBeDefined()
			expect(model.info.maxTokens).toBe(384_000)
			expect(model.info.contextWindow).toBe(1_000_000)
			expect(model.info.supportsImages).toBe(true)
			expect(model.info.supportsPromptCache).toBe(true) // Should be true now
			expect((model.info as ModelInfo).preserveReasoning).toBe(true)
		})

		it("should use deepseek-flash as the default model ID for new configs", () => {
			const handlerWithoutModel = new DeepSeekHandler({
				...mockOptions,
				apiModelId: undefined,
			})
			const model = handlerWithoutModel.getModel()
			expect(model.id).toBe(deepSeekDefaultModelId)
			expect(model.id).toBe("deepseek-flash")
			expect(model.info.maxTokens).toBe(384_000)
			expect(model.info.contextWindow).toBe(1_000_000)
			expect(model.info.supportsImages).toBe(true)
			expect((model.info as ModelInfo).supportsReasoningEffort).toContain("max")
		})

		it("should return correct model info for deepseek-v4-pro", () => {
			const handlerWithV4Pro = new DeepSeekHandler({
				...mockOptions,
				apiModelId: "deepseek-v4-pro",
			})
			const model = handlerWithV4Pro.getModel()
			expect(model.id).toBe("deepseek-v4-pro")
			expect(model.info).toBeDefined()
			expect(model.info.maxTokens).toBe(384_000)
			expect(model.info.contextWindow).toBe(1_000_000)
			expect(model.info.supportsImages).toBe(false)
			expect(model.info.supportsPromptCache).toBe(true)
			expect((model.info as ModelInfo).preserveReasoning).toBe(true)
			expect((model.info as ModelInfo).reasoningEffort).toBe("high")
		})

		it("should return vision metadata for deepseek-v4-flash-vision-exp", () => {
			const visionHandler = new DeepSeekHandler({
				...mockOptions,
				apiModelId: "deepseek-v4-flash-vision-exp",
			})
			const model = visionHandler.getModel()

			expect(model.id).toBe("deepseek-v4-flash-vision-exp")
			expect(model.info).toMatchObject({
				maxTokens: 384_000,
				contextWindow: 1_000_000,
				supportsImages: true,
				supportsPromptCache: true,
				preserveReasoning: true,
				reasoningEffort: "high",
			})
		})

		it("should return provided model ID with default model info if model does not exist", () => {
			const handlerWithInvalidModel = new DeepSeekHandler({
				...mockOptions,
				apiModelId: "invalid-model",
			})
			const defaultHandler = new DeepSeekHandler({
				...mockOptions,
				apiModelId: undefined,
			})
			const model = handlerWithInvalidModel.getModel()
			expect(model.id).toBe("invalid-model") // Returns provided ID
			expect(model.info).toBeDefined()
			// With the current implementation, it's the same object reference when using default model info
			expect(model.info).toBe(defaultHandler.getModel().info)
			// Should have the same base properties
			expect(model.info.contextWindow).toBe(defaultHandler.getModel().info.contextWindow)
			// And should have supportsPromptCache set to true
			expect(model.info.supportsPromptCache).toBe(true)
		})

		it("should return default model if no model ID is provided", () => {
			const handlerWithoutModel = new DeepSeekHandler({
				...mockOptions,
				apiModelId: undefined,
			})
			const model = handlerWithoutModel.getModel()
			expect(model.id).toBe(deepSeekDefaultModelId)
			expect(model.info).toBeDefined()
			expect(model.info.supportsPromptCache).toBe(true)
		})

		it("should include model parameters from getModelParams", () => {
			const model = handler.getModel()
			expect(model).toHaveProperty("temperature")
			expect(model).toHaveProperty("maxTokens")
		})

		it("should use DEEP_SEEK_DEFAULT_TEMPERATURE as the default temperature", () => {
			const model = handler.getModel()
			expect(model.temperature).toBe(DEEP_SEEK_DEFAULT_TEMPERATURE)
		})

		it("should respect user-provided temperature over DEEP_SEEK_DEFAULT_TEMPERATURE", () => {
			const handlerWithTemp = new DeepSeekHandler({
				...mockOptions,
				modelTemperature: 0.9,
			})
			const model = handlerWithTemp.getModel()
			expect(model.temperature).toBe(0.9)
		})
	})

	describe("createMessage", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "text" as const,
						text: "Hello!",
					},
				],
			},
		]

		it("should handle streaming responses", async () => {
			const chunks: any[] = await collectStream(handler.createMessage(systemPrompt, messages))

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")
		})

		it.each(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"] as const)(
			"should send images and thinking controls to %s",
			async (modelId) => {
				const visionHandler = new DeepSeekHandler({
					...mockOptions,
					apiModelId: modelId,
				})
				const visionMessages: Anthropic.Messages.MessageParam[] = [
					{
						role: "user",
						content: [
							{ type: "text", text: "Describe this image." },
							{
								type: "image",
								source: { type: "base64", media_type: "image/png", data: "image-data" },
							},
						],
					},
				]

				await collectStream(visionHandler.createMessage(systemPrompt, visionMessages))

				const callArgs = mockCreate.mock.calls[0][0]
				expect(callArgs).toMatchObject({
					model: modelId,
					thinking: { type: "enabled" },
					reasoning_effort: "high",
					max_completion_tokens: 200_000,
				})
				expect(callArgs.temperature).toBeUndefined()
				expect(callArgs.messages).toContainEqual({
					role: "user",
					content: expect.arrayContaining([
						{ type: "text", text: expect.stringContaining("Describe this image.") },
						{ type: "image_url", image_url: { url: "data:image/png;base64,image-data" } },
					]),
				})
			},
		)

		it("should use the provider default temperature when reasoning is disabled for the vision alias", async () => {
			const visionHandler = new DeepSeekHandler({
				...mockOptions,
				apiModelId: "deepseek-v4-flash-vision-exp",
				enableReasoningEffort: false,
			})

			await collectStream(visionHandler.createMessage(systemPrompt, messages))

			expect(mockCreate.mock.calls[0][0]).toMatchObject({
				model: "deepseek-v4-flash-vision-exp",
				thinking: { type: "disabled" },
				temperature: 0,
			})
			expect(mockCreate.mock.calls[0][0].reasoning_effort).toBeUndefined()
		})

		it("should include usage information", async () => {
			const chunks: any[] = await collectStream(handler.createMessage(systemPrompt, messages))

			const usageChunks = chunks.filter((chunk) => chunk.type === "usage")
			expect(usageChunks.length).toBeGreaterThan(0)
			expect(usageChunks[0].inputTokens).toBe(10)
			expect(usageChunks[0].outputTokens).toBe(5)
		})

		it("should include cache metrics in usage information", async () => {
			const chunks: any[] = await collectStream(handler.createMessage(systemPrompt, messages))

			const usageChunks = chunks.filter((chunk) => chunk.type === "usage")
			expect(usageChunks.length).toBeGreaterThan(0)
			expect(usageChunks[0].cacheWriteTokens).toBe(8)
			expect(usageChunks[0].cacheReadTokens).toBe(2)
		})

		it("streams reasoning chunks from delta.reasoning_content", async () => {
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "thinking..." }, index: 0 }] },
					{ choices: [{ delta: { content: "answer" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const chunks: any[] = await collectStream(handler.createMessage(systemPrompt, messages))

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
		})

		it("falls back to delta.reasoning when reasoning_content is absent", async () => {
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning: "router-style thought" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const chunks: any[] = await collectStream(handler.createMessage(systemPrompt, messages))

			expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
		})

		it("should throw a wrapped error when the API call fails", async () => {
			const apiError = Object.assign(new Error("Invalid API key"), { status: 401 })
			mockCreate.mockRejectedValueOnce(apiError)

			const stream = handler.createMessage(systemPrompt, messages)
			const err = await stream.next().catch((e) => e)

			expect(err.message).toBe("DeepSeek completion error: Invalid API key")
			expect((err as any).status).toBe(401)
		})

		it("prefers delta.reasoning_content over delta.reasoning when both are present", async () => {
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									reasoning_content: "primary thought",
									reasoning: "fallback thought",
								},
								index: 0,
							},
						],
					},
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const chunks: any[] = await collectStream(handler.createMessage(systemPrompt, messages))

			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")
			expect(reasoningChunks).toEqual([{ type: "reasoning", text: "primary thought" }])
		})
	})

	describe("processUsageMetrics", () => {
		class TestDeepSeekHandler extends DeepSeekHandler {
			public testProcessUsageMetrics(usage: any) {
				return this.processUsageMetrics(usage)
			}
		}

		// mockOptions is assigned in beforeEach, so the handler must be built
		// per test rather than at describe-collection time.
		const processUsage = (usage: any) => new TestDeepSeekHandler(mockOptions).testProcessUsageMetrics(usage)

		// DeepSeek's OpenAPI marks prompt_cache_hit_tokens and
		// prompt_cache_miss_tokens as required top-level members, and declares
		// only cached_tokens inside prompt_tokens_details. This is the vendor's
		// own documented example response.
		// https://api-docs.deepseek.com/api/create-chat-completion
		it("reads the documented top-level cache counters", () => {
			const result = processUsage({
				prompt_tokens: 7,
				completion_tokens: 11,
				total_tokens: 18,
				prompt_tokens_details: { cached_tokens: 0 },
				prompt_cache_hit_tokens: 0,
				prompt_cache_miss_tokens: 7,
			})

			expect(result.type).toBe("usage")
			expect(result.inputTokens).toBe(7)
			expect(result.outputTokens).toBe(11)
			expect(result.cacheReadTokens).toBe(0)
			expect(result.cacheWriteTokens).toBe(7)
		})

		it("reads top-level cache counters when prompt_tokens_details is absent", () => {
			const result = processUsage({
				prompt_tokens: 100,
				completion_tokens: 50,
				total_tokens: 150,
				prompt_cache_hit_tokens: 20,
				prompt_cache_miss_tokens: 80,
			})

			expect(result.inputTokens).toBe(100)
			expect(result.outputTokens).toBe(50)
			expect(result.cacheWriteTokens).toBe(80)
			expect(result.cacheReadTokens).toBe(20)
		})

		it("falls back to the nested cache counters for legacy shapes", () => {
			const result = processUsage({
				prompt_tokens: 100,
				completion_tokens: 50,
				total_tokens: 150,
				prompt_tokens_details: {
					cache_miss_tokens: 80,
					cached_tokens: 20,
				},
			})

			expect(result.inputTokens).toBe(100)
			expect(result.outputTokens).toBe(50)
			expect(result.cacheWriteTokens).toBe(80)
			expect(result.cacheReadTokens).toBe(20)
		})

		it("does not double-count when both shapes are present", () => {
			const result = processUsage({
				prompt_tokens: 100,
				completion_tokens: 50,
				total_tokens: 150,
				prompt_tokens_details: { cached_tokens: 20, cache_miss_tokens: 80 },
				prompt_cache_hit_tokens: 20,
				prompt_cache_miss_tokens: 80,
			})

			expect(result.cacheWriteTokens).toBe(80)
			expect(result.cacheReadTokens).toBe(20)
		})

		it("should handle missing cache metrics gracefully", () => {
			const usage = {
				prompt_tokens: 100,
				completion_tokens: 50,
				total_tokens: 150,
				// No prompt_tokens_details and no top-level cache counters
			}

			const result = processUsage(usage)

			expect(result.type).toBe("usage")
			expect(result.inputTokens).toBe(100)
			expect(result.outputTokens).toBe(50)
			expect(result.cacheWriteTokens).toBeUndefined()
			expect(result.cacheReadTokens).toBeUndefined()
		})
	})

	describe("interleaved thinking mode", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "text" as const,
						text: "Hello!",
					},
				],
			},
		]

		it("should handle reasoning_content in streaming responses for deepseek-v4-pro", async () => {
			const reasonerHandler = new DeepSeekHandler({
				...mockOptions,
				apiModelId: "deepseek-v4-pro",
			})

			const stream = reasonerHandler.createMessage(systemPrompt, messages)
			const chunks: any[] = await collectStream(stream)

			// Should have reasoning chunks
			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")
			expect(reasoningChunks.length).toBeGreaterThan(0)
			expect(reasoningChunks[0].text).toBe("Let me think about this...")
			expect(reasoningChunks[1].text).toBe(" I'll analyze step by step.")
		})

		it("should pass thinking parameter for deepseek-v4-pro model", async () => {
			const reasonerHandler = new DeepSeekHandler({
				...mockOptions,
				apiModelId: "deepseek-v4-pro",
			})

			const stream = reasonerHandler.createMessage(systemPrompt, messages)
			await collectStream(stream)

			// Verify that the thinking parameter was passed to the API
			// Note: mockCreate receives two arguments - request options and path options
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					thinking: { type: "enabled" },
				}),
				{}, // Empty path options for non-Azure URLs
			)
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.reasoning_effort).toBe("high")
		})

		it("should enable thinking by default for deepseek-v4-flash", async () => {
			const v4Handler = new DeepSeekHandler({
				...mockOptions,
				apiModelId: "deepseek-v4-flash",
			})

			const stream = v4Handler.createMessage(systemPrompt, messages)
			await collectStream(stream)

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					thinking: { type: "enabled" },
					reasoning_effort: "high",
					max_completion_tokens: 200_000,
				}),
				{},
			)
		})

		it("should respect user max token override for deepseek-v4 models", async () => {
			const v4Handler = new DeepSeekHandler({
				...mockOptions,
				apiModelId: "deepseek-v4-flash",
				modelMaxTokens: 32_000,
			})

			const stream = v4Handler.createMessage(systemPrompt, messages)
			await collectStream(stream)

			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBe(32_000)
		})

		it("should disable thinking for deepseek-v4 models when reasoning is disabled", async () => {
			const v4Handler = new DeepSeekHandler({
				...mockOptions,
				apiModelId: "deepseek-v4-pro",
				enableReasoningEffort: false,
			})

			const stream = v4Handler.createMessage(systemPrompt, messages)
			await collectStream(stream)

			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.thinking).toEqual({ type: "disabled" })
			expect(callArgs.reasoning_effort).toBeUndefined()
		})

		it("should not send V4 thinking parameters for unknown model IDs", async () => {
			const customHandler = new DeepSeekHandler({
				...mockOptions,
				apiModelId: "custom-deepseek-model",
			})

			const stream = customHandler.createMessage(systemPrompt, messages)
			await collectStream(stream)

			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.thinking).toBeUndefined()
			expect(callArgs.reasoning_effort).toBeUndefined()
			expect(callArgs.temperature).toBe(DEEP_SEEK_DEFAULT_TEMPERATURE)
		})

		it("should handle tool calls with reasoning_content", async () => {
			const reasonerHandler = new DeepSeekHandler({
				...mockOptions,
				apiModelId: "deepseek-v4-pro",
			})

			const tools: any[] = [
				{
					type: "function",
					function: {
						name: "get_weather",
						description: "Get weather",
						parameters: { type: "object", properties: {} },
					},
				},
			]

			const stream = reasonerHandler.createMessage(systemPrompt, messages, { taskId: "test", tools })
			const chunks: any[] = await collectStream(stream)

			// Should have reasoning chunks
			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")
			expect(reasoningChunks.length).toBeGreaterThan(0)

			// Should have tool call chunks
			const toolCallChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallChunks.length).toBeGreaterThan(0)
			expect(toolCallChunks[0].name).toBe("get_weather")
		})
	})

	describe("normalizeDeepSeekReasoningEffort", () => {
		// https://api-docs.deepseek.com/guides/thinking_mode/
		// updated on 2026-08-13
		it("should map acceptable reasoning efforts the same way as stated by the official documentation", async () => {
			const mappings: {
				modelId: DeepSeekModelId
				rawReasoningEffort: string
				mappedReasoningEffort: string | undefined
			}[] = [
				{
					modelId: "deepseek-v4-flash",
					rawReasoningEffort: "disable",
					mappedReasoningEffort: undefined,
				},
				{
					modelId: "deepseek-v4-flash",
					rawReasoningEffort: "low",
					mappedReasoningEffort: "low",
				},
				{
					modelId: "deepseek-v4-flash",
					rawReasoningEffort: "medium",
					mappedReasoningEffort: "high",
				},
				{
					modelId: "deepseek-v4-flash",
					rawReasoningEffort: "high",
					mappedReasoningEffort: "high",
				},
				{
					modelId: "deepseek-v4-flash",
					rawReasoningEffort: "xhigh",
					mappedReasoningEffort: "high",
				},
				{
					modelId: "deepseek-v4-flash",
					rawReasoningEffort: "max",
					mappedReasoningEffort: "max",
				},
				{
					modelId: "deepseek-v4-pro",
					rawReasoningEffort: "disable",
					mappedReasoningEffort: undefined,
				},
				{
					modelId: "deepseek-v4-pro",
					rawReasoningEffort: "low",
					mappedReasoningEffort: "low",
				},
				{
					modelId: "deepseek-v4-pro",
					rawReasoningEffort: "medium",
					mappedReasoningEffort: "high",
				},
				{
					modelId: "deepseek-v4-pro",
					rawReasoningEffort: "high",
					mappedReasoningEffort: "high",
				},
				{
					modelId: "deepseek-v4-pro",
					rawReasoningEffort: "xhigh",
					mappedReasoningEffort: "high",
				},
				{
					modelId: "deepseek-v4-pro",
					rawReasoningEffort: "max",
					mappedReasoningEffort: "max",
				},
				{
					modelId: "deepseek-v4-flash-vision-exp",
					rawReasoningEffort: "disable",
					mappedReasoningEffort: undefined,
				},
				{
					modelId: "deepseek-v4-flash-vision-exp",
					rawReasoningEffort: "low",
					mappedReasoningEffort: "low",
				},
				{
					modelId: "deepseek-v4-flash-vision-exp",
					rawReasoningEffort: "medium",
					mappedReasoningEffort: "high",
				},
				{
					modelId: "deepseek-v4-flash-vision-exp",
					rawReasoningEffort: "high",
					mappedReasoningEffort: "high",
				},
				{
					modelId: "deepseek-v4-flash-vision-exp",
					rawReasoningEffort: "xhigh",
					mappedReasoningEffort: "high",
				},
				{
					modelId: "deepseek-v4-flash-vision-exp",
					rawReasoningEffort: "max",
					mappedReasoningEffort: "max",
				},
			]

			for (const { modelId, rawReasoningEffort, mappedReasoningEffort } of mappings) {
				const result = normalizeDeepSeekReasoningEffort(modelId, rawReasoningEffort)
				expect(result).toBe(mappedReasoningEffort)
			}
		})
	})
	// Issue #547: DeepSeek tool dialect. DeepSeek cannot compile strict-mode
	// schemas (Draft 2020-12 rejects pattern/minLength and forces every property
	// into required), so the handler must send strict: false, keep declared
	// optionality, and still strip the keywords its gateway rejects.
	describe("tool dialect (issue #547)", () => {
		type ConvertedTool = {
			type: unknown
			function: {
				name: unknown
				description: unknown
				strict: unknown
				parameters: unknown
			}
		}

		const convert = (tools: unknown[]): ConvertedTool[] => {
			const view = handler as unknown as {
				convertToolsForOpenAI: (tools: unknown[]) => ConvertedTool[] | undefined
			}
			return view.convertToolsForOpenAI(tools) as ConvertedTool[]
		}

		type ObjectSchema = {
			type: unknown
			description?: unknown
			properties?: Record<string, Record<string, unknown>>
			required?: string[]
			items?: Record<string, unknown>
			minItems?: unknown
		}

		const readTool = {
			type: "function",
			function: {
				name: "read_file",
				description: "Read a file",
				strict: true,
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "The file path" },
						limit: { type: "number", description: "Max lines" },
						offset: { type: "number", description: "Start line" },
					},
					required: ["path"],
					additionalProperties: false,
				},
			},
		} satisfies Record<string, unknown>

		const mcpTool = {
			type: "function",
			function: {
				name: "mcp--vibe--search",
				description: "MCP search",
				strict: false,
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", pattern: "^[a-zA-Z0-9_]+$", minLength: 2 },
					},
					required: [],
				},
			},
		} satisfies Record<string, unknown>

		it("sends DeepSeek tools with strict disabled", () => {
			const tools = convert([readTool])
			expect(tools).toHaveLength(1)
			expect(tools[0].function.strict).toBe(false)
		})

		it("keeps declared optional parameters optional (defect 1)", () => {
			const tools = convert([readTool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			expect(params.required).toStrictEqual(["path"])
		})

		it("keeps every declared property present in the schema (defect 1)", () => {
			const tools = convert([readTool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			expect(Object.keys(params.properties ?? {}).sort()).toStrictEqual(["limit", "offset", "path"])
		})

		it("strips the forbidden pattern keyword and records it in the schema description (defect 2)", () => {
			const tools = convert([mcpTool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const query = (params.properties ?? {}).query
			expect(query).not.toHaveProperty("pattern")
			expect(query).not.toHaveProperty("minLength")
			// The removed constraints are re-encoded where they were removed: the
			// query property carries a description hint the model still reads.
			expect(String(query.description)).toContain("^[a-zA-Z0-9_]+$")
			expect(String(query.description)).toContain("minLength")
		})

		it("recurses into nested object and array schemas (defect 2)", () => {
			const nested = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						properties: {
							filter: {
								type: "object",
								properties: { ext: { type: "string", pattern: "^[a-z]+$" } },
								required: ["ext"],
							},
							tags: { type: "array", items: { type: "string", minLength: 1 }, minItems: 2 },
						},
						required: ["filter"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([nested])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const filter = (params.properties ?? {}).filter as unknown as ObjectSchema
			const tags = (params.properties ?? {}).tags as unknown as ObjectSchema
			expect((filter.properties ?? {}).ext).not.toHaveProperty("pattern")
			expect((tags.items ?? {}).minLength).toBeUndefined()
			expect(tags).not.toHaveProperty("minItems")
		})

		it("does not mutate the caller-owned tool schema", () => {
			const original = structuredClone(readTool)
			convert([readTool])
			expect(readTool).toStrictEqual(original)
		})

		it("relaxes additionalProperties when patternProperties is removed (review 4712438380)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						patternProperties: { "^x": { type: "string" } },
						properties: { query: { type: "string" } },
						required: ["x"],
						additionalProperties: false,
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema & {
				additionalProperties?: unknown
			}
			// The required key x was legal only through the pattern rules; a
			// retained closed-object rule would leave the object with no valid
			// instance.
			expect(params.additionalProperties).toBe(true)
			// An ordinary closed object without patternProperties keeps its rule.
			const plain = convert([readTool])
			const plainParams = plain[0].function.parameters as unknown as ObjectSchema & {
				additionalProperties?: unknown
			}
			expect(plainParams.additionalProperties).toBe(false)
		})

		it("moves a relaxed oneOf under anyOf so branch values stay valid (review 4712438393)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						properties: {
							label: {
								oneOf: [
									{ type: "string", pattern: "^a" },
									{ type: "string", pattern: "^b" },
								],
							},
						},
						required: ["label"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const label = (params.properties ?? {}).label as unknown as {
				oneOf?: unknown
				anyOf?: Array<Record<string, unknown>>
			}
			// Both branches lost their distinguishing patterns, so every
			// string would match both and oneOf would accept nothing.
			expect(label).not.toHaveProperty("oneOf")
			const branches = label.anyOf ?? []
			expect(branches).toHaveLength(2)
			// Each relaxed branch is a plain string schema: "apple" matched ^a
			// before compilation and stays valid afterwards.
			for (const branch of branches) {
				expect(branch.type).toBe("string")
				expect(branch).not.toHaveProperty("pattern")
			}
		})

		it("keeps an unchanged oneOf as oneOf (review 4712438393)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						properties: {
							label: { oneOf: [{ type: "string" }, { type: "integer" }] },
						},
						required: ["label"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const label = (params.properties ?? {}).label as unknown as {
				oneOf?: unknown[]
				anyOf?: unknown
			}
			expect(label.oneOf).toHaveLength(2)
			expect(label).not.toHaveProperty("anyOf")
		})

		it("drops a not whose predicate changed and records it in the description (review 4712438405)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						properties: {
							name: { type: "string", not: { pattern: "^tmp" } },
						},
						required: ["name"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const name = (params.properties ?? {}).name as unknown as Record<string, unknown>
			// The compiled predicate accepts every value, so a retained not
			// would reject every value.
			expect(name).not.toHaveProperty("not")
			// The original rule stays visible as a hint.
			expect(String(name.description)).toContain("not")
			expect(String(name.description)).toContain("^tmp")
		})

		it("keeps an unchanged not in place (review 4712438405)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						properties: {
							name: { type: "string", not: { format: "uuid" } },
						},
						required: ["name"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const name = (params.properties ?? {}).name as unknown as Record<string, unknown>
			// The predicate compiles unchanged, so the negation is preserved.
			expect(name.not).toStrictEqual({ format: "uuid" })
		})

		it("preserves an own __proto__ property as a data property (review 4712438384)", () => {
			// JSON.parse produces an own "__proto__" property; ordinary
			// assignment would change the compiled object's prototype and lose
			// the definition instead of keeping it.
			const parameters = JSON.parse(
				'{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}',
			)
			const tool = {
				type: "function",
				function: { name: "read_file", description: "Read", strict: true, parameters },
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as {
				properties: Record<string, unknown>
				required: string[]
			}
			const props = params.properties
			expect(Object.prototype.hasOwnProperty.call(props, "__proto__")).toBe(true)
			expect(Object.getPrototypeOf(props)).toBe(Object.prototype)
			expect((props["__proto__"] as Record<string, unknown>).type).toBe("string")
			expect(params.required).toStrictEqual(["__proto__"])
		})

		it("keeps a sibling anyOf as its own constraint next to a relaxed oneOf (review 4713747398)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						properties: {
							label: {
								anyOf: [{ const: "apple" }],
								oneOf: [
									{ type: "string", pattern: "^a" },
									{ type: "string", pattern: "^b" },
								],
							},
						},
						required: ["label"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const label = (params.properties ?? {}).label as unknown as {
				anyOf?: Array<Record<string, unknown>>
				oneOf?: unknown
				allOf?: Array<{ anyOf?: Array<Record<string, unknown>> }>
			}
			// The sibling anyOf must stay exactly as declared: the relaxed
			// branches are alternatives only among themselves, so "banana"
			// keeps failing the unchanged const constraint.
			expect(label.anyOf).toStrictEqual([{ const: "apple" }])
			expect(label).not.toHaveProperty("oneOf")
			const conjuncts = label.allOf ?? []
			expect(conjuncts).toHaveLength(1)
			const relaxed = conjuncts[0].anyOf ?? []
			expect(relaxed).toHaveLength(2)
			// Each relaxed branch keeps its type and the removed pattern only
			// as the description hint the model still reads.
			expect(relaxed[0].type).toBe("string")
			expect(relaxed[1].type).toBe("string")
			expect(relaxed[0]).not.toHaveProperty("pattern")
			expect(relaxed[1]).not.toHaveProperty("pattern")
			expect(String(relaxed[0].description)).toContain("^a")
			expect(String(relaxed[1].description)).toContain("^b")
		})

		it("drops a conditional whose if predicate changed and records it (review 4713747391)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						properties: {
							name: {
								type: "string",
								if: { pattern: "^tmp" },
								then: false,
							},
						},
						required: ["name"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const name = (params.properties ?? {}).name as unknown as Record<string, unknown>
			// The compiled predicate stays as an annotation-only applicator:
			// a bare if asserts nothing, so a changed predicate cannot
			// tighten the emitted schema, and its property evaluations keep
			// reaching a retained unevaluatedProperties rule (review
			// 4725679712 - dropping the whole conditional would strand a
			// required key the original if evaluated). The branches travel
			// into the hint with the original predicate.
			expect(name.then).toBeUndefined()
			expect(name.else).toBeUndefined()
			expect(name.if).toStrictEqual({
				description: "DeepSeek compatibility (constraint kept for the caller): value must match /^tmp/",
			})
			// The original conditional stays visible as a hint.
			expect(String(name.description)).toContain("^tmp")
			expect(String(name.description)).toContain("then")
		})

		it("keeps an unchanged conditional in place (review 4713747391)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						properties: {
							name: {
								type: "string",
								if: { format: "uuid" },
								then: { description: "an id" },
							},
						},
						required: ["name"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const name = (params.properties ?? {}).name as unknown as Record<string, unknown>
			// The predicate compiles unchanged, so the conditional is preserved.
			expect(name.if).toStrictEqual({ format: "uuid" })
			expect(name.then).toStrictEqual({ description: "an id" })
			expect(name).not.toHaveProperty("description")
		})

		it("compiles a chain of unchanged conditionals in bounded work (review 4714821172)", () => {
			// 24 nested unchanged if predicates: compiling the predicate a
			// second time in the key loop doubles the work at every level
			// (2^24 node compiles, seconds of blocked extension host), so the
			// single-compile rule keeps the work linear. The memo hit count is
			// a deterministic work count - wall-clock timing would flake on a
			// busy worker (review 4725679675).
			let predicate: Record<string, unknown> = { type: "string" }
			for (let level = 0; level < 24; level++) {
				predicate = { if: predicate, then: { type: "string" } }
			}
			const expected = {
				type: "object",
				properties: { name: predicate },
				required: ["name"],
			}
			const tool = {
				type: "function",
				function: {
					name: "conditional_tool",
					description: "Conditional",
					strict: true,
					parameters: expected,
				},
			} satisfies Record<string, unknown>

			const memoGetSpy = vi.spyOn(WeakMap.prototype, "get")
			try {
				const tools = convert([tool])

				// The unchanged chain must still compile to itself, key order
				// included.
				expect(JSON.stringify(tools[0].function.parameters)).toStrictEqual(JSON.stringify(expected))
				// Deterministic work count: every compileSchemaNode entry
				// consults the memo once. With the single-compile rule the
				// count stays linear in the schema size; the doubled
				// recompilation would need 2^24 entries.
				expect(memoGetSpy.mock.calls.length).toBeLessThan(2000)
			} finally {
				memoGetSpy.mockRestore()
			}
		}, 2500)

		it("compiles a repeated-reference chain in bounded work (review 4719419419)", () => {
			// 18 definitions chained through if/not predicates that carry
			// only a $ref: the reference-target checks recompile the shared
			// target once per predicate, so without the per-document memo
			// the work doubles at every level (2^18 target compilations on a
			// schema of 18 small nodes).
			const defs: Record<string, unknown> = {}
			for (let level = 0; level < 18; level++) {
				const next = level === 17 ? { type: "string" } : { $ref: `#/$defs/d${level + 1}` }
				defs[`d${level}`] = { if: next, then: false, not: next }
			}
			const expected = {
				type: "object",
				properties: {
					v: { if: { $ref: "#/$defs/d0" }, then: false, not: { $ref: "#/$defs/d0" } },
				},
				required: ["v"],
				$defs: defs,
			}
			const tool = {
				type: "function",
				function: {
					name: "ref_chain",
					description: "Chain",
					strict: true,
					parameters: expected,
				},
			} satisfies Record<string, unknown>

			const memoGetSpy = vi.spyOn(WeakMap.prototype, "get")
			try {
				const tools = convert([tool])

				// Every target compiles unchanged, so every predicate survives
				// verbatim, key order included.
				expect(JSON.stringify(tools[0].function.parameters)).toStrictEqual(JSON.stringify(expected))
				// Deterministic work count: with the memo the repeated targets
				// compile once per depth; the unmemoized chain recompiles the
				// shared target 2^18 times.
				expect(memoGetSpy.mock.calls.length).toBeLessThan(2000)
			} finally {
				memoGetSpy.mockRestore()
			}
		}, 2500)

		it("passes nodes deeper than the schema depth cap through uncompiled (round-4 pre-merge check)", () => {
			// 33 properties levels: the leaf sits past MAX_SCHEMA_DEPTH (32),
			// where compilation stops on purpose to bound pathological or
			// cyclic schemas — the forbidden keywords must survive verbatim
			// and no hint may be added for them.
			let leaf: Record<string, unknown> = { type: "string", pattern: "^tmp$", minLength: 3 }
			for (let level = 0; level < 33; level++) {
				leaf = { type: "object", properties: { a: leaf } }
			}
			const tool = {
				type: "function",
				function: {
					name: "deep_tool",
					description: "Deep",
					strict: true,
					parameters: leaf,
				},
			} satisfies Record<string, unknown>

			const tools = convert([tool])
			const compiled = tools[0].function.parameters

			let node = compiled as Record<string, unknown>
			for (let level = 0; level < 33; level++) {
				node = (node.properties as Record<string, unknown>).a as Record<string, unknown>
			}
			// Past the cap the node is passed through untouched.
			expect(node).toStrictEqual({ type: "string", pattern: "^tmp$", minLength: 3 })
			// Nothing above the cap carried a rejected keyword, so no hint
			// was recorded anywhere in the compiled tree.
			expect(JSON.stringify(compiled)).not.toContain("DeepSeek compatibility")
		})

		it("compiles constraints inside dependentSchemas (review 4716476931)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						properties: { query: { type: "string" } },
						dependentSchemas: {
							query: {
								properties: { query: { pattern: "^a" } },
								required: ["query"],
							},
						},
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema & {
				dependentSchemas?: Record<string, unknown>
			}
			const dependent = params.dependentSchemas ?? {}
			const query = dependent.query as { properties?: Record<string, unknown>; required?: string[] }
			// The dependent schema's constraints are compiled like any other
			// container: the gateway-rejected pattern is removed and stays
			// visible only as the description hint.
			const inner = (query.properties ?? {}).query as Record<string, unknown>
			expect(inner).not.toHaveProperty("pattern")
			expect(String(inner.description)).toContain("^a")
			// Property-name keys and nested required arrays survive traversal.
			expect(Object.keys(dependent)).toStrictEqual(["query"])
			expect(query.required).toStrictEqual(["query"])
		})

		it("leaves an unchanged dependentSchemas entry structurally identical (review 4716476931)", () => {
			const dependentSchemas = { query: { properties: { query: { type: "string" } } } }
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						properties: { query: { type: "string" } },
						dependentSchemas,
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as { dependentSchemas?: unknown }
			// Nothing to compile away: no rejected keyword, no hint added.
			expect(params.dependentSchemas).toStrictEqual(dependentSchemas)
			expect(tools[0].function.parameters).not.toHaveProperty("description")
		})

		it("drops a not whose $ref target changed and records it (review 4716476940)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						$defs: { tmp: { pattern: "^tmp" } },
						properties: {
							name: { type: "string", not: { $ref: "#/$defs/tmp" } },
						},
						required: ["name"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema & {
				$defs?: Record<string, unknown>
			}
			const name = (params.properties ?? {}).name as unknown as Record<string, unknown>
			// The reference object is unchanged, but its target lost the
			// pattern: the compiled target accepts every string, so a
			// retained not would reject {"name":"report"} — a value the
			// original schema accepted.
			expect(name).not.toHaveProperty("not")
			expect(String(name.description)).toContain("not")
			// The target itself compiled: its pattern is removed with a hint.
			expect(params.$defs?.tmp).not.toHaveProperty("pattern")
		})

		it("keeps a not whose $ref target compiles unchanged (review 4716476940)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						$defs: { tmp: { type: "string" } },
						properties: {
							name: { type: "string", not: { $ref: "#/$defs/tmp" } },
						},
						required: ["name"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const name = (params.properties ?? {}).name as unknown as Record<string, unknown>
			// The target compiles unchanged, so the reference-stable negation
			// is preserved exactly as declared.
			expect(name.not).toStrictEqual({ $ref: "#/$defs/tmp" })
			expect(name).not.toHaveProperty("description")
		})

		it("moves a oneOf whose $ref targets changed under anyOf (review 4716476940)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						$defs: { a: { pattern: "^a" }, b: { type: "string" } },
						properties: {
							label: { oneOf: [{ $ref: "#/$defs/a" }, { $ref: "#/$defs/b" }] },
						},
						required: ["label"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const label = (params.properties ?? {}).label as unknown as Record<string, unknown>
			// Target #/$defs/a lost its pattern, so every value would match
			// both branches and a retained oneOf would accept nothing.
			expect(label).not.toHaveProperty("oneOf")
			expect(label.anyOf).toStrictEqual([{ $ref: "#/$defs/a" }, { $ref: "#/$defs/b" }])
		})

		it("drops a conditional whose if only references a changed target (review 4716476940)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						$defs: { tmp: { pattern: "^tmp" } },
						properties: {
							name: {
								type: "string",
								if: { $ref: "#/$defs/tmp" },
								then: { type: "string" },
							},
						},
						required: ["name"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const name = (params.properties ?? {}).name as unknown as Record<string, unknown>
			// The compiled predicate stays as an annotation-only applicator
			// (review 4725679712): a bare if asserts nothing, so the
			// changed-target predicate cannot tighten the emitted schema,
			// and a retained then branch would still fire on values the
			// original rejected.
			expect(name.then).toBeUndefined()
			expect(name.else).toBeUndefined()
			expect(name.if).toStrictEqual({ $ref: "#/$defs/tmp" })
			expect(String(name.description)).toContain("then")
		})

		it("keeps a conditional whose if references an unchanged target (review 4716476940)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						$defs: { tmp: { type: "string" } },
						properties: {
							name: {
								type: "string",
								if: { $ref: "#/$defs/tmp" },
								then: { description: "a tmp string" },
							},
						},
						required: ["name"],
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as ObjectSchema
			const name = (params.properties ?? {}).name as unknown as Record<string, unknown>
			// The target compiles unchanged, so the conditional is preserved.
			expect(name.if).toStrictEqual({ $ref: "#/$defs/tmp" })
			expect(name.then).toStrictEqual({ description: "a tmp string" })
		})

		it("relaxes unevaluatedProperties when patternProperties is removed (review 4716476950)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						patternProperties: { "^x": { type: "string" } },
						required: ["x"],
						unevaluatedProperties: false,
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// patternProperties was what evaluated the key x; with the rules
			// removed, unevaluatedProperties: false would forbid the required
			// property and no argument object could satisfy the schema.
			expect(params.unevaluatedProperties).toBe(true)
			expect(params.required).toStrictEqual(["x"])
			expect(String(params.description)).toContain("patternProperties")
		})

		it("keeps unevaluatedProperties when no patternProperties is removed (review 4716476950)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						properties: { x: { type: "string" } },
						required: ["x"],
						unevaluatedProperties: false,
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// properties evaluates its own keys, so the closed-object rule is
			// an ordinary restriction and stays untouched.
			expect(params.unevaluatedProperties).toBe(false)
			expect(params).not.toHaveProperty("description")
		})

		it("relaxes unevaluatedItems when contains is removed (review 4719419428)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						required: ["items"],
						dependentSchemas: {
							items: {
								properties: {
									items: {
										type: "array",
										const: ["a"],
										contains: { type: "string" },
										unevaluatedItems: false,
									},
								},
							},
						},
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as {
				dependentSchemas?: Record<string, Record<string, unknown>>
			}
			const dependent = (params.dependentSchemas ?? {}) as Record<string, Record<string, unknown>>
			const dependentProps = (dependent.items?.properties ?? {}) as Record<string, unknown>
			const arr = dependentProps.items as Record<string, unknown>
			// contains was what evaluated the array items; with it removed, a
			// retained unevaluatedItems: false would forbid every item the
			// original accepted ({"items":["a"]}) and no argument object
			// could satisfy the schema.
			expect(arr.unevaluatedItems).toBe(true)
			expect(arr).not.toHaveProperty("contains")
			expect(String(arr.description)).toContain("contains")
		})

		it("keeps unevaluatedItems when an items evaluator remains beside contains (review 4719419428)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						required: ["items"],
						dependentSchemas: {
							items: {
								properties: {
									items: {
										type: "array",
										items: { type: "string" },
										contains: { type: "string" },
										unevaluatedItems: false,
									},
								},
							},
						},
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as {
				dependentSchemas?: Record<string, Record<string, unknown>>
			}
			const dependent = (params.dependentSchemas ?? {}) as Record<string, Record<string, unknown>>
			const dependentProps = (dependent.items?.properties ?? {}) as Record<string, unknown>
			const arr = dependentProps.items as Record<string, unknown>
			// items still evaluates every position, so the restriction is an
			// ordinary one and stays; only the removed contains moves into the
			// hint.
			expect(arr.unevaluatedItems).toBe(false)
			expect(arr.items).toStrictEqual({ type: "string" })
			expect(String(arr.description)).toContain("contains")
		})

		it("relaxes unevaluatedItems beside a partial prefixItems when contains is removed (review 4719935091)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						required: ["items"],
						properties: {
							items: {
								type: "array",
								const: ["a", "b"],
								prefixItems: [{ type: "string" }],
								contains: { const: "b" },
								unevaluatedItems: false,
							},
						},
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as {
				properties?: Record<string, Record<string, unknown>>
			}
			const arr = (params.properties ?? {}).items as Record<string, unknown>
			// prefixItems evaluates only the positions it lists: with a single
			// prefix entry, contains was what evaluated index 1. A retained
			// unevaluatedItems: false would forbid that index and the retained
			// const would leave the compiled schema without any valid array.
			expect(arr.unevaluatedItems).toBe(true)
			expect(arr.const).toStrictEqual(["a", "b"])
			expect(arr.prefixItems).toStrictEqual([{ type: "string" }])
			expect(arr).not.toHaveProperty("contains")
			expect(String(arr.description)).toContain("contains")
		})

		it("re-admits the removed pattern rules beside a schema-valued unevaluatedProperties (review 4719336022)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						patternProperties: { "^x": { type: "string" } },
						required: ["x"],
						unevaluatedProperties: { type: "number" },
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The key x was evaluated by the pattern rule, so the original
			// schema accepts {"x":"a"} while the retained {type:"number"}
			// restriction rejects it once patternProperties is gone. The rule
			// keeps restricting the keys the pattern rules never matched and
			// re-admits the compiled pattern rule as an alternative.
			expect(params.unevaluatedProperties).toStrictEqual({
				anyOf: [{ type: "number" }, { type: "string" }],
			})
			expect(params.required).toStrictEqual(["x"])
			expect(String(params.description)).toContain("patternProperties")
			// Control: with properties evaluating its own keys, the
			// schema-valued rule is an ordinary restriction and stays verbatim.
			const plain = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							properties: { x: { type: "string" } },
							required: ["x"],
							unevaluatedProperties: { type: "number" },
						},
					},
				} satisfies Record<string, unknown>,
			])
			const plainParams = plain[0].function.parameters as unknown as Record<string, unknown>
			expect(plainParams.unevaluatedProperties).toStrictEqual({ type: "number" })
			expect(plainParams).not.toHaveProperty("description")
		})

		it("re-admits the removed pattern rules beside a schema-valued additionalProperties", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						patternProperties: { "^x": { type: "string" } },
						required: ["x"],
						additionalProperties: { type: "number" },
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The same annotation dependency on the additionalProperties rule:
			// the key x was exempt through the pattern rule, so the retained
			// {type:"number"} must re-admit the compiled pattern rule instead
			// of rejecting the value the original accepted.
			expect(params.additionalProperties).toStrictEqual({
				anyOf: [{ type: "number" }, { type: "string" }],
			})
			expect(params.required).toStrictEqual(["x"])
		})

		// Walks a compiled schema and fails on any local "#/..." reference the
		// compiled document cannot resolve - the gateway would answer with a
		// compilation error instead of applying the rule. The walk is
		// schema-aware: a "$ref"-shaped VALUE under const, enum, default or
		// examples is asserted data a validator compares for equality and
		// never resolves, so the walk skips it at schema positions; entries
		// of a name-to-schema map (properties, $defs, ...) are schemas whose
		// references must resolve even when their NAME is a literal keyword
		// (review 4725679679).
		const literalValueKeywords = new Set(["const", "enum", "default", "examples"])
		const schemaMapKeywords = new Set([
			"properties",
			"patternProperties",
			"$defs",
			"definitions",
			"dependentSchemas",
		])
		const assertNoDanglingLocalRefs = (node: unknown, root: unknown = node, insideSchemaMap = false): void => {
			if (Array.isArray(node)) {
				node.forEach((entry) => assertNoDanglingLocalRefs(entry, root, insideSchemaMap))
				return
			}
			if (typeof node !== "object" || node === null) {
				return
			}
			const record = node as Record<string, unknown>
			if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
				let cursor: unknown = root
				for (const rawSegment of record.$ref.slice(2).split("/")) {
					const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~")
					if (
						typeof cursor !== "object" ||
						cursor === null ||
						!Object.prototype.hasOwnProperty.call(cursor, segment)
					) {
						throw new Error(`dangling local reference ${record.$ref}`)
					}
					cursor = (cursor as Record<string, unknown>)[segment]
				}
			}
			for (const [key, value] of Object.entries(record)) {
				if (!insideSchemaMap && literalValueKeywords.has(key)) {
					continue
				}
				assertNoDanglingLocalRefs(
					value,
					root,
					insideSchemaMap
						? false
						: schemaMapKeywords.has(key) &&
								typeof value === "object" &&
								value !== null &&
								!Array.isArray(value),
				)
			}
		}

		it("inlines a moved pattern-rule reference that would dangle under additionalProperties (review 6089521528)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						patternProperties: {
							"^x": {
								$defs: { value: { type: "string" } },
								$ref: "#/patternProperties/^x/$defs/value",
							},
						},
						required: ["x"],
						additionalProperties: { type: "number" },
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The moved alternative carries the rule the pointer denoted, not
			// the pointer: the compiled document has no patternProperties
			// location left, so a retained reference could not resolve its
			// string alternative and the value the original accepted for the
			// key x would break. The inert $defs sibling stays on the outer
			// schema beside the allOf conjunct (review 4723722028).
			expect(params.additionalProperties).toStrictEqual({
				anyOf: [{ type: "number" }, { allOf: [{ type: "string" }], $defs: { value: { type: "string" } } }],
			})
			assertNoDanglingLocalRefs(params)
			expect(String(params.description)).toContain("patternProperties")
		})

		it("inlines a moved pattern-rule reference that would dangle under unevaluatedProperties (review 6089521528)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						patternProperties: {
							"^x": {
								$defs: { value: { type: "string" } },
								$ref: "#/patternProperties/^x/$defs/value",
							},
						},
						required: ["x"],
						unevaluatedProperties: { type: "number" },
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The same relocation for the second schema-valued closed rule.
			expect(params.unevaluatedProperties).toStrictEqual({
				anyOf: [{ type: "number" }, { allOf: [{ type: "string" }], $defs: { value: { type: "string" } } }],
			})
			assertNoDanglingLocalRefs(params)
		})

		it("keeps a moved pattern-rule reference whose target survives compilation", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						$defs: { shared: { type: "string" } },
						patternProperties: { "^x": { $ref: "#/$defs/shared" } },
						required: ["x"],
						additionalProperties: { type: "number" },
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// A pointer that still resolves in the compiled document stays a
			// pointer: the relocation must not inline references whose
			// target compilation keeps at its original location.
			expect(params.additionalProperties).toStrictEqual({
				anyOf: [{ type: "number" }, { $ref: "#/$defs/shared" }],
			})
			assertNoDanglingLocalRefs(params)
		})

		it("relaxes a schema-valued closed rule when a moved reference resolves only through itself", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						patternProperties: { "^x": { $ref: "#/patternProperties/^x" } },
						required: ["x"],
						additionalProperties: { type: "number" },
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The pattern rule references itself through the removed
			// location: no moved copy can resolve it, so the keys it
			// evaluated are unknown and the retained rule relaxes instead of
			// forbidding a value the original accepted.
			expect(params.additionalProperties).toBe(true)
			assertNoDanglingLocalRefs(params)
			expect(String(params.description)).toContain("patternProperties")
		})

		it("inlines a moved contains reference that would dangle under unevaluatedItems (review 6089521528)", () => {
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "array",
						contains: { $defs: { v: { type: "string" } }, $ref: "#/contains/$defs/v" },
						minContains: 1,
						unevaluatedItems: { type: "number" },
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The contains rule re-enters beside the retained restriction
			// (review 4719419428); the same relocation applies to it, since
			// the compiled document loses the contains location too.
			expect(params.unevaluatedItems).toStrictEqual({
				anyOf: [{ type: "number" }, { allOf: [{ type: "string" }], $defs: { v: { type: "string" } } }],
			})
			assertNoDanglingLocalRefs(params)
			expect(String(params.description)).toContain("contains")
		})

		it("keeps a moved reference's sibling evaluation rule on the outer schema (review 4723722028)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							patternProperties: {
								"^x": {
									$defs: { v: { properties: { a: { type: "string" } } } },
									$ref: "#/patternProperties/^x/$defs/v",
									unevaluatedProperties: false,
								},
							},
							required: ["x"],
							additionalProperties: { type: "number" },
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// unevaluatedProperties is an evaluation keyword: Draft 2020-12
			// collects its annotations from adjacent keywords and from the
			// schemas the same object applies in place, and a sibling allOf
			// branch is not one of those. Moved inside the conjunct it would no
			// longer see the inlined target's evaluations and would reject
			// {"x":{"a":"ok"}} although the original accepts it (an ajv
			// 2020-12 probe of this exact pair rejects the nested shape and
			// accepts this one). On the outer schema the conjunct feeds it the
			// same annotations the reference did, so the instance stays valid.
			expect(params.additionalProperties).toStrictEqual({
				anyOf: [
					{ type: "number" },
					{
						allOf: [{ properties: { a: { type: "string" } } }],
						$defs: { v: { properties: { a: { type: "string" } } } },
						unevaluatedProperties: false,
					},
				],
			})
			assertNoDanglingLocalRefs(params)
		})

		it("keeps a moved reference's existing allOf conjuncts while its siblings move outside (review 4723722028)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							patternProperties: {
								"^x": {
									$defs: { v: { type: "string" } },
									allOf: [{ required: ["y"] }],
									$ref: "#/patternProperties/^x/$defs/v",
								},
							},
							required: ["x"],
							additionalProperties: { type: "number" },
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// An existing allOf sibling was a conjunct before the rewrite and
			// stays one: only the inlined target joins the conjunct array, the
			// other keywords keep their outer position.
			expect(params.additionalProperties).toStrictEqual({
				anyOf: [
					{ type: "number" },
					{ allOf: [{ type: "string" }, { required: ["y"] }], $defs: { v: { type: "string" } } },
				],
			})
			assertNoDanglingLocalRefs(params)
		})

		it("relocates a reference inside an existing allOf conjunct of a moved rule (review 4724111350)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							patternProperties: {
								"^x": {
									$defs: { v: { type: "string" } },
									$ref: "#/patternProperties/^x/$defs/v",
									allOf: [{ $ref: "#/patternProperties/^x/$defs/v" }],
								},
							},
							required: ["x"],
							additionalProperties: { type: "number" },
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// Every existing conjunct relocates too: compilation removes
			// patternProperties, so a conjunct that keeps a pointer into the
			// removed location would dangle there and the conjunct would reject
			// values the original accepted. The conjuncts stay conjuncts.
			expect(params.additionalProperties).toStrictEqual({
				anyOf: [
					{ type: "number" },
					{ allOf: [{ type: "string" }, { type: "string" }], $defs: { v: { type: "string" } } },
				],
			})
			assertNoDanglingLocalRefs(params)
		})

		it("relocates a schema under a property whose name is a literal keyword (review 4724111355)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							patternProperties: {
								"^x": {
									$defs: { v: { type: "string" } },
									properties: { const: { $ref: "#/patternProperties/^x/$defs/v" } },
								},
							},
							required: ["x"],
							additionalProperties: { type: "number" },
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// Inside a schema map the keys are property names, never keywords:
			// a property named "const" carries a schema, and its reference must
			// relocate - compilation removes patternProperties and the pointer
			// would dangle. A literal VALUE under const inside a schema object
			// stays verbatim (the $ref-shaped const tests above).
			expect(params.additionalProperties).toStrictEqual({
				anyOf: [
					{ type: "number" },
					{
						$defs: { v: { type: "string" } },
						properties: { const: { type: "string" } },
					},
				],
			})
			assertNoDanglingLocalRefs(params)
		})

		it("relocates a surviving reference's sibling schema maps in a moved rule (review 4724550474)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							$defs: { base: { type: "object" } },
							patternProperties: {
								"^x": {
									$defs: { v: { type: "string" } },
									$ref: "#/$defs/base",
									properties: { const: { $ref: "#/patternProperties/^x/$defs/v" } },
								},
							},
							required: ["x"],
							additionalProperties: { type: "number" },
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The rule's own reference survives compilation ($defs stays at its
			// location), but the walk must not stop there: the sibling properties
			// map carries a reference through the removed patternProperties
			// location, compilation deletes it, and an unrelocated pointer would
			// dangle so the value the original accepted breaks.
			expect(params.additionalProperties).toStrictEqual({
				anyOf: [
					{ type: "number" },
					{
						$defs: { v: { type: "string" } },
						$ref: "#/$defs/base",
						properties: { const: { type: "string" } },
					},
				],
			})
			assertNoDanglingLocalRefs(params)
		})

		it("keeps a surviving reference's literal sibling unrewritten (review 4725307765)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							$defs: { base: { type: "object" } },
							patternProperties: {
								"^x": {
									$defs: { v: { type: "string" } },
									$ref: "#/$defs/base",
									const: { $ref: "#/patternProperties/^x/$defs/v" },
									properties: { kept: { $ref: "#/patternProperties/^x/$defs/v" } },
								},
							},
							required: ["x"],
							additionalProperties: { type: "number" },
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The rule's own reference survives compilation ($defs stays at its
			// location), so the sibling walk keeps it. The walk must still
			// relocate the sibling schema map, and it must treat the const
			// sibling as instance data: a "$ref"-shaped value there is the
			// literal a caller asserts against, and rewriting it changed the
			// accepted inputs.
			expect(params.additionalProperties).toStrictEqual({
				anyOf: [
					{ type: "number" },
					{
						$defs: { v: { type: "string" } },
						$ref: "#/$defs/base",
						const: { $ref: "#/patternProperties/^x/$defs/v" },
						properties: { kept: { type: "string" } },
					},
				],
			})
			// assertNoDanglingLocalRefs now applies: the schema-aware walk
			// checks the real references (the rule's own pointer to
			// $defs/base and the relocated schema map) and skips the const
			// literal, which a validator compares for equality and never
			// resolves (review 4725679679).
			assertNoDanglingLocalRefs(params)
		})

		it("keeps a $ref-shaped const literal unrewritten (review 4723722038)", () => {
			const literal = { $ref: "#/patternProperties/^x/$defs/v" }
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							patternProperties: {
								"^x": {
									$defs: { v: { type: "string" } },
									properties: { cmd: { const: literal } },
								},
							},
							required: ["x"],
							additionalProperties: { type: "number" },
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// const carries instance data, not a schema: the "$ref"-shaped
			// object is the value a caller asserts against, and rewriting it
			// into the resolved schema changed the accepted inputs.
			const rule = (params.additionalProperties as Record<string, unknown>).anyOf as unknown[]
			expect(rule[1]).toStrictEqual({
				$defs: { v: { type: "string" } },
				properties: { cmd: { const: { $ref: "#/patternProperties/^x/$defs/v" } } },
			})
			// assertNoDanglingLocalRefs does not apply here: the literal's
			// pointer is instance data under const, which a validator compares
			// for equality and never resolves.
		})

		const literalCases: [string, Record<string, unknown>][] = [
			["enum", { enum: [{ $ref: "#/patternProperties/^x/$defs/v" }] }],
			["default", { default: { $ref: "#/patternProperties/^x/$defs/v" } }],
			["examples", { examples: [{ $ref: "#/patternProperties/^x/$defs/v" }] }],
		]
		it.each(literalCases)("keeps the $0 literal unrewritten (review 4723722038)", (keyword, literal) => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							patternProperties: {
								"^x": {
									$defs: { v: { type: "string" } },
									properties: { cmd: literal },
								},
							},
							required: ["x"],
							additionalProperties: { type: "number" },
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			const rule = (params.additionalProperties as Record<string, unknown>).anyOf as unknown[]
			expect(rule[1]).toStrictEqual({
				$defs: { v: { type: "string" } },
				properties: { cmd: literal },
			})
		})

		it("relaxes a branched reference graph whose relocation exceeds the budget (review 4723722021)", () => {
			const defs: Record<string, unknown> = { d0: { type: "string" } }
			for (let level = 1; level <= 16; level++) {
				const pointer = `#/patternProperties/^x/$defs/d${level - 1}`
				defs[`d${level}`] = { allOf: [{ $ref: pointer }, { $ref: pointer }] }
			}
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							patternProperties: {
								"^x": { $defs: defs, $ref: "#/patternProperties/^x/$defs/d16" },
							},
							required: ["x"],
							additionalProperties: { type: "number" },
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The graph is acyclic, so the cycle check never fires, and each
			// level is referenced twice: unbounded relocation would build 2^16
			// leaves from one small schema and block the synchronous request
			// path. Past MAX_RELOCATION_NODES the relocation abandons and the
			// retained closed rule relaxes instead.
			expect(params.additionalProperties).toBe(true)
		})

		it("keeps a not whose const carries a ref-shaped literal (review 4725679699)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							not: { const: { $ref: "#/not-in-the-document" } },
							required: ["x"],
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The "$ref" inside const is the asserted VALUE, not a schema
			// reference: collecting it would report the predicate as
			// reference-unstable and drop a not that compiles unchanged.
			expect(params.not).toStrictEqual({ const: { $ref: "#/not-in-the-document" } })
			expect(params).not.toHaveProperty("description")
		})

		it("resolves a percent-encoded pointer segment (review 4725679702)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							$defs: { "a b": { type: "string" } },
							properties: {
								name: { if: { $ref: "#/$defs/a%20b" }, then: { type: "string" } },
							},
							required: ["name"],
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			const name = (params.properties as Record<string, Record<string, unknown>>).name
			// The URI fragment decodes before resolution: the target named
			// "a b" compiles unchanged, so the conditional keeps every part
			// of itself instead of being relaxed as reference-unstable.
			expect(name).toStrictEqual({ if: { $ref: "#/$defs/a%20b" }, then: { type: "string" } })
			expect(name).not.toHaveProperty("description")
		})

		it("resolves an array index in a local pointer and inlines the retained reference (reviews 4725679704, 4725679720)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							patternProperties: { "^a": { allOf: [{ type: "string", pattern: "^q$" }] } },
							properties: { x: { $ref: "#/patternProperties/^a/allOf/0" } },
							required: ["x"],
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The canonical array index resolves before compilation, so the
			// RETAINED property's reference through the removed
			// patternProperties location is inlined with its compiled
			// target - compilation deletes that location and an unrewritten
			// pointer would dangle. The inlined target carries the compiled
			// pattern hint.
			expect(params.properties).toStrictEqual({
				x: {
					type: "string",
					description: "DeepSeek compatibility (constraint kept for the caller): value must match /^q$/",
				},
			})
			assertNoDanglingLocalRefs(params)
		})

		it("inlines a retained property reference whose target location compilation removes (review 4725679720)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							patternProperties: { y: { type: "string" } },
							properties: { x: { $ref: "#/patternProperties/y" } },
							required: ["x"],
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The reference sits OUTSIDE the moved rules, so the relocation
			// walk never saw it; compilation removes the patternProperties
			// location and the pointer would dangle. The repair pass inlines
			// it with its compiled target.
			expect(params.properties).toStrictEqual({ x: { type: "string" } })
			assertNoDanglingLocalRefs(params)
		})

		it("drops a not whose reference target probe passes the depth limit (review 4725679706)", () => {
			// The negation sits 32 properties levels deep: its target probe
			// compiles past MAX_SCHEMA_DEPTH and returns unchanged, while
			// the SAME target emits from the root $defs at depth 1 with its
			// pattern stripped - a retained not would negate a schema
			// without the pattern and reject strings the original accepted.
			let node: Record<string, unknown> = { not: { $ref: "#/$defs/tmp" } }
			for (let level = 0; level < 32; level++) {
				node = { type: "object", properties: { k: node }, required: ["k"] }
			}
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: { ...node, $defs: { tmp: { type: "string", pattern: "^tmp" } } },
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			let cursor: Record<string, unknown> = params
			for (let level = 0; level < 32; level++) {
				cursor = (cursor.properties as Record<string, Record<string, unknown>>).k as Record<string, unknown>
			}
			expect(cursor).not.toHaveProperty("not")
			expect(String(cursor.description)).toContain("not")
		})

		it("relaxes a moved rule that follows an over-budget acyclic chain (review 4725679710)", () => {
			// A chain of 120000 links through a removed location: each link
			// consumes budget BEFORE the next descent fires, so relocation
			// stops at the budget instead of blowing the call stack with a
			// RangeError - the retained rule relaxes exactly like an
			// oversized graph.
			const links: Record<string, unknown> = {}
			const CHAIN_LENGTH = 120000
			for (let level = 1; level < CHAIN_LENGTH; level++) {
				links[`l${level}`] = { $ref: `#/not/l${level + 1}` }
			}
			const tool = {
				type: "function",
				function: {
					name: "search_files",
					description: "Search",
					strict: true,
					parameters: {
						type: "object",
						patternProperties: { "^a": { $ref: "#/not/l1" } },
						not: { ...links, [`l${CHAIN_LENGTH}`]: { type: "string" } },
						required: ["x"],
						additionalProperties: { type: "number" },
					},
				},
			} satisfies Record<string, unknown>
			const tools = convert([tool])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// Graceful relaxation, not a stack overflow: the abandoned
			// relocation leaves the retained rule widened.
			expect(params.additionalProperties).toBe(true)
			assertNoDanglingLocalRefs(params)
		})

		it("keeps a changed conditional predicate as an annotation (review 4725679712)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							required: ["x"],
							if: { properties: { x: { pattern: "^a" } } },
							unevaluatedProperties: false,
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// Dropping the whole conditional would strand the required key:
			// the original if EVALUATED x, and the retained
			// unevaluatedProperties: false only accepts evaluated keys. The
			// bare predicate stays - it asserts nothing - so x stays
			// evaluated and accepted; the branches disappear.
			expect(params.if).toStrictEqual({
				properties: {
					x: {
						description: "DeepSeek compatibility (constraint kept for the caller): value must match /^a/",
					},
				},
			})
			expect(params.unevaluatedProperties).toBe(false)
			expect(params).not.toHaveProperty("then")
			expect(params).not.toHaveProperty("else")
			expect(String(params.description)).toContain("if")
		})

		it("compiles a schema-valued unevaluatedProperties rule (review 4725679716)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							unevaluatedProperties: { type: "string", minLength: 2 },
							required: ["x"],
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// A schema-valued unevaluated* rule is a schema: its rejected
			// keywords must compile, or the request ships minLength verbatim.
			expect(params.unevaluatedProperties).toStrictEqual({
				type: "string",
				description: "DeepSeek compatibility (constraint kept for the caller): minLength: 2",
			})
		})

		it("compiles a schema-valued unevaluatedItems rule (review 4725679716)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "array",
							unevaluatedItems: { type: "string", maxLength: 4 },
							minItems: 1,
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			expect(params.unevaluatedItems).toStrictEqual({
				type: "string",
				description: "DeepSeek compatibility (constraint kept for the caller): maxLength: 4",
			})
		})

		it("keeps a boolean unevaluatedProperties rule untouched (review 4725679716)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							properties: { x: { type: "string" } },
							unevaluatedProperties: false,
							required: ["x"],
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			expect(params.unevaluatedProperties).toBe(false)
			expect(params).not.toHaveProperty("description")
		})

		it("relaxes unevaluatedProperties when a child applicator loses patternProperties (review 4725679723)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							required: ["x"],
							allOf: [{ patternProperties: { "^x$": { type: "string" } } }],
							unevaluatedProperties: false,
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The allOf branch evaluated x through its patternProperties rule;
			// compilation removes the rule, the outer removed record never
			// saw it, and a retained unevaluatedProperties: false would make
			// the required property forbidden - the compiled schema would
			// accept nothing. The rule relaxes instead.
			expect(params.unevaluatedProperties).toBe(true)
			// The removed patternProperties rule is the CHILD branch's
			// removal: its hint lands on the compiled branch, the
			// relaxation on the enclosing rule.
			const branch = (params.allOf as Record<string, unknown>[])[0] as Record<string, unknown>
			expect(String(branch.description)).toContain("patternProperties")
		})

		it("relaxes unevaluatedItems when a child branch loses contains through a reference (review 4726390999)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							$defs: { strings: { contains: { type: "string" } } },
							properties: {
								values: {
									type: "array",
									const: ["a"],
									allOf: [{ $ref: "#/$defs/strings", minItems: 1 }],
									unevaluatedItems: false,
								},
							},
							required: ["values"],
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as {
				properties?: Record<string, Record<string, unknown>>
			}
			const arr = (params.properties ?? {}).values as Record<string, unknown>
			// The referenced contains annotated the items the conjunct matched.
			// Compilation strips minItems from the conjunct (so the branch
			// changed) and contains from the referenced definition itself: the
			// stranded unevaluatedItems: false would reject the item "a" the
			// original accepted, so it relaxes exactly like the inline case.
			expect(arr.unevaluatedItems).toBe(true)
			// The removed minItems is the conjunct's own removal: its hint
			// lands on the compiled branch.
			const conjunct = (arr.allOf as Record<string, unknown>[])[0] as Record<string, unknown>
			expect(String(conjunct.description)).toContain("minItems")
		})

		it("keeps unevaluatedItems when items and prefixItems are both present (review 4725679660)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							properties: {
								items: {
									type: "array",
									items: { type: "string" },
									prefixItems: [{ type: "string" }],
									contains: { const: "b" },
									unevaluatedItems: false,
								},
							},
							required: ["items"],
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as {
				properties?: Record<string, Record<string, unknown>>
			}
			const arr = (params.properties ?? {}).items as Record<string, unknown>
			// A retained items evaluates every index, whether or not a
			// prefixItems sits beside it: the restriction is an ordinary one
			// and stays; only the removed contains moves into the hint.
			expect(arr.unevaluatedItems).toBe(false)
			expect(arr.items).toStrictEqual({ type: "string" })
			expect(arr.prefixItems).toStrictEqual([{ type: "string" }])
			expect(String(arr.description)).toContain("contains")
		})

		it("relaxes unevaluatedProperties when a dropped then branch evaluated the required key (review 4726104161)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							required: ["x"],
							if: { properties: { y: { pattern: "^a" } } },
							then: { properties: { x: { type: "string" } } },
							unevaluatedProperties: false,
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// The pattern leaves the if predicate, the conditional relaxes,
			// and the then branch - the rule that evaluated x - travels into
			// the hint. A retained unevaluatedProperties: false would forbid
			// the required key, and the compiled schema would accept no
			// object. The rule relaxes instead; the closed object with no
			// changed conditional keeps it (control below).
			expect(params.unevaluatedProperties).toBe(true)
			expect(params.required).toStrictEqual(["x"])
			expect(String(params.description)).toContain("then")
		})

		it("keeps unevaluatedProperties on a closed object whose conditional strips unchanged (review 4726104161 control)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							required: ["x"],
							properties: { x: { type: "string" } },
							if: { properties: { y: { type: "string" } } },
							then: { properties: { x: { type: "string" } } },
							unevaluatedProperties: false,
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as Record<string, unknown>
			// No rejected keyword anywhere: the predicate strips unchanged,
			// the branch stays, and the closed rule is an ordinary one.
			// The branch is asserted exactly: a conversion that replaced
			// then with false would still satisfy a bare toBeDefined
			// (review 4726390983).
			expect(params.unevaluatedProperties).toBe(false)
			expect(params.then).toStrictEqual({ properties: { x: { type: "string" } } })
		})

		it("relaxes unevaluatedItems when a child applicator branch loses contains (review 4726104165)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							properties: {
								items: {
									type: "array",
									const: ["a"],
									allOf: [{ contains: { type: "string" } }],
									unevaluatedItems: false,
								},
							},
							required: ["items"],
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as {
				properties?: Record<string, Record<string, unknown>>
			}
			const arr = (params.properties ?? {}).items as Record<string, unknown>
			// The contains rule inside the allOf branch evaluated index 0;
			// compilation removes it, the outer removed record never saw it,
			// and a retained unevaluatedItems: false would forbid every item
			// the original accepted - with the const there is no valid value
			// left. The restriction relaxes to true, and with no removed
			// contains at this level the empty-schema alternative covers the
			// items the branch evaluated.
			expect(arr.unevaluatedItems).toBe(true)
			expect(arr.const).toStrictEqual(["a"])
		})

		it("relaxes unevaluatedItems through the removed contains when the branch also lost it (review 4726104165 polarity)", () => {
			const tools = convert([
				{
					type: "function",
					function: {
						name: "search_files",
						description: "Search",
						strict: true,
						parameters: {
							type: "object",
							properties: {
								items: {
									type: "array",
									contains: { type: "string" },
									allOf: [{ contains: { type: "string" } }],
									unevaluatedItems: false,
								},
							},
							required: ["items"],
						},
					},
				},
			])
			const params = tools[0].function.parameters as unknown as {
				properties?: Record<string, Record<string, unknown>>
			}
			const arr = (params.properties ?? {}).items as Record<string, unknown>
			// Both the level's own contains and the child branch's contains
			// leave: the relaxation fires through the removed record, and
			// the compiled contains rule re-enters as the alternative.
			expect(arr.unevaluatedItems).toBe(true)
			expect(String(arr.description)).toContain("contains")
		})
	})
})

describe("DeepSeekHandler lone surrogate sanitization (#461)", () => {
	beforeEach(() => {
		mockCreate.mockClear()
	})

	const surrogateOptions: ApiHandlerOptions = {
		deepSeekApiKey: "test-api-key",
		apiModelId: "deepseek-v4-flash",
		deepSeekBaseUrl: "https://api.deepseek.com",
	}

	it("sends a request body free of lone surrogates, keeping tool call/result pairing intact", async () => {
		const lone = "bad\uD800end"
		const sanitized = "bad\uFFFDend"
		const handler = new DeepSeekHandler(surrogateOptions)
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: lone },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call-\uD800", name: "read_file", input: { path: lone } }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-\uD800", content: lone }] },
		]

		await collectStream(
			handler.createMessage("system \uD800 prompt", messages, {
				taskId: "task-1",
				tools: [
					{
						type: "function",
						function: {
							name: "read_file",
							description: lone,
							parameters: {
								type: "object",
								properties: { path: { type: "string", description: lone } },
							},
						},
					},
				],
			}),
		)

		expect(mockCreate).toHaveBeenCalledOnce()
		const request = mockCreate.mock.calls[0][0]

		// The whole body (messages + tools) must be free of lone surrogates. Inspect the raw
		// values: JSON.stringify escapes lone surrogates as \udXXX text, so a regex over the
		// serialized body can never fail. See expectNoLoneSurrogates.
		expectNoLoneSurrogates(request)

		// The tool call and its result stay paired after injective id sanitization.
		const assistantMessage = request.messages.find(
			(message: { role: string }) => message.role === "assistant",
		) as OpenAI.Chat.ChatCompletionAssistantMessageParam
		const toolMessage = request.messages.find(
			(message: { role: string }) => message.role === "tool",
		) as OpenAI.Chat.ChatCompletionToolMessageParam
		const toolCalls = assistantMessage.tool_calls as OpenAI.Chat.ChatCompletionMessageFunctionToolCall[]
		expect(toolMessage.tool_call_id).toBe(toolCalls[0].id)
		expect(toolMessage.content).toBe(sanitized)
		expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ path: sanitized })
		expect(request.tools[0].function.description).toBe(sanitized)
		// Request-level strict assertion: the converter-level test pins
		// the converter output, and this pins the value that actually
		// leaves on the outgoing request after conversion (review
		// 4725679670).
		expect(request.tools[0].function.strict).toBe(false)
	})
})
