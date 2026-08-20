import { poeDefaultModelId, providerIdentifiers } from "@roo-code/types"

import { PoeHandler } from "../poe"
import { getModelsFromCache } from "../fetchers/modelCache"

import { makeCreateMessageMetadata } from "../../../test-utils/api"
import { clearAllMocks } from "../../../test-utils/reset"

const { mockStreamText, mockGenerateText, mockCreatePoe, mockGetModelsFromCache, mockCaptureException } =
	vitest.hoisted(() => ({
		mockStreamText: vitest.fn(),
		mockGenerateText: vitest.fn(),
		mockCreatePoe: vitest.fn(),
		mockCaptureException: vitest.fn(),
		mockGetModelsFromCache: vitest.fn(),
	}))

const cachedModels = {
	"anthropic/claude-sonnet-4": {
		maxTokens: 10_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningBudget: true,
		inputPrice: 3,
		outputPrice: 15,
	},
	"openai/gpt-4o": {
		maxTokens: 16_384,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 2.5,
		outputPrice: 10,
	},
	"openai/o3": {
		maxTokens: 100_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: false,
		supportsReasoningEffort: ["low", "medium", "high"],
		inputPrice: 10,
		outputPrice: 40,
	},
}

vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: (...args: unknown[]) => mockCaptureException(...args),
		},
	},
}))

vitest.mock("ai-sdk-provider-poe", () => ({
	createPoe: (...args: unknown[]) => mockCreatePoe(...args),
}))

vitest.mock("ai-sdk-provider-poe/code", () => ({
	mapToolChoice: vitest.fn(function (value: unknown) {
		return value
	}),
	extractUsageMetrics: vitest.fn(function (usage: any) {
		return {
			inputTokens: usage?.inputTokens || 0,
			outputTokens: usage?.outputTokens || 0,
			cacheReadTokens: usage?.cacheReadTokens,
			cacheWriteTokens: usage?.cacheWriteTokens,
			reasoningTokens: usage?.reasoningTokens,
		}
	}),
	getPoeDefaultModelInfo: vitest.fn(function () {
		return {
			maxTokens: 8192,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			inputPrice: 3,
			outputPrice: 15,
		}
	}),
}))

vitest.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>()
	return {
		...actual,
		streamText: (...args: unknown[]) => mockStreamText(...args),
		generateText: (...args: unknown[]) => mockGenerateText(...args),
	}
})

vitest.mock("../fetchers/modelCache", () => ({
	getModelsFromCache: mockGetModelsFromCache,
}))

