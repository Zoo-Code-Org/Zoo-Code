import { DeepSeekHandler } from "../deepseek"
import { responsesReasoningScope } from "../../transform/responses-api-reasoning"
import { KimiCodeHandler } from "../kimi-code"
import { MoonshotHandler } from "../moonshot"
import { MimoHandler } from "../mimo"
import { prepareApiConversationMessage } from "../../../core/task/apiConversationHistory"
// npx vitest run api/providers/__tests__/openai.spec.ts

import { OpenAiHandler, getOpenAiModels } from "../openai"
import { ApiHandlerOptions } from "../../../shared/api"
import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { AzureOpenAI } from "openai"
import {
	openAiModelInfoSaneDefaults,
	DEEP_SEEK_DEFAULT_TEMPERATURE,
	azureOpenAiDefaultApiVersion,
	type ModelInfo,
	providerIdentifiers,
} from "@roo-code/types"
import { Package } from "../../../shared/package"
import { makeApiHandlerOptions, makeCreateMessageMetadata } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { expectNoLoneSurrogates } from "../../../test-utils/surrogates"
import axios from "axios"

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn().mockReturnValue(300_000),
}))

const MOCK_TIMEOUT_MS = 300_000

const mockCreate = vitest.fn()
const mockResponsesCreate = vitest.fn()

vitest.mock("openai", () => {
	const mockConstructor = vitest.fn()
	const mockAzureConstructor = vitest.fn()
	return {
		__esModule: true,
		default: mockConstructor.mockImplementation(function (options: { baseURL: string }) {
			return {
				baseURL: options.baseURL,
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
									},
								}
							}

							return asyncStreamFrom([
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
									},
								},
							])
						}),
					},
				},
				responses: {
					create: mockResponsesCreate.mockImplementation(async () =>
						asyncStreamFrom([
							{ type: "response.output_text.delta", delta: "Test response" },
							{
								type: "response.completed",
								response: {
									usage: {
										input_tokens: 10,
										output_tokens: 5,
									},
								},
							},
						]),
					),
				},
			}
		}),
		AzureOpenAI: mockAzureConstructor,
	}
})

// Mock axios for getOpenAiModels tests
vitest.mock("axios", () => ({
	default: {
		get: vitest.fn(),
	},
}))

