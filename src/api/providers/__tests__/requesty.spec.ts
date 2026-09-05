// npx vitest run api/providers/__tests__/requesty.spec.ts

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn().mockReturnValue(300_000),
}))

const MOCK_TIMEOUT_MS = 300_000

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import type { ModelRecord } from "@roo-code/types"

import { RequestyHandler } from "../requesty"
import { Package } from "../../../shared/package"
import { ApiHandlerCreateMessageMetadata } from "../../index"
import { makeApiHandlerOptions, makeCreateMessageMetadata } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { withSettleGuard } from "../../../test-utils/settle-guard"

const mockCreate = vitest.fn()

vitest.mock("openai", () => {
	return {
		default: vitest.fn().mockImplementation(function () {
			return {
				chat: {
					completions: {
						create: mockCreate,
					},
				},
			}
		}),
	}
})

vitest.mock("delay", () => ({
	default: vitest.fn(function () {
		return Promise.resolve()
	}),
}))

vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(function () {
		return Promise.resolve({
			"coding/claude-4-sonnet": {
				maxTokens: 8192,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude 4 Sonnet",
			},
			"anthropic/claude-fable-5": {
				maxTokens: 128000,
				contextWindow: 1000000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsReasoningBudget: true,
				supportsReasoningBinary: true,
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
				supportsReasoningBudget: true,
				supportsReasoningBinary: true,
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
				supportsReasoningBudget: true,
				supportsReasoningBinary: true,
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
				supportsReasoningBudget: true,
				supportsReasoningBinary: true,
				supportsTemperature: false,
				inputPrice: 5,
				outputPrice: 25,
				cacheWritesPrice: 6.25,
				cacheReadsPrice: 0.5,
				description: "Claude Opus 5",
			},
		})
	}),
	refreshModels: vitest.fn(async (options) => {
		const { getModels } = await import("../fetchers/modelCache")
		return getModels(options)
	}),
}))