describe("PoeHandler", () => {
	const mockLanguageModel = { modelId: "test-model" }
	const mockPoeProvider = vitest.fn().mockReturnValue(mockLanguageModel)

	beforeEach(() => {
		clearAllMocks()
		mockCreatePoe.mockReturnValue(mockPoeProvider)
		mockGetModelsFromCache.mockReturnValue(cachedModels)
	})

	describe("constructor", () => {
		it("creates poe provider with api key and default base URL", () => {
			new PoeHandler({ poeApiKey: "test-key" })

			expect(mockCreatePoe).toHaveBeenCalledWith({
				apiKey: "test-key",
				baseURL: undefined,
			})
		})

		it("creates poe provider with custom base URL", () => {
			new PoeHandler({ poeApiKey: "key", poeBaseUrl: "https://custom.poe.com/v1" })

			expect(mockCreatePoe).toHaveBeenCalledWith({
				apiKey: "key",
				baseURL: "https://custom.poe.com/v1",
			})
		})

		it("uses fallback api key when not provided", () => {
			new PoeHandler({})

			expect(mockCreatePoe).toHaveBeenCalledWith({
				apiKey: "not-provided",
				baseURL: undefined,
			})
		})
	})

	describe("getModel", () => {
		it("returns model info from cache", () => {
			const options = {
				poeApiKey: "key",
				poeBaseUrl: "https://custom.poe.com/v1",
				apiModelId: "anthropic/claude-sonnet-4",
			}
			const handler = new PoeHandler(options)
			const result = handler.getModel()

			expect(getModelsFromCache).toHaveBeenCalledWith({
				provider: providerIdentifiers.poe,
				apiKey: options.poeApiKey,
				baseUrl: options.poeBaseUrl,
			})
			expect(result.id).toBe("anthropic/claude-sonnet-4")
			expect(result.info.contextWindow).toBe(200_000)
			expect(result.info.maxTokens).toBe(10_000)
		})

		it("returns default model when no model ID specified", () => {
			const handler = new PoeHandler({ poeApiKey: "key" })
			const result = handler.getModel()

			expect(result.id).toBe(poeDefaultModelId)
		})

		it("falls back to default model info when model not in cache", () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "unknown/model" })
			const result = handler.getModel()

			expect(result.id).toBe("unknown/model")
			expect(result.info.contextWindow).toBeGreaterThan(0)
			expect(result.info.maxTokens).toBeGreaterThan(0)
		})
	})

	describe("createMessage", () => {
		it("streams text chunks", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "anthropic/claude-sonnet-4" })

			const fullStream = (async function* () {
				yield { type: "text-delta", text: "Hello " }
				yield { type: "text-delta", text: "world!" }
			})()

			mockStreamText.mockReturnValue({
				fullStream,
				usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
			})

			const chunks = []
			for await (const chunk of handler.createMessage("system prompt", [
				{ role: "user" as const, content: "Hi" },
			])) {
				chunks.push(chunk)
			}

			expect(chunks).toContainEqual({ type: "text", text: "Hello " })
			expect(chunks).toContainEqual({ type: "text", text: "world!" })
			expect(chunks).toContainEqual(expect.objectContaining({ type: "usage", inputTokens: 10, outputTokens: 5 }))
		})

		it("reports synchronous completion failures with the canonical provider identifier", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })
			mockStreamText.mockImplementationOnce(() => {
				throw new Error("request failed")
			})

			await expect(
				handler.createMessage("system", [{ role: "user" as const, content: "hello" }]).next(),
			).rejects.toThrow("Poe completion error: request failed")
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					provider: providerIdentifiers.poe,
					modelId: "openai/gpt-4o",
					operation: "createMessage",
				}),
			)
		})

		it("reports asynchronous stream failures with the canonical provider identifier", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })
			const failedStream = {
				[Symbol.asyncIterator]() {
					return this
				},
				next: vitest.fn().mockRejectedValueOnce(new Error("stream failed")),
			}
			mockStreamText.mockReturnValueOnce({
				fullStream: failedStream,
				usage: Promise.resolve(undefined),
			})

			await expect(
				handler.createMessage("system", [{ role: "user" as const, content: "hello" }]).next(),
			).rejects.toThrow("Poe streaming error: stream failed")
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					provider: providerIdentifiers.poe,
					modelId: "openai/gpt-4o",
					operation: "createMessage",
				}),
			)
		})

		it("rejects with AbortError when the external signal is pre-aborted", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })
			mockStreamText.mockReturnValue({
				fullStream: (async function* () {})(),
				usage: Promise.resolve(undefined),
			})

			const controller = new AbortController()
			controller.abort()
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			await expect(
				handler.createMessage("system", [{ role: "user" as const, content: "hi" }], metadata).next(),
			).rejects.toMatchObject({
				name: "AbortError",
			})
		})

		it("aborts the in-flight stream and rejects with AbortError when the external signal aborts", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })

			let requestSignal: AbortSignal | undefined
			mockStreamText.mockImplementationOnce((args: { abortSignal?: AbortSignal }) => {
				requestSignal = args.abortSignal
				// Emulate the AI SDK: the first chunk arrives, then the stream errors once
				// the abort signal fires.
				const fullStream = (async function* () {
					yield { type: "text-delta", text: "Hello " }
					await new Promise<void>((resolve) => {
						if (requestSignal?.aborted) {
							resolve()
						} else {
							requestSignal?.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					const abortError = new Error("The operation was aborted")
					abortError.name = "AbortError"
					throw abortError
				})()
				return { fullStream, usage: Promise.resolve(undefined) }
			})

			const controller = new AbortController()
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			const chunks: unknown[] = []
			const iteration = (async () => {
				for await (const chunk of handler.createMessage(
					"system",
					[{ role: "user" as const, content: "hi" }],
					metadata,
				)) {
					chunks.push(chunk)
					if (chunk.type === "text") {
						// Abort while the stream is still in flight.
						controller.abort()
					}
				}
			})()

			await expect(iteration).rejects.toMatchObject({ name: "AbortError" })
			expect(chunks).toContainEqual({ type: "text", text: "Hello " })
		})
	})

	describe("reasoning", () => {
		it("passes anthropic thinking config for budget models", async () => {
			const handler = new PoeHandler({
				poeApiKey: "key",
				apiModelId: "anthropic/claude-sonnet-4",
				enableReasoningEffort: true,
				modelMaxThinkingTokens: 4096,
			})

			const fullStream = (async function* () {
				yield { type: "reasoning", text: "Let me think..." }
				yield { type: "text-delta", text: "Answer" }
			})()

			mockStreamText.mockReturnValue({
				fullStream,
				usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
			})

			const chunks = []
			const modelMaxTokens = handler.getModel().info.maxTokens ?? 0
			for await (const chunk of handler.createMessage("system", [
				{ role: "user" as const, content: "think about this" },
			])) {
				chunks.push(chunk)
			}

			const callArgs = mockStreamText.mock.calls[0][0]
			expect(callArgs.temperature).toBe(1.0)
			expect(callArgs.providerOptions).toEqual({
				poe: {
					reasoningBudgetTokens: 4096,
				},
			})
			expect(callArgs.maxOutputTokens).toBe(modelMaxTokens - 4096)

			expect(chunks).toContainEqual({ type: "reasoning", text: "Let me think..." })
			expect(chunks).toContainEqual({ type: "text", text: "Answer" })
		})

		it("passes openai reasoning effort for effort models", async () => {
			const handler = new PoeHandler({
				poeApiKey: "key",
				apiModelId: "openai/o3",
				enableReasoningEffort: true,
				reasoningEffort: "high",
			})

			const fullStream = (async function* () {
				yield { type: "text-delta", text: "Answer" }
			})()

			mockStreamText.mockReturnValue({
				fullStream,
				usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
			})

			for await (const _ of handler.createMessage("system", [{ role: "user" as const, content: "reason" }])) {
				/* drain */
			}

			expect(mockStreamText).toHaveBeenCalledWith(
				expect.objectContaining({
					providerOptions: {
						poe: {
							reasoningEffort: "high",
							reasoningSummary: "auto",
						},
					},
				}),
			)
		})

		it("does not pass providerOptions when reasoning is disabled", async () => {
			const handler = new PoeHandler({
				poeApiKey: "key",
				apiModelId: "anthropic/claude-sonnet-4",
				enableReasoningEffort: false,
			})

			const fullStream = (async function* () {
				yield { type: "text-delta", text: "Answer" }
			})()

			mockStreamText.mockReturnValue({
				fullStream,
				usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
			})

			for await (const _ of handler.createMessage("system", [{ role: "user" as const, content: "hi" }])) {
				/* drain */
			}

			const callArgs = mockStreamText.mock.calls[0][0]
			expect(callArgs.providerOptions).toBeUndefined()
			expect(callArgs.temperature).toBeUndefined()
		})

		it("uses default thinking budget when not specified", async () => {
			const handler = new PoeHandler({
				poeApiKey: "key",
				apiModelId: "anthropic/claude-sonnet-4",
				enableReasoningEffort: true,
			})

			const fullStream = (async function* () {})()
			mockStreamText.mockReturnValue({
				fullStream,
				usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
			})

			for await (const _ of handler.createMessage("system", [{ role: "user" as const, content: "hi" }])) {
				/* drain */
			}

			const callArgs = mockStreamText.mock.calls[0][0]
			expect(callArgs.providerOptions).toEqual({
				poe: {
					reasoningBudgetTokens: expect.any(Number),
				},
			})
			expect(callArgs.providerOptions.poe.reasoningBudgetTokens + callArgs.maxOutputTokens).toBe(
				handler.getModel().info.maxTokens,
			)
		})
	})

	describe("completePrompt", () => {
		it("returns generated text", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })

			mockGenerateText.mockResolvedValue({ text: "generated response" })

			const result = await handler.completePrompt("complete this")

			expect(result).toBe("generated response")
			expect(mockGenerateText).toHaveBeenCalledWith(
				expect.objectContaining({
					model: mockLanguageModel,
					prompt: "complete this",
				}),
			)
		})

		it("reports failures with the canonical provider identifier", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })
			mockGenerateText.mockRejectedValueOnce(new Error("generation failed"))

			await expect(handler.completePrompt("complete this")).rejects.toThrow(
				"Poe completion error: generation failed",
			)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					provider: providerIdentifiers.poe,
					modelId: "openai/gpt-4o",
					operation: "completePrompt",
				}),
			)
		})

		it("completePrompt should pass abort signal through to generateText", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })
			const controller = new AbortController()
			mockGenerateText.mockResolvedValueOnce({ text: "response" })

			await handler.completePrompt("test prompt", { abortSignal: controller.signal })
			expect(mockGenerateText).toHaveBeenCalledWith(
				expect.objectContaining({
					model: mockLanguageModel,
					prompt: "test prompt",
					abortSignal: controller.signal,
				}),
			)
		})

		it("completePrompt should work without options (backward compatible)", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })
			mockGenerateText.mockResolvedValueOnce({ text: "response" })

			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("response")
			expect(mockGenerateText).toHaveBeenCalledWith(
				expect.objectContaining({
					model: mockLanguageModel,
					prompt: "test prompt",
				}),
			)
		})

		it("completePrompt should merge signal and timeoutMs into combined abortSignal", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })
			const controller = new AbortController()
			mockGenerateText.mockResolvedValueOnce({ text: "response" })

			await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 5000 })
			expect(mockGenerateText).toHaveBeenCalledWith(
				expect.objectContaining({
					model: mockLanguageModel,
					prompt: "test prompt",
					abortSignal: expect.any(AbortSignal),
				}),
			)
			// The abortSignal should be a merged signal (not the original controller.signal)
			const callArgs = mockGenerateText.mock.calls[0][0]
			expect(callArgs.abortSignal).toBeDefined()
			expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal)
		})

		it("completePrompt should use AbortSignal.timeout when only timeoutMs is provided", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })
			mockGenerateText.mockResolvedValueOnce({ text: "response" })

			await handler.completePrompt("test prompt", { timeoutMs: 3000 })
			expect(mockGenerateText).toHaveBeenCalledWith(
				expect.objectContaining({
					model: mockLanguageModel,
					prompt: "test prompt",
					abortSignal: expect.any(AbortSignal),
				}),
			)
			const callArgs = mockGenerateText.mock.calls[0][0]
			expect(callArgs.abortSignal).toBeDefined()
			expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal)
		})

		it("completePrompt should prefer signal over timeoutMs when both are provided", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })
			const controller = new AbortController()
			mockGenerateText.mockResolvedValueOnce({ text: "response" })

			await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 5000 })
			const callArgs = mockGenerateText.mock.calls[0][0]
			// Should have a merged abortSignal (not the original controller.signal)
			expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal)
			expect(callArgs.abortSignal).not.toBe(controller.signal)
		})

		it("completePrompt rejects with AbortError when the external signal aborts mid-flight", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })
			const controller = new AbortController()
			// Emulate the AI SDK: the in-flight generation rejects when the abort signal fires.
			mockGenerateText.mockImplementationOnce(async (args: { abortSignal?: AbortSignal }) => {
				await new Promise<void>((resolve) => {
					if (args.abortSignal?.aborted) {
						resolve()
					} else {
						args.abortSignal?.addEventListener("abort", () => resolve(), { once: true })
					}
				})
				const abortError = new Error("The operation was aborted")
				abortError.name = "AbortError"
				throw abortError
			})

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 5000 })
			const callArgs = mockGenerateText.mock.calls[0][0]
			expect(callArgs.abortSignal).toBeDefined()

			// Abort the external signal before the generation settles.
			controller.abort()

			await expect(promise).rejects.toMatchObject({ name: "AbortError" })
			// The merged signal should be aborted once the user signal aborts.
			expect(callArgs.abortSignal.aborted).toBe(true)
		})

		it("completePrompt should handle timeoutMs=0 as no timeout", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })
			mockGenerateText.mockResolvedValueOnce({ text: "response" })

			await handler.completePrompt("test prompt", { timeoutMs: 0 })
			expect(mockGenerateText).toHaveBeenCalledWith(
				expect.objectContaining({
					model: mockLanguageModel,
					prompt: "test prompt",
				}),
			)
			const callArgs = mockGenerateText.mock.calls[0][0]
			expect(callArgs.abortSignal).toBeUndefined()
		})

		it("completePrompt should handle non-Error values in catch block", async () => {
			const handler = new PoeHandler({ poeApiKey: "key", apiModelId: "openai/gpt-4o" })
			mockGenerateText.mockRejectedValueOnce("not an error")

			await expect(handler.completePrompt("test prompt")).rejects.toThrow()
		})
	})
})
