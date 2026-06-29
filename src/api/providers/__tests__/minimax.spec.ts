// npx vitest run src/api/providers/__tests__/minimax.spec.ts

vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: vitest.fn().mockReturnValue({
			get: vitest.fn().mockReturnValue(600), // Default timeout in seconds
		}),
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"

import { type MinimaxModelId, minimaxDefaultModelId, minimaxModels } from "@roo-code/types"

import { MiniMaxHandler } from "../minimax"

vitest.mock("@anthropic-ai/sdk", () => {
	const mockCreate = vitest.fn()
	return {
		Anthropic: vitest.fn(function () {
			return {
				messages: {
					create: mockCreate,
				},
			}
		}),
	}
})

describe("MiniMaxHandler", () => {
	let handler: MiniMaxHandler
	let mockCreate: any

	beforeEach(() => {
		vitest.clearAllMocks()
		const anthropicInstance = (Anthropic as unknown as any)()
		mockCreate = anthropicInstance.messages.create
	})

	describe("International MiniMax (default)", () => {
		beforeEach(() => {
			handler = new MiniMaxHandler({
				minimaxApiKey: "test-minimax-api-key",
				minimaxBaseUrl: "https://api.minimax.io/v1",
			})
		})

		it("should use the correct international MiniMax base URL by default", () => {
			new MiniMaxHandler({ minimaxApiKey: "test-minimax-api-key" })
			expect(Anthropic).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: "https://api.minimax.io/anthropic",
				}),
			)
		})

		it("should convert /v1 endpoint to /anthropic endpoint", () => {
			new MiniMaxHandler({
				minimaxApiKey: "test-minimax-api-key",
				minimaxBaseUrl: "https://api.minimax.io/v1",
			})
			expect(Anthropic).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: "https://api.minimax.io/anthropic",
				}),
			)
		})

		it("should use the provided API key", () => {
			const minimaxApiKey = "test-minimax-api-key"
			new MiniMaxHandler({ minimaxApiKey })
			expect(Anthropic).toHaveBeenCalledWith(expect.objectContaining({ apiKey: minimaxApiKey }))
		})

		it("should return default model when no model is specified", () => {
			const model = handler.getModel()
			expect(model.id).toBe(minimaxDefaultModelId)
			expect(model.info).toEqual(minimaxModels[minimaxDefaultModelId])
		})

		it("should return specified model when valid model is provided", () => {
			const testModelId: MinimaxModelId = "MiniMax-M2"
			const handlerWithModel = new MiniMaxHandler({
				apiModelId: testModelId,
				minimaxApiKey: "test-minimax-api-key",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(minimaxModels[testModelId])
		})

		it("should return MiniMax-M2.5 model with correct configuration", () => {
			const testModelId: MinimaxModelId = "MiniMax-M2.5"
			const handlerWithModel = new MiniMaxHandler({
				apiModelId: testModelId,
				minimaxApiKey: "test-minimax-api-key",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(minimaxModels[testModelId])
			expect(model.info.contextWindow).toBe(204_800)
			expect(model.info.maxTokens).toBe(16_384)
			expect(model.info.supportsPromptCache).toBe(true)
			expect(model.info.cacheWritesPrice).toBe(0.375)
			expect(model.info.cacheReadsPrice).toBe(0.03)
		})

		it("should return MiniMax-M2 model with correct configuration", () => {
			const testModelId: MinimaxModelId = "MiniMax-M2"
			const handlerWithModel = new MiniMaxHandler({
				apiModelId: testModelId,
				minimaxApiKey: "test-minimax-api-key",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(minimaxModels[testModelId])
			expect(model.info.contextWindow).toBe(204_800)
			expect(model.info.maxTokens).toBe(16_384)
			expect(model.info.supportsPromptCache).toBe(true)
			expect(model.info.cacheWritesPrice).toBe(0.375)
			expect(model.info.cacheReadsPrice).toBe(0.03)
		})

		it("should return MiniMax-M3-512k model with correct configuration", () => {
			const testModelId: MinimaxModelId = "MiniMax-M3-512k"
			const handlerWithModel = new MiniMaxHandler({
				apiModelId: testModelId,
				minimaxApiKey: "test-minimax-api-key",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(minimaxModels[testModelId])
			expect(model.info.contextWindow).toBe(524_288)
			expect(model.info.maxTokens).toBe(65_536)
			expect(model.info.supportsImages).toBe(true)
			expect(model.info.supportsPromptCache).toBe(true)
			expect(model.info.inputPrice).toBe(0.3)
			expect(model.info.outputPrice).toBe(1.2)
			expect(model.info.cacheWritesPrice).toBe(0.375)
			expect(model.info.cacheReadsPrice).toBe(0.06)
		})

		it("should return MiniMax-M3-1M model with correct configuration", () => {
			const testModelId: MinimaxModelId = "MiniMax-M3-1M"
			const handlerWithModel = new MiniMaxHandler({
				apiModelId: testModelId,
				minimaxApiKey: "test-minimax-api-key",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(minimaxModels[testModelId])
			expect(model.info.contextWindow).toBe(1_048_576)
			expect(model.info.maxTokens).toBe(131_072)
			expect(model.info.supportsImages).toBe(true)
			expect(model.info.supportsPromptCache).toBe(true)
			expect(model.info.inputPrice).toBe(0.3)
			expect(model.info.outputPrice).toBe(1.2)
			expect(model.info.cacheWritesPrice).toBe(0.375)
			expect(model.info.cacheReadsPrice).toBe(0.06)
		})

		it(`should default to ${minimaxDefaultModelId} model`, () => {
			const handlerDefault = new MiniMaxHandler({ minimaxApiKey: "test-minimax-api-key" })
			const model = handlerDefault.getModel()
			expect(model.id).toBe(minimaxDefaultModelId)
		})

		it("should return MiniMax-M2-Stable model with correct configuration", () => {
			const testModelId: MinimaxModelId = "MiniMax-M2-Stable"
			const handlerWithModel = new MiniMaxHandler({
				apiModelId: testModelId,
				minimaxApiKey: "test-minimax-api-key",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(minimaxModels[testModelId])
			expect(model.info.contextWindow).toBe(204_800)
			expect(model.info.maxTokens).toBe(16_384)
			expect(model.info.supportsPromptCache).toBe(true)
			expect(model.info.cacheWritesPrice).toBe(0.375)
			expect(model.info.cacheReadsPrice).toBe(0.03)
		})
	})

	describe("China MiniMax", () => {
		beforeEach(() => {
			handler = new MiniMaxHandler({
				minimaxApiKey: "test-minimax-api-key",
				minimaxBaseUrl: "https://api.minimaxi.com/v1",
			})
		})

		it("should use the correct China MiniMax base URL", () => {
			new MiniMaxHandler({
				minimaxApiKey: "test-minimax-api-key",
				minimaxBaseUrl: "https://api.minimaxi.com/v1",
			})
			expect(Anthropic).toHaveBeenCalledWith(
				expect.objectContaining({ baseURL: "https://api.minimaxi.com/anthropic" }),
			)
		})

		it("should convert China /v1 endpoint to /anthropic endpoint", () => {
			new MiniMaxHandler({
				minimaxApiKey: "test-minimax-api-key",
				minimaxBaseUrl: "https://api.minimaxi.com/v1",
			})
			expect(Anthropic).toHaveBeenCalledWith(
				expect.objectContaining({ baseURL: "https://api.minimaxi.com/anthropic" }),
			)
		})

		it("should use the provided API key for China", () => {
			const minimaxApiKey = "test-minimax-api-key"
			new MiniMaxHandler({ minimaxApiKey, minimaxBaseUrl: "https://api.minimaxi.com/v1" })
			expect(Anthropic).toHaveBeenCalledWith(expect.objectContaining({ apiKey: minimaxApiKey }))
		})

		it("should return default model when no model is specified", () => {
			const model = handler.getModel()
			expect(model.id).toBe(minimaxDefaultModelId)
			expect(model.info).toEqual(minimaxModels[minimaxDefaultModelId])
		})
	})

	describe("Default behavior", () => {
		it("should default to international base URL when none is specified", () => {
			const handlerDefault = new MiniMaxHandler({ minimaxApiKey: "test-minimax-api-key" })
			expect(Anthropic).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: "https://api.minimax.io/anthropic",
				}),
			)

			const model = handlerDefault.getModel()
			expect(model.id).toBe(minimaxDefaultModelId)
			expect(model.info).toEqual(minimaxModels[minimaxDefaultModelId])
		})

		it(`should default to ${minimaxDefaultModelId} model`, () => {
			const handlerDefault = new MiniMaxHandler({ minimaxApiKey: "test-minimax-api-key" })
			const model = handlerDefault.getModel()
			expect(model.id).toBe(minimaxDefaultModelId)
		})

		it("should still resolve MiniMax-M2.7 when explicitly requested (back-compat)", () => {
			const handlerWithModel = new MiniMaxHandler({
				apiModelId: "MiniMax-M2.7",
				minimaxApiKey: "test-minimax-api-key",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe("MiniMax-M2.7")
			expect(model.info).toEqual(minimaxModels["MiniMax-M2.7"])
		})
	})

	describe("API Methods", () => {
		beforeEach(() => {
			handler = new MiniMaxHandler({ minimaxApiKey: "test-minimax-api-key" })
		})

		it("completePrompt method should return text from MiniMax API", async () => {
			const expectedResponse = "This is a test response from MiniMax"
			mockCreate.mockResolvedValueOnce({
				content: [{ type: "text", text: expectedResponse }],
			})
			const result = await handler.completePrompt("test prompt")
			expect(result).toBe(expectedResponse)
		})

		it("should handle errors in completePrompt", async () => {
			const errorMessage = "MiniMax API error"
			mockCreate.mockRejectedValueOnce(new Error(errorMessage))
			await expect(handler.completePrompt("test prompt")).rejects.toThrow()
		})

		it("createMessage should yield text content from stream", async () => {
			const testContent = "This is test content from MiniMax stream"

			mockCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: () => ({
					next: vitest
						.fn()
						.mockResolvedValueOnce({
							done: false,
							value: {
								type: "content_block_start",
								index: 0,
								content_block: { type: "text", text: testContent },
							},
						})
						.mockResolvedValueOnce({ done: true }),
				}),
			})

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			expect(firstChunk.value).toEqual({ type: "text", text: testContent })
		})

		it("createMessage should yield usage data from stream", async () => {
			mockCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: () => ({
					next: vitest
						.fn()
						.mockResolvedValueOnce({
							done: false,
							value: {
								type: "message_start",
								message: {
									usage: {
										input_tokens: 10,
										output_tokens: 20,
									},
								},
							},
						})
						.mockResolvedValueOnce({ done: true }),
				}),
			})

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			expect(firstChunk.value).toEqual({ type: "usage", inputTokens: 10, outputTokens: 20 })
		})

		it("createMessage should pass correct parameters to MiniMax client", async () => {
			const modelId: MinimaxModelId = "MiniMax-M2"
			const modelInfo = minimaxModels[modelId]
			const handlerWithModel = new MiniMaxHandler({
				apiModelId: modelId,
				minimaxApiKey: "test-minimax-api-key",
			})

			mockCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			})

			const systemPrompt = "Test system prompt for MiniMax"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Test message for MiniMax" }]

			const messageGenerator = handlerWithModel.createMessage(systemPrompt, messages)
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: modelId,
					max_tokens: Math.min(modelInfo.maxTokens, Math.ceil(modelInfo.contextWindow * 0.2)),
					temperature: 1,
					system: expect.any(Array),
					messages: expect.any(Array),
					stream: true,
				}),
			)
		})

		it("should use temperature 1 by default", async () => {
			mockCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			})

			const messageGenerator = handler.createMessage("test", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					temperature: 1,
				}),
			)
		})

		// Regression guard for the "double-think" hang: MiniMax M3 on the Anthropic
		// endpoint defaults thinking OFF, so we must explicitly enable adaptive
		// thinking and never pass budget_tokens (M-series is a binary toggle).
		// Ported from kilo-code opencode provider transform (lines 661, 1208-1211).
		it("should enable adaptive thinking for MiniMax-M3 models on Anthropic endpoint", async () => {
			for (const modelId of ["MiniMax-M3-512k", "MiniMax-M3-1M"] as const) {
				mockCreate.mockResolvedValueOnce({
					[Symbol.asyncIterator]: () => ({
						async next() {
							return { done: true }
						},
					}),
				})

				const handlerForModel = new MiniMaxHandler({
					apiModelId: modelId,
					minimaxApiKey: "test-minimax-api-key",
				})
				const gen = handlerForModel.createMessage("test", [])
				await gen.next()

				expect(mockCreate).toHaveBeenLastCalledWith(
					expect.objectContaining({
						model: modelId,
						thinking: { type: "adaptive" },
					}),
				)
				// M-series is a binary toggle: budget_tokens must NEVER be sent.
				const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
				expect(lastCall.thinking).not.toHaveProperty("budget_tokens")
				expect(lastCall).not.toHaveProperty("budget_tokens")
			}
		})

		it("should NOT enable adaptive thinking for MiniMax-M2.x models", async () => {
			for (const modelId of ["MiniMax-M2", "MiniMax-M2.5", "MiniMax-M2.7"] as const) {
				mockCreate.mockResolvedValueOnce({
					[Symbol.asyncIterator]: () => ({
						async next() {
							return { done: true }
						},
					}),
				})

				const handlerForModel = new MiniMaxHandler({
					apiModelId: modelId,
					minimaxApiKey: "test-minimax-api-key",
				})
				const gen = handlerForModel.createMessage("test", [])
				await gen.next()

				const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
				expect(lastCall.thinking).toBeUndefined()
			}
		})

		// Regression guard for the "hang" symptom: M-series sampling parameters
		// must match kilo-code defaults (transform.ts lines 488-524). M2.x and M3
		// both use top_p=0.95; M2.x additionally uses top_k=40.
		it("should pass MiniMax-M2 sampling params (top_p=0.95, top_k=40)", async () => {
			mockCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			})

			const handlerForModel = new MiniMaxHandler({
				apiModelId: "MiniMax-M2.7",
				minimaxApiKey: "test-minimax-api-key",
			})
			const gen = handlerForModel.createMessage("test", [])
			await gen.next()

			expect(mockCreate).toHaveBeenLastCalledWith(
				expect.objectContaining({
					temperature: 1,
					top_p: 0.95,
					top_k: 40,
				}),
			)
		})

		it("should pass MiniMax-M3 sampling params (top_p=0.95, no top_k)", async () => {
			mockCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			})

			const handlerForModel = new MiniMaxHandler({
				apiModelId: "MiniMax-M3-1M",
				minimaxApiKey: "test-minimax-api-key",
			})
			const gen = handlerForModel.createMessage("test", [])
			await gen.next()

			const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
			expect(lastCall).toMatchObject({
				temperature: 1,
				top_p: 0.95,
			})
			expect(lastCall).not.toHaveProperty("top_k")
		})

		// Regression guard for CR-3: the M-series double-think/hang fix depends
		// on the exact `temperature: 1.0` default. Any user-supplied temperature
		// must be ignored on the M-series path.
		it("should ignore user-supplied temperature for MiniMax-M3 M-series request", async () => {
			mockCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			})

			const handlerWithCustomTemp = new MiniMaxHandler({
				apiModelId: "MiniMax-M3-1M",
				minimaxApiKey: "test-minimax-api-key",
				// Attempt to override the M-series temperature hard-coded in
				// `getMSeriesRequestParams`. If this propagates, the hang-fix
				// contract is broken.
				modelTemperature: 0.2 as any,
			})

			const messageGenerator = handlerWithCustomTemp.createMessage("system", [])
			await messageGenerator.next()

			const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
			expect(lastCall).toMatchObject({ temperature: 1.0, top_p: 0.95 })
		})

		it("should ignore user-supplied temperature for MiniMax-M2 M-series request", async () => {
			mockCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			})

			const handlerWithCustomTemp = new MiniMaxHandler({
				apiModelId: "MiniMax-M2.7",
				minimaxApiKey: "test-minimax-api-key",
				modelTemperature: 0.2 as any,
			})

			const messageGenerator = handlerWithCustomTemp.createMessage("system", [])
			await messageGenerator.next()

			const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
			expect(lastCall).toMatchObject({ temperature: 1.0, top_p: 0.95, top_k: 40 })
		})

		// Regression guard for CR-2: the M-series request-param builder is shared
		// by `createMessage` and `completePrompt`, so the M3 default still works
		// for non-streaming single-turn completions.
		it("should also apply adaptive thinking to MiniMax-M3 in completePrompt", async () => {
			mockCreate.mockResolvedValueOnce({
				content: [{ type: "text", text: "ok" }],
			})

			const handler = new MiniMaxHandler({
				apiModelId: "MiniMax-M3-1M",
				minimaxApiKey: "test-minimax-api-key",
			})

			await handler.completePrompt("hello")

			const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
			expect(lastCall).toMatchObject({
				model: "MiniMax-M3-1M",
				max_tokens: 131_072,
				temperature: 1.0,
				top_p: 0.95,
				thinking: { type: "adaptive" },
			})
			expect(lastCall).not.toHaveProperty("top_k")
			expect(lastCall.thinking).not.toHaveProperty("budget_tokens")
		})

		it("should also apply M2 sampling params to completePrompt", async () => {
			mockCreate.mockResolvedValueOnce({
				content: [{ type: "text", text: "ok" }],
			})

			const handler = new MiniMaxHandler({
				apiModelId: "MiniMax-M2.7",
				minimaxApiKey: "test-minimax-api-key",
			})

			await handler.completePrompt("hello")

			const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
			expect(lastCall).toMatchObject({
				model: "MiniMax-M2.7",
				max_tokens: 16_384,
				temperature: 1.0,
				top_p: 0.95,
				top_k: 40,
			})
			expect(lastCall.thinking).toBeUndefined()
		})

		// Regression guard for the new max_tokens follow-up: completePrompt must
		// honor the selected model's registry `maxTokens` (not the legacy 16_384
		// cap). M3-1M's registry advertises 131_072; M2.x stays at 16_384.
		it("should honor M3-1M 131_072 max_tokens in completePrompt (no legacy 16_384 cap)", async () => {
			mockCreate.mockResolvedValueOnce({
				content: [{ type: "text", text: "ok" }],
			})

			const handler = new MiniMaxHandler({
				apiModelId: "MiniMax-M3-1M",
				minimaxApiKey: "test-minimax-api-key",
			})

			await handler.completePrompt("hello")

			const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
			expect(lastCall.max_tokens).toBe(131_072)
			expect(lastCall.max_tokens).not.toBe(16_384)
		})

		it("should honor M3-512k 65_536 max_tokens in completePrompt", async () => {
			mockCreate.mockResolvedValueOnce({
				content: [{ type: "text", text: "ok" }],
			})

			const handler = new MiniMaxHandler({
				apiModelId: "MiniMax-M3-512k",
				minimaxApiKey: "test-minimax-api-key",
			})

			await handler.completePrompt("hello")

			const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
			expect(lastCall.max_tokens).toBe(65_536)
			expect(lastCall.max_tokens).not.toBe(16_384)
		})

		it("should handle thinking blocks in stream", async () => {
			const thinkingContent = "Let me think about this..."

			mockCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: () => ({
					next: vitest
						.fn()
						.mockResolvedValueOnce({
							done: false,
							value: {
								type: "content_block_start",
								index: 0,
								content_block: { type: "thinking", thinking: thinkingContent },
							},
						})
						.mockResolvedValueOnce({ done: true }),
				}),
			})

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			expect(firstChunk.value).toEqual({ type: "reasoning", text: thinkingContent })
		})

		it("should handle tool calls in stream", async () => {
			mockCreate.mockResolvedValueOnce({
				[Symbol.asyncIterator]: () => ({
					next: vitest
						.fn()
						.mockResolvedValueOnce({
							done: false,
							value: {
								type: "content_block_start",
								index: 0,
								content_block: {
									type: "tool_use",
									id: "tool-123",
									name: "get_weather",
									input: { city: "London" },
								},
							},
						})
						.mockResolvedValueOnce({
							done: false,
							value: {
								type: "content_block_stop",
								index: 0,
							},
						})
						.mockResolvedValueOnce({ done: true }),
				}),
			})

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			// Provider now yields tool_call_partial chunks, NativeToolCallParser handles reassembly
			expect(firstChunk.value).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "tool-123",
				name: "get_weather",
				arguments: undefined,
			})
		})
	})

	describe("Model Configuration", () => {
		it("should correctly configure MiniMax-M2 model properties", () => {
			const model = minimaxModels["MiniMax-M2"]
			expect(model.maxTokens).toBe(16_384)
			expect(model.contextWindow).toBe(204_800)
			expect(model.supportsImages).toBe(false)
			expect(model.supportsPromptCache).toBe(true)
			expect(model.inputPrice).toBe(0.3)
			expect(model.outputPrice).toBe(1.2)
			expect(model.cacheWritesPrice).toBe(0.375)
			expect(model.cacheReadsPrice).toBe(0.03)
		})

		it("should correctly configure MiniMax-M2-Stable model properties", () => {
			const model = minimaxModels["MiniMax-M2-Stable"]
			expect(model.maxTokens).toBe(16_384)
			expect(model.contextWindow).toBe(204_800)
			expect(model.supportsImages).toBe(false)
			expect(model.supportsPromptCache).toBe(true)
			expect(model.inputPrice).toBe(0.3)
			expect(model.outputPrice).toBe(1.2)
			expect(model.cacheWritesPrice).toBe(0.375)
			expect(model.cacheReadsPrice).toBe(0.03)
		})

		it("should correctly configure MiniMax-M2.7 model properties", () => {
			const model = minimaxModels["MiniMax-M2.7"]
			expect(model.maxTokens).toBe(16_384)
			expect(model.contextWindow).toBe(204_800)
			expect(model.supportsImages).toBe(false)
			expect(model.supportsPromptCache).toBe(true)
			expect(model.inputPrice).toBe(0.3)
			expect(model.outputPrice).toBe(1.2)
			expect(model.cacheWritesPrice).toBe(0.375)
			expect(model.cacheReadsPrice).toBe(0.06)
		})

		it("should correctly configure MiniMax-M3-512k model properties", () => {
			const model = minimaxModels["MiniMax-M3-512k"]
			expect(model.maxTokens).toBe(65_536)
			expect(model.contextWindow).toBe(524_288)
			expect(model.supportsImages).toBe(true)
			expect(model.supportsPromptCache).toBe(true)
			expect(model.inputPrice).toBe(0.3)
			expect(model.outputPrice).toBe(1.2)
			expect(model.cacheWritesPrice).toBe(0.375)
			expect(model.cacheReadsPrice).toBe(0.06)
		})

		it("should correctly configure MiniMax-M3-1M model properties", () => {
			const model = minimaxModels["MiniMax-M3-1M"]
			expect(model.maxTokens).toBe(131_072)
			expect(model.contextWindow).toBe(1_048_576)
			expect(model.supportsImages).toBe(true)
			expect(model.supportsPromptCache).toBe(true)
			expect(model.inputPrice).toBe(0.3)
			expect(model.outputPrice).toBe(1.2)
			expect(model.cacheWritesPrice).toBe(0.375)
			expect(model.cacheReadsPrice).toBe(0.06)
		})

		it("should correctly configure MiniMax-M2.7-highspeed model properties", () => {
			const model = minimaxModels["MiniMax-M2.7-highspeed"]
			expect(model.maxTokens).toBe(16_384)
			expect(model.contextWindow).toBe(204_800)
			expect(model.supportsImages).toBe(false)
			expect(model.supportsPromptCache).toBe(true)
			expect(model.inputPrice).toBe(0.6)
			expect(model.outputPrice).toBe(2.4)
			expect(model.cacheWritesPrice).toBe(0.375)
			expect(model.cacheReadsPrice).toBe(0.06)
		})

		it("should correctly configure MiniMax-M2.5-highspeed model properties", () => {
			const model = minimaxModels["MiniMax-M2.5-highspeed"]
			expect(model.maxTokens).toBe(16_384)
			expect(model.contextWindow).toBe(204_800)
			expect(model.supportsImages).toBe(false)
			expect(model.supportsPromptCache).toBe(true)
			expect(model.inputPrice).toBe(0.6)
			expect(model.outputPrice).toBe(2.4)
			expect(model.cacheWritesPrice).toBe(0.375)
			expect(model.cacheReadsPrice).toBe(0.03)
		})

		it("should correctly configure MiniMax-M2.1-highspeed model properties", () => {
			const model = minimaxModels["MiniMax-M2.1-highspeed"]
			expect(model.maxTokens).toBe(16_384)
			expect(model.contextWindow).toBe(204_800)
			expect(model.supportsImages).toBe(false)
			expect(model.supportsPromptCache).toBe(true)
			expect(model.inputPrice).toBe(0.6)
			expect(model.outputPrice).toBe(2.4)
			expect(model.cacheWritesPrice).toBe(0.375)
			expect(model.cacheReadsPrice).toBe(0.03)
		})

		it("should correctly configure MiniMax-M2.1 model properties with updated context window", () => {
			const model = minimaxModels["MiniMax-M2.1"]
			expect(model.contextWindow).toBe(204_800)
		})

		it("should correctly configure MiniMax-M2 model properties with updated context window", () => {
			const model = minimaxModels["MiniMax-M2"]
			expect(model.contextWindow).toBe(204_800)
		})

		// Regression guard: MiniMax M3 pricing is intentionally a single flat tier
		// across the 512K and 1M context windows. Keep `longContextPricing` unset
		// (not even `undefined`) so the existing token math is reused end-to-end.
		it("should NOT add longContextPricing to MiniMax-M3-512k (flat pricing by design)", () => {
			expect(minimaxModels["MiniMax-M3-512k"]).not.toHaveProperty("longContextPricing")
		})

		it("should NOT add longContextPricing to MiniMax-M3-1M (flat pricing by design)", () => {
			expect(minimaxModels["MiniMax-M3-1M"]).not.toHaveProperty("longContextPricing")
		})
	})
})
