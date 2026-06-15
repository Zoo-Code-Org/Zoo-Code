// npx vitest run api/providers/__tests__/native-ollama.spec.ts

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
	})

	describe("completePrompt", () => {
		it("should complete a prompt with streaming", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "This is the response" } }
			})

			const result = await handler.completePrompt("Tell me a joke")

			expect(mockChat).toHaveBeenCalledWith({
				model: "llama2",
				messages: [{ role: "user", content: "Tell me a joke" }],
				stream: true,
				options: {
					temperature: 0,
				},
			})
			expect(result).toBe("This is the response")
		})

		it("should not include num_ctx in completePrompt by default", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "Response" } }
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

			mockChat.mockImplementation(async function* () {
				yield { message: { content: "Response" } }
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

		it("should wrap chat errors in completePrompt", async () => {
			mockChat.mockRejectedValue(new Error("chat failure"))

			await expect(handler.completePrompt("Test")).rejects.toThrow("Ollama completion error: chat failure")
		})

		it("should re-throw non-Error objects in completePrompt", async () => {
			mockChat.mockRejectedValue("string error")

			await expect(handler.completePrompt("Test")).rejects.toBe("string error")
		})
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

		it("should re-throw generic chat errors in createMessage", async () => {
			const error = new Error("Internal server error") as any
			error.status = 500
			mockChat.mockRejectedValue(error)

			const stream = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])

			await expect(async () => {
				for await (const _ of stream) {
					// consume stream
				}
			}).rejects.toThrow("Internal server error")
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
	})

	describe("abort lifecycle", () => {
		it("abort() should not throw when no controller exists", () => {
			expect(() => handler.abort()).not.toThrow()
		})

		it("abort() should abort the current signal during createMessage", async () => {
			// Use a stream that blocks until aborted
			let resolveStream: (() => void) | undefined
			const streamDone = new Promise<void>((resolve) => {
				resolveStream = resolve
			})

			const mockAbort = vitest.fn()
			mockChat.mockImplementation(() => {
				return {
					[Symbol.asyncIterator]: async function* () {
						yield { message: { content: "first" } }
						// Wait until the test signals us to stop
						await streamDone
					},
					abort: mockAbort,
				}
			})

			const gen = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])
			await gen.next() // Get first chunk, which starts the stream

			// Now abort
			handler.abort()

			// Let the stream finish
			resolveStream!()

			// Consume remaining
			for await (const _ of gen) {
				// drain
			}

			// The stream.abort() should have been called via the abort event listener
			expect(mockAbort).toHaveBeenCalled()
		})

		it("should handle already-aborted signal in createMessage", async () => {
			const mockAbort = vitest.fn()
			mockChat.mockImplementation(() => ({
				[Symbol.asyncIterator]: async function* () {
					yield { message: { content: "should not reach" } }
				},
				abort: mockAbort,
			}))

			// Spy on createAbortSignal to return an already-aborted signal
			vitest.spyOn(handler as any, "createAbortSignal").mockReturnValue({
				aborted: true,
				addEventListener: vitest.fn(),
				removeEventListener: vitest.fn(),
			})

			const gen = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])
			const results = []
			for await (const chunk of gen) {
				results.push(chunk)
			}

			// The already-aborted signal should cause stream.abort() and break out of the loop
			expect(mockAbort).toHaveBeenCalled()
		})

		it("should handle already-aborted signal in completePrompt", async () => {
			const mockAbort = vitest.fn()
			mockChat.mockImplementation(() => ({
				[Symbol.asyncIterator]: async function* () {
					yield { message: { content: "should not reach" } }
				},
				abort: mockAbort,
			}))

			vitest.spyOn(handler as any, "createAbortSignal").mockReturnValue({
				aborted: true,
				addEventListener: vitest.fn(),
				removeEventListener: vitest.fn(),
			})

			const result = await handler.completePrompt("Test")

			expect(mockAbort).toHaveBeenCalled()
			// Should break out early, returning empty string
			expect(result).toBe("")
		})

		it("should call stream.abort() when signal fires during completePrompt", async () => {
			let abortController: AbortController | undefined
			const mockAbort = vitest.fn()

			vitest.spyOn(handler as any, "createAbortSignal").mockImplementation(() => {
				abortController = new AbortController()
				return abortController.signal
			})

			mockChat.mockImplementation(() => ({
				[Symbol.asyncIterator]: async function* () {
					yield { message: { content: "response" } }
					// Delay to let the abort fire between chunk iterations
					await new Promise((resolve) => setTimeout(resolve, 100))
					yield { message: { content: " more" } }
				},
				abort: mockAbort,
			}))

			// Start completePrompt (we don't await it since we need to abort mid-stream)
			const promptPromise = handler.completePrompt("Test")

			// Wait a tick for the first chunk to be yielded and the onAbort listener
			// to be attached, then fire the abort signal between chunk iterations.
			await new Promise((resolve) => setTimeout(resolve, 10))

			// Fire the abort signal — this triggers onAbort → stream.abort()
			abortController!.abort()

			const result = await promptPromise

			expect(mockAbort).toHaveBeenCalled()
			expect(result).toBe("response")
		})

		it("should break out of stream loop when signal becomes aborted", async () => {
			let abortController: AbortController | undefined
			const mockAbort = vitest.fn()

			vitest.spyOn(handler as any, "createAbortSignal").mockImplementation(() => {
				abortController = new AbortController()
				return abortController.signal
			})

			let chunkCount = 0
			mockChat.mockImplementation(() => ({
				[Symbol.asyncIterator]: async function* () {
					yield { message: { content: "chunk1" } }
					yield { message: { content: "chunk2" } }
					yield { message: { content: "chunk3" } }
				},
				abort: mockAbort,
			}))

			const gen = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])

			// Get first chunk
			const first = await gen.next()
			expect(first.value).toEqual({ type: "text", text: "chunk1" })
			chunkCount++

			// Abort after first chunk
			abortController!.abort()

			// Get next chunk - should break due to signal.aborted check
			const second = await gen.next()
			// The generator should finish
			expect(second.done).toBe(true)
		})

		it("should call abortAndCleanup in finally block of createMessage", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "done" } }
			})

			const spy = vitest.spyOn(handler as any, "abortAndCleanup")

			const gen = handler.createMessage("System", [{ role: "user" as const, content: "Test" }])
			for await (const _ of gen) {
				// consume
			}

			expect(spy).toHaveBeenCalled()
		})

		it("should call abortAndCleanup in finally block of completePrompt", async () => {
			mockChat.mockImplementation(async function* () {
				yield { message: { content: "response" } }
			})

			const spy = vitest.spyOn(handler as any, "abortAndCleanup")

			await handler.completePrompt("Test")

			expect(spy).toHaveBeenCalled()
		})
	})
})