describe("OpenAiHandler", () => {
	let handler: OpenAiHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = makeApiHandlerOptions({
			openAiApiKey: "test-api-key",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "https://api.openai.com/v1",
		})
		handler = new OpenAiHandler(mockOptions)
		mockCreate.mockClear()
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(OpenAiHandler)
			expect(handler.getModel().id).toBe(mockOptions.openAiModelId)
		})

		it("should use custom base URL if provided", () => {
			const customBaseUrl = "https://custom.openai.com/v1"
			const handlerWithCustomUrl = new OpenAiHandler({
				...mockOptions,
				openAiBaseUrl: customBaseUrl,
			})
			expect(handlerWithCustomUrl).toBeInstanceOf(OpenAiHandler)
		})

		it("should set default headers correctly", () => {
			// Check that the OpenAI constructor was called with correct parameters
			expect(vi.mocked(OpenAI)).toHaveBeenCalledWith({
				baseURL: expect.any(String),
				apiKey: expect.any(String),
				defaultHeaders: {
					"HTTP-Referer": "https://github.com/Zoo-Code-Org/Zoo-Code",
					"X-Title": "Zoo Code",
					"User-Agent": `ZooCode/${Package.version}`,
				},
				timeout: MOCK_TIMEOUT_MS,
			})
		})

		it.each([
			["https://resource.openai.azure.com", "https://resource.openai.azure.com/openai"],
			["https://resource.openai.azure.com/", "https://resource.openai.azure.com/openai"],
			["https://resource.openai.azure.com/openai", "https://resource.openai.azure.com/openai"],
			["https://resource.openai.azure.com/openai/", "https://resource.openai.azure.com/openai"],
		])("normalizes Azure OpenAI base URL %s", (openAiBaseUrl, expectedBaseUrl) => {
			new OpenAiHandler({ ...mockOptions, openAiBaseUrl })

			expect(vi.mocked(AzureOpenAI)).toHaveBeenLastCalledWith(
				expect.objectContaining({
					baseURL: expectedBaseUrl,
					apiKey: mockOptions.openAiApiKey,
					apiVersion: azureOpenAiDefaultApiVersion,
					defaultHeaders: expect.any(Object),
					timeout: MOCK_TIMEOUT_MS,
				}),
			)
		})

		it("normalizes reverse-proxy URLs when Azure mode is enabled", () => {
			new OpenAiHandler({
				...mockOptions,
				openAiBaseUrl: "https://models.example.com/azure/",
				openAiUseAzure: true,
			})

			expect(vi.mocked(AzureOpenAI)).toHaveBeenLastCalledWith(
				expect.objectContaining({
					baseURL: "https://models.example.com/azure/openai",
					apiKey: mockOptions.openAiApiKey,
					apiVersion: azureOpenAiDefaultApiVersion,
					defaultHeaders: expect.any(Object),
					timeout: MOCK_TIMEOUT_MS,
				}),
			)
		})
	})

	describe("withExtraBody", () => {
		it("gives request-owned options precedence when an allowed Extra Body field collides", () => {
			const extraBodyHandler = new OpenAiHandler({
				...mockOptions,
				openAiExtraBody: JSON.stringify({ service_tier: "flex" }),
			})

			expect(extraBodyHandler["withExtraBody"]({})).toEqual({ service_tier: "flex" })
			expect(extraBodyHandler["withExtraBody"]({ service_tier: "default" })).toEqual({
				service_tier: "default",
			})
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

		it("should handle non-streaming mode", async () => {
			const handler = new OpenAiHandler({
				...mockOptions,
				openAiStreamingEnabled: false,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks = await collectStream(stream)

			expect(chunks.length).toBeGreaterThan(0)
			const textChunk = chunks.find((chunk) => chunk.type === "text")
			const usageChunk = chunks.find((chunk) => chunk.type === "usage")

			expect(textChunk).toBeDefined()
			expect(textChunk?.text).toBe("Test response")
			expect(usageChunk).toBeDefined()
			expect(usageChunk?.inputTokens).toBe(10)
			expect(usageChunk?.outputTokens).toBe(5)
		})

		it("should handle tool calls in non-streaming mode", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "test_tool",
										arguments: '{"arg":"value"}',
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
				},
			})

			const handler = new OpenAiHandler({
				...mockOptions,
				openAiStreamingEnabled: false,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks = await collectStream(stream)

			const toolCallChunks = chunks.filter((chunk) => chunk.type === "tool_call")
			expect(toolCallChunks).toHaveLength(1)
			expect(toolCallChunks[0]).toEqual({
				type: "tool_call",
				id: "call_1",
				name: "test_tool",
				arguments: '{"arg":"value"}',
			})
		})

		it("should handle streaming responses", async () => {
			const stream = handler.createMessage(systemPrompt, messages)
			const chunks = await collectStream(stream)

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")
		})

		it("should forward the task abortSignal to streaming requests", async () => {
			const controller = new AbortController()

			await collectStream(
				handler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ stream: true }), {
				signal: controller.signal,
			})
		})

		it("should forward the task abortSignal to non-streaming requests", async () => {
			const controller = new AbortController()
			const nonStreamingHandler = new OpenAiHandler({
				...mockOptions,
				openAiStreamingEnabled: false,
			})

			await collectStream(
				nonStreamingHandler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: mockOptions.openAiModelId }), {
				signal: controller.signal,
			})
		})

		it("adds Extra Body fields to streaming requests without allowing reserved field overrides", async () => {
			const extraBodyHandler = new OpenAiHandler({
				...mockOptions,
				openAiExtraBody: JSON.stringify({
					metadata: { completion_window: "balanced" },
					model: "overridden-model",
					messages: [],
					stream: false,
				}),
			})

			await collectStream(extraBodyHandler.createMessage(systemPrompt, messages))

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					metadata: { completion_window: "balanced" },
					model: mockOptions.openAiModelId,
					stream: true,
					messages: expect.arrayContaining([expect.objectContaining({ role: "user" })]),
				}),
				{},
			)
		})

		it("adds Extra Body fields to non-streaming requests", async () => {
			const extraBodyHandler = new OpenAiHandler({
				...mockOptions,
				openAiStreamingEnabled: false,
				openAiExtraBody: JSON.stringify({ metadata: { completion_window: "balanced" } }),
			})

			await collectStream(extraBodyHandler.createMessage(systemPrompt, messages))

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ metadata: { completion_window: "balanced" } }),
				{},
			)
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

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

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

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
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

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")

			expect(reasoningChunks).toEqual([{ type: "reasoning", text: "primary thought" }])
		})

		it("should handle tool calls in streaming responses", async () => {
			mockCreate.mockImplementation(async (_options) =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											function: { name: "test_tool", arguments: "" },
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						choices: [
							{
								delta: {
									tool_calls: [{ index: 0, function: { arguments: '{"arg":' } }],
								},
								finish_reason: null,
							},
						],
					},
					{
						choices: [
							{
								delta: {
									tool_calls: [{ index: 0, function: { arguments: '"value"}' } }],
								},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks = await collectStream(stream)

			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			const toolCallPartialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallPartialChunks).toHaveLength(3)
			// First chunk has id and name
			expect(toolCallPartialChunks[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_1",
				name: "test_tool",
				arguments: "",
			})
			// Subsequent chunks have arguments
			expect(toolCallPartialChunks[1]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: undefined,
				name: undefined,
				arguments: '{"arg":',
			})
			expect(toolCallPartialChunks[2]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: undefined,
				name: undefined,
				arguments: '"value"}',
			})

			// Verify tool_call_end event is emitted when finish_reason is "tool_calls"
			const toolCallEndChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(toolCallEndChunks).toHaveLength(1)
		})

		it("should yield tool calls even when finish_reason is not set (fallback behavior)", async () => {
			mockCreate.mockImplementation(async (_options) =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_fallback",
											function: { name: "fallback_tool", arguments: '{"test":"fallback"}' },
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						choices: [
							{
								delta: {},
								finish_reason: "stop",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks = await collectStream(stream)

			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			const toolCallPartialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallPartialChunks).toHaveLength(1)
			expect(toolCallPartialChunks[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_fallback",
				name: "fallback_tool",
				arguments: '{"test":"fallback"}',
			})
		})

		it("should include reasoning_effort when reasoning effort is enabled", async () => {
			const reasoningOptions: ApiHandlerOptions = {
				...mockOptions,
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					supportsPromptCache: false,
					supportsReasoningEffort: true,
					reasoningEffort: "high",
				},
			}
			const reasoningHandler = new OpenAiHandler(reasoningOptions)
			const stream = reasoningHandler.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			await collectStream(stream)
			// Assert the mockCreate was called with reasoning_effort
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.reasoning_effort).toBe("high")
		})

		it("should pass through max reasoning_effort when configured by an OpenAI-compatible model", async () => {
			const reasoningOptions: ApiHandlerOptions = {
				...mockOptions,
				enableReasoningEffort: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					supportsPromptCache: false,
					supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
					reasoningEffort: "max",
				},
			}
			const reasoningHandler = new OpenAiHandler(reasoningOptions)
			const stream = reasoningHandler.createMessage(systemPrompt, messages)
			await collectStream(stream)

			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.reasoning_effort).toBe("max")
		})

		it("should not include reasoning_effort when reasoning effort is disabled", async () => {
			const noReasoningOptions: ApiHandlerOptions = {
				...mockOptions,
				enableReasoningEffort: false,
				openAiCustomModelInfo: { contextWindow: 128_000, supportsPromptCache: false },
			}
			const noReasoningHandler = new OpenAiHandler(noReasoningOptions)
			const stream = noReasoningHandler.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			await collectStream(stream)
			// Assert the mockCreate was called without reasoning_effort
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.reasoning_effort).toBeUndefined()
		})

		it("should omit temperature when the model sets supportsTemperature to false", async () => {
			const noTempOptions: ApiHandlerOptions = {
				...mockOptions,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					supportsPromptCache: false,
					supportsTemperature: false,
				},
			}
			const noTempHandler = new OpenAiHandler(noTempOptions)
			const stream = noTempHandler.createMessage(systemPrompt, messages)
			await collectStream(stream)
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("temperature")
		})

		it("should omit temperature by default when no custom temperature is set", async () => {
			// Option A: when "use custom temperature" is off (modelTemperature unset) and the model has no
			// required default, omit `temperature` so the server's own default applies instead of forcing 0.
			const stream = handler.createMessage(systemPrompt, messages)
			await collectStream(stream)
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("temperature")
		})

		it("should use the configured modelTemperature when supportsTemperature is not false", async () => {
			const customTempHandler = new OpenAiHandler({ ...mockOptions, modelTemperature: 0.5 })
			const stream = customTempHandler.createMessage(systemPrompt, messages)
			await collectStream(stream)
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.temperature).toBe(0.5)
		})

		it("should default to DEEP_SEEK_DEFAULT_TEMPERATURE for deepseek-reasoner models", async () => {
			const deepseekHandler = new OpenAiHandler({ ...mockOptions, openAiModelId: "deepseek-reasoner" })
			const stream = deepseekHandler.createMessage(systemPrompt, messages)
			await collectStream(stream)
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.temperature).toBe(DEEP_SEEK_DEFAULT_TEMPERATURE)
		})

		it("should still send temperature when the user sets a custom value of 0", async () => {
			// A deliberate 0 must be distinguished from "unset" — it is sent, not omitted.
			const zeroTempHandler = new OpenAiHandler({ ...mockOptions, modelTemperature: 0 })
			const stream = zeroTempHandler.createMessage(systemPrompt, messages)
			await collectStream(stream)
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.temperature).toBe(0)
		})

		it("should include max_tokens when includeMaxTokens is true", async () => {
			const optionsWithMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: true,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096,
					supportsPromptCache: false,
				},
			}
			const handlerWithMaxTokens = new OpenAiHandler(optionsWithMaxTokens)
			const stream = handlerWithMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			await collectStream(stream)
			// Assert the mockCreate was called with max_tokens
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBe(4096)
		})

		it("should not include max_tokens when includeMaxTokens is false", async () => {
			const optionsWithoutMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: false,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096,
					supportsPromptCache: false,
				},
			}
			const handlerWithoutMaxTokens = new OpenAiHandler(optionsWithoutMaxTokens)
			const stream = handlerWithoutMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			await collectStream(stream)
			// Assert the mockCreate was called without max_tokens
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBeUndefined()
		})

		it.each([
			{ label: "unset (UI shows it checked)", includeMaxTokens: undefined, maxTokens: 4096, expected: 4096 },
			{ label: "true", includeMaxTokens: true, maxTokens: 4096, expected: 4096 },
			{ label: "false", includeMaxTokens: false, maxTokens: 4096, expected: undefined },
			{
				label: "unset with legacy maxTokens -1",
				includeMaxTokens: undefined,
				maxTokens: -1,
				expected: undefined,
			},
		])(
			"sends max_completion_tokens matching the checkbox when includeMaxTokens is $label",
			async ({ includeMaxTokens, maxTokens, expected }) => {
				const customModelInfo = { contextWindow: 128_000, maxTokens, supportsPromptCache: false }
				const streamingHandler = new OpenAiHandler({
					...mockOptions,
					includeMaxTokens,
					openAiCustomModelInfo: customModelInfo,
				})
				await collectStream(streamingHandler.createMessage(systemPrompt, messages))
				const nonStreamingHandler = new OpenAiHandler({
					...mockOptions,
					includeMaxTokens,
					openAiStreamingEnabled: false,
					openAiCustomModelInfo: customModelInfo,
				})
				await collectStream(nonStreamingHandler.createMessage(systemPrompt, messages))
				await nonStreamingHandler.completePrompt("Test prompt")

				expect(mockCreate).toHaveBeenCalledTimes(3)
				for (const [callArgs] of mockCreate.mock.calls) {
					if (expected === undefined) expect(callArgs).not.toHaveProperty("max_completion_tokens")
					else expect(callArgs.max_completion_tokens).toBe(expected)
				}
			},
		)

		it("should use user-configured modelMaxTokens instead of model default maxTokens", async () => {
			const optionsWithUserMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: true,
				modelMaxTokens: 32000, // User-configured value
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096, // Model's default value (should not be used)
					supportsPromptCache: false,
				},
			}
			const handlerWithUserMaxTokens = new OpenAiHandler(optionsWithUserMaxTokens)
			const stream = handlerWithUserMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			await collectStream(stream)
			// Assert the mockCreate was called with user-configured modelMaxTokens (32000), not model default maxTokens (4096)
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBe(32000)
		})

		it("should fallback to model default maxTokens when user modelMaxTokens is not set", async () => {
			const optionsWithoutUserMaxTokens: ApiHandlerOptions = {
				...mockOptions,
				includeMaxTokens: true,
				// modelMaxTokens is not set
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 4096, // Model's default value (should be used as fallback)
					supportsPromptCache: false,
				},
			}
			const handlerWithoutUserMaxTokens = new OpenAiHandler(optionsWithoutUserMaxTokens)
			const stream = handlerWithoutUserMaxTokens.createMessage(systemPrompt, messages)
			// Consume the stream to trigger the API call
			await collectStream(stream)
			// Assert the mockCreate was called with model default maxTokens (4096) as fallback
			expect(mockCreate).toHaveBeenCalled()
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.max_completion_tokens).toBe(4096)
		})

		it("should yield reasoning chunks BEFORE text chunks when both are present in the exact same delta", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: { reasoning_content: "thinking...", content: "answer" } }],
						usage: { prompt_tokens: 10, completion_tokens: 10 },
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			const contentChunks = chunks.filter((c) => c.type === "reasoning" || c.type === "text")
			expect(contentChunks).toEqual([
				{ type: "reasoning", text: "thinking..." },
				{ type: "text", text: "answer" },
			])
		})

		describe("TagMatcher reasoning tags", () => {
			it("should treat stray closing tag as plain text when no tag is open", async () => {
				mockCreate.mockImplementationOnce(() =>
					asyncStreamFrom([{ choices: [{ delta: { content: "final</think>text" } }] }]),
				)

				const stream = handler.createMessage(systemPrompt, messages)
				const chunks = await collectStream(stream)

				expect(chunks).toEqual([{ type: "text", text: "final</think>text" }])
			})

			it("should treat extra closing tag after a closed block as plain text", async () => {
				mockCreate.mockImplementationOnce(() =>
					asyncStreamFrom([
						{ choices: [{ delta: { content: "<think>thinking</think>final</think>text" } }] },
					]),
				)

				const stream = handler.createMessage(systemPrompt, messages)
				const chunks = await collectStream(stream)

				expect(chunks).toEqual([
					{ type: "reasoning", text: "thinking" },
					{ type: "text", text: "final</think>text" },
				])
			})

			it("should handle nested mixed tags with correct closure matching", async () => {
				mockCreate.mockImplementationOnce(() =>
					asyncStreamFrom([
						{ choices: [{ delta: { content: "<think>outer" } }] },
						{ choices: [{ delta: { content: "<thought>inner</thought>" } }] },
						{ choices: [{ delta: { content: " middle</think>" } }] },
						{ choices: [{ delta: { content: "final text" } }] },
					]),
				)

				const stream = handler.createMessage(systemPrompt, messages)
				const chunks = await collectStream(stream)

				// With the tag stack fix, </thought> closes <thought> inner tag,
				// and </think> correctly closes the outer <think> tag.
				// inner content inside <thought> is reasoning, middle is still reasoning under <think>
				expect(chunks).toEqual([
					{ type: "reasoning", text: "outer" },
					{ type: "reasoning", text: "<thought>inner</thought>" },
					{ type: "reasoning", text: " middle" },
					{ type: "text", text: "final text" },
				])
			})

			it("should handle nested <think> tags with correct stack unwinding", async () => {
				mockCreate.mockImplementationOnce(() =>
					asyncStreamFrom([
						{ choices: [{ delta: { content: "<think>outer" } }] },
						{ choices: [{ delta: { content: "<think>inner</think>" } }] },
						{ choices: [{ delta: { content: " middle</think>" } }] },
						{ choices: [{ delta: { content: "final text" } }] },
					]),
				)

				const stream = handler.createMessage(systemPrompt, messages)
				const chunks = await collectStream(stream)

				// With the tag stack fix, </thought> closes <thought> inner tag,
				// and </think> correctly closes the outer <think> tag.
				// inner content inside <thought> is reasoning, middle is still reasoning under <think>
				expect(chunks).toEqual([
					{ type: "reasoning", text: "outer" },
					{ type: "reasoning", text: "<think>inner</think>" },
					{ type: "reasoning", text: " middle" },
					{ type: "text", text: "final text" },
				])
			})

			it("should handle reasoning_content alongside tag matching", async () => {
				mockCreate.mockImplementationOnce(() =>
					asyncStreamFrom([
						{ choices: [{ delta: { reasoning_content: "native reasoning" } }] },
						{ choices: [{ delta: { content: "<think>tag based</think>" } }] },
						{ choices: [{ delta: { content: " final output" } }] },
					]),
				)

				const stream = handler.createMessage(systemPrompt, messages)
				const chunks = await collectStream(stream)

				expect(chunks).toEqual([
					{ type: "reasoning", text: "native reasoning" },
					{ type: "reasoning", text: "tag based" },
					{ type: "text", text: " final output" },
				])
			})
		})

		it("should include reasoning_content on assistant history messages when preserveReasoning is set", async () => {
			// Regression guard for issue #201: OpenAI-compatible providers (e.g. DeepSeek via custom
			// base URL) must pass reasoning_content back in history when thinking mode is active.
			// This exercises OpenAiHandler -> convertToOpenAiMessages directly.
			const thinkingHandler = new OpenAiHandler({
				...mockOptions,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					supportsPromptCache: false,
					preserveReasoning: true,
				},
			})

			const messagesWithReasoning: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "What files are in the project?" },
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "I should use the read_file tool.", summary: [] } as any,
						{ type: "tool_use", id: "call_001", name: "read_file", input: { path: "README.md" } },
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call_001", content: "# Project\nHello." }],
				},
			]

			const stream = thinkingHandler.createMessage(systemPrompt, messagesWithReasoning)
			await collectStream(stream)

			expect(mockCreate).toHaveBeenCalled()
			const sentMessages: any[] = mockCreate.mock.calls[0][0].messages
			const assistantMsg = sentMessages.find((m: any) => m.role === "assistant" && m.tool_calls?.length)
			expect(assistantMsg).toBeDefined()
			expect(assistantMsg.reasoning_content).toBe("I should use the read_file tool.")
		})
	})

	describe("error handling", () => {
		const testMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "text" as const,
						text: "Hello",
					},
				],
			},
		]

		it("should handle API errors", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))

			const stream = handler.createMessage("system prompt", testMessages)

			await expect(async () => {
				await collectStream(stream)
			}).rejects.toThrow("API Error")
		})

		it("should handle rate limiting", async () => {
			const rateLimitError = new Error("Rate limit exceeded")
			rateLimitError.name = "Error"
			;(rateLimitError as any).status = 429
			mockCreate.mockRejectedValueOnce(rateLimitError)

			const stream = handler.createMessage("system prompt", testMessages)

			await expect(async () => {
				await collectStream(stream)
			}).rejects.toThrow("Rate limit exceeded")
		})
	})

	describe("completePrompt", () => {
		it("should complete prompt successfully", async () => {
			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("Test response")
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: mockOptions.openAiModelId,
					messages: [{ role: "user", content: "Test prompt" }],
				},
				{},
			)
		})

		it("adds Extra Body fields to single-completion requests", async () => {
			const extraBodyHandler = new OpenAiHandler({
				...mockOptions,
				openAiExtraBody: JSON.stringify({ metadata: { completion_window: "balanced" } }),
			})

			await extraBodyHandler.completePrompt("Test prompt")

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ metadata: { completion_window: "balanced" } }),
				{},
			)
		})

		it("should handle API errors", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))
			await expect(handler.completePrompt("Test prompt")).rejects.toThrow("OpenAI completion error: API Error")
		})

		it("should preserve HTTP status when wrapping completion errors", async () => {
			mockCreate.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }))

			await expect(handler.completePrompt("Test prompt")).rejects.toMatchObject({ status: 401 })
		})

		it("should handle empty response", async () => {
			mockCreate.mockImplementationOnce(() => ({
				choices: [{ message: { content: "" } }],
			}))
			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("")
		})
	})

	describe.each([
		{ name: "streaming chat", openAiModelId: "custom-model", streaming: true, singleCompletion: false },
		{ name: "non-streaming chat", openAiModelId: "custom-model", streaming: false, singleCompletion: false },
		{ name: "streaming O3", openAiModelId: "o3-mini", streaming: true, singleCompletion: false },
		{ name: "non-streaming O3", openAiModelId: "o3-mini", streaming: false, singleCompletion: false },
		{ name: "single completion", openAiModelId: "custom-model", streaming: false, singleCompletion: true },
	])("reasoning effort consistency: $name", ({ openAiModelId, streaming, singleCompletion }) => {
		async function requestWithSettings(settings: Partial<ApiHandlerOptions>) {
			const reasoningHandler = new OpenAiHandler({
				...mockOptions,
				openAiModelId,
				openAiStreamingEnabled: streaming,
				...settings,
			})

			if (singleCompletion) {
				await reasoningHandler.completePrompt("Hello")
			} else {
				await collectStream(
					reasoningHandler.createMessage("System prompt", [{ role: "user", content: "Hello" }]),
				)
			}
		}

		it.each([
			{ selected: "max", stale: "low" },
			{ selected: "high", stale: "medium" },
			{ selected: "xhigh", stale: "medium" },
			{ selected: "max", stale: "disable" },
			{ selected: "max", stale: "none" },
		] as const)(
			"uses the custom model's $selected effort despite a stale top-level $stale",
			async ({ selected, stale }) => {
				await requestWithSettings({
					enableReasoningEffort: true,
					reasoningEffort: stale,
					openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, reasoningEffort: selected },
				})

				expect(mockCreate).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({ reasoning_effort: selected }),
					{},
				)
			},
		)

		it.each(["low", "medium", "high", "xhigh", "max"] as const)(
			"preserves the selected %s effort when the enable flag is unset in a legacy profile",
			async (reasoningEffort) => {
				await requestWithSettings({
					openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, reasoningEffort },
				})

				expect(mockCreate).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({ reasoning_effort: reasoningEffort }),
					{},
				)
			},
		)

		it("omits reasoning effort when disabled even if custom model metadata retains max", async () => {
			await requestWithSettings({
				enableReasoningEffort: false,
				reasoningEffort: "low",
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, reasoningEffort: "max" },
			})

			expect(mockCreate).toHaveBeenCalledOnce()
			expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("reasoning_effort")
		})

		it("does not use a hidden top-level effort when no custom effort is configured", async () => {
			await requestWithSettings({
				enableReasoningEffort: true,
				reasoningEffort: "low",
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, supportsReasoningEffort: true },
			})

			expect(mockCreate).toHaveBeenCalledOnce()
			expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("reasoning_effort")
		})
	})

	describe("getModel", () => {
		it.each([
			{ supportsReasoningEffort: undefined },
			{ supportsReasoningEffort: true },
			{ supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"] },
		] satisfies Array<Pick<ModelInfo, "supportsReasoningEffort">>)(
			"resolves custom effort consistently for capability $supportsReasoningEffort without mutating settings",
			({ supportsReasoningEffort }) => {
				const options: ApiHandlerOptions = {
					...mockOptions,
					enableReasoningEffort: true,
					reasoningEffort: "low",
					openAiCustomModelInfo: {
						...openAiModelInfoSaneDefaults,
						supportsReasoningEffort,
						reasoningEffort: "max",
					},
				}
				const reasoningHandler = new OpenAiHandler(options)

				expect(reasoningHandler.getModel()).toMatchObject({
					info: { reasoningEffort: "max" },
					reasoningEffort: "max",
					reasoning: { reasoning_effort: "max" },
				})
				expect(options.reasoningEffort).toBe("low")
				expect(options.openAiCustomModelInfo?.reasoningEffort).toBe("max")
			},
		)

		it("should return model info with sane defaults", () => {
			const model = handler.getModel()
			expect(model.id).toBe(mockOptions.openAiModelId)
			expect(model.info).toBeDefined()
			expect(model.info.contextWindow).toBe(128_000)
			expect(model.info.supportsImages).toBe(false)
		})

		it("should handle undefined model ID", () => {
			const handlerWithoutModel = new OpenAiHandler({
				...mockOptions,
				openAiModelId: undefined,
			})
			const model = handlerWithoutModel.getModel()
			expect(model.id).toBe("")
			expect(model.info).toBeDefined()
		})

		it("should set preserveReasoning when openAiR1FormatEnabled is on", () => {
			const r1Handler = new OpenAiHandler({
				...mockOptions,
				openAiR1FormatEnabled: true,
			})
			const model = r1Handler.getModel()
			expect(model.info).toEqual({ ...openAiModelInfoSaneDefaults, preserveReasoning: true })
		})

		it("should set preserveReasoning for deepseek-reasoner model ids without the toggle", () => {
			const deepseekHandler = new OpenAiHandler({
				...mockOptions,
				openAiModelId: "deepseek-reasoner",
			})
			const model = deepseekHandler.getModel()
			expect(model.info.preserveReasoning).toBe(true)
		})

		it("should merge preserveReasoning into custom model info when openAiR1FormatEnabled is on", () => {
			const customInfo: ModelInfo = {
				...openAiModelInfoSaneDefaults,
				contextWindow: 32_768,
				supportsImages: false,
			}
			const r1Handler = new OpenAiHandler({
				...mockOptions,
				openAiCustomModelInfo: customInfo,
				openAiR1FormatEnabled: true,
			})
			const model = r1Handler.getModel()
			expect(model.info).toEqual({ ...customInfo, preserveReasoning: true })
			expect(model.info.contextWindow).toBe(32_768)
			expect(model.info.supportsImages).toBe(false)
		})

		it("should not set preserveReasoning by default", () => {
			const model = handler.getModel()
			expect(model.info.preserveReasoning).toBeUndefined()
		})
	})

	describe("Azure AI Inference Service", () => {
		const azureOptions = {
			...mockOptions,
			openAiBaseUrl: "https://test.services.ai.azure.com",
			openAiModelId: "deepseek-v3",
			azureApiVersion: "2024-05-01-preview",
		}

		it("should initialize with Azure AI Inference Service configuration", () => {
			const azureHandler = new OpenAiHandler(azureOptions)
			expect(azureHandler).toBeInstanceOf(OpenAiHandler)
			expect(azureHandler.getModel().id).toBe(azureOptions.openAiModelId)
		})

		it("should keep Azure AI Inference precedence when Azure mode is enabled", () => {
			vi.mocked(OpenAI).mockClear()
			vi.mocked(AzureOpenAI).mockClear()

			new OpenAiHandler({ ...azureOptions, openAiUseAzure: true })

			expect(vi.mocked(OpenAI)).toHaveBeenCalled()
			expect(vi.mocked(AzureOpenAI)).not.toHaveBeenCalled()
		})

		it("should handle streaming responses with Azure AI Inference Service", async () => {
			const azureHandler = new OpenAiHandler(azureOptions)
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = azureHandler.createMessage(systemPrompt, messages)
			const chunks = await collectStream(stream)

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")

			// Verify the API call was made with correct Azure AI Inference Service path
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: azureOptions.openAiModelId,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: "Hello!" },
					],
					stream: true,
					stream_options: { include_usage: true },
					// No custom temperature set → `temperature` is omitted.
					tools: undefined,
					tool_choice: undefined,
					parallel_tool_calls: true,
				},
				{ path: "/models/chat/completions" },
			)

			// Verify max_tokens is NOT included when not explicitly set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})

		it("should forward the task abortSignal together with the Azure AI Inference path", async () => {
			const azureHandler = new OpenAiHandler(azureOptions)
			const controller = new AbortController()

			await collectStream(
				azureHandler.createMessage(
					"You are a helpful assistant.",
					[{ role: "user", content: "Hello!" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ stream: true }), {
				signal: controller.signal,
				path: "/models/chat/completions",
			})
		})

		it("should handle non-streaming responses with Azure AI Inference Service", async () => {
			const azureHandler = new OpenAiHandler({
				...azureOptions,
				openAiStreamingEnabled: false,
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = azureHandler.createMessage(systemPrompt, messages)
			const chunks = await collectStream(stream)

			expect(chunks.length).toBeGreaterThan(0)
			const textChunk = chunks.find((chunk) => chunk.type === "text")
			const usageChunk = chunks.find((chunk) => chunk.type === "usage")

			expect(textChunk).toBeDefined()
			expect(textChunk?.text).toBe("Test response")
			expect(usageChunk).toBeDefined()
			expect(usageChunk?.inputTokens).toBe(10)
			expect(usageChunk?.outputTokens).toBe(5)

			// Verify the API call was made with correct Azure AI Inference Service path
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: azureOptions.openAiModelId,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: "Hello!" },
					],
					tools: undefined,
					tool_choice: undefined,
					parallel_tool_calls: true,
				},
				{ path: "/models/chat/completions" },
			)

			// Verify max_tokens is NOT included when not explicitly set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})

		it("should handle completePrompt with Azure AI Inference Service", async () => {
			const azureHandler = new OpenAiHandler(azureOptions)
			const result = await azureHandler.completePrompt("Test prompt")
			expect(result).toBe("Test response")
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: azureOptions.openAiModelId,
					messages: [{ role: "user", content: "Test prompt" }],
				},
				{ path: "/models/chat/completions" },
			)

			// Verify max_tokens is NOT included when includeMaxTokens is not set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})
	})

	describe("Grok xAI Provider", () => {
		const grokOptions = {
			...mockOptions,
			openAiBaseUrl: "https://api.x.ai/v1",
			openAiModelId: "grok-1",
		}

		it("should initialize with Grok xAI configuration", () => {
			const grokHandler = new OpenAiHandler(grokOptions)
			expect(grokHandler).toBeInstanceOf(OpenAiHandler)
			expect(grokHandler.getModel().id).toBe(grokOptions.openAiModelId)
		})

		it("should exclude stream_options when streaming with Grok xAI", async () => {
			const grokHandler = new OpenAiHandler(grokOptions)
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = grokHandler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: grokOptions.openAiModelId,
					stream: true,
				}),
				{},
			)

			const mockCalls = mockCreate.mock.calls
			const lastCall = mockCalls[mockCalls.length - 1]
			expect(lastCall[0]).not.toHaveProperty("stream_options")
		})
	})

	describe("Grok xAI false-positive prevention", () => {
		it("should NOT detect as Grok xAI when host contains 'x.ai' as a substring but is not x.ai (e.g. box.ai)", () => {
			const nonGrokOptions = {
				...mockOptions,
				openAiBaseUrl: "https://box.ai/v1",
				openAiModelId: "gpt-4o",
			}
			const handler = new OpenAiHandler(nonGrokOptions)
			expect(handler["_isGrokXAI"](nonGrokOptions.openAiBaseUrl)).toBe(false)
		})

		it("should NOT detect as Grok xAI for other domains containing 'x.ai' substring (e.g. fox.ai, max.ai)", () => {
			const handler = new OpenAiHandler({ ...mockOptions, openAiBaseUrl: "https://fox.ai/v1" })
			expect(handler["_isGrokXAI"]("https://fox.ai/v1")).toBe(false)
			expect(handler["_isGrokXAI"]("https://max.ai/v1")).toBe(false)
		})

		it("should detect as Grok xAI for api.x.ai", () => {
			const handler = new OpenAiHandler({ ...mockOptions, openAiBaseUrl: "https://api.x.ai/v1" })
			expect(handler["_isGrokXAI"]("https://api.x.ai/v1")).toBe(true)
		})

		it("should detect as Grok xAI for subdomains of x.ai (e.g. custom.x.ai)", () => {
			const handler = new OpenAiHandler({ ...mockOptions, openAiBaseUrl: "https://custom.x.ai/v1" })
			expect(handler["_isGrokXAI"]("https://custom.x.ai/v1")).toBe(true)
		})

		it("should detect as Grok xAI when api.x.ai uses a non-default port", () => {
			const handler = new OpenAiHandler({ ...mockOptions, openAiBaseUrl: "https://api.x.ai:8443/v1" })
			expect(handler["_isGrokXAI"]("https://api.x.ai:8443/v1")).toBe(true)
		})

		it("should exclude stream_options when streaming with api.x.ai on a non-default port", async () => {
			const portOptions = {
				...mockOptions,
				openAiBaseUrl: "https://api.x.ai:8443/v1",
				openAiModelId: "grok-1",
			}
			const handler = new OpenAiHandler(portOptions)
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello!" }]

			const stream = handler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: portOptions.openAiModelId,
					stream: true,
				}),
				{},
			)

			const mockCalls = mockCreate.mock.calls
			const lastCall = mockCalls[mockCalls.length - 1]
			expect(lastCall[0]).not.toHaveProperty("stream_options")
		})

		it("should include stream_options when using a non-Grok provider whose URL contains 'x.ai' substring", async () => {
			const nonGrokOptions = {
				...mockOptions,
				openAiBaseUrl: "https://box.ai/v1",
				openAiModelId: "gpt-4o",
			}
			const handler = new OpenAiHandler(nonGrokOptions)
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello!" }]

			const stream = handler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: nonGrokOptions.openAiModelId,
					stream: true,
				}),
				{},
			)

			const mockCalls = mockCreate.mock.calls
			const lastCall = mockCalls[mockCalls.length - 1]
			expect(lastCall[0]).toHaveProperty("stream_options")
			expect(lastCall[0].stream_options).toEqual({ include_usage: true })
		})
	})

	describe("O3 Family Models", () => {
		const o3Options = {
			...mockOptions,
			openAiModelId: "o3-mini",
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 65536,
				supportsPromptCache: false,
				reasoningEffort: "medium" as "low" | "medium" | "high",
			},
		}

		it("should handle O3 model with streaming and include max_completion_tokens when includeMaxTokens is true", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				includeMaxTokens: true,
				modelMaxTokens: 32000,
				modelTemperature: 0.5,
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3Handler.createMessage(systemPrompt, messages)
			await collectStream(stream)

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
					messages: [
						{
							role: "developer",
							content: "Formatting re-enabled\nYou are a helpful assistant.",
						},
						{ role: "user", content: "Hello!" },
					],
					stream: true,
					stream_options: { include_usage: true },
					reasoning_effort: "medium",
					temperature: undefined,
					// O3 models do not support deprecated max_tokens but do support max_completion_tokens
					max_completion_tokens: 32000,
				}),
				{},
			)
		})

		it("should forward the task abortSignal to O3 requests", async () => {
			const o3Handler = new OpenAiHandler(o3Options)
			const controller = new AbortController()

			await collectStream(
				o3Handler.createMessage(
					"You are a helpful assistant.",
					[{ role: "user", content: "Hello!" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "o3-mini", stream: true }), {
				signal: controller.signal,
			})
		})

		it.each([
			{ name: "standard", baseUrl: undefined },
			{ name: "Azure AI Inference", baseUrl: "https://test.services.ai.azure.com" },
		])("should forward the task abortSignal to non-streaming O3 requests ($name)", async ({ baseUrl }) => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				openAiStreamingEnabled: false,
				...(baseUrl ? { openAiBaseUrl: baseUrl, azureApiVersion: "2024-05-01-preview" } : {}),
			})
			const controller = new AbortController()

			await collectStream(
				o3Handler.createMessage(
					"You are a helpful assistant.",
					[{ role: "user", content: "Hello!" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "o3-mini" }), {
				signal: controller.signal,
				...(baseUrl ? { path: "/models/chat/completions" } : {}),
			})
		})

		it.each([true, false])("adds Extra Body fields to O3 requests when streaming is %s", async (streaming) => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				openAiStreamingEnabled: streaming,
				openAiExtraBody: JSON.stringify({ metadata: { completion_window: "balanced" } }),
			})

			await collectStream(o3Handler.createMessage("system", []))

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ metadata: { completion_window: "balanced" } }),
				{},
			)
		})

		it("should handle tool calls with O3 model in streaming mode", async () => {
			const o3Handler = new OpenAiHandler(o3Options)

			mockCreate.mockImplementation(async (_options) =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											function: { name: "test_tool", arguments: "" },
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						choices: [
							{
								delta: {
									tool_calls: [{ index: 0, function: { arguments: "{}" } }],
								},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			)

			const stream = o3Handler.createMessage("system", [])
			const chunks = await collectStream(stream)

			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			const toolCallPartialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallPartialChunks).toHaveLength(2)
			expect(toolCallPartialChunks[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_1",
				name: "test_tool",
				arguments: "",
			})
			expect(toolCallPartialChunks[1]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: undefined,
				name: undefined,
				arguments: "{}",
			})

			// Verify tool_call_end event is emitted when finish_reason is "tool_calls"
			const toolCallEndChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(toolCallEndChunks).toHaveLength(1)
		})

		it("should yield tool calls for O3 model even when finish_reason is not set (fallback behavior)", async () => {
			const o3Handler = new OpenAiHandler(o3Options)

			mockCreate.mockImplementation(async (_options) =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_o3_fallback",
											function: { name: "o3_fallback_tool", arguments: '{"o3":"test"}' },
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						choices: [
							{
								delta: {},
								finish_reason: "length",
							},
						],
					},
				]),
			)

			const stream = o3Handler.createMessage("system", [])
			const chunks = await collectStream(stream)

			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			const toolCallPartialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			expect(toolCallPartialChunks).toHaveLength(1)
			expect(toolCallPartialChunks[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_o3_fallback",
				name: "o3_fallback_tool",
				arguments: '{"o3":"test"}',
			})
		})

		it("should handle O3 model with streaming and exclude max_tokens when includeMaxTokens is false", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				includeMaxTokens: false,
				modelTemperature: 0.7,
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3Handler.createMessage(systemPrompt, messages)
			await collectStream(stream)

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
					messages: [
						{
							role: "developer",
							content: "Formatting re-enabled\nYou are a helpful assistant.",
						},
						{ role: "user", content: "Hello!" },
					],
					stream: true,
					stream_options: { include_usage: true },
					reasoning_effort: "medium",
					temperature: undefined,
				}),
				{},
			)

			// Verify max_tokens is NOT included
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})

		it("should handle O3 model non-streaming with reasoning_effort and max_completion_tokens when includeMaxTokens is true", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				openAiStreamingEnabled: false,
				includeMaxTokens: true,
				modelTemperature: 0.3,
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3Handler.createMessage(systemPrompt, messages)
			await collectStream(stream)

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
					messages: [
						{
							role: "developer",
							content: "Formatting re-enabled\nYou are a helpful assistant.",
						},
						{ role: "user", content: "Hello!" },
					],
					reasoning_effort: "medium",
					temperature: undefined,
					// O3 models do not support deprecated max_tokens but do support max_completion_tokens
					max_completion_tokens: 65536, // Using default maxTokens from o3Options
				}),
				{},
			)

			// Verify stream is not set
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("stream")
		})

		it("should handle tool calls with O3 model in non-streaming mode", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				openAiStreamingEnabled: false,
			})

			mockCreate.mockResolvedValueOnce({
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "test_tool",
										arguments: "{}",
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
				},
			})

			const stream = o3Handler.createMessage("system", [])
			const chunks = await collectStream(stream)

			const toolCallChunks = chunks.filter((chunk) => chunk.type === "tool_call")
			expect(toolCallChunks).toHaveLength(1)
			expect(toolCallChunks[0]).toEqual({
				type: "tool_call",
				id: "call_1",
				name: "test_tool",
				arguments: "{}",
			})
		})

		it("should use default temperature of 0 when not specified for O3 models", async () => {
			const o3Handler = new OpenAiHandler({
				...o3Options,
				// No modelTemperature specified
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3Handler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: undefined, // Temperature is not supported for O3 models
				}),
				{},
			)
		})

		it("should handle O3 model with Azure AI Inference Service respecting includeMaxTokens", async () => {
			const o3AzureHandler = new OpenAiHandler({
				...o3Options,
				openAiBaseUrl: "https://test.services.ai.azure.com",
				includeMaxTokens: false, // Should NOT include max_tokens
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3AzureHandler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
				}),
				{ path: "/models/chat/completions" },
			)

			// Verify max_tokens is NOT included when includeMaxTokens is false
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs).not.toHaveProperty("max_completion_tokens")
		})

		it("should NOT include max_tokens for O3 model with Azure AI Inference Service even when includeMaxTokens is true", async () => {
			const o3AzureHandler = new OpenAiHandler({
				...o3Options,
				openAiBaseUrl: "https://test.services.ai.azure.com",
				includeMaxTokens: true, // Should include max_tokens
			})
			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello!",
				},
			]

			const stream = o3AzureHandler.createMessage(systemPrompt, messages)
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "o3-mini",
					// O3 models do not support max_tokens
				}),
				{ path: "/models/chat/completions" },
			)
		})

		it("should exclude stream_options when O3 model uses Grok xAI base URL", async () => {
			const handler = new OpenAiHandler({ ...o3Options, openAiBaseUrl: "https://api.x.ai/v1" })
			const stream = handler.createMessage("You are a helpful assistant.", [{ role: "user", content: "Hello!" }])
			await stream.next()

			const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]
			expect(lastCall[0]).not.toHaveProperty("stream_options")
		})

		it("should include stream_options when O3 model uses non-Grok URL containing 'x.ai' substring", async () => {
			const handler = new OpenAiHandler({ ...o3Options, openAiBaseUrl: "https://box.ai/v1" })
			const stream = handler.createMessage("You are a helpful assistant.", [{ role: "user", content: "Hello!" }])
			await stream.next()

			const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]
			expect(lastCall[0]).toHaveProperty("stream_options")
			expect(lastCall[0].stream_options).toEqual({ include_usage: true })
		})
	})
})

