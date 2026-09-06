// npx vitest run api/providers/__tests__/lm-studio-timeout.spec.ts

import { LmStudioHandler } from "../lm-studio"
import { ApiHandlerOptions } from "../../../shared/api"

// Mock the timeout config utility
vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn(),
}))

import { getApiRequestTimeout } from "../utils/timeout-config"

import { clearAllMocks } from "../../../test-utils/reset"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"

interface MockOpenAiClient {
	chat: {
		completions: {
			create: ReturnType<typeof vitest.fn>
		}
	}
}

// Mock OpenAI (records each created client so tests can drive its create call)
const mockOpenAIConstructor = vitest.fn()
const createdClients: MockOpenAiClient[] = []
vitest.mock("openai", () => {
	return {
		__esModule: true,
		default: vitest.fn().mockImplementation(function (config) {
			const client: MockOpenAiClient = {
				chat: {
					completions: {
						create: vitest.fn(),
					},
				},
			}
			createdClients.push(client)
			mockOpenAIConstructor(config)
			return client
		}),
	}
})

describe("LmStudioHandler timeout configuration", () => {
	beforeEach(() => {
		clearAllMocks()
	})

	it("should use default timeout of 600 seconds when no configuration is set", () => {
		vitest.mocked(getApiRequestTimeout).mockReturnValue(600000)

		const options: ApiHandlerOptions = {
			apiModelId: "llama2",
			lmStudioModelId: "llama2",
			lmStudioBaseUrl: "http://localhost:1234",
		}

		new LmStudioHandler(options)

		expect(getApiRequestTimeout).toHaveBeenCalled()
		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "http://localhost:1234/v1",
				apiKey: "noop",
				timeout: 600000, // 600 seconds in milliseconds
			}),
		)
	})

	it("should use custom timeout when configuration is set", () => {
		vitest.mocked(getApiRequestTimeout).mockReturnValue(1200000) // 20 minutes

		const options: ApiHandlerOptions = {
			apiModelId: "llama2",
			lmStudioModelId: "llama2",
			lmStudioBaseUrl: "http://localhost:1234",
		}

		new LmStudioHandler(options)

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				timeout: 1200000, // 1200 seconds in milliseconds
			}),
		)
	})

	it("should handle zero timeout (no timeout)", () => {
		vitest.mocked(getApiRequestTimeout).mockReturnValue(0)

		const options: ApiHandlerOptions = {
			apiModelId: "llama2",
			lmStudioModelId: "llama2",
		}

		new LmStudioHandler(options)

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				timeout: 0, // No timeout
			}),
		)
	})
})

