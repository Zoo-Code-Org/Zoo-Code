// npx vitest run api/providers/__tests__/qwen-code-native-tools.spec.ts

// Mock filesystem - must come before other imports
vi.mock("node:fs", () => ({
	promises: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
	},
}))

const mockCreate = vi.fn()
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
vi.mock("openai", () => {
	return {
		__esModule: true,
		default: vi.fn().mockImplementation(function () {
			return {
				apiKey: "test-key",
				baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				chat: {
					completions: {
						create: mockCreate,
					},
				},
			}
		}),
	}
})

import { promises as fs } from "node:fs"
import { QwenCodeHandler } from "../qwen-code"
import { NativeToolCallParser } from "../../../core/assistant-message/NativeToolCallParser"
import type { ApiHandlerOptions } from "../../../shared/api"

describe("QwenCodeHandler Native Tools", () => {
	let handler: QwenCodeHandler
	let mockOptions: ApiHandlerOptions & { qwenCodeOauthPath?: string }

	const testTools = [
		{
			type: "function" as const,
			function: {
				name: "test_tool",
				description: "A test tool",
				parameters: {
					type: "object",
					properties: {
						arg1: { type: "string", description: "First argument" },
					},
					required: ["arg1"],
				},
			},
		},
	]

	beforeEach(() => {
		clearAllMocks()

		// Mock credentials file
		const mockCredentials = {
			access_token: "test-access-token",
			refresh_token: "test-refresh-token",
			token_type: "Bearer",
			expiry_date: Date.now() + 3600000, // 1 hour from now
			resource_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		}
		;(fs.readFile as any).mockResolvedValue(JSON.stringify(mockCredentials))
		;(fs.writeFile as any).mockResolvedValue(undefined)

		mockOptions = {
			apiModelId: "qwen3-coder-plus",
		}
		handler = new QwenCodeHandler(mockOptions)

		// Clear NativeToolCallParser state before each test
		NativeToolCallParser.clearRawChunkState()
	})

	describe("Native Tool Calling Support", () => {
		it("should include tools in request when model supports native tools and tools are provided", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: "Test response" } }] }]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
			})
			await stream.next()

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
					parallel_tool_calls: true,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("should include tool_choice when provided", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: "Test response" } }] }]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
				tool_choice: "auto",
			})
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					tool_choice: "auto",
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("should always include tools and tool_choice (tools are guaranteed to be present after ALWAYS_AVAILABLE_TOOLS)", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: "Test response" } }] }]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
			})
			await stream.next()

			// Tools are now always present (minimum 6 from ALWAYS_AVAILABLE_TOOLS)
			const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0]
			expect(callArgs).toHaveProperty("tools")
			expect(callArgs).toHaveProperty("tool_choice")
			expect(callArgs).toHaveProperty("parallel_tool_calls", true)
		})

		it("should yield tool_call_partial chunks during streaming", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_qwen_123",
											function: {
												name: "test_tool",
												arguments: '{"arg1":',
											},
										},
									],
								},
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
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
			})

			const chunks = await collectStream(stream)

			expect(chunks).toContainEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_qwen_123",
				name: "test_tool",
				arguments: '{"arg1":',
			})

			expect(chunks).toContainEqual({
				type: "tool_call_partial",
				index: 0,
				id: undefined,
				name: undefined,
				arguments: '"value"}',
			})
		})

		it("should set parallel_tool_calls based on metadata", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: "Test response" } }] }]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
				parallelToolCalls: true,
			})
			await stream.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					parallel_tool_calls: true,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("should yield tool_call_end events when finish_reason is tool_calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_qwen_test",
											function: {
												name: "test_tool",
												arguments: '{"arg1":"value"}',
											},
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {},
								finish_reason: "tool_calls",
							},
						],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					},
				]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
			})

			const chunks = []
			for await (const chunk of stream) {
				// Simulate what Task.ts does: when we receive tool_call_partial,
				// process it through NativeToolCallParser to populate rawChunkTracker
				if (chunk.type === "tool_call_partial") {
					NativeToolCallParser.processRawChunk({
						index: chunk.index,
						id: chunk.id,
						name: chunk.name,
						arguments: chunk.arguments,
					})
				}
				chunks.push(chunk)
			}

			// Should have tool_call_partial and tool_call_end
			const partialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")

			expect(partialChunks).toHaveLength(1)
			expect(endChunks).toHaveLength(1)
			expect(endChunks[0].id).toBe("call_qwen_test")
		})

		it("streams reasoning chunks from delta.reasoning_content", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "thinking..." }, index: 0 }] },
					{ choices: [{ delta: { content: "answer" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const stream = handler.createMessage("test prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
		})

		it("falls back to delta.reasoning when reasoning_content is absent", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning: "router-style thought" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const stream = handler.createMessage("test prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
		})

		it("prefers delta.reasoning_content over delta.reasoning when both are present", async () => {
			mockCreate.mockImplementationOnce(() =>
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

			const stream = handler.createMessage("test prompt", [])
			const chunks = await collectStream(stream)

			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")
			expect(reasoningChunks).toEqual([{ type: "reasoning", text: "primary thought" }])
		})

		it("should preserve thinking block handling alongside tool calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									reasoning_content: "Thinking about this...",
								},
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
											id: "call_after_think",
											function: {
												name: "test_tool",
												arguments: '{"arg1":"result"}',
											},
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("test prompt", [], {
				taskId: "test-task-id",
				tools: testTools,
			})

			const chunks = []
			for await (const chunk of stream) {
				if (chunk.type === "tool_call_partial") {
					NativeToolCallParser.processRawChunk({
						index: chunk.index,
						id: chunk.id,
						name: chunk.name,
						arguments: chunk.arguments,
					})
				}
				chunks.push(chunk)
			}

			// Should have reasoning, tool_call_partial, and tool_call_end
			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")
			const partialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")

			expect(reasoningChunks).toHaveLength(1)
			expect(reasoningChunks[0].text).toBe("Thinking about this...")
			expect(partialChunks).toHaveLength(1)
			expect(endChunks).toHaveLength(1)
		})
	})

	describe("abort signal wiring", () => {
		afterEach(() => {
			vi.unstubAllGlobals()
		})

		// Mirror the OpenAI SDK's APIUserAbortError shape: name "Error", message
		// "Request was aborted." It does not satisfy the Task.ts abort contract
		// (message must end in "aborted"), so the provider must normalize it.
		const sdkAbortError = (): Error => {
			const err = new Error("Request was aborted.")
			err.name = "Error"
			return err
		}

		const unauthorizedError = (): Error & { status: number } =>
			Object.assign(new Error("unauthorized"), { status: 401 })

		const tokenResponse = (): { ok: boolean; json: () => Promise<Record<string, unknown>> } => ({
			ok: true,
			json: async () => ({
				access_token: "new-access-token",
				refresh_token: "new-refresh-token",
				token_type: "Bearer",
				expires_in: 3600,
			}),
		})

		const waitForCreateCall = async (create: { mock: { calls: unknown[][] } }, timeoutMs = 5000): Promise<void> => {
			const start = Date.now()
			while (create.mock.calls.length === 0) {
				if (Date.now() - start > timeoutMs) {
					throw new Error("timed out waiting for the SDK create call")
				}
				await new Promise((resolve) => setTimeout(resolve, 5))
			}
		}

		const waitForSignalAbort = (signal: AbortSignal | undefined): Promise<void> => {
			return new Promise((resolve, reject) => {
				if (!signal) {
					reject(new Error("SDK create was called without a signal"))
					return
				}
				if (signal.aborted) {
					resolve()
					return
				}
				signal.addEventListener("abort", () => resolve(), { once: true })
			})
		}

		describe("createMessage", () => {
			it("should pass a request-local AbortSignal to the SDK and bridge the external signal", async () => {
				const external = new AbortController()
				let sdkSignal: AbortSignal | undefined
				// A live stream: yield one chunk, then stay open until the SDK signal aborts.
				mockCreate.mockImplementationOnce((_params: unknown, opts?: { signal?: AbortSignal }) => {
					sdkSignal = opts?.signal
					return (async function* () {
						yield { choices: [{ delta: { content: "x" } }] }
						await waitForSignalAbort(sdkSignal)
					})()
				})

				const stream = handler.createMessage("test prompt", [], { taskId: "t1", abortSignal: external.signal })
				const first = await stream.next()
				expect(first.value?.type).toBe("text")

				const opts = mockCreate.mock.calls[0][1]
				expect(opts?.signal).toBeInstanceOf(AbortSignal)
				expect(opts.signal).not.toBe(external.signal) // request-local, not the external signal
				expect(opts.signal.aborted).toBe(false)

				external.abort()
				expect(opts.signal.aborted).toBe(true) // the external abort is bridged to the SDK signal

				await stream.next() // resume; the live stream ends once the signal aborts
			})

			it("should fast-fail with a normalized AbortError for a pre-aborted signal", async () => {
				const external = new AbortController()
				external.abort()

				const stream = handler.createMessage("test prompt", [], { taskId: "t1", abortSignal: external.signal })
				let caught: unknown
				try {
					await stream.next()
				} catch (error) {
					caught = error
				}

				expect(caught).toBeInstanceOf(Error)
				expect((caught as Error).name).toBe("AbortError")
				expect((caught as Error).message).toMatch(/aborted$/)
				expect(mockCreate).not.toHaveBeenCalled()
			})

			it("should abort the in-flight SDK request when the external signal fires", async () => {
				const external = new AbortController()
				// Simulate the OpenAI SDK: reject with its abort error when the signal aborts.
				mockCreate.mockImplementationOnce((_params: unknown, opts?: { signal?: AbortSignal }) => {
					return new Promise((_resolve, reject) => {
						if (!opts?.signal) {
							reject(new Error("SDK create was called without a signal"))
							return
						}
						opts.signal.addEventListener("abort", () => reject(sdkAbortError()), { once: true })
					})
				})

				const stream = handler.createMessage("test prompt", [], { taskId: "t1", abortSignal: external.signal })
				const pending = stream.next()
				await waitForCreateCall(mockCreate)
				external.abort()

				let caught: unknown
				try {
					await pending
				} catch (error) {
					caught = error
				}

				expect(caught).toBeInstanceOf(Error)
				expect((caught as Error).name).toBe("AbortError")
				expect((caught as Error).message).toMatch(/aborted$/)
			})

			it("should normalize an abort error thrown mid-stream", async () => {
				const external = new AbortController()
				// Simulate the OpenAI SDK stream: yield once, then reject with its
				// abort error once the request-local signal is aborted.
				mockCreate.mockImplementationOnce((_params: unknown, opts?: { signal?: AbortSignal }) => {
					return (async function* () {
						yield { choices: [{ delta: { content: "partial" } }] }
						await waitForSignalAbort(opts?.signal)
						throw sdkAbortError()
					})()
				})

				const stream = handler.createMessage("test prompt", [], { taskId: "t1", abortSignal: external.signal })
				const chunks: { type: string; text?: string }[] = []
				let caught: unknown
				try {
					for await (const chunk of stream) {
						chunks.push(chunk)
						if (chunk.type === "text") {
							external.abort()
						}
					}
				} catch (error) {
					caught = error
				}

				expect(chunks).toContainEqual({ type: "text", text: "partial" })
				expect(caught).toBeInstanceOf(Error)
				expect((caught as Error).name).toBe("AbortError")
				expect((caught as Error).message).toMatch(/aborted$/)
			})

			it("should rethrow non-abort stream errors unchanged", async () => {
				const boom = new Error("boom")
				mockCreate.mockImplementationOnce(() => {
					return (async function* () {
						yield { choices: [{ delta: { content: "x" } }] }
						throw boom
					})()
				})

				const stream = handler.createMessage("test prompt", [], { taskId: "t1" })
				let caught: unknown
				try {
					await collectStream(stream)
				} catch (error) {
					caught = error
				}

				expect(caught).toBe(boom)
			})

			it("should split </think> tag boundaries across chunks into reasoning and text", async () => {
				// Exercises the incremental think-tag parser: one chunk opens a
				// thinking block (odd segment), the next one closes it (even
				// segment) and continues as visible text.
				mockCreate.mockImplementationOnce(() =>
					asyncStreamFrom([
						{ choices: [{ delta: { content: "a</think>b" } }] },
						{ choices: [{ delta: { content: "c" } }] },
					]),
				)

				const stream = handler.createMessage("test prompt", [], { taskId: "t1" })
				const chunks = await collectStream(stream)

				expect(chunks).toContainEqual({ type: "reasoning", text: "b" })
				expect(chunks).toContainEqual({ type: "text", text: "c" })
				expect(chunks).not.toContainEqual(expect.objectContaining({ type: "text", text: "b" }))
			})

			it("should tolerate degenerate stream shapes (empty choice, repeated content, zero usage)", async () => {
				// Changed-line coverage: exercises the defensive branches of the stream
				// loop — a chunk with no choice, a delta that repeats the previous full
				// content (empty after trimming), a think block that starts the text so the
				// split yields an empty leading segment, and a usage payload of zeros.
				mockCreate.mockImplementationOnce(() =>
					asyncStreamFrom([
						{ choices: [] },
						{ choices: [{ delta: { content: "hi" }, index: 0 }] },
						{ choices: [{ delta: { content: "hi" }, index: 0 }] },
						{ choices: [{ delta: { content: "<think>thought</think>out" }, index: 0 }] },
						{
							choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
							usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
						},
					]),
				)

				const stream = handler.createMessage("test prompt", [], { taskId: "t1" })
				const chunks = await collectStream(stream)

				const hiChunks = chunks.filter((chunk) => chunk.type === "text" && chunk.text === "hi")
				expect(hiChunks).toHaveLength(1) // the repeated content chunk yields nothing
				expect(chunks).toContainEqual({ type: "reasoning", text: "thought" })
				expect(chunks).toContainEqual({ type: "text", text: "out" })
				expect(chunks).toContainEqual({ type: "usage", inputTokens: 0, outputTokens: 0 })
			})

			it("should not retry after 401 when the abort signal fires during the refresh", async () => {
				const external = new AbortController()
				const fetchMock = vi.fn().mockImplementation(async () => {
					external.abort() // simulate Stop pressed while the token refresh is in flight
					return tokenResponse()
				})
				vi.stubGlobal("fetch", fetchMock)
				mockCreate.mockRejectedValueOnce(unauthorizedError())

				const stream = handler.createMessage("test prompt", [], { taskId: "t1", abortSignal: external.signal })
				let caught: unknown
				try {
					await collectStream(stream)
				} catch (error) {
					caught = error
				}

				expect(caught).toBeInstanceOf(Error)
				expect((caught as Error).name).toBe("AbortError")
				expect((caught as Error).message).toMatch(/aborted$/)
				expect(mockCreate).toHaveBeenCalledTimes(1) // the retried request was never sent
				expect(fetchMock).toHaveBeenCalledTimes(1)
			})

			it("should normalize an abort error from the 401 retry instead of exposing the raw SDK error", async () => {
				vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()))
				const external = new AbortController()
				mockCreate
					.mockRejectedValueOnce(unauthorizedError())
					.mockImplementationOnce((_params: unknown, opts?: { signal?: AbortSignal }) => {
						external.abort() // Stop pressed while the retried request is in flight
						return Promise.reject(sdkAbortError())
					})

				const stream = handler.createMessage("test prompt", [], { taskId: "t1", abortSignal: external.signal })
				let caught: unknown
				try {
					await collectStream(stream)
				} catch (error) {
					caught = error
				}

				expect(caught).toBeInstanceOf(Error)
				expect((caught as Error).name).toBe("AbortError")
				expect((caught as Error).message).toBe("The Qwen Code request was aborted")
				expect((caught as Error).message).not.toBe("Request was aborted.") // not the raw SDK error
				expect(mockCreate).toHaveBeenCalledTimes(2) // first attempt 401, then the aborted retry
			})

			it("should rethrow a non-abort error from the 401 retry unchanged", async () => {
				vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()))
				const apiError = new Error("boom")
				mockCreate.mockRejectedValueOnce(unauthorizedError()).mockRejectedValueOnce(apiError)

				const stream = handler.createMessage("test prompt", [], {
					taskId: "t1",
					abortSignal: new AbortController().signal,
				})
				let caught: unknown
				try {
					await collectStream(stream)
				} catch (error) {
					caught = error
				}

				expect(caught).toBe(apiError)
				expect(mockCreate).toHaveBeenCalledTimes(2)
			})
		})

		describe("completePrompt", () => {
			it("should pass the external signal through, and nothing without a signal or with a zero timeout", async () => {
				mockCreate
					.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] })
					.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] })
					.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] })
				const external = new AbortController()

				expect(await handler.completePrompt("hi")).toBe("ok")
				expect(mockCreate.mock.calls[0][1]).toBeUndefined() // no signal, no timeout: nothing reaches the SDK

				expect(await handler.completePrompt("hi", { abortSignal: external.signal })).toBe("ok")
				// no timeout: the merged signal is the external signal itself
				expect(mockCreate.mock.calls[1][1]?.signal).toBe(external.signal)

				// timeoutMs <= 0 means "no explicit timeout": nothing may reach the SDK
				expect(await handler.completePrompt("hi", { timeoutMs: 0 })).toBe("ok")
				expect(mockCreate.mock.calls[2][1]).toBeUndefined()
			})

			it("should merge the external signal with a positive timeoutMs", async () => {
				const external = new AbortController()
				mockCreate.mockImplementationOnce((_params: unknown, opts?: { signal?: AbortSignal }) => {
					return new Promise((_resolve, reject) => {
						const signal = opts?.signal
						if (!signal) {
							reject(new Error("SDK create was called without a signal"))
							return
						}
						signal.addEventListener("abort", () => reject(sdkAbortError()), { once: true })
					})
				})

				const pending = handler.completePrompt("hi", { abortSignal: external.signal, timeoutMs: 60_000 })
				await waitForCreateCall(mockCreate)
				const opts = mockCreate.mock.calls[0][1]
				expect(opts?.signal).toBeInstanceOf(AbortSignal)
				expect(opts.signal).not.toBe(external.signal) // merged via AbortSignal.any
				expect(opts.signal.aborted).toBe(false)

				external.abort()
				let caught: unknown
				try {
					await pending
				} catch (error) {
					caught = error
				}

				expect((caught as Error).name).toBe("AbortError")
				expect((caught as Error).message).toMatch(/aborted$/)
			})

			it("should fast-fail with a normalized AbortError for a pre-aborted signal", async () => {
				const external = new AbortController()
				external.abort()

				let caught: unknown
				try {
					await handler.completePrompt("hi", { abortSignal: external.signal })
				} catch (error) {
					caught = error
				}

				expect((caught as Error).name).toBe("AbortError")
				expect((caught as Error).message).toMatch(/aborted$/)
				expect(fs.readFile).not.toHaveBeenCalled() // no work starts after a pre-aborted signal
				expect(mockCreate).not.toHaveBeenCalled()
			})

			it("should retry after 401 and pass the same abort signal to the retry", async () => {
				vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()))
				mockCreate
					.mockRejectedValueOnce(unauthorizedError())
					.mockResolvedValueOnce({ choices: [{ message: { content: "retried" } }] })

				const result = await handler.completePrompt("hi", { abortSignal: new AbortController().signal })

				expect(result).toBe("retried")
				expect(mockCreate).toHaveBeenCalledTimes(2)
				expect(mockCreate.mock.calls[1][1]?.signal).toBe(mockCreate.mock.calls[0][1]?.signal)
			})

			it("should not retry after 401 when the abort signal fires during the refresh", async () => {
				const external = new AbortController()
				const fetchMock = vi.fn().mockImplementation(async () => {
					external.abort() // simulate Stop pressed while the token refresh is in flight
					return tokenResponse()
				})
				vi.stubGlobal("fetch", fetchMock)
				mockCreate.mockRejectedValueOnce(unauthorizedError())

				let caught: unknown
				try {
					await handler.completePrompt("hi", { abortSignal: external.signal })
				} catch (error) {
					caught = error
				}

				expect((caught as Error).name).toBe("AbortError")
				expect((caught as Error).message).toMatch(/aborted$/)
				expect(mockCreate).toHaveBeenCalledTimes(1) // the retried request was never sent
				expect(fetchMock).toHaveBeenCalledTimes(1)
			})

			it("should normalize SDK abort errors instead of rethrowing them", async () => {
				mockCreate.mockRejectedValueOnce(sdkAbortError())

				let caught: unknown
				try {
					await handler.completePrompt("hi")
				} catch (error) {
					caught = error
				}

				expect((caught as Error).name).toBe("AbortError")
				expect((caught as Error).message).toMatch(/aborted$/)
			})

			it("should normalize an abort error from the 401 retry instead of exposing the raw SDK error", async () => {
				vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()))
				const external = new AbortController()
				mockCreate
					.mockRejectedValueOnce(unauthorizedError())
					.mockImplementationOnce((_params: unknown, opts?: { signal?: AbortSignal }) => {
						external.abort() // Stop pressed while the retried request is in flight
						return Promise.reject(sdkAbortError())
					})

				let caught: unknown
				try {
					await handler.completePrompt("hi", { abortSignal: external.signal })
				} catch (error) {
					caught = error
				}

				expect(caught).toBeInstanceOf(Error)
				expect((caught as Error).name).toBe("AbortError")
				expect((caught as Error).message).toBe("The Qwen Code request was aborted")
				expect((caught as Error).message).not.toBe("Request was aborted.") // not the raw SDK error
				expect(mockCreate).toHaveBeenCalledTimes(2) // first attempt 401, then the aborted retry
			})

			it("should rethrow a non-abort error from the 401 retry unchanged", async () => {
				vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()))
				const apiError = new Error("boom")
				mockCreate.mockRejectedValueOnce(unauthorizedError()).mockRejectedValueOnce(apiError)

				let caught: unknown
				try {
					await handler.completePrompt("hi", { abortSignal: new AbortController().signal })
				} catch (error) {
					caught = error
				}

				expect(caught).toBe(apiError)
				expect(mockCreate).toHaveBeenCalledTimes(2)
			})
		})
	})
})
