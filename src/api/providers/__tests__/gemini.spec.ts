// npx vitest run src/api/providers/__tests__/gemini.spec.ts

const mockCaptureException = vitest.fn()

vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: (...args: unknown[]) => mockCaptureException(...args),
		},
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"

import { type ModelInfo, geminiDefaultModelId, ApiProviderError } from "@roo-code/types"

import { t } from "i18next"
import { GeminiHandler } from "../gemini"

const GEMINI_MODEL_NAME = geminiDefaultModelId

describe("GeminiHandler", () => {
	let handler: GeminiHandler

	beforeEach(() => {
		// Reset mocks
		mockCaptureException.mockClear()

		// Create mock functions
		const mockGenerateContentStream = vitest.fn()
		const mockGenerateContent = vitest.fn()
		const mockGetGenerativeModel = vitest.fn()

		handler = new GeminiHandler({
			apiKey: "test-key",
			apiModelId: GEMINI_MODEL_NAME,
			geminiApiKey: "test-key",
		})

		// Replace the client with our mock
		handler["client"] = {
			models: {
				generateContentStream: mockGenerateContentStream,
				generateContent: mockGenerateContent,
				getGenerativeModel: mockGetGenerativeModel,
			},
		} as any
	})

	describe("constructor", () => {
		it("should initialize with provided config", () => {
			expect(handler["options"].geminiApiKey).toBe("test-key")
			expect(handler["options"].apiModelId).toBe(GEMINI_MODEL_NAME)
		})
	})

	describe("thoughtSignature round-trip (issue #536)", () => {
		const systemPrompt = "You are a helpful assistant"
		const toolMetadata = { tools: [{ function: { name: "read_file", description: "", parameters: {} } }] } as any

		// Helper: build a mock async-iterable stream from chunks
		function makeStream(chunks: unknown[]) {
			return {
				[Symbol.asyncIterator]: async function* () {
					for (const chunk of chunks) yield chunk
				},
			}
		}

		// Simulate a Gemini 3.x response: thoughtSignature arrives on its own part,
		// alongside a functionCall part (the way the real Gemini 3 API returns it).
		const turn1Response = makeStream([
			{
				candidates: [
					{
						content: {
							parts: [
								{ thought: true, text: "thinking…" },
								{ functionCall: { name: "read_file", args: { path: "foo.ts" } } },
								{ thoughtSignature: "sig-abc123" },
							],
						},
					},
				],
			},
			{ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
		])

		it("captures thoughtSignature from the stream after turn 1", async () => {
			;(handler["client"].models.generateContentStream as any).mockResolvedValue(turn1Response)

			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Read foo.ts" }]

			for await (const _chunk of handler.createMessage(systemPrompt, messages, toolMetadata)) {
				// drain
			}

			expect(handler.getThoughtSignature()).toBe("sig-abc123")
		})

		it("sends thoughtSignature from history on turn 2 (core regression)", async () => {
			// This is the bug from issue #536: after turn 1 the thoughtSignature block is
			// persisted into apiConversationHistory. On turn 2 the handler must include it
			// in the outgoing request, otherwise Gemini 3.x returns an empty response.
			const historyAfterTurn1: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Read foo.ts" },
				{
					role: "assistant",
					// assistant turn as stored by prepareApiConversationMessage:
					// tool_use block + appended thoughtSignature block
					content: [
						{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "foo.ts" } },
						{ type: "thoughtSignature", thoughtSignature: "sig-abc123" } as any,
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents here" }],
				},
			]

			;(handler["client"].models.generateContentStream as any).mockResolvedValue(
				makeStream([
					{ candidates: [{ content: { parts: [{ text: "Done." }] } }] },
					{ usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
				]),
			)

			for await (const _chunk of handler.createMessage(systemPrompt, historyAfterTurn1, toolMetadata)) {
				// drain
			}

			const callArgs = (handler["client"].models.generateContentStream as any).mock.calls[0][0]
			const contents: any[] = callArgs.contents

			// The model turn in the outgoing request must carry the thoughtSignature on its functionCall part
			const modelTurn = contents.find((c: any) => c.role === "model")
			expect(modelTurn).toBeDefined()
			const fnPart = modelTurn.parts.find((p: any) => p.functionCall)
			expect(fnPart).toBeDefined()
			expect(fnPart.thoughtSignature).toBe("sig-abc123")
		})

		it("falls back to base64-encoded skip_thought_signature_validator when history has no signature", async () => {
			// Cross-model history scenario: prior session used a non-Gemini model, no signature stored.
			// The fallback bypass token must be base64-encoded because Part.thoughtSignature is
			// documented as a base64 field. Vertex AI validates this strictly.
			const historyNoSig: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Read foo.ts" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "foo.ts" } }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents" }],
				},
			]

			;(handler["client"].models.generateContentStream as any).mockResolvedValue(
				makeStream([
					{ candidates: [{ content: { parts: [{ text: "Done." }] } }] },
					{ usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
				]),
			)

			for await (const _chunk of handler.createMessage(systemPrompt, historyNoSig, toolMetadata)) {
				// drain
			}

			const callArgs = (handler["client"].models.generateContentStream as any).mock.calls[0][0]
			const contents: any[] = callArgs.contents
			const modelTurn = contents.find((c: any) => c.role === "model")
			const fnPart = modelTurn?.parts.find((p: any) => p.functionCall)
			expect(fnPart).toBeDefined()
			const expectedBypass = Buffer.from("skip_thought_signature_validator").toString("base64")
			expect(fnPart.thoughtSignature).toBe(expectedBypass)
		})

		it("sends thoughtSignature even when reasoningEffort is disabled", async () => {
			// If the user disables reasoning effort, thinkingConfig=undefined.
			// The old code: includeThoughtSignatures = Boolean(thinkingConfig) || Boolean(metadata?.tools?.length)
			// With tools present this is still true — but if called with no tools it would be false.
			// Verify the signature is sent regardless when tools are in the metadata.
			const handlerNoReasoning = new GeminiHandler({
				apiKey: "test-key",
				geminiApiKey: "test-key",
				apiModelId: GEMINI_MODEL_NAME,
				reasoningEffort: "disable" as any,
			})
			handlerNoReasoning["client"] = handler["client"] as any

			const historyWithSig: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Read foo.ts" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "foo.ts" } },
						{ type: "thoughtSignature", thoughtSignature: "sig-xyz" } as any,
					],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents" }],
				},
			]

			;(handler["client"].models.generateContentStream as any).mockResolvedValue(
				makeStream([
					{ candidates: [{ content: { parts: [{ text: "Done." }] } }] },
					{ usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
				]),
			)

			for await (const _chunk of handlerNoReasoning.createMessage(systemPrompt, historyWithSig, toolMetadata)) {
				// drain
			}

			const callArgs = (handler["client"].models.generateContentStream as any).mock.calls[0][0]
			const contents: any[] = callArgs.contents
			const modelTurn = contents.find((c: any) => c.role === "model")
			const fnPart = modelTurn?.parts.find((p: any) => p.functionCall)
			expect(fnPart).toBeDefined()
			expect(fnPart.thoughtSignature).toBe("sig-xyz")
		})

		it("does NOT capture thoughtSignature when there are no tools in metadata", async () => {
			// Without tools, includeThoughtSignatures=false when thinkingConfig is also absent.
			// This tests the boundary so we don't over-eagerly store signatures for non-tool calls.
			const handlerNoReasoning = new GeminiHandler({
				apiKey: "test-key",
				geminiApiKey: "test-key",
				apiModelId: GEMINI_MODEL_NAME,
				reasoningEffort: "disable" as any,
			})
			handlerNoReasoning["client"] = handler["client"] as any
			;(handler["client"].models.generateContentStream as any).mockResolvedValue(
				makeStream([
					{
						candidates: [
							{
								content: {
									parts: [
										{ functionCall: { name: "read_file", args: { path: "foo.ts" } } },
										{ thoughtSignature: "sig-should-not-be-captured" },
									],
								},
							},
						],
					},
					{ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
				]),
			)

			// No tools in metadata, no thinkingConfig → includeThoughtSignatures=false
			for await (const _chunk of handlerNoReasoning.createMessage(systemPrompt, [
				{ role: "user", content: "hi" },
			])) {
				// drain
			}

			expect(handlerNoReasoning.getThoughtSignature()).toBeUndefined()
		})
	})

	describe("createMessage", () => {
		const mockMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: "Hello",
			},
			{
				role: "assistant",
				content: "Hi there!",
			},
		]

		const systemPrompt = "You are a helpful assistant"

		it("should handle text messages correctly", async () => {
			// Setup the mock implementation to return an async generator
			;(handler["client"].models.generateContentStream as any).mockResolvedValue({
				[Symbol.asyncIterator]: async function* () {
					yield { text: "Hello" }
					yield { text: " world!" }
					yield { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }
				},
			})

			const stream = handler.createMessage(systemPrompt, mockMessages)
			const chunks = []

			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Should have 3 chunks: 'Hello', ' world!', and usage info
			expect(chunks.length).toBe(3)
			expect(chunks[0]).toEqual({ type: "text", text: "Hello" })
			expect(chunks[1]).toEqual({ type: "text", text: " world!" })
			expect(chunks[2]).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 5 })

			// Verify the call to generateContentStream
			expect(handler["client"].models.generateContentStream).toHaveBeenCalledWith(
				expect.objectContaining({
					model: GEMINI_MODEL_NAME,
					config: expect.objectContaining({
						temperature: 1,
						systemInstruction: systemPrompt,
					}),
				}),
			)
		})

		it("should handle API errors", async () => {
			const mockError = new Error("Gemini API error")
			;(handler["client"].models.generateContentStream as any).mockRejectedValue(mockError)

			const stream = handler.createMessage(systemPrompt, mockMessages)

			await expect(async () => {
				for await (const _chunk of stream) {
					// Should throw before yielding any chunks
				}
			}).rejects.toThrow()
		})
	})

	describe("completePrompt", () => {
		it("should complete prompt successfully", async () => {
			// Mock the response with text property
			;(handler["client"].models.generateContent as any).mockResolvedValue({
				text: "Test response",
			})

			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("Test response")

			// Verify the call to generateContent
			expect(handler["client"].models.generateContent).toHaveBeenCalledWith({
				model: GEMINI_MODEL_NAME,
				contents: [{ role: "user", parts: [{ text: "Test prompt" }] }],
				config: {
					httpOptions: undefined,
					temperature: 1,
				},
			})
		})

		it("should handle API errors", async () => {
			const mockError = new Error("Gemini API error")
			;(handler["client"].models.generateContent as any).mockRejectedValue(mockError)

			await expect(handler.completePrompt("Test prompt")).rejects.toThrow(
				t("common:errors.gemini.generate_complete_prompt", { error: "Gemini API error" }),
			)
		})

		it("should handle empty response", async () => {
			// Mock the response with empty text
			;(handler["client"].models.generateContent as any).mockResolvedValue({
				text: "",
			})

			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("")
		})
	})

	describe("getModel", () => {
		it("should return correct model info", () => {
			const modelInfo = handler.getModel()
			expect(modelInfo.id).toBe(GEMINI_MODEL_NAME)
			expect(modelInfo.info).toBeDefined()
		})

		it("should return default model if invalid model specified", () => {
			const invalidHandler = new GeminiHandler({
				apiModelId: "invalid-model",
				geminiApiKey: "test-key",
			})
			const modelInfo = invalidHandler.getModel()
			expect(modelInfo.id).toBe(geminiDefaultModelId) // Default model
		})

		it("should honor a custom gemini model id not present in geminiModels (#227)", () => {
			const customHandler = new GeminiHandler({
				apiModelId: "gemini-9.9-nonexistent",
				geminiApiKey: "test-key",
			})
			const modelInfo = customHandler.getModel()
			// The configured id must be invoked, not silently swapped for the default.
			expect(modelInfo.id).toBe("gemini-9.9-nonexistent")
			expect(modelInfo.id).not.toBe(geminiDefaultModelId)
			// A baseline ModelInfo is provided so downstream params resolve.
			expect(modelInfo.info).toBeDefined()
			// Pricing is unknown for a custom model, so cost should not be reported
			// against the default model's rates.
			expect(modelInfo.info.inputPrice).toBeUndefined()
			expect(modelInfo.info.outputPrice).toBeUndefined()
			expect(modelInfo.info.cacheReadsPrice).toBeUndefined()
			expect(modelInfo.info.cacheWritesPrice).toBeUndefined()
			expect(modelInfo.info.tiers).toBeUndefined()
		})

		it("should not treat Object prototype keys as known models", () => {
			// `"toString" in geminiModels` is true via the prototype chain, which would
			// otherwise resolve `info` to a function. An own-property check avoids this.
			const protoHandler = new GeminiHandler({
				apiModelId: "toString",
				geminiApiKey: "test-key",
			})
			const modelInfo = protoHandler.getModel()
			expect(modelInfo.id).toBe(geminiDefaultModelId)
			expect(modelInfo.info).toBeDefined()
		})

		it("should exclude apply_diff and include edit in tool preferences", () => {
			const modelInfo = handler.getModel()
			expect(modelInfo.info.excludedTools).toContain("apply_diff")
			expect(modelInfo.info.includedTools).toContain("edit")
		})

		it("should not duplicate tool entries if already present", () => {
			const modelInfo = handler.getModel()
			const excludedCount = modelInfo.info.excludedTools!.filter((t: string) => t === "apply_diff").length
			const includedCount = modelInfo.info.includedTools!.filter((t: string) => t === "edit").length
			expect(excludedCount).toBe(1)
			expect(includedCount).toBe(1)
		})
	})

	describe("calculateCost", () => {
		// Mock ModelInfo based on gemini-1.5-flash-latest pricing (per 1M tokens)
		// Removed 'id' and 'name' as they are not part of ModelInfo type directly
		const mockInfo: ModelInfo = {
			inputPrice: 0.125, // $/1M tokens
			outputPrice: 0.375, // $/1M tokens
			cacheWritesPrice: 0.125, // Assume same as input for test
			cacheReadsPrice: 0.125 * 0.25, // Assume 0.25x input for test
			contextWindow: 1_000_000,
			maxTokens: 8192,
			supportsPromptCache: true, // Enable cache calculations for tests
		}

		it("should calculate cost correctly based on input and output tokens", () => {
			const inputTokens = 10000 // Use larger numbers for per-million pricing
			const outputTokens = 20000
			// Added non-null assertions (!) as mockInfo guarantees these values
			const expectedCost =
				(inputTokens / 1_000_000) * mockInfo.inputPrice! + (outputTokens / 1_000_000) * mockInfo.outputPrice!

			const cost = handler.calculateCost({ info: mockInfo, inputTokens, outputTokens })
			expect(cost).toBeCloseTo(expectedCost)
		})

		it("should return 0 if token counts are zero", () => {
			// Note: The method expects numbers, not undefined. Passing undefined would be a type error.
			// The calculateCost method itself returns undefined if prices are missing, but 0 if tokens are 0 and prices exist.
			expect(handler.calculateCost({ info: mockInfo, inputTokens: 0, outputTokens: 0 })).toBe(0)
		})

		it("should handle only input tokens", () => {
			const inputTokens = 5000
			// Added non-null assertion (!)
			const expectedCost = (inputTokens / 1_000_000) * mockInfo.inputPrice!
			expect(handler.calculateCost({ info: mockInfo, inputTokens, outputTokens: 0 })).toBeCloseTo(expectedCost)
		})

		it("should handle only output tokens", () => {
			const outputTokens = 15000
			// Added non-null assertion (!)
			const expectedCost = (outputTokens / 1_000_000) * mockInfo.outputPrice!
			expect(handler.calculateCost({ info: mockInfo, inputTokens: 0, outputTokens })).toBeCloseTo(expectedCost)
		})

		it("should calculate cost with cache read tokens", () => {
			const inputTokens = 10000 // Total logical input
			const outputTokens = 20000
			const cacheReadTokens = 8000 // Part of inputTokens read from cache

			const uncachedReadTokens = inputTokens - cacheReadTokens
			// Added non-null assertions (!)
			const expectedInputCost = (uncachedReadTokens / 1_000_000) * mockInfo.inputPrice!
			const expectedOutputCost = (outputTokens / 1_000_000) * mockInfo.outputPrice!
			const expectedCacheReadCost = mockInfo.cacheReadsPrice! * (cacheReadTokens / 1_000_000)
			const expectedCost = expectedInputCost + expectedOutputCost + expectedCacheReadCost

			const cost = handler.calculateCost({ info: mockInfo, inputTokens, outputTokens, cacheReadTokens })
			expect(cost).toBeCloseTo(expectedCost)
		})

		it("should return undefined if pricing info is missing", () => {
			// Create a copy and explicitly set a price to undefined
			const incompleteInfo: ModelInfo = { ...mockInfo, outputPrice: undefined }
			const cost = handler.calculateCost({ info: incompleteInfo, inputTokens: 1000, outputTokens: 1000 })
			expect(cost).toBeUndefined()
		})
	})

	describe("error telemetry", () => {
		const mockMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: "Hello",
			},
		]

		const systemPrompt = "You are a helpful assistant"

		it("should capture telemetry on createMessage error", async () => {
			const mockError = new Error("Gemini API error")
			;(handler["client"].models.generateContentStream as any).mockRejectedValue(mockError)

			const stream = handler.createMessage(systemPrompt, mockMessages)

			await expect(async () => {
				for await (const _chunk of stream) {
					// Should throw before yielding any chunks
				}
			}).rejects.toThrow()

			// Verify telemetry was captured
			expect(mockCaptureException).toHaveBeenCalledTimes(1)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Gemini API error",
					provider: "Gemini",
					modelId: GEMINI_MODEL_NAME,
					operation: "createMessage",
				}),
			)

			// Verify it's an ApiProviderError
			const capturedError = mockCaptureException.mock.calls[0][0]
			expect(capturedError).toBeInstanceOf(ApiProviderError)
		})

		it("should capture telemetry on completePrompt error", async () => {
			const mockError = new Error("Gemini completion error")
			;(handler["client"].models.generateContent as any).mockRejectedValue(mockError)

			await expect(handler.completePrompt("Test prompt")).rejects.toThrow()

			// Verify telemetry was captured
			expect(mockCaptureException).toHaveBeenCalledTimes(1)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Gemini completion error",
					provider: "Gemini",
					modelId: GEMINI_MODEL_NAME,
					operation: "completePrompt",
				}),
			)

			// Verify it's an ApiProviderError
			const capturedError = mockCaptureException.mock.calls[0][0]
			expect(capturedError).toBeInstanceOf(ApiProviderError)
		})

		it("should still throw the error after capturing telemetry", async () => {
			const mockError = new Error("Gemini API error")
			;(handler["client"].models.generateContentStream as any).mockRejectedValue(mockError)

			const stream = handler.createMessage(systemPrompt, mockMessages)

			// Verify the error is still thrown
			await expect(async () => {
				for await (const _chunk of stream) {
					// Should throw
				}
			}).rejects.toThrow()

			// Telemetry should have been captured before the error was thrown
			expect(mockCaptureException).toHaveBeenCalled()
		})
	})
})