describe("OpenAiHandler - strict tool schemas", () => {
	const systemPrompt = "You are a helpful assistant."
	const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello!" }]
	const tools: OpenAI.Chat.ChatCompletionFunctionTool[] = [
		{
			type: "function",
			function: {
				name: "test_tool",
				description: "A test tool",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
						offset: { type: "integer" },
					},
					required: ["path"],
				},
			},
		},
	]
	const constrainedTools: OpenAI.Chat.ChatCompletionFunctionTool[] = [
		{
			type: "function",
			function: {
				name: "ask_followup_question",
				description: "Ask a question",
				parameters: {
					type: "object",
					properties: {
						follow_up: {
							type: "array",
							items: { type: "string" },
							minItems: 1,
							maxItems: 4,
						},
					},
				},
			},
		},
	]
	const baseOptions = () =>
		makeApiHandlerOptions({
			openAiApiKey: "test-api-key",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "https://api.openai.com/v1",
		})

	beforeEach(() => {
		mockCreate.mockClear()
	})

	it("sends strict: true with normalized schemas by default", async () => {
		const handler = new OpenAiHandler(baseOptions())
		const stream = handler.createMessage(systemPrompt, messages, { taskId: "test-task", tools })
		await collectStream(stream)

		expect(mockCreate).toHaveBeenCalledTimes(1)
		const request = mockCreate.mock.calls[0][0]
		expect(request.tools).toHaveLength(1)
		expect(request.tools[0].function.strict).toBe(true)
		expect(request.tools[0].function.parameters.required).toEqual(["path", "offset"])
		expect(request.tools[0].function.parameters.additionalProperties).toBe(false)
	})

	it.each([undefined, true])("removes unsupported constraints when strict schemas are %s", async (strict) => {
		const options = strict === undefined ? baseOptions() : { ...baseOptions(), openAiStrictToolSchemas: strict }
		const handler = new OpenAiHandler(options)
		const stream = handler.createMessage(systemPrompt, messages, {
			taskId: "test-task",
			tools: constrainedTools,
		})
		await collectStream(stream)

		const request = mockCreate.mock.calls[0][0]
		const followUp = request.tools[0].function.parameters.properties.follow_up
		expect(request.tools[0].function.strict).toBe(true)
		expect(followUp.minItems).toBe(1)
		expect(followUp.maxItems).toBeUndefined()
	})

	it("sends strict: false with the declared schema when openAiStrictToolSchemas is false", async () => {
		const handler = new OpenAiHandler({ ...baseOptions(), openAiStrictToolSchemas: false })
		const stream = handler.createMessage(systemPrompt, messages, { taskId: "test-task", tools })
		await collectStream(stream)

		const request = mockCreate.mock.calls[0][0]
		expect(request.tools[0].function.strict).toBe(false)
		// Declared schema preserved: original required array, no additionalProperties coercion
		expect(request.tools[0].function.parameters).toEqual(tools[0].function.parameters)
	})

	it("keeps unsupported constraints when strict schemas are disabled", async () => {
		const handler = new OpenAiHandler({ ...baseOptions(), openAiStrictToolSchemas: false })
		const stream = handler.createMessage(systemPrompt, messages, {
			taskId: "test-task",
			tools: constrainedTools,
		})
		await collectStream(stream)

		const request = mockCreate.mock.calls[0][0]
		expect(request.tools[0].function.strict).toBe(false)
		expect(request.tools[0].function.parameters.properties.follow_up.maxItems).toBe(4)
	})

	it("propagates a gateway 400 that rejects strict tool schemas", async () => {
		const strictRejection = Object.assign(
			new Error("strict=true requires generated function arguments to satisfy the declared JSON Schema"),
			{ status: 400 },
		)
		mockCreate.mockRejectedValueOnce(strictRejection)

		const handler = new OpenAiHandler({ ...baseOptions(), openAiStrictToolSchemas: true })
		const stream = handler.createMessage(systemPrompt, messages, { taskId: "test-task", tools })

		let caught: unknown
		try {
			await collectStream(stream)
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error).message).toContain("OpenAI completion error")
		expect((caught as Error & { status?: number }).status).toBe(400)
	})

	it("omits tools when the request carries none", async () => {
		const handler = new OpenAiHandler(baseOptions())
		const stream = handler.createMessage(systemPrompt, messages)
		await collectStream(stream)

		const request = mockCreate.mock.calls[0][0]
		expect(request.tools).toBeUndefined()
	})

	it("sends strict: false for non-streaming requests when openAiStrictToolSchemas is false", async () => {
		const handler = new OpenAiHandler({
			...baseOptions(),
			openAiStreamingEnabled: false,
			openAiStrictToolSchemas: false,
		})
		const stream = handler.createMessage(systemPrompt, messages, { taskId: "test-task", tools })
		await collectStream(stream)

		const request = mockCreate.mock.calls[0][0]
		expect(request.tools[0].function.strict).toBe(false)
		expect(request.tools[0].function.parameters).toEqual(tools[0].function.parameters)
	})

	it("sends strict: true with normalized schemas for O3-family streaming requests by default", async () => {
		const handler = new OpenAiHandler({
			...baseOptions(),
			openAiModelId: "o3-mini",
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 65_536,
				supportsPromptCache: false,
				reasoningEffort: "medium" as "low" | "medium" | "high",
			},
		})
		const stream = handler.createMessage(systemPrompt, messages, { taskId: "test-task", tools })
		await collectStream(stream)

		const request = mockCreate.mock.calls[0][0]
		expect(request.model).toBe("o3-mini")
		expect(request.stream).toBe(true)
		expect(request.tools[0].function.strict).toBe(true)
		expect(request.tools[0].function.parameters.required).toEqual(["path", "offset"])
	})

	it("sends strict: false with the declared schema for O3-family streaming requests when disabled", async () => {
		// The streaming O3 branch builds its own request, so the strict argument
		// must be asserted on that path as well: dropping it at the streaming call
		// would otherwise keep passing the non-streaming test.
		const handler = new OpenAiHandler({
			...baseOptions(),
			openAiModelId: "o3-mini",
			openAiStrictToolSchemas: false,
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 65_536,
				supportsPromptCache: false,
				reasoningEffort: "medium" as "low" | "medium" | "high",
			},
		})
		const stream = handler.createMessage(systemPrompt, messages, { taskId: "test-task", tools })
		await collectStream(stream)

		const request = mockCreate.mock.calls[0][0]
		expect(request.model).toBe("o3-mini")
		expect(request.stream).toBe(true)
		expect(request.tools[0].function.strict).toBe(false)
		expect(request.tools[0].function.parameters).toEqual(tools[0].function.parameters)
	})

	it("sends strict: false with the declared schema for O3-family non-streaming requests when disabled", async () => {
		const handler = new OpenAiHandler({
			...baseOptions(),
			openAiModelId: "o3-mini",
			openAiStreamingEnabled: false,
			openAiStrictToolSchemas: false,
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 65_536,
				supportsPromptCache: false,
				reasoningEffort: "medium" as "low" | "medium" | "high",
			},
		})
		const stream = handler.createMessage(systemPrompt, messages, { taskId: "test-task", tools })
		await collectStream(stream)

		const request = mockCreate.mock.calls[0][0]
		expect(request.tools[0].function.strict).toBe(false)
		expect(request.tools[0].function.parameters).toEqual(tools[0].function.parameters)
	})
})