describe("RequestyHandler", () => {
	const mockOptions = makeApiHandlerOptions({
		requestyApiKey: "test-key",
		requestyModelId: "coding/claude-4-sonnet",
	})

	beforeEach(() => clearAllMocks())

	it("initializes with correct options", () => {
		const handler = new RequestyHandler(mockOptions)
		expect(handler).toBeInstanceOf(RequestyHandler)

		expect(OpenAI).toHaveBeenCalledWith({
			baseURL: "https://router.requesty.ai/v1",
			apiKey: mockOptions.requestyApiKey,
			defaultHeaders: {
				"HTTP-Referer": "https://github.com/Zoo-Code-Org/Zoo-Code",
				"X-Title": "Zoo Code",
				"User-Agent": `ZooCode/${Package.version}`,
			},
			timeout: MOCK_TIMEOUT_MS,
		})
	})

	it("can use a base URL instead of the default", () => {
		const handler = new RequestyHandler({ ...mockOptions, requestyBaseUrl: "https://custom.requesty.ai/v1" })
		expect(handler).toBeInstanceOf(RequestyHandler)

		expect(OpenAI).toHaveBeenCalledWith({
			baseURL: "https://custom.requesty.ai/v1",
			apiKey: mockOptions.requestyApiKey,
			defaultHeaders: {
				"HTTP-Referer": "https://github.com/Zoo-Code-Org/Zoo-Code",
				"X-Title": "Zoo Code",
				"User-Agent": `ZooCode/${Package.version}`,
			},
			timeout: MOCK_TIMEOUT_MS,
		})
	})

	describe("fetchModel", () => {
		it("returns correct model info when options are provided", async () => {
			const handler = new RequestyHandler(mockOptions)
			const result = await handler.fetchModel()

			expect(result).toMatchObject({
				id: mockOptions.requestyModelId,
				info: {
					maxTokens: 8192,
					contextWindow: 200000,
					supportsImages: true,
					supportsPromptCache: true,
					inputPrice: 3,
					outputPrice: 15,
					cacheWritesPrice: 3.75,
					cacheReadsPrice: 0.3,
					description: "Claude 4 Sonnet",
				},
			})
		})

		it("returns default model info when options are not provided", async () => {
			const handler = new RequestyHandler({})
			const result = await handler.fetchModel()

			expect(result).toMatchObject({
				id: mockOptions.requestyModelId,
				info: {
					maxTokens: 8192,
					contextWindow: 200000,
					supportsImages: true,
					supportsPromptCache: true,
					inputPrice: 3,
					outputPrice: 15,
					cacheWritesPrice: 3.75,
					cacheReadsPrice: 0.3,
					description: "Claude 4 Sonnet",
				},
			})
		})
	})

	describe("createMessage", () => {
		it("generates correct stream chunks", async () => {
			const handler = new RequestyHandler(mockOptions)

			const mockStream = asyncStreamFrom([
				{
					id: mockOptions.requestyModelId,
					choices: [{ delta: { content: "test response" } }],
				},
				{
					id: "test-id",
					choices: [{ delta: {} }],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 20,
						prompt_tokens_details: {
							caching_tokens: 5,
							cached_tokens: 2,
						},
					},
				},
			])

			mockCreate.mockResolvedValue(mockStream)

			const systemPrompt = "test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "test message" }]

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			// Verify stream chunks
			expect(chunks).toHaveLength(2) // One text chunk and one usage chunk
			expect(chunks[0]).toEqual({ type: "text", text: "test response" })
			expect(chunks[1]).toEqual({
				type: "usage",
				inputTokens: 10,
				outputTokens: 20,
				cacheWriteTokens: 5,
				cacheReadTokens: 2,
				totalCost: expect.any(Number),
			})

			// Verify OpenAI client was called with correct parameters
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					max_tokens: 8192,
					messages: [
						{
							role: "system",
							content: "test system prompt",
						},
						{
							role: "user",
							content: "test message",
						},
					],
					model: "coding/claude-4-sonnet",
					stream: true,
					stream_options: { include_usage: true },
					temperature: 0,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("forwards the settings reasoningEffort to the Requesty request", async () => {
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementationOnce(async () => ({
				"coding/claude-4-sonnet": {
					maxTokens: 8192,
					contextWindow: 200000,
					supportsImages: true,
					supportsPromptCache: true,
					supportsReasoningEffort: true,
					inputPrice: 3,
					outputPrice: 15,
					description: "Claude 4 Sonnet",
				},
			}))
			mockCreate.mockResolvedValue(asyncStreamFrom([{ id: "c1", choices: [{ delta: { content: "ok" } }] }]))
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "coding/claude-4-sonnet",
					reasoningEffort: "high",
				}),
			)

			const chunks = await collectStream(
				handler.createMessage("test system", [{ role: "user", content: "test" }]),
			)
			expect(chunks).toHaveLength(1)
			expect(mockCreate).toHaveBeenCalledTimes(1)
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: "coding/claude-4-sonnet", reasoning_effort: "high" }),
				expect.anything(),
			)
		})

		it("omits reasoning_effort when the settings effort is outside the model's supported set", async () => {
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementationOnce(async () => ({
				"coding/claude-4-sonnet": {
					maxTokens: 8192,
					contextWindow: 200000,
					supportsImages: true,
					supportsPromptCache: true,
					supportsReasoningEffort: ["low", "medium", "high"],
					inputPrice: 3,
					outputPrice: 15,
					description: "Claude 4 Sonnet",
				},
			}))
			mockCreate.mockResolvedValue(asyncStreamFrom([{ id: "c1", choices: [{ delta: { content: "ok" } }] }]))
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "coding/claude-4-sonnet",
					reasoningEffort: "minimal",
				}),
			)

			const chunks = await collectStream(
				handler.createMessage("test system", [{ role: "user", content: "test" }]),
			)
			expect(chunks).toHaveLength(1)
			expect(mockCreate).toHaveBeenCalledTimes(1)
			// "minimal" is outside ["low", "medium", "high"], so the key must be absent entirely.
			expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("reasoning_effort")
		})

		it("forwards the task metadata into the requesty-specific request block", async () => {
			mockCreate.mockResolvedValue(asyncStreamFrom([{ id: "c1", choices: [{ delta: { content: "ok" } }] }]))
			const handler = new RequestyHandler(mockOptions)

			const chunks = await collectStream(
				handler.createMessage("test system", [{ role: "user", content: "test" }], {
					taskId: "task-123",
					mode: "plan",
				}),
			)
			expect(chunks).toHaveLength(1)
			expect(mockCreate).toHaveBeenCalledTimes(1)
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					requesty: { trace_id: "task-123", extra: { mode: "plan" } },
				}),
				expect.anything(),
			)
		})

		it("tolerates chunks with empty choices before the first delta", async () => {
			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{ id: "c1", choices: [] },
					{ id: "c2", choices: [{ delta: { content: "after empty" } }] },
				]),
			)
			const handler = new RequestyHandler(mockOptions)

			const chunks = await collectStream(
				handler.createMessage("test system", [{ role: "user", content: "test" }]),
			)
			expect(chunks).toEqual([{ type: "text", text: "after empty" }])
		})

		it("streams tool_call_partial chunks when the tool call has no function payload", async () => {
			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{
						id: "c1",
						choices: [{ delta: { tool_calls: [{ index: 0, id: "call_123" }] } }],
					},
				]),
			)
			const handler = new RequestyHandler(mockOptions)

			const chunks = await collectStream(
				handler.createMessage("test system", [{ role: "user", content: "test" }]),
			)
			expect(chunks).toEqual([{ type: "tool_call_partial", index: 0, id: "call_123" }])
		})

		it("emits the usage chunk once when a final chunk carries no usage", async () => {
			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{ id: "c1", choices: [{ delta: { content: "text" } }] },
					{ id: "c2", choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
					{ id: "c3", choices: [{ delta: {} }] },
				]),
			)
			const handler = new RequestyHandler(mockOptions)

			const chunks = await collectStream(
				handler.createMessage("test system", [{ role: "user", content: "test" }]),
			)
			expect(chunks).toHaveLength(2)
			expect(chunks[0]).toEqual({ type: "text", text: "text" })
			expect(chunks[1]).toMatchObject({ type: "usage", inputTokens: 3, outputTokens: 4 })
		})

		it("does not emit a usage chunk when the stream reports no usage", async () => {
			mockCreate.mockResolvedValue(
				asyncStreamFrom([{ id: "c1", choices: [{ delta: { content: "only text" } }] }]),
			)
			const handler = new RequestyHandler(mockOptions)

			const chunks = await collectStream(
				handler.createMessage("test system", [{ role: "user", content: "test" }]),
			)
			expect(chunks).toEqual([{ type: "text", text: "only text" }])
		})

		it("uses adaptive thinking for Claude Fable 5 when reasoning is enabled", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-fable-5",
					enableReasoningEffort: true,
					modelMaxTokens: 32768,
				}),
			)

			const mockStream = asyncStreamFrom([
				{
					id: "test-id",
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 10, completion_tokens: 20 },
				},
			])

			mockCreate.mockResolvedValue(mockStream)

			const generator = handler.createMessage("test system prompt", [{ role: "user" as const, content: "test" }])
			await generator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-fable-5",
					max_tokens: 32768,
					thinking: { type: "adaptive" },
					temperature: undefined,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("uses adaptive thinking for Claude Fable 5.1 when reasoning is enabled", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-fable-5.1",
					enableReasoningEffort: true,
					modelMaxTokens: 32768,
				}),
			)

			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{
						id: "test-id",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 10, completion_tokens: 20 },
					},
				]),
			)

			const generator = handler.createMessage("test system prompt", [{ role: "user" as const, content: "test" }])
			await generator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-fable-5.1",
					max_tokens: 32768,
					thinking: { type: "adaptive" },
					temperature: undefined,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("uses adaptive thinking for Claude Sonnet 5 when reasoning is enabled", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-sonnet-5",
					enableReasoningEffort: true,
					modelMaxTokens: 32768,
				}),
			)

			const mockStream = asyncStreamFrom([
				{
					id: "test-id",
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 10, completion_tokens: 20 },
				},
			])

			mockCreate.mockResolvedValue(mockStream)

			const generator = handler.createMessage("test system prompt", [{ role: "user" as const, content: "test" }])
			await generator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-sonnet-5",
					max_tokens: 32768,
					thinking: { type: "adaptive" },
					temperature: undefined,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("uses adaptive thinking for Claude Opus 5 when reasoning is enabled", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-opus-5",
					enableReasoningEffort: true,
					modelMaxTokens: 32768,
				}),
			)

			const mockStream = asyncStreamFrom([
				{
					id: "test-id",
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 10, completion_tokens: 20 },
				},
			])

			mockCreate.mockResolvedValue(mockStream)

			const generator = handler.createMessage("test system prompt", [{ role: "user" as const, content: "test" }])
			await generator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-opus-5",
					max_tokens: 32768,
					thinking: { type: "adaptive" },
					temperature: undefined,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("handles API errors", async () => {
			const handler = new RequestyHandler(mockOptions)
			const mockError = new Error("API Error")
			mockCreate.mockRejectedValue(mockError)

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("API Error")
		})

		it("streams reasoning chunks from delta.reasoning_content", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning_content: "thinking..." } }] },
					{ id: "1", choices: [{ delta: { content: "answer" } }] },
					{
						id: "1",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
		})

		it("falls back to delta.reasoning when reasoning_content is absent", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning: "router-style thought" } }] },
					{
						id: "1",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
		})

		it("prefers delta.reasoning_content over delta.reasoning when both are present", async () => {
			const handler = new RequestyHandler(mockOptions)

			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{
								delta: {
									reasoning_content: "primary thought",
									reasoning: "fallback thought",
								},
							},
						],
					},
					{
						id: "1",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")

			expect(reasoningChunks).toEqual([{ type: "reasoning", text: "primary thought" }])
		})

		describe("native tool support", () => {
			const systemPrompt = "test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user" as const, content: "What's the weather?" },
			]

			const mockTools: OpenAI.Chat.ChatCompletionTool[] = [
				{
					type: "function",
					function: {
						name: "get_weather",
						description: "Get the current weather",
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

			beforeEach(() => {
				mockCreate.mockResolvedValue(
					asyncStreamFrom([
						{
							id: "test-id",
							choices: [{ delta: { content: "test response" } }],
						},
					]),
				)
			})

			it("should include tools in request when tools are provided", async () => {
				const metadata: ApiHandlerCreateMessageMetadata = {
					taskId: "test-task",
					tools: mockTools,
					tool_choice: "auto",
				}

				const handler = new RequestyHandler(mockOptions)
				const iterator = handler.createMessage(systemPrompt, messages, metadata)
				await iterator.next()

				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({
						tools: expect.arrayContaining([
							expect.objectContaining({
								type: "function",
								function: expect.objectContaining({
									name: "get_weather",
									description: "Get the current weather",
								}),
							}),
						]),
						tool_choice: "auto",
					}),
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				)
			})

			it("should handle tool_call_partial chunks in streaming response", async () => {
				mockCreate.mockResolvedValue(
					asyncStreamFrom([
						{
							id: "test-id",
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_123",
												function: {
													name: "get_weather",
													arguments: '{"location":',
												},
											},
										],
									},
								},
							],
						},
						{
							id: "test-id",
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												function: {
													arguments: '"New York"}',
												},
											},
										],
									},
								},
							],
						},
						{
							id: "test-id",
							choices: [{ delta: {} }],
							usage: { prompt_tokens: 10, completion_tokens: 20 },
						},
					]),
				)

				const metadata: ApiHandlerCreateMessageMetadata = {
					taskId: "test-task",
					tools: mockTools,
				}

				const handler = new RequestyHandler(mockOptions)
				const chunks = await collectStream(handler.createMessage(systemPrompt, messages, metadata))

				// Expect two tool_call_partial chunks and one usage chunk
				expect(chunks).toHaveLength(3)
				expect(chunks[0]).toEqual({
					type: "tool_call_partial",
					index: 0,
					id: "call_123",
					name: "get_weather",
					arguments: '{"location":',
				})
				expect(chunks[1]).toEqual({
					type: "tool_call_partial",
					index: 0,
					id: undefined,
					name: undefined,
					arguments: '"New York"}',
				})
				expect(chunks[2]).toMatchObject({
					type: "usage",
					inputTokens: 10,
					outputTokens: 20,
				})
			})
		})
		it("rejects with AbortError when the external signal is pre-aborted", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "response" } }] }]))

			const controller = new AbortController()
			controller.abort()
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			await expect(
				handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata).next(),
			).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
			// The fast-fail guard must reject before model discovery starts.
			const { getModels } = await import("../fetchers/modelCache")
			expect(vitest.mocked(getModels)).not.toHaveBeenCalled()
		})

		it("rejects with AbortError when the external signal aborts during deferred model discovery", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			// Model discovery is deferred: capture the resolver and settle it only at the end of
			// the test, so the abort deterministically lands while the lookup is still pending.
			// The barrier below (instead of a fixed sleep) synchronizes on the lookup starting.
			let resolveModelLookup!: (models: ModelRecord) => void
			const deferredModelLookup = new Promise<ModelRecord>((resolve) => {
				resolveModelLookup = resolve
			})
			let notifyLookupStarted!: () => void
			const lookupStarted = new Promise<void>((resolve) => {
				notifyLookupStarted = resolve
			})
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementationOnce(() => {
				notifyLookupStarted()
				return deferredModelLookup
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata)

			const nextPromise = generator.next()
			// Defensive: the fast-fail path may reject before the barrier below settles,
			// which would otherwise surface as an unhandled rejection.
			void nextPromise.catch(() => {})
			await withSettleGuard(lookupStarted)
			controller.abort()

			await expect(withSettleGuard(nextPromise)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()

			// Settle the abandoned lookup so it cannot outlive the test.
			resolveModelLookup({})
		})

		it("aborts the in-flight stream and rejects with AbortError when the external signal aborts", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			let requestSignal: AbortSignal | undefined
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				requestSignal = options?.signal
				// Emulate the OpenAI SDK: the first chunk arrives, then the in-flight
				// response body rejects once the request signal aborts.
				return (async function* () {
					yield { id: "1", choices: [{ delta: { content: "first" } }] }
					await new Promise<void>((resolve) => {
						expect(requestSignal).toBeDefined()
						if (requestSignal!.aborted) {
							resolve()
						} else {
							requestSignal!.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					const abortError = new Error("The user aborted a request")
					abortError.name = "AbortError"
					throw abortError
				})()
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata)

			const chunks: unknown[] = []
			const iteration = (async () => {
				for await (const chunk of generator) {
					chunks.push(chunk)
					if (chunk.type === "text") {
						// Abort while the stream is still in flight.
						controller.abort()
					}
				}
			})()

			await expect(withSettleGuard(iteration)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
			expect(chunks).toContainEqual({ type: "text", text: "first" })
		})
		it("rejects with AbortError when the stream ends normally after a mid-stream abort (swallowed AbortError)", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			// Simulate openai@5.23.2: the SDK stream iterator swallows the mid-stream
			// AbortError and returns normally instead of throwing, so the catch in
			// createMessage never runs. The per-request signal (second argument) is the
			// one the SDK observes.
			let requestSignal: AbortSignal | undefined
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				requestSignal = options?.signal
				return (async function* () {
					yield { id: "1", choices: [{ delta: { content: "partial" } }] }
					// Wait for the abort instead of polling: the iterator ends gracefully
					// (no throw) once the request signal aborts.
					await new Promise<void>((resolve) => {
						expect(requestSignal).toBeDefined()
						if (requestSignal!.aborted) {
							resolve()
						} else {
							requestSignal!.addEventListener("abort", () => resolve(), { once: true })
						}
					})
				})()
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata)

			const first = await generator.next()
			expect(first.value).toEqual({ type: "text", text: "partial" })
			// Abort mid-stream, after the first chunk has been yielded.
			controller.abort()

			// The stream ended normally, but createMessage must still reject with AbortError.
			await expect(withSettleGuard(generator.next())).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
		})
		it("does not emit buffered chunks after a mid-stream abort (iterator keeps delivering)", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			// Simulate openai@5.23.2 delivering a buffered chunk after the abort has already
			// fired, then ending the iterator normally (no throw).
			let requestSignal: AbortSignal | undefined
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				requestSignal = options?.signal
				return (async function* () {
					yield { id: "1", choices: [{ delta: { content: "partial" } }] }
					// Wait for the abort instead of polling: the buffered chunk is delivered
					// once the request signal aborts.
					await new Promise<void>((resolve) => {
						expect(requestSignal).toBeDefined()
						if (requestSignal!.aborted) {
							resolve()
						} else {
							requestSignal!.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					yield { id: "2", choices: [{ delta: { content: "after-abort" } }] }
				})()
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata)

			const first = await generator.next()
			expect(first.value).toEqual({ type: "text", text: "partial" })
			// Abort mid-stream, after the first chunk has been yielded.
			controller.abort()

			// The buffered second chunk must not be emitted, and the generator must reject
			// with the provider AbortError.
			await expect(withSettleGuard(generator.next())).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
		})
		it("rejects with AbortError when the external signal aborts during request creation", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			// Synchronize on request startup (instead of a fixed sleep) so the abort
			// deterministically lands while the request is in flight.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				notifyCreateStarted()
				// Emulate the OpenAI SDK: the pending request rejects when the signal aborts.
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve()
					} else {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true })
					}
				})
				const abortError = new Error("The user aborted a request")
				abortError.name = "AbortError"
				throw abortError
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata)

			const nextPromise = generator.next()
			// Defensive: the fast-fail path may reject before the barrier below settles,
			// which would otherwise surface as an unhandled rejection.
			void nextPromise.catch(() => {})
			await withSettleGuard(createStarted)
			controller.abort()

			await expect(withSettleGuard(nextPromise)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
		})

		it("rethrows non-abort creation errors from createMessage", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockImplementationOnce(async () => {
				throw new Error("boom")
			})

			const generator = handler.createMessage("sys", [{ role: "user", content: "hi" }])

			await expect(collectStream(generator)).rejects.toThrow("boom")
		})

		it("removes the external abort listener when the stream completes", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()
			const addSpy = vi.spyOn(controller.signal, "addEventListener")
			const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
			mockCreate.mockImplementationOnce(async () => {
				return asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "done" } }] }])
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata)

			await collectStream(generator)

			// The cleanup path must remove the exact listener that was registered, not just any
			// function: removing a different reference would leave the original abort listener
			// attached to the signal.
			const registeredListener = addSpy.mock.calls[0]?.[1] as EventListener | undefined
			expect(removeSpy).toHaveBeenCalledWith("abort", registeredListener)
			addSpy.mockRestore()
			removeSpy.mockRestore()
		})

		it("rethrows non-abort stream errors from createMessage", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockImplementationOnce(async () => {
				return (async function* () {
					yield { id: "1", choices: [{ delta: { content: "first" } }] }
					throw new Error("stream broke")
				})()
			})

			const generator = handler.createMessage("sys", [{ role: "user", content: "hi" }])

			await expect(collectStream(generator)).rejects.toThrow("stream broke")
		})
	})

	describe("completePrompt", () => {
		// The createMessage tests leave behind a persistent stream mock plus queued
		// one-shot implementations; reset so each completePrompt test starts from a clean
		// mock (its own mockSetup below is authoritative).
		beforeEach(() => {
			mockCreate.mockReset()
		})

		it("returns correct response", async () => {
			const handler = new RequestyHandler(mockOptions)
			const mockResponse = { choices: [{ message: { content: "test completion" } }] }

			mockCreate.mockResolvedValue(mockResponse)

			const result = await handler.completePrompt("test prompt")

			expect(result).toBe("test completion")

			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: mockOptions.requestyModelId,
					max_tokens: 8192,
					messages: [{ role: "system", content: "test prompt" }],
					temperature: 0,
				},
				{},
			)
		})

		it("omits temperature for Claude Fable 5 in completePrompt", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-fable-5",
				}),
			)
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "test completion" } }] })

			await handler.completePrompt("test prompt")

			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: "anthropic/claude-fable-5",
					max_tokens: 8192,
					messages: [{ role: "system", content: "test prompt" }],
					temperature: undefined,
				},
				{},
			)
		})

		it("omits temperature for Claude Sonnet 5 in completePrompt", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-sonnet-5",
				}),
			)
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "test completion" } }] })

			await handler.completePrompt("test prompt")

			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: "anthropic/claude-sonnet-5",
					max_tokens: 8192,
					messages: [{ role: "system", content: "test prompt" }],
					temperature: undefined,
				},
				{},
			)
		})

		it("omits temperature for Claude Opus 5 in completePrompt", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-opus-5",
				}),
			)
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "test completion" } }] })

			await handler.completePrompt("test prompt")

			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: "anthropic/claude-opus-5",
					max_tokens: 8192,
					messages: [{ role: "system", content: "test prompt" }],
					temperature: undefined,
				},
				{},
			)
		})

		it("handles API errors", async () => {
			const handler = new RequestyHandler(mockOptions)
			const mockError = new Error("API Error")
			mockCreate.mockRejectedValue(mockError)

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("API Error")
		})

		it("handles unexpected errors", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockRejectedValue(new Error("Unexpected error"))

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("Unexpected error")
		})
		it("should pass abort signal through to client", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			await handler.completePrompt("test prompt", { abortSignal: controller.signal })
			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {
				signal: controller.signal,
			})
		})

		it("should pass timeout through to client", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			// Capture the exact timeout signal instance the provider creates so the
			// test can assert identity, not just type, for the signal it forwards.
			const timeoutSignalSpy = vitest.spyOn(AbortSignal, "timeout")
			try {
				await handler.completePrompt("test prompt", { timeoutMs: 5000 })
				// Assert the factory argument and call count too: the identity check
				// below would also pass for a signal created with the wrong duration.
				expect(timeoutSignalSpy).toHaveBeenCalledTimes(1)
				expect(timeoutSignalSpy).toHaveBeenCalledWith(5000)
				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({ model: expect.any(String) }),
					expect.objectContaining({ timeout: 5000 }),
				)
				// Without a caller signal the merged signal is exactly the
				// AbortSignal.timeout instance; the SDK relies on it to reject with a
				// DOM-standard AbortError when the timeout fires.
				const clientOptions = mockCreate.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined
				const expectedSignal = timeoutSignalSpy.mock.results[0]?.value
				expect(expectedSignal).toBeInstanceOf(AbortSignal)
				expect(clientOptions?.signal).toBe(expectedSignal)
			} finally {
				// Restore on every exit path: a failed assertion above must not leave
				// the static spy installed for the remaining tests in this file.
				timeoutSignalSpy.mockRestore()
			}
		})

		it("should work without options (backward compatible)", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("response")
		})

		it("rejects with AbortError when the signal is pre-aborted", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			const controller = new AbortController()
			controller.abort()

			await expect(
				handler.completePrompt("test prompt", { abortSignal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
				message: "This operation was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("rejects with AbortError when the signal aborts during model lookup", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			// Model discovery is deferred and never settles: with rejectOnAbort racing the
			// lookup, the abort must end the request before the lookup resolves.
			let notifyLookupStarted!: () => void
			const lookupStarted = new Promise<void>((resolve) => {
				notifyLookupStarted = resolve
			})
			const deferredModelLookup = new Promise<ModelRecord>(() => {})
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementationOnce(() => {
				notifyLookupStarted()
				return deferredModelLookup
			})

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			// Defensive: the fast-fail path may reject before the barrier below settles,
			// which would otherwise surface as an unhandled rejection.
			void promise.catch(() => {})
			await withSettleGuard(lookupStarted)
			controller.abort()

			await expect(withSettleGuard(promise)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("rethrows non-abort model lookup failures from completePrompt", async () => {
			const handler = new RequestyHandler(mockOptions)
			const { getModels } = await import("../fetchers/modelCache")
			const lookupError = new Error("lookup failed")
			vitest.mocked(getModels).mockImplementationOnce(() => {
				return Promise.reject(lookupError)
			})

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("lookup failed")
		})

		it("normalizes raw AbortError lookup failures to the provider AbortError", async () => {
			const handler = new RequestyHandler(mockOptions)
			const { getModels } = await import("../fetchers/modelCache")
			const rawAbort = new Error("The user aborted a request")
			rawAbort.name = "AbortError"
			vitest.mocked(getModels).mockImplementationOnce(() => {
				return Promise.reject(rawAbort)
			})

			await expect(handler.completePrompt("test prompt")).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
		})

		it("rejects with AbortError when aborted mid-flight", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			// Deterministic synchronization (mirrors the Requesty test): the mock notifies the
			// test when the request actually starts, so the abort lands mid-flight (after model
			// lookup) instead of winning the race at model discovery on a slow runner.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				notifyCreateStarted()
				// Emulate the OpenAI SDK: the in-flight request rejects when the signal aborts.
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve()
					} else {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true })
					}
				})
				const abortError = new Error("The user aborted a request")
				abortError.name = "AbortError"
				throw abortError
			})

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			// Defensive: the fast-fail path may reject before the barrier below settles,
			// which would otherwise surface as an unhandled rejection.
			void promise.catch(() => {})
			// Abort only once create() has actually started (after model lookup).
			await withSettleGuard(createStarted)
			controller.abort()

			await expect(withSettleGuard(promise)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
		})
		it("rejects with AbortError when only a timeout is provided and it elapses", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				// Emulate the OpenAI SDK: the in-flight request rejects when the signal times out.
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve()
					} else {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true })
					}
				})
				const timeoutError = new Error("TimeoutError: Request timed out.")
				timeoutError.name = "TimeoutError"
				throw timeoutError
			})

			await expect(handler.completePrompt("test prompt", { timeoutMs: 50 })).rejects.toMatchObject({
				name: "AbortError",
			})
		})

		it("does not return a late result when the response resolves after abort", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			// Emulate the OpenAI SDK: the pending request resolves once the signal aborts,
			// i.e. after the caller has already cancelled.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				notifyCreateStarted()
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve()
					} else {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true })
					}
				})
				return { choices: [{ message: { content: "late" } }] }
			})

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			// Defensive: the fast-fail path may reject before the barrier below settles,
			// which would otherwise surface as an unhandled rejection.
			void promise.catch(() => {})
			// Abort while the request is in flight; the resolved response is late and must
			// be discarded instead of returned.
			await withSettleGuard(createStarted)
			controller.abort()

			await expect(withSettleGuard(promise)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
		})

		it("does not forward a non-positive timeout to the client", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			await handler.completePrompt("test prompt", { timeoutMs: 0 })
			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {})
		})

		it("rejects with AbortError when both an abort signal and a timeout are provided", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			let requestSignal: AbortSignal | undefined
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				notifyCreateStarted()
				requestSignal = options?.signal
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve()
					} else {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true })
					}
				})
				const abortError = new Error("The user aborted a request")
				abortError.name = "AbortError"
				throw abortError
			})

			const promise = handler.completePrompt("test prompt", {
				abortSignal: controller.signal,
				timeoutMs: 100_000,
			})
			// Defensive: the fast-fail path may reject before the barrier below settles,
			// which would otherwise surface as an unhandled rejection.
			void promise.catch(() => {})
			// Abort only once create() has actually started (after model lookup).
			await withSettleGuard(createStarted)
			controller.abort()

			await expect(withSettleGuard(promise)).rejects.toMatchObject({ name: "AbortError" })
			// The SDK received a merged signal (not the caller's signal) plus the timeout.
			expect(requestSignal).toBeDefined()
			expect(requestSignal).not.toBe(controller.signal)
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({
					timeout: 100_000,
				}),
			)
		})
	})
})
