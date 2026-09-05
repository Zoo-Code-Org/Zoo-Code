// npx vitest run api/providers/__tests__/qwen-code.spec.ts

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

describe("QwenCodeHandler abort wiring", () => {
	let handler: QwenCodeHandler
	let mockOptions: ApiHandlerOptions

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

	afterEach(() => {
		vi.unstubAllGlobals()
	})

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
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockCredentials))
		vi.mocked(fs.writeFile).mockResolvedValue(undefined)

		mockOptions = {
			apiModelId: "qwen3-coder-plus",
		}
		handler = new QwenCodeHandler(mockOptions)

		// Clear NativeToolCallParser state before each test
		NativeToolCallParser.clearRawChunkState()
	})

	describe("callApiWithRetry", () => {
		it("normalizes a first-attempt SDK abort error", async () => {
			mockCreate.mockRejectedValueOnce(sdkAbortError())

			let caught: unknown
			try {
				await handler.completePrompt("hi")
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The Qwen Code request was aborted")
		})

		it("rethrows a non-abort, non-401 error unchanged", async () => {
			const apiError = new Error("server exploded")
			Object.assign(apiError, { status: 500 })
			mockCreate.mockRejectedValueOnce(apiError)

			let caught: unknown
			try {
				await handler.completePrompt("hi")
			} catch (error) {
				caught = error
			}

			expect(caught).toBe(apiError)
		})

		it("rethrows a non-object rejection unchanged", async () => {
			// A null rejection is not an object: the optional status read must
			// yield undefined (not throw) and fall through to the rethrow.
			mockCreate.mockRejectedValueOnce(null)

			let caught: unknown
			try {
				await handler.completePrompt("hi")
			} catch (error) {
				caught = error
			}

			expect(caught).toBeNull()
		})

		it("retries once after 401 and succeeds", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()))
			mockCreate
				.mockRejectedValueOnce(unauthorizedError())
				.mockResolvedValueOnce({ choices: [{ message: { content: "retried" } }] })

			const result = await handler.completePrompt("hi", { abortSignal: new AbortController().signal })

			expect(result).toBe("retried")
			expect(mockCreate).toHaveBeenCalledTimes(2)
		})

		it("retries after 401 when no external signal is provided", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()))
			mockCreate
				.mockRejectedValueOnce(unauthorizedError())
				.mockResolvedValueOnce({ choices: [{ message: { content: "retried" } }] })

			const result = await handler.completePrompt("hi")

			expect(result).toBe("retried")
			expect(mockCreate).toHaveBeenCalledTimes(2)
		})

		it("does not retry after 401 once the signal aborts during the refresh", async () => {
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

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The Qwen Code request was aborted")
			expect(mockCreate).toHaveBeenCalledTimes(1) // the retried request was never sent
			expect(fetchMock).toHaveBeenCalledTimes(1)
		})

		it("normalizes an abort error from the 401 retry", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()))
			const external = new AbortController()
			mockCreate.mockRejectedValueOnce(unauthorizedError()).mockImplementationOnce(() => {
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
			expect(mockCreate).toHaveBeenCalledTimes(2) // first attempt 401, then the aborted retry
		})

		it("rethrows a non-abort error from the 401 retry unchanged", async () => {
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

	describe("createMessage", () => {
		it("passes a request-local signal and bridges the external abort", async () => {
			const external = new AbortController()
			const addSpy = vi.spyOn(external.signal, "addEventListener")
			mockCreate.mockResolvedValueOnce(asyncStreamFrom([{ choices: [{ delta: { content: "x" } }] }]))

			const stream = handler.createMessage("test prompt", [], { taskId: "t1", abortSignal: external.signal })
			const first = await stream.next()
			expect(first.value?.type).toBe("text")

			const opts = mockCreate.mock.calls[0][1]
			expect(opts?.signal).toBeInstanceOf(AbortSignal)
			expect(opts.signal).not.toBe(external.signal) // request-local, not the external signal
			expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function))

			external.abort()
			expect(opts.signal.aborted).toBe(true) // the external abort is bridged to the SDK signal

			await stream.next() // drain the generator
		})

		it("fast-fails with the abort contract error for a pre-aborted signal", async () => {
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
			expect((caught as Error).message).toBe("This operation was aborted")
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("settles with the abort contract when the signal aborts while the credential load is pending", async () => {
			// The cached credential load never settles, so without the race the
			// generator would wait for fs.readFile forever after a Stop.
			vi.mocked(fs.readFile).mockImplementation(() => new Promise<string>(() => {}))
			const external = new AbortController()

			const stream = handler.createMessage("test prompt", [], { taskId: "t1", abortSignal: external.signal })
			const pending = stream.next()
			await new Promise((resolve) => setTimeout(resolve, 10)) // let the generator reach the pending load
			external.abort()

			let caught: unknown
			try {
				await pending
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The Qwen Code request was aborted")
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("settles with the abort contract when the signal aborts while the token refresh is pending, and the shared refresh still completes", async () => {
			// Expired cached credentials force a refresh; its fetch stays
			// pending until the Stop lands, then settles in the background —
			// the request-local abort must cut only the wait, not the shared
			// refresh that other requests dedupe against.
			const expiredCredentials = {
				access_token: "expired-access-token",
				refresh_token: "test-refresh-token",
				token_type: "Bearer",
				expiry_date: Date.now() - 1000, // expired
				resource_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			}
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(expiredCredentials))
			let resolveFetch!: (response: { ok: boolean; json: () => Promise<Record<string, unknown>> }) => void
			vi.stubGlobal(
				"fetch",
				vi.fn().mockImplementation(
					() =>
						new Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }>((resolve) => {
							resolveFetch = resolve
						}),
				),
			)
			const external = new AbortController()

			const stream = handler.createMessage("test prompt", [], { taskId: "t1", abortSignal: external.signal })
			const pending = stream.next()
			await new Promise((resolve) => setTimeout(resolve, 10)) // let the generator reach the pending refresh
			external.abort()

			let caught: unknown
			try {
				await pending
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The Qwen Code request was aborted")
			expect(mockCreate).not.toHaveBeenCalled()

			// The shared refresh keeps running: once its fetch settles, the new
			// credentials are persisted even though this request gave up.
			resolveFetch(tokenResponse())
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(fs.writeFile).toHaveBeenCalled()
		})

		it("streams content, strips repeated prefixes and splits think tags", async () => {
			mockCreate.mockResolvedValueOnce(
				asyncStreamFrom([
					{ choices: [{ delta: { content: "Hello" } }] },
					// A full duplicate chunk strips to empty content and must
					// emit no chunk (it exercises the empty newText guard).
					{ choices: [{ delta: { content: "Hello" } }] },
					{ choices: [{ delta: { content: "Hello world" } }] },
					{ choices: [{ delta: { content: "bye" } }] },
					{ choices: [{ delta: { content: "a<think>b</think>c" } }] },
					{ choices: [{ delta: { content: "only<think>tag" } }] },
				]),
			)

			const chunks = await collectStream(handler.createMessage("test prompt", []))

			expect(chunks).toEqual([
				{ type: "text", text: "Hello" },
				{ type: "text", text: " world" },
				{ type: "text", text: "bye" },
				{ type: "text", text: "a" },
				{ type: "reasoning", text: "b" },
				{ type: "text", text: "c" },
				{ type: "text", text: "only" },
				{ type: "reasoning", text: "tag" },
			])
		})

		it("yields no chunks for empty thinking tags", async () => {
			mockCreate.mockResolvedValueOnce(
				asyncStreamFrom([{ choices: [{ delta: { content: "<think></think>" } }] }]),
			)

			const chunks = await collectStream(handler.createMessage("test prompt", []))

			expect(chunks).toEqual([])
		})

		it("emits reasoning from reasoning_content and tolerates malformed deltas", async () => {
			mockCreate.mockResolvedValueOnce(
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "thinking" } }] },
					{ choices: [{}] }, // no delta at all
					{ choices: [] }, // empty choices
					{ choices: [{ delta: { content: "" } }] }, // empty content
				]),
			)

			const chunks = await collectStream(handler.createMessage("test prompt", []))

			expect(chunks).toEqual([{ type: "reasoning", text: "thinking" }])
		})

		it("emits content equal to the Stryker sentinel as-is", async () => {
			// fullContent must start empty: a first chunk that happens to begin
			// with the sentinel string must not be treated as a repeated prefix.
			mockCreate.mockResolvedValueOnce(
				asyncStreamFrom([{ choices: [{ delta: { content: "Stryker was here!done" } }] }]),
			)

			const chunks = await collectStream(handler.createMessage("test prompt", []))

			expect(chunks).toEqual([{ type: "text", text: "Stryker was here!done" }])
		})

		it("builds the streaming request with strict defaults when no metadata is provided", async () => {
			mockCreate.mockResolvedValueOnce(asyncStreamFrom([{ choices: [{ delta: { content: "hello" } }] }]))

			const chunks = await collectStream(handler.createMessage("test prompt", []))

			expect(chunks).toContainEqual({ type: "text", text: "hello" })
			expect(mockCreate.mock.calls[0][0]).toEqual(
				expect.objectContaining({
					model: "qwen3-coder-plus",
					temperature: 0,
					stream: true,
					stream_options: { include_usage: true },
					parallel_tool_calls: true,
					messages: [{ role: "system", content: "test prompt" }],
				}),
			)
		})

		it("emits tool_call_partial chunks and tool_call_end on finish_reason", async () => {
			mockCreate.mockResolvedValueOnce(
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, id: "call_1", function: { name: "tool_x", arguments: '{"a":1}' } },
									],
								},
							},
						],
					},
					{ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_2" }] } }] },
					{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
				]),
			)

			const stream = handler.createMessage("test prompt", [])

			// Collect the provider stream and process tool_call_partial chunks
			// through NativeToolCallParser, exactly as Task.ts does.
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

			expect(chunks).toEqual([
				{ type: "tool_call_partial", index: 0, id: "call_1", name: "tool_x", arguments: '{"a":1}' },
				{ type: "tool_call_partial", index: 1, id: "call_2", name: undefined, arguments: undefined },
				{ type: "tool_call_end", id: "call_1" },
				{ type: "tool_call_end", id: "call_2" },
			])
		})

		it("emits a usage chunk from the stream usage field", async () => {
			mockCreate.mockResolvedValueOnce(
				asyncStreamFrom([
					{ choices: [{ delta: {} }], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } },
				]),
			)

			const chunks = await collectStream(handler.createMessage("test prompt", []))

			expect(chunks).toEqual([{ type: "usage", inputTokens: 42, outputTokens: 7 }])
		})

		it("normalizes an abort error thrown mid-stream", async () => {
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
			let caught: unknown
			try {
				for await (const chunk of stream) {
					if (chunk.type === "text") {
						external.abort()
					}
				}
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The Qwen Code request was aborted")
		})

		it("rethrows a non-abort stream error unchanged", async () => {
			const apiError = new Error("stream exploded")
			mockCreate.mockImplementationOnce(() => {
				return (async function* () {
					yield { choices: [{ delta: { content: "partial" } }] }
					throw apiError
				})()
			})

			let caught: unknown
			try {
				await collectStream(handler.createMessage("test prompt", []))
			} catch (error) {
				caught = error
			}

			expect(caught).toBe(apiError)
		})

		it("aborts the request-local signal when the consumer stops early", async () => {
			mockCreate.mockImplementationOnce((_params: unknown, opts?: { signal?: AbortSignal }) => {
				return (async function* () {
					yield { choices: [{ delta: { content: "x" } }] }
					await waitForSignalAbort(opts?.signal) // stay open until the SDK signal aborts
				})()
			})

			const stream = handler.createMessage("test prompt", [])
			const first = await stream.next()
			expect(first.value?.type).toBe("text")

			const opts = mockCreate.mock.calls[0][1]
			await stream.return(undefined) // consumer stops early; finally must cancel the request

			expect(opts?.signal.aborted).toBe(true)
		})

		it("removes the external abort listener when the stream completes", async () => {
			const external = new AbortController()
			const removeSpy = vi.spyOn(external.signal, "removeEventListener")
			mockCreate.mockResolvedValueOnce(asyncStreamFrom([{ choices: [{ delta: { content: "ok" } }] }]))

			await collectStream(
				handler.createMessage("test prompt", [], { taskId: "t1", abortSignal: external.signal }),
			)

			expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function))
		})
	})

	describe("completePrompt", () => {
		it("passes the merged signal through and nothing without options", async () => {
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "qwen ok" } }] })

			expect(await handler.completePrompt("hi")).toBe("qwen ok")
			expect(mockCreate.mock.calls[0][1]).toBeUndefined() // no signal, no timeout: nothing reaches the SDK

			const external = new AbortController()
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "qwen ok" } }] })

			expect(await handler.completePrompt("hi", { abortSignal: external.signal })).toBe("qwen ok")
			// no timeout: the merged signal is the external signal itself
			expect(mockCreate.mock.calls[1][1]?.signal).toBe(external.signal)
		})

		it("fast-fails with the abort contract error for a pre-aborted signal", async () => {
			const external = new AbortController()
			external.abort()

			let caught: unknown
			try {
				await handler.completePrompt("hi", { abortSignal: external.signal })
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("This operation was aborted")
			expect(mockCreate).not.toHaveBeenCalled()
			expect(fs.readFile).not.toHaveBeenCalled() // no work starts after a pre-aborted signal
		})

		it("settles with the abort contract when the signal aborts while the credential load is pending", async () => {
			// The cached credential load never settles, so without the race the
			// call would wait for fs.readFile forever after a Stop.
			vi.mocked(fs.readFile).mockImplementation(() => new Promise<string>(() => {}))
			const external = new AbortController()

			const pending = handler.completePrompt("hi", { abortSignal: external.signal })
			await new Promise((resolve) => setTimeout(resolve, 10)) // let the call reach the pending load
			external.abort()

			let caught: unknown
			try {
				await pending
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The Qwen Code request was aborted")
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("settles with the abort contract when the signal aborts while the token refresh is pending, and the shared refresh still completes", async () => {
			// Expired cached credentials force a refresh; its fetch stays
			// pending until the Stop lands, then settles in the background —
			// the abort must cut only the wait, not the shared refresh that
			// other requests dedupe against.
			const expiredCredentials = {
				access_token: "expired-access-token",
				refresh_token: "test-refresh-token",
				token_type: "Bearer",
				expiry_date: Date.now() - 1000, // expired
				resource_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			}
			vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(expiredCredentials))
			let resolveFetch!: (response: { ok: boolean; json: () => Promise<Record<string, unknown>> }) => void
			vi.stubGlobal(
				"fetch",
				vi.fn().mockImplementation(
					() =>
						new Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }>((resolve) => {
							resolveFetch = resolve
						}),
				),
			)
			const external = new AbortController()

			const pending = handler.completePrompt("hi", { abortSignal: external.signal })
			await new Promise((resolve) => setTimeout(resolve, 10)) // let the call reach the pending refresh
			external.abort()

			let caught: unknown
			try {
				await pending
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The Qwen Code request was aborted")
			expect(mockCreate).not.toHaveBeenCalled()

			// The shared refresh keeps running: once its fetch settles, the new
			// credentials are persisted even though this request gave up.
			resolveFetch(tokenResponse())
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(fs.writeFile).toHaveBeenCalled()
		})
	})
})