describe("OpenAiHandler Responses API (openAiUseResponsesApi)", () => {
	const systemPrompt = "You are a helpful assistant."
	const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

	const baseOptions: ApiHandlerOptions = {
		openAiApiKey: "test-key",
		openAiModelId: "my-terra-deployment",
		openAiBaseUrl: "https://gateway.corp.example/v1",
		openAiUseResponsesApi: true,
	}

	const functionTool = {
		type: "function" as const,
		function: {
			name: "read_file",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	}

	beforeEach(() => {
		mockCreate.mockClear()
		mockResponsesCreate.mockClear()
	})

	it.each([true, false, undefined])("preserves streaming=%s and Extra Body request precedence", async (streaming) => {
		const handler = new OpenAiHandler({
			...baseOptions,
			openAiStreamingEnabled: streaming,
			openAiExtraBody: JSON.stringify({ service_tier: "flex", model: "wrong", stream: !streaming }),
		})
		if (streaming === false) {
			mockResponsesCreate.mockResolvedValueOnce({
				output: [
					{ type: "message", content: [{ type: "output_text", text: "Answer" }] },
					{ type: "reasoning", summary: [{ type: "summary_text", text: "Thinking" }] },
					{ type: "function_call", call_id: "call-1", name: "read_file", arguments: "{}" },
				],
				usage: { input_tokens: 10, output_tokens: 5 },
			})
		}
		const chunks = await collectStream(handler.createMessage(systemPrompt, messages))
		expect(mockResponsesCreate.mock.calls[0][0]).toMatchObject({
			model: baseOptions.openAiModelId,
			stream: streaming !== false,
			service_tier: "flex",
		})
		if (streaming === false) {
			expect(chunks).toContainEqual({ type: "text", text: "Answer" })
			expect(chunks).toContainEqual({ type: "reasoning", text: "Thinking" })
			expect(chunks).toContainEqual({ type: "tool_call", id: "call-1", name: "read_file", arguments: "{}" })
			expect(chunks).toContainEqual(expect.objectContaining({ type: "usage", inputTokens: 10, outputTokens: 5 }))
		}
	})

	it.each(["plain", "😀", "\ud800", "\udfff", "a\ud800b", "\ud800\ud801\udc00"])(
		"sends well-formed prompt, history, and JSON tool arguments for %j",
		async (text) => {
			const history: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: text },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: text } }],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: text }] },
			]
			await collectStream(new OpenAiHandler(baseOptions).createMessage(text, history))
			const body = mockResponsesCreate.mock.calls[0][0]
			expectNoLoneSurrogates(body)
			for (const item of body.input) {
				if (item.type === "function_call") expectNoLoneSurrogates(JSON.parse(item.arguments))
			}
			expect(history[0].content).toBe(text)
			if (text === "😀" || text === "plain") expect(body.instructions).toBe(text)
		},
	)

	const optionCases = [true, false, undefined].flatMap((responses) =>
		[true, false, undefined].flatMap((streaming) =>
			[true, false].map((reasoning) => ({ responses, streaming, reasoning })),
		),
	)
	it.each(optionCases)(
		"preserves routing, tools, and reasoning for %j",
		async ({ responses, streaming, reasoning }) => {
			const handler = new OpenAiHandler({
				...baseOptions,
				openAiUseResponsesApi: responses,
				openAiStreamingEnabled: streaming,
				enableReasoningEffort: reasoning,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					supportsPromptCache: false,
					supportsReasoningEffort: true,
					reasoningEffort: "high",
				},
			})
			if (responses && streaming === false) mockResponsesCreate.mockResolvedValueOnce({ output: [] })
			await collectStream(
				handler.createMessage(systemPrompt, messages, makeCreateMessageMetadata({ tools: [functionTool] })),
			)
			expect(mockResponsesCreate.mock.calls.length).toBe(responses ? 1 : 0)
			expect(mockCreate.mock.calls.length).toBe(responses ? 0 : 1)
			if (responses) {
				const body = mockResponsesCreate.mock.calls[0][0]
				expect(body.stream).toBe(streaming !== false)
				expect(body.reasoning?.effort).toBe(reasoning ? "high" : undefined)
				expect(body.tools[0].name).toBe("read_file")
			}
		},
	)

	const units = [0x61, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xfffd]
	const textCases = units.flatMap((first) =>
		units.flatMap((second) => units.map((third) => String.fromCharCode(first, second, third))),
	)
	it.each(textCases)("sends well-formed text for generated UTF-16 input %j", async (text) => {
		await collectStream(new OpenAiHandler(baseOptions).createMessage(text, [{ role: "user", content: text }]))
		expectNoLoneSurrogates(mockResponsesCreate.mock.calls[0][0])
	})

	it("keeps distinct tool IDs paired after sanitization", async () => {
		const history: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "call\ud800", name: "read_file", input: { path: "a" } },
					{ type: "tool_use", id: "call\ud801", name: "read_file", input: { path: "b" } },
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call\ud800", content: "a" },
					{ type: "tool_result", tool_use_id: "call\ud801", content: "b" },
				],
			},
		]
		await collectStream(new OpenAiHandler(baseOptions).createMessage(systemPrompt, history))
		const input = mockResponsesCreate.mock.calls[0][0].input
		expectNoLoneSurrogates(input)
		expect(input[0].call_id).not.toBe(input[1].call_id)
		expect(input[2].call_id).toBe(input[0].call_id)
		expect(input[3].call_id).toBe(input[1].call_id)
	})

	it("resolves model parameters once on the Responses route", async () => {
		const handler = new OpenAiHandler(baseOptions)
		const getModel = vi.spyOn(handler, "getModel")
		await collectStream(handler.createMessage(systemPrompt, messages))
		expect(getModel).toHaveBeenCalledOnce()
	})

	it.each([true, false])(
		"does not attach a listener when construction fails with streaming=%s",
		async (streaming) => {
			const controller = new AbortController()
			const add = vi.spyOn(controller.signal, "addEventListener")
			const failure = new Error("history could not be read")
			const history: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					get content(): string {
						throw failure
					},
				},
			]
			await expect(
				collectStream(
					new OpenAiHandler({ ...baseOptions, openAiStreamingEnabled: streaming }).createMessage(
						systemPrompt,
						history,
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				),
			).rejects.toBe(failure)
			expect(add).not.toHaveBeenCalled()
			expect(mockResponsesCreate).not.toHaveBeenCalled()
		},
	)

	it.each(["before", "during"])("forwards an external abort %s the request", async (timing) => {
		const controller = new AbortController()
		const add = vi.spyOn(controller.signal, "addEventListener")
		const remove = vi.spyOn(controller.signal, "removeEventListener")
		if (timing === "before") controller.abort()
		const stream = new OpenAiHandler(baseOptions).createMessage(
			systemPrompt,
			messages,
			makeCreateMessageMetadata({ abortSignal: controller.signal }),
		)
		await stream.next()
		const signal: AbortSignal = mockResponsesCreate.mock.calls[0][1].signal
		expect(signal.aborted).toBe(timing === "before")
		controller.abort()
		expect(signal.aborted).toBe(true)
		await stream.return(undefined)
		if (timing === "before") expect(add).not.toHaveBeenCalled()
		else expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1])
	})

	it.each([true, false])("releases the listener on completion with streaming=%s", async (streaming) => {
		const controller = new AbortController()
		const add = vi.spyOn(controller.signal, "addEventListener")
		const remove = vi.spyOn(controller.signal, "removeEventListener")
		if (!streaming) mockResponsesCreate.mockResolvedValueOnce({ output: [], usage: null })
		await collectStream(
			new OpenAiHandler({ ...baseOptions, openAiStreamingEnabled: streaming }).createMessage(
				systemPrompt,
				messages,
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			),
		)
		expect(add).toHaveBeenCalledOnce()
		expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1])
	})

	it.each(["request", "iteration", "close"])("releases the listener on %s exit", async (exit) => {
		const controller = new AbortController()
		const add = vi.spyOn(controller.signal, "addEventListener")
		const remove = vi.spyOn(controller.signal, "removeEventListener")
		const failure = new Error("Request was aborted.")
		if (exit === "request") mockResponsesCreate.mockRejectedValueOnce(failure)
		if (exit === "iteration")
			mockResponsesCreate.mockResolvedValueOnce(
				(async function* () {
					controller.abort()
					yield { type: "response.output_text.delta", delta: "partial" }
					throw failure
				})(),
			)
		const stream = new OpenAiHandler(baseOptions).createMessage(
			systemPrompt,
			messages,
			makeCreateMessageMetadata({ abortSignal: controller.signal }),
		)
		if (exit === "close") {
			await stream.next()
			await stream.return(undefined)
		} else {
			await expect(collectStream(stream)).rejects.toMatchObject({ name: "AbortError" })
		}
		expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1])
	})

	it("preserves HTTP failures and releases the listener", async () => {
		const controller = new AbortController()
		const remove = vi.spyOn(controller.signal, "removeEventListener")
		mockResponsesCreate.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
		await expect(
			collectStream(
				new OpenAiHandler(baseOptions).createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			),
		).rejects.toMatchObject({ status: 429 })
		expect(remove).toHaveBeenCalledOnce()
	})

	it.each([
		{ type: "function" as const, function: { name: "read_file" } },
		{ type: "custom" as const, custom: { name: "read_file" } },
	])("maps named $type tool choices", async (choice) => {
		await collectStream(
			new OpenAiHandler(baseOptions).createMessage(
				systemPrompt,
				messages,
				makeCreateMessageMetadata({ tools: [functionTool], tool_choice: choice, parallelToolCalls: false }),
			),
		)
		expect(mockResponsesCreate.mock.calls[0][0]).toMatchObject({
			tool_choice: { type: choice.type, name: "read_file" },
			parallel_tool_calls: false,
		})
	})

	it.each([true, false])("honors temperature and output limits with support=%s", async (supportsTemperature) => {
		await collectStream(
			new OpenAiHandler({
				...baseOptions,
				modelTemperature: 0.4,
				includeMaxTokens: true,
				modelMaxTokens: 456,
				openAiCustomModelInfo: {
					contextWindow: 128_000,
					maxTokens: 1000,
					supportsPromptCache: false,
					supportsTemperature,
				},
			}).createMessage(systemPrompt, messages),
		)
		expect(mockResponsesCreate.mock.calls[0][0].temperature).toBe(supportsTemperature ? 0.4 : undefined)
		expect(mockResponsesCreate.mock.calls[0][0].max_output_tokens).toBe(456)
	})

	it.each(["message", "completion"])(
		"sends max_output_tokens from %s when includeMaxTokens is unset (UI shows it checked)",
		async (entry) => {
			const handler = new OpenAiHandler({
				...baseOptions,
				openAiStreamingEnabled: false,
				modelMaxTokens: 456,
				openAiCustomModelInfo: { contextWindow: 128_000, maxTokens: 1000, supportsPromptCache: false },
			})
			mockResponsesCreate.mockResolvedValueOnce({
				status: "completed",
				output: [{ type: "message", content: [{ type: "output_text", text: "Answer" }] }],
				usage: { input_tokens: 10, output_tokens: 5 },
			})
			if (entry === "message") await collectStream(handler.createMessage(systemPrompt, messages))
			else await handler.completePrompt("prompt")
			expect(mockResponsesCreate.mock.calls[0][0].max_output_tokens).toBe(456)
		},
	)

	it.each(["o1-mini", "o3-mini", "o4-mini"])(
		"routes %s to Responses before model-family dispatch",
		async (openAiModelId) => {
			await collectStream(
				new OpenAiHandler({ ...baseOptions, openAiModelId }).createMessage(systemPrompt, messages),
			)
			expect(mockResponsesCreate).toHaveBeenCalledOnce()
			expect(mockCreate).not.toHaveBeenCalled()
		},
	)

	it.each([true, false, undefined])(
		"routes single completions with streaming setting %s",
		async (openAiStreamingEnabled) => {
			const handler = new OpenAiHandler({
				...baseOptions,
				openAiStreamingEnabled,
				openAiExtraBody: '{"service_tier":"flex"}',
			})
			mockResponsesCreate.mockResolvedValueOnce({
				status: "completed",
				output: [
					{
						type: "message",
						content: [
							{ type: "output_text", text: "first" },
							{ type: "refusal", refusal: "ignored" },
							{ type: "output_text", text: "second" },
						],
					},
				],
			})
			const controller = new AbortController()
			expect(
				await handler.completePrompt("prompt\ud800", { abortSignal: controller.signal, timeoutMs: 1234 }),
			).toBe("firstsecond")
			expect(mockCreate).not.toHaveBeenCalled()
			expect(mockResponsesCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: baseOptions.openAiModelId,
					stream: false,
					store: false,
					service_tier: "flex",
				}),
				{ signal: controller.signal, timeout: 1234 },
			)
			expectNoLoneSurrogates(mockResponsesCreate.mock.calls[0][0])
		},
	)

	const terminalCases = ["message", "completion"].flatMap((entry) =>
		["failed", "incomplete", "cancelled"].map((status) => ({ entry, status })),
	)
	it.each(terminalCases)("rejects terminal $status from $entry", async ({ entry, status }) => {
		const handler = new OpenAiHandler({ ...baseOptions, openAiStreamingEnabled: false })
		mockResponsesCreate.mockResolvedValueOnce({
			status,
			output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
			error: { message: "server rejected", code: "server_error" },
		})
		const request =
			entry === "completion"
				? handler.completePrompt("prompt")
				: collectStream(handler.createMessage(systemPrompt, messages))
		await expect(request).rejects.toMatchObject({
			code: "server_error",
			message: expect.stringContaining("server rejected"),
		})
	})

	it.each(["message", "completion"])("preserves token-limit classification from $s", async (entry) => {
		const handler = new OpenAiHandler({ ...baseOptions, openAiStreamingEnabled: false })
		mockResponsesCreate.mockResolvedValueOnce({
			status: "incomplete",
			incomplete_details: { reason: "max_output_tokens" },
			output: [],
		})
		await expect(
			entry === "completion"
				? handler.completePrompt("prompt")
				: collectStream(handler.createMessage(systemPrompt, messages)),
		).rejects.toMatchObject({ name: "OutputTokenLimitError" })
	})

	it.each([KimiCodeHandler, MoonshotHandler, MimoHandler, DeepSeekHandler])(
		"isolates the inherited Responses flag in %s",
		async (Provider) => {
			const handler = new Provider({
				...baseOptions,
				apiModelId: "custom-model",
				kimiCodeAuthMethod: "api-key",
				kimiCodeApiKey: "key",
			})
			await collectStream(OpenAiHandler.prototype.createMessage.call(handler, systemPrompt, messages))
			await OpenAiHandler.prototype.completePrompt.call(handler, "prompt")
			expect(mockCreate).toHaveBeenCalledTimes(2)
			expect(mockResponsesCreate).not.toHaveBeenCalled()
		},
	)

	it.each([true, false])("round-trips all encrypted reasoning items with streaming=%s", async (streaming) => {
		const handler = new OpenAiHandler({ ...baseOptions, openAiStreamingEnabled: streaming })
		const reasoningItems = ["rs1", "rs2"].map((id, index) => ({
			type: "reasoning",
			id,
			summary: index === 0 ? undefined : [],
			encrypted_content: `opaque-${id}`,
		}))
		const expected = reasoningItems.map((item) => ({ ...item, summary: [] }))
		const output = [
			...reasoningItems,
			{ type: "function_call", call_id: "call1", name: "read_file", arguments: "{}" },
		]
		mockResponsesCreate.mockResolvedValueOnce(
			streaming
				? asyncStreamFrom([
						...[...reasoningItems].reverse().map((item) => ({ type: "response.output_item.done", item })),
						{ type: "response.completed", response: { status: "completed", output } },
					])
				: { status: "completed", output },
		)
		await collectStream(handler.createMessage(systemPrompt, messages))
		expect(handler.getReasoningDetails()).toEqual(
			expected.map((item) => ({
				...item,
				format: "openai-responses-v1",
				provider: providerIdentifiers.openai,
				endpoint: responsesReasoningScope(baseOptions.openAiBaseUrl!),
			})),
		)
		const saved = prepareApiConversationMessage({
			message: { role: "assistant", content: [{ type: "tool_use", id: "call1", name: "read_file", input: {} }] },
			api: handler,
			apiConfiguration: { ...baseOptions, apiProvider: providerIdentifiers.openai },
			apiConversationHistory: [],
		})
		const reloaded: typeof saved = JSON.parse(JSON.stringify(saved))
		mockResponsesCreate.mockResolvedValueOnce(
			streaming
				? asyncStreamFrom([{ type: "response.completed", response: { status: "completed" } }])
				: { status: "completed", output: [] },
		)
		await collectStream(
			handler.createMessage(systemPrompt, [
				reloaded,
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "call1", content: "result" }] },
			]),
		)
		const input = mockResponsesCreate.mock.calls[1][0].input
		expect(input.slice(0, 2)).toEqual(expected)
		expect(input[2]).toMatchObject({ type: "function_call", call_id: "call1" })
		expect(input[3]).toMatchObject({ type: "function_call_output", call_id: "call1" })
		expect(handler.getReasoningDetails()).toBeUndefined()
	})

	it.each([undefined, null, []])(
		"uses item fallback only when the completion snapshot is missing: %j",
		async (output) => {
			const handler = new OpenAiHandler(baseOptions)
			const item = { type: "reasoning", id: "rs1", summary: [], encrypted_content: "opaque" }
			mockResponsesCreate.mockResolvedValueOnce(
				asyncStreamFrom([
					{ type: "response.output_item.done", item },
					{ type: "response.completed", response: { status: "completed", output } },
				]),
			)
			await collectStream(handler.createMessage(systemPrompt, messages))
			expect(handler.getReasoningDetails()).toEqual(output ? undefined : [expect.objectContaining(item)])
		},
	)

	it.each(["endpoint", "chat"])("does not forward saved reasoning after switching %s", async (destination) => {
		const handler = new OpenAiHandler(baseOptions)
		const item = { type: "reasoning", id: "rs1", summary: [], encrypted_content: "private-opaque" }
		mockResponsesCreate.mockResolvedValueOnce(
			asyncStreamFrom([{ type: "response.completed", response: { status: "completed", output: [item] } }]),
		)
		await collectStream(handler.createMessage(systemPrompt, messages))
		const saved = prepareApiConversationMessage({
			message: { role: "assistant", content: "answer" },
			api: handler,
			apiConfiguration: { ...baseOptions, apiProvider: providerIdentifiers.openai },
			apiConversationHistory: [],
		})
		const reloaded: typeof saved = JSON.parse(JSON.stringify(saved))
		const next = new OpenAiHandler({
			...baseOptions,
			openAiUseResponsesApi: destination !== "chat",
			openAiBaseUrl: destination === "chat" ? baseOptions.openAiBaseUrl : "https://other.example/v1",
		})
		mockCreate.mockClear()
		mockResponsesCreate.mockClear()
		await collectStream(next.createMessage(systemPrompt, [reloaded]))
		const calls = destination === "chat" ? mockCreate.mock.calls : mockResponsesCreate.mock.calls
		expect(calls).toHaveLength(1)
		expect(JSON.stringify(calls[0][0])).not.toContain("private-opaque")
		expect(JSON.stringify(calls[0][0])).not.toContain("reasoning_details")
	})

	it("returns a fresh copy of encrypted reasoning details", async () => {
		const handler = new OpenAiHandler(baseOptions)
		const item = {
			type: "reasoning",
			id: "rs1",
			summary: [{ type: "summary_text", text: "summary" }],
			encrypted_content: "opaque",
		}
		mockResponsesCreate.mockResolvedValueOnce(
			asyncStreamFrom([{ type: "response.completed", response: { status: "completed", output: [item] } }]),
		)
		await collectStream(handler.createMessage(systemPrompt, messages))
		const details = handler.getReasoningDetails()!
		details[0].encrypted_content = "changed"
		details[0].summary[0].text = "changed"
		expect(handler.getReasoningDetails()?.[0]).toMatchObject(item)
	})

	it("normalizes an aborted Responses completion", async () => {
		const handler = new OpenAiHandler(baseOptions)
		const controller = new AbortController()
		mockResponsesCreate.mockImplementationOnce(async (_body, options) => {
			controller.abort()
			options.signal.throwIfAborted()
		})
		await expect(handler.completePrompt("prompt", { abortSignal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(mockResponsesCreate.mock.calls[0][1].signal).toBe(controller.signal)
	})

	it.each(["failure", "close", "construction"])("clears prior reasoning on $s", async (exit) => {
		const handler = new OpenAiHandler(baseOptions)
		const item = { type: "reasoning", id: "rs1", summary: [], encrypted_content: "opaque" }
		mockResponsesCreate.mockResolvedValueOnce(
			asyncStreamFrom([{ type: "response.completed", response: { status: "completed", output: [item] } }]),
		)
		await collectStream(handler.createMessage(systemPrompt, messages))
		expect(handler.getReasoningDetails()).toEqual([expect.objectContaining(item)])
		if (exit === "construction") {
			vi.spyOn(handler, "getModel").mockImplementationOnce(() => {
				throw new Error("construction failed")
			})
			await expect(collectStream(handler.createMessage(systemPrompt, messages))).rejects.toThrow()
		} else {
			mockResponsesCreate.mockResolvedValueOnce(
				asyncStreamFrom([
					{ type: "response.output_item.done", item },
					{ type: "response.output_text.delta", delta: "partial" },
					{ type: "response.failed", response: { error: { message: "failed" } } },
				]),
			)
			const stream = handler.createMessage(systemPrompt, messages)
			if (exit === "close") {
				await stream.next()
				await stream.return(undefined)
			} else await expect(collectStream(stream)).rejects.toThrow()
		}
		expect(handler.getReasoningDetails()).toBeUndefined()
	})

	it("passes the strict-schema setting through the Responses tool mapper", async () => {
		await collectStream(
			new OpenAiHandler({ ...baseOptions, openAiStrictToolSchemas: false }).createMessage(
				systemPrompt,
				messages,
				makeCreateMessageMetadata({ tools: [functionTool] }),
			),
		)
		expect(mockResponsesCreate.mock.calls[0][0].tools[0]).toMatchObject({
			strict: false,
			parameters: functionTool.function.parameters,
		})
	})

	it.each(["none", "max"] as const)("preserves model-specific reasoning effort %s", async (reasoningEffort) => {
		const handler = new OpenAiHandler({
			...baseOptions,
			enableReasoningEffort: true,
			openAiCustomModelInfo: {
				contextWindow: 128000,
				supportsPromptCache: false,
				supportsReasoningEffort: true,
				reasoningEffort,
			},
		})
		await collectStream(handler.createMessage(systemPrompt, messages))
		expect(mockResponsesCreate.mock.calls[0][0].reasoning.effort).toBe(reasoningEffort)
		if (reasoningEffort === "none") expect(mockResponsesCreate.mock.calls[0][0]).not.toHaveProperty("include")
	})

	it.each(["openai.azure.com", "services.ai.azure.com"])("preserves Azure v1 endpoint on %s", (host) => {
		new OpenAiHandler({
			...baseOptions,
			openAiBaseUrl: `https://resource.${host}/openai/v1/`,
			openAiUseAzure: true,
		})
		expect(vi.mocked(OpenAI)).toHaveBeenLastCalledWith(
			expect.objectContaining({ baseURL: `https://resource.${host}/openai/v1/` }),
		)
	})

	it("uses Azure v1 for Responses when no dated version was selected", () => {
		new OpenAiHandler({ ...baseOptions, openAiBaseUrl: "https://resource.openai.azure.com/openai" })
		expect(vi.mocked(OpenAI)).toHaveBeenLastCalledWith(
			expect.objectContaining({ baseURL: "https://resource.openai.azure.com/openai/v1" }),
		)
	})

	it("preserves an explicit Azure API version", () => {
		new OpenAiHandler({
			...baseOptions,
			openAiBaseUrl: "https://resource.openai.azure.com",
			azureApiVersion: "custom-version",
		})
		expect(vi.mocked(AzureOpenAI)).toHaveBeenLastCalledWith(
			expect.objectContaining({
				apiVersion: "custom-version",
				baseURL: "https://resource.openai.azure.com/openai",
			}),
		)
	})

	it("rejects the legacy Azure AI Inference Responses combination", () => {
		expect(
			() => new OpenAiHandler({ ...baseOptions, openAiBaseUrl: "https://resource.services.ai.azure.com" }),
		).toThrow("/openai/v1")
	})

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, 1.2])(
		"normalizes completion timeout %s",
		async (timeoutMs) => {
			const handler = new OpenAiHandler(baseOptions)
			mockResponsesCreate.mockResolvedValueOnce({ status: "completed", output: [] })
			await handler.completePrompt("prompt", { timeoutMs })
			const options = mockResponsesCreate.mock.calls[0][1]
			if (timeoutMs === 1.2) expect(options).toHaveProperty("timeout", 2)
			else expect(options).not.toHaveProperty("timeout")
		},
	)

	it.each(["openai.azure.com", "services.ai.azure.com"])(
		"uses the chat path under the explicit Azure v1 root on %s",
		async (host) => {
			const handler = new OpenAiHandler({
				...baseOptions,
				openAiUseResponsesApi: false,
				openAiBaseUrl: `https://resource.${host}/openai/v1/`,
			})
			await collectStream(handler.createMessage(systemPrompt, messages))
			expect(mockCreate).toHaveBeenCalledOnce()
			expect(mockCreate.mock.calls[0][1]).not.toHaveProperty("path")
		},
	)

	it("rejects EOF without a terminal completion and does not publish partial reasoning", async () => {
		const handler = new OpenAiHandler(baseOptions)
		mockResponsesCreate.mockResolvedValueOnce(
			asyncStreamFrom([
				{
					type: "response.output_item.done",
					item: { type: "reasoning", id: "rs1", encrypted_content: "opaque", summary: [] },
				},
				{ type: "response.output_text.delta", delta: "partial" },
			]),
		)
		await expect(collectStream(handler.createMessage(systemPrompt, messages))).rejects.toThrow(
			"before a completed response",
		)
		expect(handler.getReasoningDetails()).toBeUndefined()
	})

	it("routes createMessage to the Responses API and not Chat Completions", async () => {
		const handler = new OpenAiHandler(baseOptions)
		const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

		expect(mockResponsesCreate).toHaveBeenCalledOnce()
		expect(mockCreate).not.toHaveBeenCalled()

		const body = mockResponsesCreate.mock.calls[0][0]
		expect(body.model).toBe("my-terra-deployment")
		expect(body.instructions).toBe(systemPrompt)
		expect(body.stream).toBe(true)
		expect(body.store).toBe(false)
		expect(body).not.toHaveProperty("reasoning_effort")

		// The shared Responses stream processor surfaces text and usage chunks.
		expect(chunks).toContainEqual({ type: "text", text: "Test response" })
		expect(chunks.some((chunk) => chunk.type === "usage")).toBe(true)
	})

	it("translates reasoning_effort into reasoning: { effort } and keeps function tools", async () => {
		const handler = new OpenAiHandler({
			...baseOptions,
			enableReasoningEffort: true,
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				supportsPromptCache: false,
				supportsReasoningEffort: true,
				reasoningEffort: "high",
			},
		})

		await collectStream(
			handler.createMessage(systemPrompt, messages, makeCreateMessageMetadata({ tools: [functionTool] })),
		)

		expect(mockResponsesCreate).toHaveBeenCalledOnce()
		const body = mockResponsesCreate.mock.calls[0][0]
		expect(body.reasoning).toEqual({ effort: "high" })
		expect(body.include).toEqual(["reasoning.encrypted_content"])
		// Reasoning and tools are combined on the Responses API path — neither is dropped.
		expect(body.tools).toEqual([
			{
				type: "function",
				name: "read_file",
				description: "Read a file",
				parameters: expect.objectContaining({ type: "object" }),
				strict: true,
			},
		])
		expect(body.tool_choice).toBeUndefined()
		expect(body.parallel_tool_calls).toBe(true)
	})

	it("omits reasoning when reasoning effort is disabled", async () => {
		const handler = new OpenAiHandler({
			...baseOptions,
			enableReasoningEffort: false,
			openAiCustomModelInfo: { contextWindow: 128_000, supportsPromptCache: false },
		})

		await collectStream(handler.createMessage(systemPrompt, messages))

		expect(mockResponsesCreate).toHaveBeenCalledOnce()
		const body = mockResponsesCreate.mock.calls[0][0]
		expect(body).not.toHaveProperty("reasoning")
		expect(body).not.toHaveProperty("include")
	})

	it("passes string tool_choice through unchanged", async () => {
		const handler = new OpenAiHandler(baseOptions)

		await collectStream(
			handler.createMessage(
				systemPrompt,
				messages,
				makeCreateMessageMetadata({ tools: [functionTool], tool_choice: "auto" }),
			),
		)

		const body = mockResponsesCreate.mock.calls[0][0]
		expect(body.tool_choice).toBe("auto")
	})

	it("keeps Chat Completions as the default when the setting is off", async () => {
		const handler = new OpenAiHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "https://api.openai.com/v1",
		})

		await collectStream(handler.createMessage(systemPrompt, messages))

		expect(mockCreate).toHaveBeenCalled()
		expect(mockResponsesCreate).not.toHaveBeenCalled()
	})
})

