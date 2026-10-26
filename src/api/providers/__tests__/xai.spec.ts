// npx vitest api/providers/__tests__/xai.spec.ts

// Mock TelemetryService - must come before other imports
const mockCaptureException = vitest.hoisted(() => vitest.fn())
vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: mockCaptureException,
		},
	},
}))

const mockResponsesCreate = vitest.hoisted(() => vitest.fn())

vitest.mock("openai", async () => {
	const { mockOpenAiResponsesClient } = await import("../../../test-utils/api")
	const actual = await vi.importActual<typeof import("openai")>("openai")
	return {
		...mockOpenAiResponsesClient(mockResponsesCreate),
		// Expose the real SDK error class so the mock transport can throw it exactly
		// the way the OpenAI SDK does when a request signal aborts.
		APIUserAbortError: actual.APIUserAbortError,
	}
})

import OpenAI, { APIUserAbortError } from "openai"

import { xaiDefaultModelId, xaiModels } from "@roo-code/types"

import { XAIHandler } from "../xai"
import { MAX_TIMEOUT_MS } from "../utils/abort-signal"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { makeCreateMessageMetadata } from "../../../test-utils/api"
import { clearAllMocks } from "../../../test-utils/reset"

describe("XAIHandler", () => {
	let handler: XAIHandler

	beforeEach(() => {
		clearAllMocks()
		mockResponsesCreate.mockClear()
		mockCaptureException.mockClear()
		handler = new XAIHandler({})
	})

	it("should use the correct X.AI base URL", () => {
		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://api.x.ai/v1",
			}),
		)
	})

	it("should use the provided API key", () => {
		clearAllMocks()
		const xaiApiKey = "test-api-key"
		new XAIHandler({ xaiApiKey })
		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: xaiApiKey,
			}),
		)
	})

	it("should return default model when no model is specified", () => {
		const model = handler.getModel()
		expect(model.id).toBe(xaiDefaultModelId)
		expect(model.info).toEqual(xaiModels[xaiDefaultModelId])
	})

	it("should return specified model when valid model is provided", () => {
		const testModelId = "grok-3"
		const handlerWithModel = new XAIHandler({ apiModelId: testModelId })
		const model = handlerWithModel.getModel()
		expect(model.id).toBe(testModelId)
		expect(model.info).toEqual(xaiModels[testModelId])
	})

	it("should return grok-build-0.1 when specified", () => {
		const testModelId = "grok-build-0.1"
		const handlerWithModel = new XAIHandler({ apiModelId: testModelId })
		const model = handlerWithModel.getModel()
		expect(model.id).toBe(testModelId)
		expect(model.info).toEqual(xaiModels[testModelId])
	})

	it("should return default model for an unknown model id", () => {
		const handlerWithModel = new XAIHandler({ apiModelId: "grok-build-0.1-not-a-model" })
		const model = handlerWithModel.getModel()
		expect(model.id).toBe(xaiDefaultModelId)
		expect(model.info).toEqual(xaiModels[xaiDefaultModelId])
	})

	it("should use Responses API (client.responses.create)", async () => {
		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = handler.createMessage("test prompt", [])
		await stream.next()

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				model: xaiDefaultModelId,
				instructions: "test prompt",
				stream: true,
				store: false,
				include: ["reasoning.encrypted_content"],
			}),
		)
	})

	it("createMessage should yield text content from stream", async () => {
		const testContent = "This is test content"

		mockResponsesCreate.mockResolvedValueOnce(
			asyncStreamFrom([{ type: "response.output_text.delta", delta: testContent }]),
		)

		const stream = handler.createMessage("system prompt", [])
		const firstChunk = await stream.next()

		expect(firstChunk.done).toBe(false)
		expect(firstChunk.value).toEqual({
			type: "text",
			text: testContent,
		})
	})

	it("createMessage should yield reasoning content from stream", async () => {
		const testReasoning = "Test reasoning content"

		mockResponsesCreate.mockResolvedValueOnce(
			asyncStreamFrom([{ type: "response.reasoning_text.delta", delta: testReasoning }]),
		)

		const stream = handler.createMessage("system prompt", [])
		const firstChunk = await stream.next()

		expect(firstChunk.done).toBe(false)
		expect(firstChunk.value).toEqual({
			type: "reasoning",
			text: testReasoning,
		})
	})

	it("createMessage should yield usage data from response.completed", async () => {
		mockResponsesCreate.mockResolvedValueOnce(
			asyncStreamFrom([
				{
					type: "response.completed",
					response: {
						usage: {
							input_tokens: 10,
							output_tokens: 20,
							input_tokens_details: { cached_tokens: 5 },
							output_tokens_details: { reasoning_tokens: 8 },
						},
					},
				},
			]),
		)

		const stream = handler.createMessage("system prompt", [])
		const firstChunk = await stream.next()

		expect(firstChunk.done).toBe(false)
		expect(firstChunk.value).toEqual(
			expect.objectContaining({
				type: "usage",
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 5,
				reasoningTokens: 8,
			}),
		)
	})

	it("createMessage should yield tool_call from output_item.done", async () => {
		mockResponsesCreate.mockResolvedValueOnce(
			asyncStreamFrom([
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call_123",
						name: "test_tool",
						arguments: '{"arg1":"value"}',
					},
				},
			]),
		)

		const stream = handler.createMessage("system prompt", [])
		const firstChunk = await stream.next()

		expect(firstChunk.done).toBe(false)
		expect(firstChunk.value).toEqual({
			type: "tool_call",
			id: "call_123",
			name: "test_tool",
			arguments: '{"arg1":"value"}',
		})
	})

	it("should include tools in Responses API format", async () => {
		const testTools = [
			{
				type: "function" as const,
				function: {
					name: "test_tool",
					description: "A test tool",
					parameters: { type: "object", properties: { arg1: { type: "string" } }, required: ["arg1"] },
				},
			},
		]

		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = handler.createMessage("test prompt", [], {
			taskId: "test-task-id",
			tools: testTools,
		})
		await stream.next()

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				tools: [
					expect.objectContaining({
						type: "function",
						name: "test_tool",
						description: "A test tool",
						strict: true,
					}),
				],
				tool_choice: "auto",
				parallel_tool_calls: true,
			}),
		)
	})

	it("createMessage should honor an explicit parallelToolCalls false", async () => {
		const testTools = [
			{
				type: "function" as const,
				function: {
					name: "test_tool",
					description: "A test Tool",
					parameters: { type: "object", properties: { arg1: { type: "string" } }, required: ["arg1"] },
				},
			},
		]

		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = handler.createMessage("test prompt", [], {
			taskId: "test-task-id",
			tools: testTools,
			parallelToolCalls: false,
		})
		await stream.next()

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				parallel_tool_calls: false,
			}),
		)
	})

	it("createMessage should send max_output_tokens and temperature for the default model", async () => {
		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = handler.createMessage("test prompt", [])
		await stream.next()

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				max_output_tokens: 65_536,
				temperature: 0,
			}),
		)
	})

	it("createMessage should omit tool parameters when no tools are provided", async () => {
		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = handler.createMessage("test prompt", [])
		await stream.next()

		const callArgs = mockResponsesCreate.mock.calls[mockResponsesCreate.mock.calls.length - 1][0]
		expect(callArgs).not.toHaveProperty("tools")
		expect(callArgs).not.toHaveProperty("tool_choice")
		expect(callArgs).not.toHaveProperty("parallel_tool_calls")
	})

	it("completePrompt should return text from Responses API", async () => {
		const expectedResponse = "This is a test response"
		mockResponsesCreate.mockResolvedValueOnce({
			output_text: expectedResponse,
		})

		const result = await handler.completePrompt("test prompt")
		expect(result).toBe(expectedResponse)
	})

	it("createMessage should map a forced tool_choice to the Responses API shape", async () => {
		const testTools = [
			{
				type: "function" as const,
				function: {
					name: "test_tool",
					description: "A test tool",
					parameters: { type: "object", properties: { arg1: { type: "string" } }, required: ["arg1"] },
				},
			},
		]

		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = handler.createMessage("test prompt", [], {
			taskId: "test-task-id",
			tools: testTools,
			tool_choice: { type: "function", function: { name: "test_tool" } },
		})
		await stream.next()

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				tool_choice: { type: "function", name: "test_tool" },
			}),
		)
	})

	it("createMessage should flatten allowed_tools entries to the Responses API shape", async () => {
		const testTools = [
			{
				type: "function" as const,
				function: {
					name: "test_tool",
					description: "A test tool",
					parameters: { type: "object", properties: { arg1: { type: "string" } }, required: ["arg1"] },
				},
			},
		]

		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = handler.createMessage("test prompt", [], {
			taskId: "test-task-id",
			tools: testTools,
			tool_choice: {
				type: "allowed_tools",
				allowed_tools: {
					mode: "required",
					tools: [
						{ type: "function", function: { name: "test_tool" } },
						{ type: "mcp", server_label: "deepwiki" },
					],
				},
			},
		})
		await stream.next()

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				tool_choice: {
					type: "allowed_tools",
					mode: "required",
					tools: [
						{ type: "function", name: "test_tool" },
						{ type: "mcp", server_label: "deepwiki" },
					],
				},
			}),
		)
	})

	it("createMessage should reject an allowed_tools function entry with a malformed name", async () => {
		// The Chat Completions allowlist type accepts open records, so a
		// function entry can carry a missing or non-string name. It must be
		// rejected at the boundary rather than forwarded in the nested Chat
		// Completions shape, which the Responses API cannot express.
		const testTools = [
			{
				type: "function" as const,
				function: {
					name: "test_tool",
					description: "A test tool",
					parameters: { type: "object", properties: { arg1: { type: "string" } }, required: ["arg1"] },
				},
			},
		]
		const callsBefore = mockResponsesCreate.mock.calls.length

		const malformedEntries = [
			{ type: "function", function: { name: null } },
			{ type: "function", function: null },
			{ type: "function", function: () => 1 },
			{ type: "function", function: { name: 123 } },
		]
		for (const entry of malformedEntries) {
			// The mapping throws during request construction; the abort bridge must not have
			// registered a listener yet, or a malformed tool choice would leak it.
			const abortController = new AbortController()
			const addListenerSpy = vi.spyOn(abortController.signal, "addEventListener")
			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				abortSignal: abortController.signal,
				tools: testTools,
				tool_choice: {
					type: "allowed_tools",
					allowed_tools: {
						mode: "required",
						tools: [entry, { type: "mcp", server_label: "deepwiki" }],
					},
				},
			})
			await expect(stream.next()).rejects.toThrow(
				'allowed_tools entry of type "function" is missing a valid function name',
			)
			expect(addListenerSpy).not.toHaveBeenCalled()
			addListenerSpy.mockRestore()
		}
		expect(mockResponsesCreate.mock.calls.length).toBe(callsBefore)
	})

	it("createMessage should map a custom tool_choice to the Responses API shape", async () => {
		const testTools = [
			{
				type: "function" as const,
				function: {
					name: "test_tool",
					description: "A test tool",
					parameters: { type: "object", properties: { arg1: { type: "string" } }, required: ["arg1"] },
				},
			},
		]

		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = handler.createMessage("test prompt", [], {
			taskId: "test-task-id",
			tools: testTools,
			tool_choice: { type: "custom", custom: { name: "custom_tool" } },
		})
		await stream.next()

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				tool_choice: { type: "custom", name: "custom_tool" },
			}),
		)
	})

	it("createMessage should pass through unmappable allowed_tools entries unchanged", async () => {
		const testTools = [
			{
				type: "function" as const,
				function: {
					name: "test_tool",
					description: "A test tool",
					parameters: { type: "object", properties: { arg1: { type: "string" } }, required: ["arg1"] },
				},
			},
		]

		// Entries that are not function references pass through unchanged: a
		// non-function type carrying a function ref must not be rewritten.
		// Malformed function entries (null ref, function value, non-string name)
		// are rejected at the boundary; see the dedicated rejection test.
		const entries = [{ type: "mcp", function: { name: "leaky" } }]

		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = handler.createMessage("test prompt", [], {
			taskId: "test-task-id",
			tools: testTools,
			tool_choice: { type: "allowed_tools", allowed_tools: { mode: "auto", tools: entries } },
		})
		await stream.next()

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				tool_choice: {
					type: "allowed_tools",
					mode: "auto",
					tools: entries,
				},
			}),
		)
	})

	it("createMessage should send max_output_tokens and temperature for the default model", async () => {
		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = handler.createMessage("test prompt", [])
		await stream.next()

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				max_output_tokens: 65_536,
				temperature: 0,
			}),
		)
	})

	it("should handle errors in completePrompt", async () => {
		const errorMessage = "API error"
		mockResponsesCreate.mockRejectedValueOnce(new Error(errorMessage))

		await expect(handler.completePrompt("test prompt")).rejects.toThrow(`xAI completion error: ${errorMessage}`)
	})

	it("completePrompt should normalize the SDK APIUserAbortError to the contract AbortError on abort", async () => {
		const controller = new AbortController()
		controller.abort()
		const sdkAbortError = new APIUserAbortError()
		mockResponsesCreate.mockRejectedValueOnce(sdkAbortError)

		// The raw SDK abort error (name "Error", message "Request was aborted.") does not
		// satisfy the caller's AbortError contract; it must be normalized, not wrapped by
		// handleOpenAIError.
		await expect(handler.completePrompt("test prompt", { abortSignal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
			message: "The xAI request was aborted",
		})
	})

	it("completePrompt should normalize a native AbortError to the contract error on abort", async () => {
		const controller = new AbortController()
		controller.abort()
		const abortError = new Error("This operation was aborted")
		abortError.name = "AbortError"
		mockResponsesCreate.mockRejectedValueOnce(abortError)

		// Normalized to the branded contract message while keeping the contract name.
		await expect(handler.completePrompt("test prompt", { abortSignal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
			message: "The xAI request was aborted",
		})
	})

	it("completePrompt should pass abort signal through to client", async () => {
		const controller = new AbortController()
		mockResponsesCreate.mockResolvedValueOnce({ output_text: "response" })

		await handler.completePrompt("test prompt", { abortSignal: controller.signal })
		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ model: expect.any(String) }))
		const requestOptions = mockResponsesCreate.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined
		expect(requestOptions?.signal).toBe(controller.signal)
	})

	it("completePrompt should work without options (backward compatible)", async () => {
		mockResponsesCreate.mockResolvedValueOnce({ output_text: "response" })

		const result = await handler.completePrompt("test prompt")
		expect(result).toBe("response")
		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ model: expect.any(String) }))
	})

	it("completePrompt should send the full Responses API request body", async () => {
		mockResponsesCreate.mockResolvedValueOnce({ output_text: "response" })

		await handler.completePrompt("test prompt")

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual({
			model: xaiDefaultModelId,
			input: [{ role: "user", content: [{ type: "input_text", text: "test prompt" }] }],
			store: false,
		})
	})

	it("completePrompt should pass timeout through to client", async () => {
		const controller = new AbortController()
		mockResponsesCreate.mockResolvedValueOnce({ output_text: "response" })

		await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 5000 })
		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ model: expect.any(String) }))
		const requestOptions = mockResponsesCreate.mock.calls[0]?.[1] as
			{ signal?: AbortSignal; timeout?: number } | undefined
		expect(requestOptions).toMatchObject({ signal: controller.signal, timeout: 5000 })
	})

	it.each([
		{ label: "a whole-number", input: 3000, forwarded: 3000 },
		// Only a call through toSdkTimeoutMs rounds this up.
		{ label: "a fractional", input: 12.5, forwarded: 13 },
		// Only a call through toSdkTimeoutMs caps at the Node timer maximum.
		{ label: "an over-cap", input: MAX_TIMEOUT_MS + 1, forwarded: MAX_TIMEOUT_MS },
	])(
		"completePrompt should forward $label timeoutMs as $forwarded when no signal provided",
		async ({ input, forwarded }) => {
			mockResponsesCreate.mockResolvedValueOnce({ output_text: "response" })

			await handler.completePrompt("test prompt", { timeoutMs: input })
			expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
				expect.objectContaining({ model: expect.any(String) }),
			)
			expect(mockResponsesCreate.mock.calls[0]?.[1]).toMatchObject({ timeout: forwarded })
		},
	)

	// "No explicit timeout" must leave the option absent: timeout: 0 aborts
	// immediately and negative/non-finite delays throw inside the SDK.
	it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
		"completePrompt should not forward an unusable timeoutMs (%s)",
		async (timeoutMs) => {
			mockResponsesCreate.mockClear()
			mockResponsesCreate.mockResolvedValueOnce({ output_text: "response" })
			await handler.completePrompt("test prompt", { timeoutMs })
			expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
				expect.objectContaining({ model: expect.any(String) }),
			)
			// No usable timeout and no signal means the SDK options argument is omitted entirely.
			expect(mockResponsesCreate.mock.calls[0]?.[1]).toBeUndefined()
		},
	)

	it("should include reasoning effort for mini models in Responses API format", async () => {
		const miniModelHandler = new XAIHandler({
			apiModelId: "grok-3-mini",
			reasoningEffort: "high",
		})

		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = miniModelHandler.createMessage("test prompt", [])
		await stream.next()

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				reasoning: expect.objectContaining({
					effort: "high",
				}),
			}),
		)
	})

	it("should include reasoning effort for grok-4.5 with default high effort", async () => {
		const grok45Handler = new XAIHandler({
			apiModelId: "grok-4.5",
		})

		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = grok45Handler.createMessage("test prompt", [])
		await stream.next()

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				model: "grok-4.5",
				reasoning: expect.objectContaining({
					effort: "high",
				}),
			}),
		)
	})

	it("should include reasoning effort for grok-4.5 with custom low effort", async () => {
		const grok45Handler = new XAIHandler({
			apiModelId: "grok-4.5",
			reasoningEffort: "low",
		})

		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = grok45Handler.createMessage("test prompt", [])
		await stream.next()

		expect(mockResponsesCreate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				model: "grok-4.5",
				reasoning: expect.objectContaining({
					effort: "low",
				}),
			}),
		)
	})

	it("should not include reasoning for non-mini models", async () => {
		const regularHandler = new XAIHandler({
			apiModelId: "grok-3",
			reasoningEffort: "high",
		})

		mockResponsesCreate.mockResolvedValueOnce(asyncStreamFrom([]))

		const stream = regularHandler.createMessage("test prompt", [])
		await stream.next()

		const callArgs = mockResponsesCreate.mock.calls[mockResponsesCreate.mock.calls.length - 1][0]
		expect(callArgs).not.toHaveProperty("reasoning")
	})

	it("should handle errors in createMessage", async () => {
		const errorMessage = "Stream error"
		mockResponsesCreate.mockRejectedValueOnce(new Error(errorMessage))

		const stream = handler.createMessage("test prompt", [])
		await expect(stream.next()).rejects.toThrow(`xAI completion error: ${errorMessage}`)
	})

	it("should capture createMessage failures in telemetry with operation context", async () => {
		mockResponsesCreate.mockRejectedValueOnce(new Error("Stream error"))

		const stream = handler.createMessage("test prompt", [])
		await expect(stream.next()).rejects.toThrow("xAI completion error: Stream error")

		expect(mockCaptureException).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "ApiProviderError",
				provider: "xAI",
				modelId: xaiDefaultModelId,
				operation: "createMessage",
			}),
		)
	})

	it("createMessage should normalize the SDK APIUserAbortError to the contract AbortError on abort", async () => {
		const abortedController = new AbortController()
		abortedController.abort()
		const sdkAbortError = new APIUserAbortError()

		mockResponsesCreate.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
			// Mimic the OpenAI SDK: reject with its own APIUserAbortError when the
			// request signal is aborted.
			if (options?.signal?.aborted) {
				throw sdkAbortError
			}
			return asyncStreamFrom([])
		})

		const stream = handler.createMessage(
			"test prompt",
			[],
			makeCreateMessageMetadata({ abortSignal: abortedController.signal }),
		)

		// The raw SDK abort error does not satisfy the caller's AbortError contract: it
		// must be normalized, not wrapped by handleOpenAIError.
		await expect(stream.next()).rejects.toMatchObject({
			name: "AbortError",
			message: "The xAI request was aborted",
		})
	})

	it("createMessage should normalize an SDK abort raised while iterating the response stream", async () => {
		const controller = new AbortController()
		const sdkAbortError = new APIUserAbortError()

		// responses.create resolves; the cancellation lands while the stream is
		// being consumed, so the SDK abort error escapes from the iterator.
		mockResponsesCreate.mockResolvedValueOnce({
			[Symbol.asyncIterator]: () => ({
				next: async () => {
					controller.abort()
					throw sdkAbortError
				},
			}),
		})

		const stream = handler.createMessage(
			"test prompt",
			[],
			makeCreateMessageMetadata({ abortSignal: controller.signal }),
		)

		// The raw SDK abort error (name "Error") must be normalized to the
		// contract AbortError even though it escapes outside the create call.
		await expect(stream.next()).rejects.toMatchObject({
			name: "AbortError",
			message: "The xAI request was aborted",
		})
	})

	it("should reject with AbortError when createMessage is called with an already-aborted signal", async () => {
		const abortedController = new AbortController()
		abortedController.abort()

		mockResponsesCreate.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
			if (options?.signal?.aborted) {
				const error = new Error("The operation was aborted")
				error.name = "AbortError"
				throw error
			}
			return asyncStreamFrom([])
		})

		const stream = handler.createMessage(
			"test prompt",
			[],
			makeCreateMessageMetadata({ abortSignal: abortedController.signal }),
		)

		await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" })
	})

	it("should abort the request when the external signal aborts mid-flight", async () => {
		const controller = new AbortController()

		mockResponsesCreate.mockImplementation((_params: unknown, options?: { signal?: AbortSignal }) => {
			return new Promise<void>((_resolve, reject) => {
				const signal = options?.signal
				if (!signal) {
					return
				}
				if (signal.aborted) {
					const error = new Error("The operation was aborted")
					error.name = "AbortError"
					reject(error)
					return
				}
				signal.addEventListener(
					"abort",
					() => {
						const error = new Error("The operation was aborted")
						error.name = "AbortError"
						reject(error)
					},
					{ once: true },
				)
			})
		})

		const stream = handler.createMessage(
			"test prompt",
			[],
			makeCreateMessageMetadata({ abortSignal: controller.signal }),
		)

		const promise = stream.next()
		controller.abort()
		await expect(promise).rejects.toMatchObject({ name: "AbortError" })
	})

	it("should remove the external abort listener when the stream completes", async () => {
		const controller = new AbortController()
		const addEventListenerSpy = vitest.spyOn(controller.signal, "addEventListener")
		const removeEventListenerSpy = vitest.spyOn(controller.signal, "removeEventListener")

		mockResponsesCreate.mockResolvedValueOnce(
			asyncStreamFrom([{ type: "response.output_text.delta", delta: "done" }]),
		)

		const stream = handler.createMessage(
			"test prompt",
			[],
			makeCreateMessageMetadata({ abortSignal: controller.signal }),
		)

		const chunks = await collectStream(stream)
		expect(chunks).toEqual([{ type: "text", text: "done" }])

		expect(addEventListenerSpy).toHaveBeenCalledTimes(1)
		const [event, listener] = addEventListenerSpy.mock.calls[0]
		expect(event).toBe("abort")
		// The listener is registered once so it detaches itself when the signal aborts.
		expect(addEventListenerSpy.mock.calls[0][2]).toEqual({ once: true })
		// The same retained callback must be detached once the stream is done.
		expect(removeEventListenerSpy).toHaveBeenCalledTimes(1)
		expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", listener)
	})

	it("should remove the external abort listener when the SDK call rejects", async () => {
		const controller = new AbortController()
		const addEventListenerSpy = vitest.spyOn(controller.signal, "addEventListener")
		const removeEventListenerSpy = vitest.spyOn(controller.signal, "removeEventListener")

		mockResponsesCreate.mockRejectedValueOnce(new Error("xai createMessage error"))

		const stream = handler.createMessage(
			"test prompt",
			[],
			makeCreateMessageMetadata({ abortSignal: controller.signal }),
		)

		await expect(stream.next()).rejects.toThrow()

		expect(addEventListenerSpy).toHaveBeenCalledTimes(1)
		const [event, listener] = addEventListenerSpy.mock.calls[0]
		expect(event).toBe("abort")
		// The finally block must detach the listener when the request fails, not
		// only on normal completion.
		expect(removeEventListenerSpy).toHaveBeenCalledTimes(1)
		expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", listener)
	})

	it("should remove the external abort listener when the consumer returns early", async () => {
		const controller = new AbortController()
		const addEventListenerSpy = vitest.spyOn(controller.signal, "addEventListener")
		const removeEventListenerSpy = vitest.spyOn(controller.signal, "removeEventListener")

		mockResponsesCreate.mockResolvedValueOnce(
			asyncStreamFrom([
				{ type: "response.output_text.delta", delta: "first" },
				{ type: "response.output_text.delta", delta: "second" },
			]),
		)

		const stream = handler.createMessage(
			"test prompt",
			[],
			makeCreateMessageMetadata({ abortSignal: controller.signal }),
		)
		const iterator = stream[Symbol.asyncIterator]()

		expect((await iterator.next()).value).toEqual({ type: "text", text: "first" })
		await iterator.return(undefined)

		expect(addEventListenerSpy).toHaveBeenCalledTimes(1)
		const [event, listener] = addEventListenerSpy.mock.calls[0]
		expect(event).toBe("abort")
		// Abandoning the generator mid-stream runs the finally block too.
		expect(removeEventListenerSpy).toHaveBeenCalledTimes(1)
		expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", listener)
	})
})
