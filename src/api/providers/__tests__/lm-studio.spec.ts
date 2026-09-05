// npx vitest run api/providers/__tests__/lm-studio.spec.ts

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

describe("LmStudioHandler abort wiring", () => {
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
		it("passes a request-local AbortSignal to the SDK and bridges the external signal", async () => {
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

		it("fast-fails with the abort contract error for a pre-aborted signal", async () => {
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
			expect((caught as Error).message).toBe("This operation was aborted")
			expect(create).not.toHaveBeenCalled()
		})

		it("aborts the in-flight SDK request when the external signal fires", async () => {
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			const create = lastCreate()
			// Simulate the OpenAI SDK: reject with its abort error when the
			// request-local signal aborts. A fallback resolution keeps the test
			// fast if the signal never aborts (e.g. a bridging regression).
			create.mockImplementation((_params: unknown, opts?: { signal?: AbortSignal }) => {
				return new Promise((resolve, reject) => {
					if (!opts?.signal) {
						reject(new Error("SDK create was called without a signal"))
						return
					}
					opts.signal.addEventListener("abort", () => reject(sdkAbortError()), { once: true })
					setTimeout(() => resolve(asyncStreamFrom([])), 300)
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
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
			expect(create).toHaveBeenCalledTimes(1)
		})

		it("normalizes an abort-shaped create rejection without an external signal", async () => {
			// Without an external signal the outer catch cannot normalize via the
			// signal, so the inner catch's own abort decision alone determines
			// whether the SDK abort error is normalized to the abort contract.
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			const create = lastCreate()
			create.mockRejectedValue(sdkAbortError())

			let caught: unknown
			try {
				await collectStream(handler.createMessage("system", []))
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
		})

		it("fast-fails when the external signal aborts while the input token count is pending", async () => {
			const handler = new LmStudioHandler(options)
			let resolveCountTokens!: (tokens: number) => void
			// The first (input) count stays pending so the abort can land while
			// it is; any later count (the output count) resolves, so a mutant
			// that slips past the fast-fail guard fails fast instead of hanging
			// the mutation-test run at the pending output count.
			vitest
				.spyOn(handler, "countTokens")
				.mockImplementationOnce(
					() =>
						new Promise<number>((resolve) => {
							resolveCountTokens = resolve
						}),
				)
				.mockResolvedValue(1)
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([])) // must never be reached

			const external = new AbortController()
			const stream = handler.createMessage("system", [], { taskId: "t1", abortSignal: external.signal })
			const pending = stream.next()
			await new Promise((resolve) => setTimeout(resolve, 10)) // let the generator reach the pending count
			external.abort()
			resolveCountTokens(1)

			let caught: unknown
			try {
				await pending
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
			expect(create).not.toHaveBeenCalled()
		})

		it("settles with the abort contract when the external signal aborts and the input count never settles", async () => {
			// The input count is left pending forever: without the abort race
			// the generator would hang on it after a Stop.
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "countTokens").mockImplementation(() => new Promise<number>(() => {}))
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([])) // must never be reached

			const external = new AbortController()
			const stream = handler.createMessage("system", [], { taskId: "t1", abortSignal: external.signal })
			const pending = stream.next()
			await new Promise((resolve) => setTimeout(resolve, 10)) // let the generator reach the pending count
			external.abort()

			let caught: unknown
			try {
				await pending
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
			expect(create).not.toHaveBeenCalled()
		})

		it("settles with the abort contract when the external signal aborts while the output count is pending", async () => {
			const handler = new LmStudioHandler(options)
			// The input count resolves; the output count (second call) never settles.
			vitest
				.spyOn(handler, "countTokens")
				.mockResolvedValueOnce(1)
				.mockImplementation(() => new Promise<number>(() => {}))
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([{ choices: [{ delta: { content: "hi" } }] }]))

			const external = new AbortController()
			const stream = handler.createMessage("system", [], { taskId: "t1", abortSignal: external.signal })
			const first = await stream.next()
			expect(first.value?.type).toBe("text")
			const pending = stream.next() // runs past the stream into the pending output count
			await new Promise((resolve) => setTimeout(resolve, 10))
			external.abort()

			let caught: unknown
			try {
				await pending
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
		})

		it("does not report usage when a stop lands between the output count settling and the usage yield", async () => {
			// The stop lands in the microtask gap: after the output count
			// settles (and the race detaches its listener) but before the
			// generator resumes, so only the pre-yield aborted check stops the
			// usage chunk being reported for an aborted response.
			const handler = new LmStudioHandler(options)
			let resolveOutputCount!: (tokens: number) => void
			vitest
				.spyOn(handler, "countTokens")
				.mockResolvedValueOnce(1)
				.mockImplementationOnce(
					() =>
						new Promise<number>((resolve) => {
							resolveOutputCount = resolve
						}),
				)
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([{ choices: [{ delta: { content: "hi" } }] }]))

			const external = new AbortController()
			const stream = handler.createMessage("system", [], { taskId: "t1", abortSignal: external.signal })
			const first = await stream.next()
			expect(first.value?.type).toBe("text")
			const pending = stream.next() // runs past the stream toward the output count
			await vitest.waitFor(() => {
				expect(typeof resolveOutputCount).toBe("function")
			}) // wait until the generator reaches the (deferred) output count
			resolveOutputCount(3)
			await Promise.resolve() // let the race settle and detach its listener
			external.abort()

			let caught: unknown
			try {
				await pending
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
		})

		it("succeeds without metadata and cancels the request-local signal on completion", async () => {
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([{ choices: [{ delta: { content: "hi" } }] }]))

			const chunks = await collectStream(handler.createMessage("system", []))

			expect(chunks).toContainEqual({ type: "text", text: "hi" })
			const opts = create.mock.calls[0][1]
			expect(opts?.signal).toBeInstanceOf(AbortSignal)
			expect(opts.signal.aborted).toBe(true) // the finally block cancels the request-local request
		})

		it("normalizes an abort error thrown mid-stream", async () => {
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
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
		})

		it("wraps a non-abort create rejection in the generic debug message", async () => {
			// The inner catch's handleOpenAIError throw is re-wrapped by the outer
			// catch into the generic debug message (it is not abort-shaped).
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			const create = lastCreate()
			create.mockRejectedValue(new Error("boom"))

			let caught: unknown
			try {
				await collectStream(handler.createMessage("system", []))
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("Error")
			expect((caught as Error).message).toBe(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Zoo Code's prompts.",
			)
		})

		it("wraps a non-abort stream error in the generic debug message", async () => {
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			const create = lastCreate()
			const apiError = new Error("stream exploded")
			create.mockImplementation(() => {
				return (async function* () {
					yield { choices: [{ delta: { content: "partial" } }] }
					throw apiError
				})()
			})

			let caught: unknown
			try {
				await collectStream(handler.createMessage("system", []))
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).not.toBe("AbortError")
			expect((caught as Error).message).toBe(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Zoo Code's prompts.",
			)
		})

		it("registers and removes the external abort listener", async () => {
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([{ choices: [{ delta: { content: "hi" } }] }]))

			const external = new AbortController()
			const addSpy = vitest.spyOn(external.signal, "addEventListener")
			const removeSpy = vitest.spyOn(external.signal, "removeEventListener")

			await collectStream(handler.createMessage("system", [], { taskId: "t1", abortSignal: external.signal }))

			expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function))
			expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function))
		})

		it("counts the input tokens for the system prompt plus every message content block", async () => {
			const handler = new LmStudioHandler(options)
			const countSpy = vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([]))

			const chunks = await collectStream(handler.createMessage("system", [{ role: "user", content: "hello" }]))

			// The count must see the system prompt block plus each converted
			// message block - a reduced payload would undercount the context.
			expect(countSpy).toHaveBeenCalledTimes(2)
			expect(countSpy.mock.calls[0][0]).toEqual([
				{ type: "text", text: "system" },
				{ type: "text", text: "hello" },
			])
			expect(chunks).toEqual([{ type: "usage", inputTokens: 1, outputTokens: 1 }])
		})

		it("counts the output tokens for the exact concatenation of reasoning and visible text", async () => {
			const handler = new LmStudioHandler(options)
			const countSpy = vitest.spyOn(handler, "countTokens").mockResolvedValue(1)
			const create = lastCreate()
			// Reasoning models stream their thinking in the delta's
			// `reasoning_content` field alongside the visible `content`.
			create.mockResolvedValue(
				asyncStreamFrom([{ choices: [{ delta: { reasoning_content: "thinking", content: "answer" } }] }]),
			)

			const chunks = await collectStream(handler.createMessage("system", []))

			expect(chunks).toEqual([
				{ type: "reasoning", text: "thinking" },
				{ type: "text", text: "answer" },
				{ type: "usage", inputTokens: 1, outputTokens: 1 },
			])
			// The output count must see exactly reasoning + visible text:
			// reasoning tokens are billed as output.
			expect(countSpy.mock.calls[1][0]).toEqual([{ type: "text", text: "thinkinganswer" }])
		})

		it("falls back to zero input tokens and logs when the input count fails without an abort", async () => {
			const handler = new LmStudioHandler(options)
			const countSpy = vitest
				.spyOn(handler, "countTokens")
				.mockRejectedValueOnce(new Error("count failed"))
				.mockResolvedValue(1)
			const errorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([{ choices: [{ delta: { content: "hi" } }] }]))

			const chunks = await collectStream(handler.createMessage("system", []))

			// A count failure is not a request failure: the response still
			// streams, with the failed count falling back to zero tokens.
			expect(errorSpy).toHaveBeenCalledWith("[LmStudio] Failed to count input tokens:", expect.any(Error))
			expect(countSpy).toHaveBeenCalledTimes(2)
			expect(chunks).toEqual([
				{ type: "text", text: "hi" },
				{ type: "usage", inputTokens: 0, outputTokens: 1 },
			])
			errorSpy.mockRestore()
		})

		it("lets an abort-shaped input count rejection propagate to the abort contract", async () => {
			const handler = new LmStudioHandler(options)
			// Only the input count rejects: a permanent rejection would also hit
			// the output count below, whose intact abort check would surface the
			// same contract error and mask a dead input-side check.
			vitest.spyOn(handler, "countTokens").mockRejectedValueOnce(sdkAbortError()).mockResolvedValue(1)
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([{ choices: [{ delta: { content: "hi" } }] }]))

			let caught: unknown
			try {
				await collectStream(handler.createMessage("system", []))
			} catch (error) {
				caught = error
			}

			// An abort-shaped count failure is the caller's Stop, not a count
			// failure: it must surface as the abort contract error instead of
			// falling back to zero tokens and keeping the stream alive.
			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
			expect(create).not.toHaveBeenCalled() // no request goes out after the Stop
		})

		it("falls back to zero output tokens and logs when the output count fails without an abort", async () => {
			const handler = new LmStudioHandler(options)
			const countSpy = vitest
				.spyOn(handler, "countTokens")
				.mockResolvedValueOnce(1)
				.mockRejectedValueOnce(new Error("count failed"))
			const errorSpy = vitest.spyOn(console, "error").mockImplementation(() => {})
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([{ choices: [{ delta: { content: "hi" } }] }]))

			const chunks = await collectStream(handler.createMessage("system", []))

			// Same fallback as the input count above: an error is logged,
			// zero tokens are reported, and the stream still completes.
			expect(errorSpy).toHaveBeenCalledWith("[LmStudio] Failed to count output tokens:", expect.any(Error))
			expect(chunks).toEqual([
				{ type: "text", text: "hi" },
				{ type: "usage", inputTokens: 1, outputTokens: 0 },
			])
			errorSpy.mockRestore()
		})

		it("lets an abort-shaped output count rejection propagate to the abort contract", async () => {
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "countTokens").mockResolvedValueOnce(1).mockRejectedValueOnce(sdkAbortError())
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([{ choices: [{ delta: { content: "hi" } }] }]))

			let caught: unknown
			try {
				await collectStream(handler.createMessage("system", []))
			} catch (error) {
				caught = error
			}

			// Same contract as the input count above: an abort is not a count
			// failure, so the usage chunk must not be reported for an
			// aborted response.
			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
		})

		it("does not issue the SDK request once the signal aborts while the input count settles", async () => {
			// The stop lands in the microtask gap: after the input count
			// settles (and the race detaches its listener) but before the
			// generator resumes, so only the post-count fast-fail guard keeps
			// the request from going out once the request-local signal has
			// aborted.
			const handler = new LmStudioHandler(options)
			let resolveInputCount!: (tokens: number) => void
			vitest
				.spyOn(handler, "countTokens")
				.mockImplementationOnce(
					() =>
						new Promise<number>((resolve) => {
							resolveInputCount = resolve
						}),
				)
				.mockResolvedValue(1)
			const create = lastCreate()
			create.mockResolvedValue(asyncStreamFrom([{ choices: [{ delta: { content: "hi" } }] }]))

			const external = new AbortController()
			const stream = handler.createMessage("system", [], { taskId: "t1", abortSignal: external.signal })
			const pending = stream.next()
			await new Promise((resolve) => setTimeout(resolve, 10)) // let the generator reach the pending count
			resolveInputCount(1)
			await Promise.resolve() // let the race settle and detach its listener
			external.abort()

			let caught: unknown
			try {
				await pending
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
			expect(create).not.toHaveBeenCalled() // the request must not be issued after the Stop
		})
	})

	describe("completePrompt", () => {
		it("passes the merged signal through and nothing without options", async () => {
			const handler = new LmStudioHandler(options)
			const create = lastCreate()
			create.mockResolvedValue({ choices: [{ message: { content: "ok" } }] })
			const external = new AbortController()

			expect(await handler.completePrompt("hi")).toBe("ok")
			expect(create.mock.calls[0][1]).toBeUndefined() // no signal, no timeout: nothing reaches the SDK

			expect(await handler.completePrompt("hi", { abortSignal: external.signal })).toBe("ok")
			// no timeout: the merged signal is the external signal itself
			expect(create.mock.calls[1][1]?.signal).toBe(external.signal)
		})

		it("normalizes a create rejection that looks like an abort", async () => {
			const handler = new LmStudioHandler(options)
			const create = lastCreate()
			create.mockRejectedValue(sdkAbortError())

			let caught: unknown
			try {
				await handler.completePrompt("hi")
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
		})

		it("wraps a non-abort create rejection in the generic debug message", async () => {
			// The inner catch's handleOpenAIError throw is re-wrapped by the outer
			// catch into the generic debug message (it is not abort-shaped).
			const handler = new LmStudioHandler(options)
			const create = lastCreate()
			create.mockRejectedValue(new Error("model not found"))

			let caught: unknown
			try {
				await handler.completePrompt("hi")
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("Error")
			expect((caught as Error).message).toBe(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Zoo Code's prompts.",
			)
		})

		it("normalizes an abort error thrown while building the request", async () => {
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "getModel").mockImplementation(() => {
				const error = new Error("aborted")
				error.name = "AbortError"
				throw error
			})

			let caught: unknown
			try {
				await handler.completePrompt("hi")
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).toBe("AbortError")
			expect((caught as Error).message).toBe("The LM Studio request was aborted")
		})

		it("wraps a non-abort request-building error in the generic debug message", async () => {
			const handler = new LmStudioHandler(options)
			vitest.spyOn(handler, "getModel").mockImplementation(() => {
				throw new Error("model not found")
			})

			let caught: unknown
			try {
				await handler.completePrompt("hi")
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(Error)
			expect((caught as Error).name).not.toBe("AbortError")
			expect((caught as Error).message).toBe(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Zoo Code's prompts.",
			)
		})
	})
})