describe("getOpenAiModels", () => {
	beforeEach(() => {
		vi.mocked(axios.get).mockClear()
	})

	it("should return empty array when baseUrl is not provided", async () => {
		const result = await getOpenAiModels(undefined, "test-key")
		expect(result).toEqual([])
		expect(axios.get).not.toHaveBeenCalled()
	})

	it("should return empty array when baseUrl is empty string", async () => {
		const result = await getOpenAiModels("", "test-key")
		expect(result).toEqual([])
		expect(axios.get).not.toHaveBeenCalled()
	})

	it("should trim whitespace from baseUrl", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "gpt-4" }, { id: "gpt-3.5-turbo" }],
			},
		}
		vi.mocked(axios.get).mockResolvedValueOnce(mockResponse)

		const result = await getOpenAiModels("  https://api.openai.com/v1  ", "test-key")

		expect(axios.get).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.any(Object))
		expect(result).toEqual(["gpt-4", "gpt-3.5-turbo"])
	})

	it("should handle baseUrl with trailing spaces", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "model-1" }, { id: "model-2" }],
			},
		}
		vi.mocked(axios.get).mockResolvedValueOnce(mockResponse)

		const result = await getOpenAiModels("https://api.example.com/v1 ", "test-key")

		expect(axios.get).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.any(Object))
		expect(result).toEqual(["model-1", "model-2"])
	})

	it("should handle baseUrl with leading spaces", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "model-1" }],
			},
		}
		vi.mocked(axios.get).mockResolvedValueOnce(mockResponse)

		const result = await getOpenAiModels(" https://api.example.com/v1", "test-key")

		expect(axios.get).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.any(Object))
		expect(result).toEqual(["model-1"])
	})

	it("should return empty array for invalid URL after trimming", async () => {
		const result = await getOpenAiModels("   not-a-valid-url   ", "test-key")
		expect(result).toEqual([])
		expect(axios.get).not.toHaveBeenCalled()
	})

	it("should include authorization header when apiKey is provided", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "model-1" }],
			},
		}
		vi.mocked(axios.get).mockResolvedValueOnce(mockResponse)

		await getOpenAiModels("https://api.example.com/v1", "test-api-key")

		expect(axios.get).toHaveBeenCalledWith(
			"https://api.example.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer test-api-key",
				}),
			}),
		)
	})

	it("should include custom headers when provided", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "model-1" }],
			},
		}
		vi.mocked(axios.get).mockResolvedValueOnce(mockResponse)

		const customHeaders = {
			"X-Custom-Header": "custom-value",
		}

		await getOpenAiModels("https://api.example.com/v1", "test-key", customHeaders)

		expect(axios.get).toHaveBeenCalledWith(
			"https://api.example.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({
					"X-Custom-Header": "custom-value",
					Authorization: "Bearer test-key",
				}),
			}),
		)
	})

	it("should handle API errors gracefully", async () => {
		vi.mocked(axios.get).mockRejectedValueOnce(new Error("Network error"))

		const result = await getOpenAiModels("https://api.example.com/v1", "test-key")

		expect(result).toEqual([])
	})

	it("should handle malformed response data", async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({ data: null })

		const result = await getOpenAiModels("https://api.example.com/v1", "test-key")

		expect(result).toEqual([])
	})

	it("should deduplicate model IDs", async () => {
		const mockResponse = {
			data: {
				data: [{ id: "gpt-4" }, { id: "gpt-4" }, { id: "gpt-3.5-turbo" }, { id: "gpt-4" }],
			},
		}
		vi.mocked(axios.get).mockResolvedValueOnce(mockResponse)

		const result = await getOpenAiModels("https://api.example.com/v1", "test-key")

		expect(result).toEqual(["gpt-4", "gpt-3.5-turbo"])
	})
})