describe("LmStudioHandler abort signal wiring", () => {
	let options: ApiHandlerOptions

	// Mirror the OpenAI SDK's APIUserAbortError shape: name "Error", message
	// "Request was aborted." It does not satisfy the Task.ts abort contract
	// (message must end in "aborted"), so the provider must normalize it.
	const sdkAbortError = (): Error => {
		const err = new Error("Request was aborted.")
		err.name = "Error"
		return err
	}

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

	const lastCreate = (): MockOpenAiClient["chat"]["completions"]["create"] => {
		const client = createdClients[createdClients.length - 1]
		if (!client) {
			throw new Error("no OpenAI client was created")
		}
		return client.chat.completions.create
	}

	beforeEach(() => {
		clearAllMocks()
		vitest.mocked(getApiRequestTimeout).mockReturnValue(600000)
		options = {
			apiModelId: "llama2",
			lmStudioModelId: "llama2",
			lmStudioBaseUrl: "http://localhost:1234",
		}
	})

	describe("createMessage", () => {
		it("should pass a request-local AbortSignal to the SDK and bridge the external signal", async () => {
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([]))

			const external = new AbortController()
			const stream = handler.createMessage("system", [], { taskId: "t1", abortSignal: external.signal })
			await stream.next()

			const opts = create.mock.calls[0][1]
			expect(opts?.signal).toBeInstanceOf(AbortSignal)
			expect(opts.signal).not.toBe(external.signal) // request-local, not the external signal
			expect(opts.signal.aborted).toBe(false)

			external.abort()
			expect(opts.signal.aborted).toBe(true) // the external abort is bridged to the SDK signal

			await stream.next() // drain the generator
		})

		it("should fast-fail with a normalized AbortError when the signal is pre-aborted", async () => {
			const handler = new LmStudioHandler(options)
			const create = lastCreate()
			const external = new AbortController()
			external.abort()

			const stream = handler.createMessage("system", [], { taskId: "t1", abortSignal: external.signal })
			let caught: unknown
			try {
				await stream.next()
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toMatch(/aborted$/)
			expect(create).not.toHaveBeenCalled()
		})

		it("should abort the in-flight SDK request when the external signal fires", async () => {
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			const create = lastCreate()
			// Simulate the OpenAI SDK: reject with its abort error when the signal aborts.
			create.mockImplementation((_params: unknown, opts?: { signal?: AbortSignal }) => {
				return new Promise((_resolve, reject) => {
					if (!opts?.signal) {
						reject(new Error("SDK create was called without a signal"))
						return
					}
					opts.signal.addEventListener("abort", () => reject(sdkAbortError()), { once: true })
				})
			})

			const external = new AbortController()
			const stream = handler.createMessage("system", [], { taskId: "t1", abortSignal: external.signal })
			const pending = stream.next()
			await waitForCreateCall(create)
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
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			const create = lastCreate()
			const external = new AbortController()
			// Simulate the OpenAI SDK stream: yield once, then reject with its
			// abort error once the request-local signal is aborted.
			create.mockImplementation((_params: unknown, opts?: { signal?: AbortSignal }) => {
				return (async function* () {
					yield { choices: [{ delta: { content: "partial" } }] }
					await waitForSignalAbort(opts?.signal)
					throw sdkAbortError()
				})()
			})

			const stream = handler.createMessage("system", [], { taskId: "t1", abortSignal: external.signal })
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

		it("should stream reasoning chunks from a reasoning_content delta", async () => {
			// Changed-line coverage regression: reasoning models served by LM Studio
			// stream thinking via delta.reasoning_content, and createMessage must yield
			// a reasoning chunk from that dedicated field.
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			const create = lastCreate()
			create.mockResolvedValue(
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "thinking..." }, index: 0 }] },
					{ choices: [{ delta: { content: "answer" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage("system", []))

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
			expect(chunks).toContainEqual({ type: "text", text: "answer" })
		})
	})

	describe("completePrompt", () => {
		it("should pass the external signal through, and nothing without a signal or with a zero timeout", async () => {
			const handler = new LmStudioHandler(options)
			const create = lastCreate()
			create.mockResolvedValue({ choices: [{ message: { content: "ok" } }] })
			const external = new AbortController()

			expect(await handler.completePrompt("hi")).toBe("ok")
			expect(create.mock.calls[0][1]).toBeUndefined() // no signal, no timeout: nothing reaches the SDK

			expect(await handler.completePrompt("hi", { abortSignal: external.signal })).toBe("ok")
			// no timeout: the merged signal is the external signal itself
			expect(create.mock.calls[1][1]?.signal).toBe(external.signal)

			// timeoutMs <= 0 means "no explicit timeout": nothing may reach the SDK
			expect(await handler.completePrompt("hi", { timeoutMs: 0 })).toBe("ok")
			expect(create.mock.calls[2][1]).toBeUndefined()
		})

		it("should merge the external signal with a positive timeoutMs", async () => {
			const handler = new LmStudioHandler(options)
			const create = lastCreate()
			create.mockImplementation((_params: unknown, opts?: { signal?: AbortSignal }) => {
				return new Promise((_resolve, reject) => {
					const signal = opts?.signal
					if (!signal) {
						reject(new Error("SDK create was called without a signal"))
						return
					}
					signal.addEventListener("abort", () => reject(sdkAbortError()), { once: true })
				})
			})
			const external = new AbortController()

			const pending = handler.completePrompt("hi", { abortSignal: external.signal, timeoutMs: 60_000 })
			const opts = create.mock.calls[0][1]
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

		it("should normalize SDK abort errors instead of wrapping them", async () => {
			const handler = new LmStudioHandler(options)
			const create = lastCreate()
			create.mockRejectedValue(sdkAbortError())

			let caught: unknown
			try {
				await handler.completePrompt("hi")
			} catch (error) {
				caught = error
			}

			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toMatch(/aborted$/)
		})

		it("should keep wrapping non-abort errors in the LM Studio debug message", async () => {
			const handler = new LmStudioHandler(options)
			const create = lastCreate()
			create.mockRejectedValue(new Error("boom"))

			let caught: unknown
			try {
				await handler.completePrompt("hi")
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).message).toContain("Please check the LM Studio developer logs")
		})
	})
})
