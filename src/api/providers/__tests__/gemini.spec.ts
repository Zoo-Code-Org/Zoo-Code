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

import type { GenerateContentResponse } from "@google/genai"

import { type ModelInfo, geminiDefaultModelId, ApiProviderError } from "@roo-code/types"

import { t } from "i18next"
import type { ApiHandlerCreateMessageMetadata } from "../../index"
import { GeminiHandler } from "../gemini"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { makeCreateMessageMetadata } from "../../../test-utils/api"

const GEMINI_MODEL_NAME = geminiDefaultModelId

// @google/genai's GenerateContentResponse exposes `text` via a getter backed by
// `candidates`, so the stub only carries the field the provider reads; the double
// cast is the least-friction way to satisfy the class type in mocks.
const stubGenerateContentResponse = (text: string) => ({ text }) as unknown as GenerateContentResponse

describe("GeminiHandler", () => {
	let handler: GeminiHandler
	let mockGenerateContentStream: ReturnType<typeof vitest.fn>

	beforeEach(() => {
		// Reset mocks
		mockCaptureException.mockClear()

		// Create mock functions
		mockGenerateContentStream = vitest.fn()
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
			return asyncStreamFrom(chunks)
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

			await collectStream(handler.createMessage(systemPrompt, messages, toolMetadata))

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

			await collectStream(handler.createMessage(systemPrompt, historyAfterTurn1, toolMetadata))

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

			await collectStream(handler.createMessage(systemPrompt, historyNoSig, toolMetadata))

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

			await collectStream(handlerNoReasoning.createMessage(systemPrompt, historyWithSig, toolMetadata))

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
			await collectStream(handlerNoReasoning.createMessage(systemPrompt, [{ role: "user", content: "hi" }]))

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
			;(handler["client"].models.generateContentStream as any).mockResolvedValue(
				asyncStreamFrom([
					{ text: "Hello" },
					{ text: " world!" },
					{ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
				]),
			)

			const stream = handler.createMessage(systemPrompt, mockMessages)
			const chunks = await collectStream(stream)

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

		it("should keep an empty tool result as the final user turn", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Run the tool" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "empty.txt" } }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call-1", content: "" }],
				},
			]
			const metadata = {
				taskId: "test-task",
				tools: [{ type: "function", function: { name: "read_file", description: "", parameters: {} } }],
			} satisfies ApiHandlerCreateMessageMetadata

			mockGenerateContentStream.mockResolvedValue(
				asyncStreamFrom([{ candidates: [{ content: { parts: [{ text: "Done" }] } }] }]),
			)

			await collectStream(handler.createMessage(systemPrompt, messages, metadata))

			const params = mockGenerateContentStream.mock.calls[0][0]
			expect(params.contents.at(-1)).toEqual({
				role: "user",
				parts: [
					{
						functionResponse: {
							name: "read_file",
							response: { name: "read_file", content: "(empty)" },
						},
					},
				],
			})
		})

		it("should handle API errors", async () => {
			const mockError = new Error("Gemini API error")
			;(handler["client"].models.generateContentStream as any).mockRejectedValue(mockError)

			const stream = handler.createMessage(systemPrompt, mockMessages)

			await expect(collectStream(stream)).rejects.toThrow()
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

		it("should pass abort signal through to client via config.abortSignal", async () => {
			const controller = new AbortController()
			vi.mocked(handler["client"].models.generateContent).mockResolvedValue(
				stubGenerateContentResponse("response"),
			)
			await handler.completePrompt("test prompt", { abortSignal: controller.signal })
			expect(handler["client"].models.generateContent).toHaveBeenCalledWith({
				model: GEMINI_MODEL_NAME,
				contents: [{ role: "user", parts: [{ text: "test prompt" }] }],
				config: {
					abortSignal: controller.signal,
					httpOptions: undefined,
					temperature: 1,
				},
			})
		})

		it("should work without options (backward compatible)", async () => {
			vi.mocked(handler["client"].models.generateContent).mockResolvedValue(
				stubGenerateContentResponse("response"),
			)
			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("response")
			expect(handler["client"].models.generateContent).toHaveBeenCalledWith({
				model: GEMINI_MODEL_NAME,
				contents: [{ role: "user", parts: [{ text: "test prompt" }] }],
				config: {
					httpOptions: undefined,
					temperature: 1,
				},
			})
		})

		it("should pass timeoutMs through to client via httpOptions with abortSignal on config", async () => {
			const controller = new AbortController()
			vi.mocked(handler["client"].models.generateContent).mockResolvedValue(
				stubGenerateContentResponse("response"),
			)
			await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 10000 })
			expect(handler["client"].models.generateContent).toHaveBeenCalledWith({
				model: GEMINI_MODEL_NAME,
				contents: [{ role: "user", parts: [{ text: "test prompt" }] }],
				config: {
					abortSignal: controller.signal,
					httpOptions: { timeout: 10000 },
					temperature: 1,
				},
			})
		})

		it("should pass only timeoutMs when no signal is provided", async () => {
			vi.mocked(handler["client"].models.generateContent).mockResolvedValue(
				stubGenerateContentResponse("response"),
			)
			await handler.completePrompt("test prompt", { timeoutMs: 5000 })
			expect(handler["client"].models.generateContent).toHaveBeenCalledWith({
				model: GEMINI_MODEL_NAME,
				contents: [{ role: "user", parts: [{ text: "test prompt" }] }],
				config: {
					httpOptions: { timeout: 5000 },
					temperature: 1,
				},
			})
		})

		it("should omit httpOptions entirely for timeoutMs=0 (0 disables the timeout)", async () => {
			vi.mocked(handler["client"].models.generateContent).mockResolvedValue(
				stubGenerateContentResponse("response"),
			)
			await handler.completePrompt("test prompt", { timeoutMs: 0 })
			expect(handler["client"].models.generateContent).toHaveBeenCalledWith({
				model: GEMINI_MODEL_NAME,
				contents: [{ role: "user", parts: [{ text: "test prompt" }] }],
				config: {
					httpOptions: undefined,
					temperature: 1,
				},
			})
		})

		it("should surface a standard AbortError when the signal was aborted and the request fails", async () => {
			const controller = new AbortController()
			controller.abort()
			vi.mocked(handler["client"].models.generateContent).mockRejectedValue(new Error("Gemini API error"))

			const error = await handler
				.completePrompt("Test prompt", { abortSignal: controller.signal })
				.catch((e: unknown) => e)
			expect(error).toBeInstanceOf(DOMException)
			expect((error as Error).name).toBe("AbortError")
			expect((error as Error).message).toBe("Gemini completion aborted")
		})

		it("should surface the wrapped provider error when the request fails without options", async () => {
			vi.mocked(handler["client"].models.generateContent).mockRejectedValue(new Error("Gemini API error"))

			const error = await handler.completePrompt("Test prompt").catch((e: unknown) => e)
			expect(error).toBeInstanceOf(Error)
			// The catch must take the non-abort wrapping path (not the abort
			// DOMException path) and must not crash reading a missing signal.
			// The i18n message itself is asserted by the error telemetry tests.
			expect((error as Error).message).not.toContain("Cannot read properties")
		})

		it("should surface the wrapped provider error when the request fails with options but no signal", async () => {
			vi.mocked(handler["client"].models.generateContent).mockRejectedValue(new Error("Gemini API error"))

			const error = await handler.completePrompt("Test prompt", { timeoutMs: 0 }).catch((e: unknown) => e)
			expect(error).toBeInstanceOf(Error)
			// Options exist but no signal: exercises the second optional-chain
			// position, which would crash here if the `?.` were removed.
			expect((error as Error).message).not.toContain("Cannot read properties")
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

	describe("completePrompt request options", () => {
		it("should pass timeout and baseUrl through httpOptions", async () => {
			const handlerWithBaseUrl = new GeminiHandler({
				apiKey: "test-key",
				apiModelId: GEMINI_MODEL_NAME,
				geminiApiKey: "test-key",
				googleGeminiBaseUrl: "https://gemini.example.test",
			})
			handlerWithBaseUrl["client"] = handler["client"]
			vi.mocked(handler["client"].models.generateContent).mockResolvedValue(
				stubGenerateContentResponse("Response"),
			)

			const result = await handlerWithBaseUrl.completePrompt("Test prompt", { timeoutMs: 1234 })

			expect(result).toBe("Response")
			expect(handler["client"].models.generateContent).toHaveBeenCalledWith(
				expect.objectContaining({
					config: expect.objectContaining({
						httpOptions: {
							timeout: 1234,
							baseUrl: "https://gemini.example.test",
						},
					}),
				}),
			)
		})

		it("should pass abortSignal on config instead of httpOptions", async () => {
			const controller = new AbortController()
			vi.mocked(handler["client"].models.generateContent).mockResolvedValue(
				stubGenerateContentResponse("Response"),
			)

			await handler.completePrompt("Test prompt", { abortSignal: controller.signal })

			expect(handler["client"].models.generateContent).toHaveBeenCalledWith(
				expect.objectContaining({
					config: expect.objectContaining({
						abortSignal: controller.signal,
						httpOptions: undefined,
					}),
				}),
			)
		})

		it("should omit httpOptions when timeoutMs and baseUrl are not provided", async () => {
			vi.mocked(handler["client"].models.generateContent).mockResolvedValue(
				stubGenerateContentResponse("Response"),
			)

			await handler.completePrompt("Test prompt")

			expect(handler["client"].models.generateContent).toHaveBeenCalledWith(
				expect.objectContaining({
					config: expect.objectContaining({
						httpOptions: undefined,
					}),
				}),
			)
		})
		describe("googleGeminiBaseUrl security (CWE-319)", () => {
			it("should reject a non-HTTPS non-loopback googleGeminiBaseUrl in completePrompt", async () => {
				const insecureHandler = new GeminiHandler({
					apiKey: "test-key",
					apiModelId: GEMINI_MODEL_NAME,
					geminiApiKey: "test-key",
					googleGeminiBaseUrl: "http://gemini.example.test",
				})
				insecureHandler["client"] = handler["client"]
				vi.mocked(handler["client"].models.generateContent).mockResolvedValue(
					stubGenerateContentResponse("Response"),
				)

				await expect(insecureHandler.completePrompt("Test prompt")).rejects.toThrow(
					t("common:errors.gemini.generate_complete_prompt", {
						error: "Google Gemini base URL must use HTTPS (or a loopback HTTP endpoint for local test proxies)",
					}),
				)
				expect(handler["client"].models.generateContent).not.toHaveBeenCalled()
			})

			it("should allow a loopback HTTP googleGeminiBaseUrl in completePrompt", async () => {
				const loopbackHandler = new GeminiHandler({
					apiKey: "test-key",
					apiModelId: GEMINI_MODEL_NAME,
					geminiApiKey: "test-key",
					googleGeminiBaseUrl: "http://127.0.0.1:8080",
				})
				loopbackHandler["client"] = handler["client"]
				vi.mocked(handler["client"].models.generateContent).mockResolvedValue(
					stubGenerateContentResponse("Response"),
				)

				const result = await loopbackHandler.completePrompt("Test prompt")

				expect(result).toBe("Response")
				expect(handler["client"].models.generateContent).toHaveBeenCalledWith(
					expect.objectContaining({
						config: expect.objectContaining({
							httpOptions: {
								baseUrl: "http://127.0.0.1:8080",
							},
						}),
					}),
				)
			})

			it("should reject a non-HTTPS non-loopback googleGeminiBaseUrl in createMessage", async () => {
				const messages: Anthropic.Messages.MessageParam[] = [
					{
						role: "user",
						content: "Hello",
					},
				]
				const stub = vi.fn().mockReturnValue((async function* () {})())
				const insecureHandler = new GeminiHandler({
					apiKey: "test-key",
					apiModelId: GEMINI_MODEL_NAME,
					geminiApiKey: "test-key",
					googleGeminiBaseUrl: "http://insecure.example.com",
				})
				insecureHandler["client"] = handler["client"]
				handler["client"].models.generateContentStream = stub

				const stream = insecureHandler.createMessage("You are a helpful assistant", messages)

				const error = await collectStream(stream).catch((e: unknown) => e)
				expect(error).toBeInstanceOf(ApiProviderError)
				expect((error as ApiProviderError).message).toBe(
					"Google Gemini base URL must use HTTPS (or a loopback HTTP endpoint for local test proxies)",
				)
				expect((error as ApiProviderError).provider).toBe("Gemini")
				expect((error as ApiProviderError).operation).toBe("createMessage")
				expect(stub).not.toHaveBeenCalled()
			})

			it("should allow a loopback HTTP googleGeminiBaseUrl in createMessage", async () => {
				const messages: Anthropic.Messages.MessageParam[] = [
					{
						role: "user",
						content: "Hello",
					},
				]
				const stub = vi.fn().mockReturnValue((async function* () {})())
				const loopbackHandler = new GeminiHandler({
					apiKey: "test-key",
					apiModelId: GEMINI_MODEL_NAME,
					geminiApiKey: "test-key",
					googleGeminiBaseUrl: "http://127.0.0.1:8080",
				})
				loopbackHandler["client"] = handler["client"]
				handler["client"].models.generateContentStream = stub

				await collectStream(loopbackHandler.createMessage("You are a helpful assistant", messages))

				const config = stub.mock.calls[0][0].config
				expect(config.httpOptions).toEqual({ baseUrl: "http://127.0.0.1:8080" })
			})

			it("should allow an http://localhost googleGeminiBaseUrl in createMessage", async () => {
				const messages: Anthropic.Messages.MessageParam[] = [
					{
						role: "user",
						content: "Hello",
					},
				]
				const stub = vi.fn().mockReturnValue((async function* () {})())
				const localhostHandler = new GeminiHandler({
					apiKey: "test-key",
					apiModelId: GEMINI_MODEL_NAME,
					geminiApiKey: "test-key",
					googleGeminiBaseUrl: "http://localhost:8080",
				})
				localhostHandler["client"] = handler["client"]
				handler["client"].models.generateContentStream = stub

				await collectStream(localhostHandler.createMessage("You are a helpful assistant", messages))

				expect(stub.mock.calls[0][0].config.httpOptions).toEqual({ baseUrl: "http://localhost:8080" })
			})

			it("should allow an http://[::1] googleGeminiBaseUrl (IPv6 loopback host)", async () => {
				const messages: Anthropic.Messages.MessageParam[] = [
					{
						role: "user",
						content: "Hello",
					},
				]
				const stub = vi.fn().mockReturnValue((async function* () {})())
				const ipv6Handler = new GeminiHandler({
					apiKey: "test-key",
					apiModelId: GEMINI_MODEL_NAME,
					geminiApiKey: "test-key",
					googleGeminiBaseUrl: "http://[::1]:8080",
				})
				ipv6Handler["client"] = handler["client"]
				handler["client"].models.generateContentStream = stub

				await collectStream(ipv6Handler.createMessage("You are a helpful assistant", messages))

				expect(stub.mock.calls[0][0].config.httpOptions).toEqual({ baseUrl: "http://[::1]:8080" })
			})

			it("should reject hostnames that only resemble the 127. range", async () => {
				// "127a.b" shares the 127 prefix but is not a loopback address and
				// must not pass the anchored, dot-escaped 127. check. This case pins
				// the dot escape itself: an unescaped /^127/ pattern would match
				// "127a.b" and wrongly allow cleartext. (Hosts such as a127.0.0.1
				// are rejected by new URL() outright — its mixed digit-led/letter-led
				// label rule — so they never reach the check.)
				const messages: Anthropic.Messages.MessageParam[] = [
					{
						role: "user",
						content: "Hello",
					},
				]
				const stub = vi.fn().mockReturnValue((async function* () {})())
				const restrictedHandler = new GeminiHandler({
					apiKey: "test-key",
					apiModelId: GEMINI_MODEL_NAME,
					geminiApiKey: "test-key",
					googleGeminiBaseUrl: "http://127a.b:8080",
				})
				restrictedHandler["client"] = handler["client"]
				handler["client"].models.generateContentStream = stub

				const error = await collectStream(
					restrictedHandler.createMessage("You are a helpful assistant", messages),
				).catch((e: unknown) => e)
				expect(error).toBeInstanceOf(ApiProviderError)
				expect((error as ApiProviderError).message).toBe(
					"Google Gemini base URL must use HTTPS (or a loopback HTTP endpoint for local test proxies)",
				)
				expect((error as ApiProviderError).provider).toBe("Gemini")
				expect(stub).not.toHaveBeenCalled()
			})

			it("should reject a valid hostname containing the 127. substring that is not loopback", async () => {
				// "foo127.bar" is accepted by new URL() (a syntactically valid
				// hostname), contains the "127." substring, yet is not a loopback
				// address: only the anchored 127. check rejects it. A de-anchored
				// /127\./ pattern would match it and wrongly allow cleartext.
				const messages: Anthropic.Messages.MessageParam[] = [
					{
						role: "user",
						content: "Hello",
					},
				]
				const stub = vi.fn().mockReturnValue((async function* () {})())
				const restrictedHandler = new GeminiHandler({
					apiKey: "test-key",
					apiModelId: GEMINI_MODEL_NAME,
					geminiApiKey: "test-key",
					googleGeminiBaseUrl: "http://foo127.bar:8080",
				})
				restrictedHandler["client"] = handler["client"]
				handler["client"].models.generateContentStream = stub

				const error = await collectStream(
					restrictedHandler.createMessage("You are a helpful assistant", messages),
				).catch((e: unknown) => e)
				expect(error).toBeInstanceOf(ApiProviderError)
				expect((error as ApiProviderError).message).toBe(
					"Google Gemini base URL must use HTTPS (or a loopback HTTP endpoint for local test proxies)",
				)
				expect((error as ApiProviderError).provider).toBe("Gemini")
				expect(stub).not.toHaveBeenCalled()
			})

			it("should reject a non-HTTP loopback scheme such as ftp://localhost", async () => {
				// The protocol operand (left of the && in the loopback exception) must
				// still be enforced: a non-HTTP scheme aimed at a loopback host is not
				// a local test proxy and must be rejected like any other non-HTTPS URL.
				const messages: Anthropic.Messages.MessageParam[] = [
					{
						role: "user",
						content: "Hello",
					},
				]
				const stub = vi.fn().mockReturnValue((async function* () {})())
				const ftpHandler = new GeminiHandler({
					apiKey: "test-key",
					apiModelId: GEMINI_MODEL_NAME,
					geminiApiKey: "test-key",
					googleGeminiBaseUrl: "ftp://localhost:8080",
				})
				ftpHandler["client"] = handler["client"]
				handler["client"].models.generateContentStream = stub

				const error = await collectStream(
					ftpHandler.createMessage("You are a helpful assistant", messages),
				).catch((e: unknown) => e)
				expect(error).toBeInstanceOf(ApiProviderError)
				expect((error as ApiProviderError).message).toBe(
					"Google Gemini base URL must use HTTPS (or a loopback HTTP endpoint for local test proxies)",
				)
				expect((error as ApiProviderError).provider).toBe("Gemini")
				expect(stub).not.toHaveBeenCalled()
			})

			it("should reject an invalid googleGeminiBaseUrl in createMessage", async () => {
				const messages: Anthropic.Messages.MessageParam[] = [
					{
						role: "user",
						content: "Hello",
					},
				]
				const stub = vi.fn().mockReturnValue((async function* () {})())
				const invalidHandler = new GeminiHandler({
					apiKey: "test-key",
					apiModelId: GEMINI_MODEL_NAME,
					geminiApiKey: "test-key",
					googleGeminiBaseUrl: "not a valid url",
				})
				invalidHandler["client"] = handler["client"]
				handler["client"].models.generateContentStream = stub

				const error = await collectStream(
					invalidHandler.createMessage("You are a helpful assistant", messages),
				).catch((e: unknown) => e)
				expect(error).toBeInstanceOf(ApiProviderError)
				expect((error as ApiProviderError).message).toBe("Invalid Google Gemini base URL (not a valid URL)")
				expect((error as ApiProviderError).provider).toBe("Gemini")
				expect((error as ApiProviderError).operation).toBe("createMessage")
				expect(stub).not.toHaveBeenCalled()
			})
		})
	})

	describe("createMessage abort signal (bridging)", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: "Hello",
			},
		]

		it("should reject immediately with AbortError when the external signal is pre-aborted", async () => {
			const controller = new AbortController()
			controller.abort()

			const stream = handler.createMessage(
				"You are a helpful assistant",
				messages,
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const error = await collectStream(stream).catch((e: unknown) => e)
			expect(error).toBeInstanceOf(Error)
			expect((error as Error).name).toBe("AbortError")
			expect((error as Error).message).toBe("Gemini request aborted")
			expect(handler["client"].models.generateContentStream).not.toHaveBeenCalled()
		})

		it("should abort the in-flight request when the external signal is triggered", async () => {
			const controller = new AbortController()
			const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener")
			const removeEventListenerSpy = vi.spyOn(controller.signal, "removeEventListener")
			let capturedSignal: AbortSignal | undefined
			const stub = vi.fn().mockImplementation(async (params: { config?: { abortSignal?: AbortSignal } }) => {
				capturedSignal = params.config?.abortSignal
				return (async function* () {
					yield { text: "partial" }
					if (capturedSignal?.aborted) {
						throw new DOMException("aborted", "AbortError")
					}
					await new Promise((_resolve, reject) => {
						capturedSignal?.addEventListener(
							"abort",
							() => reject(new DOMException("aborted", "AbortError")),
							{ once: true },
						)
					})
				})()
			})
			handler["client"].models.generateContentStream = stub

			const stream = handler.createMessage(
				"You are a helpful assistant",
				messages,
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const collector = collectStream(stream).catch((e: unknown) => e)
			await new Promise((resolve) => setTimeout(resolve, 10))
			controller.abort()

			// Bound the wait so a broken abort bridge fails this test fast (and fails
			// the Stryker mutant) instead of hanging until the runner timeout.
			const error = await new Promise<unknown>((resolve) => {
				const deadline = setTimeout(() => resolve(new Error("abort propagation deadline exceeded")), 3000)
				collector.then((result) => {
					clearTimeout(deadline)
					resolve(result)
				})
			})
			expect(error).toBeInstanceOf(Error)
			expect((error as Error).name).toBe("AbortError")
			expect((error as Error).message).toBe("Gemini request aborted")
			expect(capturedSignal).toBeDefined()
			// The in-flight request must run against a request-local signal, not the
			// external one forwarded by reference.
			expect(capturedSignal).not.toBe(controller.signal)
			expect(capturedSignal?.aborted).toBe(true)
			// The bridge registers a once-only listener on the external signal and
			// detaches it when the request settles. Target the last "abort"
			// registration (the bridge's listener) and assert the exact reference
			// so a bridge that removes a different callback cannot pass.
			const abortAddCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === "abort")
			const addedListener = abortAddCalls[abortAddCalls.length - 1]?.[1]
			expect(typeof addedListener).toBe("function")
			expect(addEventListenerSpy).toHaveBeenCalledWith("abort", addedListener, { once: true })
			expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", addedListener)
		})

		it("should not set config.abortSignal when no external signal is provided", async () => {
			const stub = vi.fn().mockReturnValue((async function* () {})())
			handler["client"].models.generateContentStream = stub

			await collectStream(handler.createMessage("You are a helpful assistant", messages))

			const config = stub.mock.calls[0][0].config
			expect(config.abortSignal).toBeUndefined()
		})

		it("should wrap a non-abort stream failure with the i18n message and capture telemetry", async () => {
			const mockError = new Error("Gemini stream failure")
			handler["client"].models.generateContentStream = vi.fn().mockRejectedValue(mockError)

			const stream = handler.createMessage("You are a helpful assistant", messages, makeCreateMessageMetadata())

			const error = await collectStream(stream).catch((e: unknown) => e)
			expect(error).toBeInstanceOf(Error)
			// The catch must take the non-abort wrapping path (not the abort
			// DOMException path) and must not crash reading a missing signal.
			expect((error as Error).message).not.toContain("Cannot read properties")
			expect(mockCaptureException).toHaveBeenCalledTimes(1)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Gemini stream failure",
					provider: "Gemini",
					operation: "createMessage",
				}),
			)
		})

		it("should wrap a stream failure when no metadata is provided at all", async () => {
			const mockError = new Error("Gemini stream failure")
			handler["client"].models.generateContentStream = vi.fn().mockRejectedValue(mockError)

			const stream = handler.createMessage("You are a helpful assistant", messages)

			const error = await collectStream(stream).catch((e: unknown) => e)
			expect(error).toBeInstanceOf(Error)
			// No metadata at all: exercises the first optional-chain position,
			// which would crash here if the `?.` were removed.
			expect((error as Error).message).not.toContain("Cannot read properties")
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

			await expect(collectStream(stream)).rejects.toThrow()

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
			await expect(collectStream(stream)).rejects.toThrow()

			// Telemetry should have been captured before the error was thrown
			expect(mockCaptureException).toHaveBeenCalled()
		})
	})
})