describe("OpenAiHandler lone surrogate sanitization (#461)", () => {
	beforeEach(() => {
		mockCreate.mockClear()
	})

	it("sends a request body free of lone surrogates, keeping tool call/result pairing intact", async () => {
		const lone = "bad\uD800end"
		const sanitized = "bad\uFFFDend"
		const handler = new OpenAiHandler(
			makeApiHandlerOptions({
				openAiApiKey: "test-api-key",
				openAiModelId: "gpt-4",
				openAiBaseUrl: "https://api.openai.com/v1",
			}),
		)
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

		// The whole body (system prompt, messages, tools) must be free of lone surrogates.
		// Inspect the raw values: JSON.stringify escapes lone surrogates as \udXXX text, so
		// a regex over the serialized body can never fail. See expectNoLoneSurrogates.
		expectNoLoneSurrogates(request)

		expect(request.messages[0]).toEqual({ role: "system", content: "system \uFFFD prompt" })

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
	})

	it("sanitizes the system prompt inside the cache_control block when streaming with prompt caching", async () => {
		const handler = new OpenAiHandler(
			makeApiHandlerOptions({
				openAiApiKey: "test-api-key",
				openAiModelId: "gpt-4",
				openAiBaseUrl: "https://api.openai.com/v1",
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, supportsPromptCache: true },
			}),
		)

		await collectStream(
			handler.createMessage("system \uD800 prompt", [{ role: "user", content: "hi" }], { taskId: "task-1" }),
		)

		expect(mockCreate).toHaveBeenCalledOnce()
		const request = mockCreate.mock.calls[0][0]
		expect(request.messages[0]).toEqual({
			role: "system",
			content: [{ type: "text", text: "system \uFFFD prompt", cache_control: { type: "ephemeral" } }],
		})
		expect(request.stream).toBe(true)
		expectNoLoneSurrogates(request)
	})

	it("sanitizes the system prompt string for non-streaming requests", async () => {
		const handler = new OpenAiHandler(
			makeApiHandlerOptions({
				openAiApiKey: "test-api-key",
				openAiModelId: "gpt-4",
				openAiBaseUrl: "https://api.openai.com/v1",
				openAiStreamingEnabled: false,
			}),
		)

		await collectStream(
			handler.createMessage("system \uD800 prompt", [{ role: "user", content: "hi" }], { taskId: "task-1" }),
		)

		expect(mockCreate).toHaveBeenCalledOnce()
		const request = mockCreate.mock.calls[0][0]
		expect(request.messages[0]).toEqual({ role: "system", content: "system \uFFFD prompt" })
		expect(request.stream).toBeUndefined()
		expectNoLoneSurrogates(request)
	})

	it("sanitizes the o3 developer message when streaming", async () => {
		const handler = new OpenAiHandler(
			makeApiHandlerOptions({
				openAiApiKey: "test-api-key",
				openAiModelId: "o3-mini",
				openAiBaseUrl: "https://api.openai.com/v1",
			}),
		)

		await collectStream(
			handler.createMessage("system \uD800 prompt", [{ role: "user", content: "hi" }], { taskId: "task-1" }),
		)

		expect(mockCreate).toHaveBeenCalledOnce()
		const request = mockCreate.mock.calls[0][0]
		expect(request.messages[0]).toEqual({
			role: "developer",
			content: "Formatting re-enabled\nsystem \uFFFD prompt",
		})
		expect(request.stream).toBe(true)
		expectNoLoneSurrogates(request)
	})

	it("sanitizes the o3 developer message for non-streaming requests", async () => {
		const handler = new OpenAiHandler(
			makeApiHandlerOptions({
				openAiApiKey: "test-api-key",
				openAiModelId: "o3-mini",
				openAiBaseUrl: "https://api.openai.com/v1",
				openAiStreamingEnabled: false,
			}),
		)

		await collectStream(
			handler.createMessage("system \uD800 prompt", [{ role: "user", content: "hi" }], { taskId: "task-1" }),
		)

		expect(mockCreate).toHaveBeenCalledOnce()
		const request = mockCreate.mock.calls[0][0]
		expect(request.messages[0]).toEqual({
			role: "developer",
			content: "Formatting re-enabled\nsystem \uFFFD prompt",
		})
		expect(request.stream).toBeUndefined()
		expectNoLoneSurrogates(request)
	})
})
