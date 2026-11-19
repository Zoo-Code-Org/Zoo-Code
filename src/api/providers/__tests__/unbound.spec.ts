import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { APIConnectionTimeoutError, APIUserAbortError } from "openai"

import { unboundDefaultModelInfo } from "@roo-code/types"

import { UnboundHandler } from "../unbound"
import { getModels } from "../fetchers/modelCache"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { makeCreateMessageMetadata } from "../../../test-utils/api"

// Single hoisted mock shared by the `openai` factory and every test so tests
// can configure the SDK `create` call without untyped access casts.
const sharedMockCreate = vi.hoisted(() => vi.fn())

// The real SDK error classes are re-exported alongside the mocked client so
// tests can emulate the SDK's abort/timeout rejections (APIUserAbortError,
// APIConnectionTimeoutError) and the provider's instanceof checks resolve.
vi.mock("openai", async () => {
	const actual = await vi.importActual<typeof import("openai")>("openai")
	return {
		...actual,
		default: vi.fn(function () {
			return {
				chat: {
					completions: {
						create: sharedMockCreate,
					},
				},
			}
		}),
	}
})

vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({
		"openai/gpt-4o": {
			maxTokens: 4096,
			contextWindow: 128000,
			supportsImages: true,
			supportsPromptCache: false,
			inputPrice: 2.5,
			outputPrice: 10,
			description: "GPT-4o",
		},
	}),
	refreshModels: vi.fn(async (options, handler) => {
		const { getModels } = await import("../fetchers/modelCache")
		return getModels(options, handler)
	}),
}))

// A bounded observation window built on vi.waitFor: it polls while its callback throws, so a
// callback that always throws keeps it polling for the whole window (measured on vitest 4.1.12:
// a callback that only returns a value settles immediately instead of waiting). It also doubles
// as the "still pending" sentinel in the cancel races below, which is what pins the race itself.
async function observeWindow(ms: number): Promise<"pending"> {
	return vi
		.waitFor(() => expect(false).toBe(true), { timeout: ms, interval: 10 })
		.then(
			() => "pending",
			() => "pending",
		)
}

describe("UnboundHandler", () => {
	beforeEach(() => {
		clearAllMocks()
	})

	it("identifies itself as Zoo Code in the Unbound request headers", () => {
		new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultHeaders: expect.objectContaining({
					"X-Unbound-Metadata": JSON.stringify({ labels: [{ key: "app", value: "zoo-code" }] }),
				}),
			}),
		)
	})

	it("streams reasoning chunks from delta.reasoning_content", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{ choices: [{ delta: { reasoning_content: "thinking..." } }] },
				{ choices: [{ delta: { content: "answer" } }] },
				{ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
			]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks = await collectStream(
			handler.createMessage("system", [{ role: "user", content: "hi" }], {
				taskId: "t",
				tools: [],
			}),
		)

		expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
	})

	it("falls back to delta.reasoning when reasoning_content is absent", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{ choices: [{ delta: { reasoning: "router-style thought" } }] },
				{ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
			]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks = await collectStream(
			handler.createMessage("system", [{ role: "user", content: "hi" }], {
				taskId: "t",
				tools: [],
			}),
		)

		expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
	})

	it("prefers delta.reasoning_content over delta.reasoning when both are present", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create

		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{
					choices: [
						{
							delta: {
								reasoning_content: "primary thought",
								reasoning: "fallback thought",
							},
						},
					],
				},
				{ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
			]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks = await collectStream(
			handler.createMessage("system", [{ role: "user", content: "hi" }], {
				taskId: "t",
				tools: [],
			}),
		)

		const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")

		expect(reasoningChunks).toEqual([{ type: "reasoning", text: "primary thought" }])
	})

	it("identifies itself as Zoo Code in per-request Unbound metadata", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue(
			asyncStreamFrom([
				{
					choices: [{ delta: { content: "ok" } }],
				},
				{
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				},
			]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "hello" }]
		const stream = handler.createMessage("system", messages, {
			taskId: "task-123",
			mode: "architect",
			tools: [],
		})

		await collectStream(stream)

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				unbound_metadata: {
					originApp: "zoo-code",
					taskId: "task-123",
					mode: "architect",
				},
			}),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
	})

	it("wraps non-abort pre-stream failures via handleOpenAIError", async () => {
		// A non-abort rejection from create() (e.g. an upstream 500) must be
		// routed through handleOpenAIError, not the AbortError normalization
		// path: assert the wrapped identity and the preserved message.
		sharedMockCreate.mockRejectedValue(new Error("upstream 500"))

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const stream = handler.createMessage("system", [{ role: "user", content: "hi" }], {
			taskId: "t",
			tools: [],
		})

		const error = await collectStream(stream).then(
			() => undefined,
			(e: unknown) => e,
		)
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toBe("Unbound completion error: upstream 500")
		expect((error as Error).name).not.toBe("AbortError")
	})

	it("emits tool_call_partial chunks for native tool calls in the stream", async () => {
		// Native tool calls arrive on delta.tool_calls and must be re-emitted
		// as raw tool_call_partial chunks for NativeToolCallParser to assemble.
		sharedMockCreate.mockResolvedValue(
			asyncStreamFrom([
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_1",
										type: "function",
										function: { name: "get_weather", arguments: '{"city": "NYC"}' },
									},
								],
							},
						},
					],
				},
				{ choices: [{ delta: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
			]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks = await collectStream(
			handler.createMessage("system", [{ role: "user", content: "hi" }], {
				taskId: "t",
				tools: [],
			}),
		)

		// Ordered, not membership: a provider that emitted the tool partial twice, or emitted it after
		// the text, must fail here. The fixture interleaves tool, text and usage frames.
		expect(chunks).toEqual([
			{ type: "tool_call_partial", index: 0, id: "call_1", name: "get_weather", arguments: '{"city": "NYC"}' },
			{ type: "text", text: "done" },
			{
				type: "usage",
				inputTokens: 1,
				outputTokens: 1,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: expect.any(Number),
			},
		])
	})

	it("skips frames without a first choice", async () => {
		sharedMockCreate.mockResolvedValue(
			asyncStreamFrom([{ choices: [] }, { choices: [{ delta: { content: "hi" } }] }]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks = await collectStream(
			handler.createMessage("system", [{ role: "user", content: "hi" }], { taskId: "t", tools: [] }),
		)

		expect(chunks).toEqual([{ type: "text", text: "hi" }])
	})

	it("ignores a non-array tool_calls field on the delta", async () => {
		sharedMockCreate.mockResolvedValue(
			// Truthy and not an array: a bare null would also pass if the production guard dropped its
			// Array.isArray check, because "null" in an if is simply falsy. A truthy non-array forces the
			// iteration itself to be the thing the guard prevents.
			asyncStreamFrom([{ choices: [{ delta: { content: "hi", tool_calls: {} } }] }]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks = await collectStream(
			handler.createMessage("system", [{ role: "user", content: "hi" }], { taskId: "t", tools: [] }),
		)

		expect(chunks).toEqual([{ type: "text", text: "hi" }])
	})

	it("emits a partial tool call with undefined name and arguments when function is absent", async () => {
		sharedMockCreate.mockResolvedValue(
			asyncStreamFrom([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1" }] } }] }]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks = await collectStream(
			handler.createMessage("system", [{ role: "user", content: "hi" }], { taskId: "t", tools: [] }),
		)

		expect(chunks).toEqual([{ type: "tool_call_partial", index: 0, id: "call_1" }])
	})

	it("keeps the last reported usage when a later frame carries none", async () => {
		sharedMockCreate.mockResolvedValue(
			asyncStreamFrom([
				{ choices: [{ delta: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
				{ choices: [{ delta: {} }] },
			]),
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks = await collectStream(
			handler.createMessage("system", [{ role: "user", content: "hi" }], { taskId: "t", tools: [] }),
		)

		expect(chunks).toEqual([
			{ type: "text", text: "hi" },
			expect.objectContaining({ type: "usage", inputTokens: 1, outputTokens: 2 }),
		])
	})

	it("emits no usage chunk when the stream reports none", async () => {
		sharedMockCreate.mockResolvedValue(asyncStreamFrom([{ choices: [{ delta: { content: "hi" } }] }]))

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks = await collectStream(
			handler.createMessage("system", [{ role: "user", content: "hi" }], { taskId: "t", tools: [] }),
		)

		expect(chunks).toEqual([{ type: "text", text: "hi" }])
	})

	it("completePrompt returns the response text", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "completed text" } }],
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const result = await handler.completePrompt("Write a haiku")
		expect(result).toBe("completed text")
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [{ role: "system", content: "Write a haiku" }],
			}),
			{},
		)
	})

	it("completePrompt hands the client a per-request bridge that settles on the caller cancel", async () => {
		const controller = new AbortController()
		let sdkSignal: AbortSignal | undefined
		let abortedAtEntry = true
		// A create that never settles reproduces the SDK waiting out a retry delay while the caller
		// cancels. Observations are recorded here and asserted below: an assertion raised inside the
		// mock would be normalized into the very AbortError this test expects.
		sharedMockCreate.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
			sdkSignal = options?.signal
			abortedAtEntry = sdkSignal?.aborted === true
			return new Promise<never>(() => {})
		})
		const handler = new UnboundHandler({ unboundApiKey: "test-key", unboundModelId: "openai/gpt-4o" })
		const completing = handler.completePrompt("Write a haiku", { abortSignal: controller.signal }).then(
			() => "resolved",
			(e: unknown) => e,
		)
		await vi.waitFor(() => expect(sharedMockCreate).toHaveBeenCalledTimes(1))
		controller.abort()
		const error = await Promise.race([completing, observeWindow(200)])
		// The SDK adds an abort listener to whatever signal it is handed and never removes it, so it
		// must receive the per-request bridge rather than the caller's long-lived signal.
		expect(sdkSignal).toBeInstanceOf(AbortSignal)
		expect(sdkSignal).not.toBe(controller.signal)
		expect(abortedAtEntry).toBe(false)
		expect(sdkSignal?.aborted).toBe(true) // the bridge forwarded the cancel to the SDK signal
		expect(error).not.toBe("pending") // an in-flight completion must not outlive the cancel
		expect(error).not.toBe("resolved")
		expect(error).toMatchObject({ name: "AbortError" })
		expect((error as Error).message).toBe("The Unbound request was aborted")
	})

	it("completePrompt should pass timeout through to client", async () => {
		sharedMockCreate.mockResolvedValue({
			choices: [{ message: { content: "completed text" } }],
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		await handler.completePrompt("Write a haiku", { timeoutMs: 5000 })
		// Without a caller signal there is no bridge to hand over, so the option object stays without a
		// signal key rather than carrying an undefined one.
		expect(Object.keys((sharedMockCreate.mock.calls.at(-1)?.[1] ?? {}) as object)).not.toContain("signal")
		expect(sharedMockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: expect.any(String) }),
			expect.objectContaining({ timeout: 5000 }),
		)
	})

	it("completePrompt should omit the timeout option when timeoutMs is 0", async () => {
		// The OpenAI SDK treats timeout: 0 as an immediate abort, so the
		// "disabled" value must never be forwarded — assert the absence of
		// the option (a forwarded timeout: 0 would fail this assertion).
		sharedMockCreate.mockResolvedValue({
			choices: [{ message: { content: "completed text" } }],
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		await handler.completePrompt("Write a haiku", { timeoutMs: 0 })
		const call = sharedMockCreate.mock.calls[sharedMockCreate.mock.calls.length - 1]
		const requestOptions = call[1] as { timeout?: number } | undefined
		expect(requestOptions).not.toHaveProperty("timeout")
	})

	it("completePrompt should omit the timeout option for a negative timeoutMs and keep the bridged signal", async () => {
		// -5 is a disabled budget, not a five-second one: hasUsableTimeout rejects every non-positive
		// value, so nothing may reach the SDK. Dropping the budget must not drop the cancel either —
		// the per-request bridged signal still has to reach the client.
		sharedMockCreate.mockResolvedValue({
			choices: [{ message: { content: "completed text" } }],
		})

		const controller = new AbortController()
		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		await handler.completePrompt("Write a haiku", { abortSignal: controller.signal, timeoutMs: -5 })
		const call = sharedMockCreate.mock.calls[sharedMockCreate.mock.calls.length - 1]
		const requestOptions = call[1] as { timeout?: number; signal?: AbortSignal } | undefined
		expect(requestOptions).not.toHaveProperty("timeout")
		expect(requestOptions?.signal).toBeInstanceOf(AbortSignal)
	})

	it("detaches the bridged abort listener when the completion finishes", async () => {
		// The OpenAI SDK keeps an abort listener on whatever signal it is handed and never removes it, so
		// the bridge's own listener has to go in the completion's finally: a task-scoped signal spanning
		// several completions must not accumulate one listener per request.
		sharedMockCreate.mockResolvedValue({
			choices: [{ message: { content: "completed text" } }],
		})

		const controller = new AbortController()
		const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener")
		const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener")
		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		await handler.completePrompt("Write a haiku", { abortSignal: controller.signal })

		try {
			const abortAdds = addEventListenerSpy.mock.calls.filter(([event]) => event === "abort")
			const bridgeListener = abortAdds.at(-1)?.[1]
			expect(typeof bridgeListener).toBe("function")
			expect(addEventListenerSpy).toHaveBeenCalledWith("abort", bridgeListener, { once: true })
			const removed = removeListenerSpy.mock.calls
				.filter(([event]) => event === "abort")
				.map(([, listener]) => listener)
			expect(removed).toContain(bridgeListener)
			expect(controller.signal.aborted).toBe(false)
		} finally {
			addEventListenerSpy.mockRestore()
			removeListenerSpy.mockRestore()
		}
	})

	it("completePrompt should preserve abort identity when the caller aborts during the request", async () => {
		// Emulate the OpenAI SDK: an aborted request signal rejects with
		// APIUserAbortError ("Request was aborted." — the trailing period would
		// fail task-level abort detection, so the provider must normalize it).
		// The abort fires inside the mock so the SDK abort branch is actually reached:
		// a pre-aborted signal settles in the cancellation scope before the mock
		// runs, which would leave this catch untested.
		const controller = new AbortController()
		sharedMockCreate.mockImplementationOnce(async (_params: unknown, _options: { signal?: AbortSignal }) => {
			controller.abort()
			throw new APIUserAbortError()
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const error = await handler.completePrompt("Write a haiku", { abortSignal: controller.signal }).then(
			() => undefined,
			(e: unknown) => e,
		)
		expect(sharedMockCreate).toHaveBeenCalledTimes(1)
		expect(error).toMatchObject({ name: "AbortError" })
		expect((error as Error).message).toBe("The Unbound request was aborted")
	})

	it("completePrompt should surface request timeouts as an AbortError", async () => {
		// Emulate the OpenAI SDK: when the request timeout fires, the SDK
		// surfaces APIConnectionTimeoutError ("Request timed out.") once retries
		// are exhausted — verified against openai v5.23.2 against a hung server.
		sharedMockCreate.mockImplementationOnce(
			async (_params: unknown, options: { timeout?: number; signal?: AbortSignal }) => {
				// The SDK surfaces its timeout error only once the client's patience runs out: wait on
				// the per-request signal the handler passed instead of guessing at a duration.
				const sdkSignal = options?.signal
				if (sdkSignal && !sdkSignal.aborted) {
					await new Promise<void>((resolve) => {
						sdkSignal.addEventListener("abort", () => resolve(), { once: true })
					})
				}
				throw new APIConnectionTimeoutError()
			},
		)

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const error = await handler.completePrompt("Write a haiku", { timeoutMs: 50 }).then(
			() => undefined,
			(e: unknown) => e,
		)
		expect(error).toMatchObject({ name: "AbortError" })
		expect((error as Error).message).toBe("The Unbound request was aborted")
	})

	it("completePrompt should preserve abort identity when the signal aborts during the request with a plain error", async () => {
		// The aborted-signal disjunct alone must normalize a plain rejection
		// (not just SDK abort classes) to the DOM-standard AbortError. The abort
		// fires inside the request so the cancellation scope still lets the model
		// lookup finish and the catch observes an aborted signal.
		const controller = new AbortController()
		sharedMockCreate.mockImplementationOnce(async (_params: unknown, _options: { signal?: AbortSignal }) => {
			controller.abort()
			throw new Error("boom")
		})
		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const error = await handler.completePrompt("Write a haiku", { abortSignal: controller.signal }).then(
			() => undefined,
			(e: unknown) => e,
		)
		expect(error).toMatchObject({ name: "AbortError" })
		expect((error as Error).message).toBe("The Unbound request was aborted")
	})

	it("completePrompt should preserve abort identity for a name-based AbortError rejection", async () => {
		// No aborted signal and no SDK abort class: only the DOM-standard
		// name === "AbortError" check marks a cancelled request.
		sharedMockCreate.mockRejectedValueOnce(Object.assign(new Error("raw"), { name: "AbortError" }))
		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const error = await handler.completePrompt("Write a haiku").then(
			() => undefined,
			(e: unknown) => e,
		)
		expect(error).toMatchObject({ name: "AbortError" })
		expect((error as Error).message).toBe("The Unbound request was aborted")
	})

	it("completePrompt should wrap a plain rejection when no options are provided", async () => {
		// No options at all: options?.abortSignal must tolerate an undefined
		// options argument and the rejection must surface as the wrapped
		// completion error.
		sharedMockCreate.mockRejectedValueOnce(new Error("boom"))
		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const error = await handler.completePrompt("Write a haiku").then(
			() => undefined,
			(e: unknown) => e,
		)
		expect((error as Error).message).toBe("Unbound completion error: boom")
	})

	it("completePrompt should wrap a non-Error rejection with its object string", async () => {
		// The 4th disjunct must require an actual Error instance: a plain
		// object with name === "AbortError" is not a cancelled request and
		// must go through the completion-error wrapping path.
		sharedMockCreate.mockRejectedValueOnce({ name: "AbortError" })
		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const error = await handler.completePrompt("Write a haiku").then(
			() => undefined,
			(e: unknown) => e,
		)
		expect((error as Error).message).toBe("Unbound completion error: [object Object]")
	})
	it("completePrompt should work without options (backward compatible)", async () => {
		sharedMockCreate.mockResolvedValue({
			choices: [{ message: { content: "completed text" } }],
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const result = await handler.completePrompt("Write a haiku")
		expect(result).toBe("completed text")
	})

	it("completePrompt settles on the abort while model resolution is pending", async () => {
		// The catalog lookup parks forever, so the prompt can only settle through
		// the cancellation scope around the lookup; without it the handler waits
		// for the catalog and then issues the SDK request.
		let releaseGate!: () => void
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve
		})
		let markLookupParked!: () => void
		const lookupParked = new Promise<void>((resolve) => {
			markLookupParked = resolve
		})
		vi.mocked(getModels).mockImplementationOnce(async () => {
			markLookupParked()
			await gate
			return {}
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})
		const controller = new AbortController()

		const completion = handler.completePrompt("Write a haiku", { abortSignal: controller.signal })
		await lookupParked
		controller.abort()

		const error = await completion.then(
			() => undefined,
			(caught: unknown) => caught,
		)
		// Release the parked lookup so the disposable mock does not leak into the
		// next test in the file.
		releaseGate()
		expect(sharedMockCreate).not.toHaveBeenCalled()
		expect(error).toMatchObject({ name: "AbortError" })
		expect((error as Error).message).toBe("The Unbound request was aborted")
	})

	describe("createMessage abort signal bridging", () => {
		it("rejects with the standardized AbortError before any request work when the external signal is already aborted", async () => {
			// A pre-aborted request must fail fast before any model-catalog or
			// SDK work starts: the standardized AbortError wins over any
			// resolution failure, and the request itself never begins.
			let capturedSignal: AbortSignal | undefined
			sharedMockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
				throw new DOMException("The operation was aborted.", "AbortError")
			})

			const controller = new AbortController()
			controller.abort()

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
			})

			const stream = handler.createMessage(
				"system",
				[{ role: "user", content: "hi" }],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const error = await collectStream(stream).then(
				() => undefined,
				(e: unknown) => e,
			)
			// The fast-fail guard rejects before the request starts.
			expect(sharedMockCreate).not.toHaveBeenCalled()
			// Pre-flight cancellation must skip the model catalog entirely:
			// the getModels mock must remain uncalled, not just the SDK create.
			expect(getModels).not.toHaveBeenCalled()
			expect(capturedSignal).toBeUndefined()
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Unbound request was aborted")
		})

		it("rejects with the standardized AbortError when the external signal aborts while model resolution is pending", async () => {
			// The model catalog stays pending while the external signal aborts:
			// the resolution race must settle with the standardized AbortError
			// before the lookup is released, and the request itself must never
			// start. A bridge-only fix would let the lookup finish and abort the
			// internal controller after the fact; this gate proves the prompt
			// settles on the abort itself.
			let releaseResolution!: () => void
			const resolutionGate = new Promise<void>((resolve) => {
				releaseResolution = resolve
			})
			let markLookupParked!: () => void
			const lookupParked = new Promise<void>((resolve) => {
				markLookupParked = resolve
			})
			vi.mocked(getModels).mockImplementationOnce(async () => {
				markLookupParked()
				await resolutionGate
				return {
					"openai/gpt-4o": {
						maxTokens: 4096,
						contextWindow: 128000,
						supportsImages: true,
						supportsPromptCache: false,
						inputPrice: 2.5,
						outputPrice: 10,
						description: "GPT-4o",
					},
				}
			})

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
			})
			const controller = new AbortController()

			const consumed = collectStream(
				handler.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			// Let the lookup park on the gate, then abort while it is still pending.
			await lookupParked
			controller.abort()

			const error = await consumed.then(
				() => undefined,
				(e: unknown) => e,
			)
			// The catalog lookup was attempted but the prompt must have settled
			// on the abort itself, before the lookup was released: no SDK call.
			expect(getModels).toHaveBeenCalledTimes(1)
			expect(sharedMockCreate).not.toHaveBeenCalled()
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Unbound request was aborted")

			// Releasing the lookup afterwards must not start a late request.
			releaseResolution()
			// A late request is an absence, so give the released continuation a real observation window.
			// vi.waitFor resolves as soon as its callback stops throwing, and a callback that only returns a
			// falsy value never throws at all (measured on vitest 4.1.12: it settled well inside the timeout),
			// so polling the call count here would not wait. The assertion below is what fails when a late
			// request appears.
			await observeWindow(50)
			expect(sharedMockCreate).not.toHaveBeenCalled()
		})

		it("aborts the in-flight request when the external signal fires mid-stream", async () => {
			// The mock polls the INTERNAL controller signal (bounded 40x5ms)
			// instead of waiting for an "abort" event, so the test can never
			// hang if the bridge stops forwarding aborts.
			let capturedSignal: AbortSignal | undefined
			sharedMockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
				return (async function* () {
					yield { choices: [{ delta: { content: "partial" } }] }
					// Reached only when the consumer asks for the next chunk, i.e. the first chunk is
					// delivered: fire the caller's abort here so the abort is mid-stream by construction.
					controller.abort()
					if (capturedSignal?.aborted) {
						throw new Error("boom")
					}
				})()
			})

			const controller = new AbortController()
			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
			})

			const consumed = collectStream(
				handler.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			// Let the request start and the first chunk be yielded before aborting.
			// The mock calls controller.abort() the moment the first chunk has been consumed,

			// The stream loop normalizes failures that surface after the stream
			// has started (series standard): the cancellation must surface as
			// the standardized AbortError, not the raw rejection.
			const error = await consumed.then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(capturedSignal?.aborted).toBe(true)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Unbound request was aborted")
		})

		it("normalizes a mid-stream APIUserAbortError to the standardized AbortError", async () => {
			// The SDK can raise its own user-abort error even when the per-request
			// controller was not aborted (e.g. the SDK watched a different signal):
			// the instanceof branch of the loop catch must normalize it.
			sharedMockCreate.mockImplementation(async () =>
				(async function* () {
					yield { choices: [{ delta: { content: "partial" } }] }
					throw new APIUserAbortError()
				})(),
			)

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
			})

			await expect(
				collectStream(
					handler.createMessage(
						"system",
						[{ role: "user", content: "hi" }],
						makeCreateMessageMetadata({ abortSignal: new AbortController().signal }),
					),
				),
			).rejects.toMatchObject({
				name: "AbortError",
				message: "The Unbound request was aborted",
			})
		})

		it("normalizes a name-based AbortError thrown from the stream to the standardized AbortError", async () => {
			// The DOM-style name check must catch errors that are not SDK abort
			// classes: a plain Error named AbortError is normalized too.
			const abortError = new Error("The operation was aborted.")
			abortError.name = "AbortError"
			sharedMockCreate.mockImplementation(async () =>
				(async function* () {
					yield { choices: [{ delta: { content: "partial" } }] }
					throw abortError
				})(),
			)

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
			})

			await expect(
				collectStream(
					handler.createMessage(
						"system",
						[{ role: "user", content: "hi" }],
						makeCreateMessageMetadata({ abortSignal: new AbortController().signal }),
					),
				),
			).rejects.toMatchObject({
				name: "AbortError",
				message: "The Unbound request was aborted",
			})
		})

		it("rethrows a non-Error mid-stream failure that merely looks like an abort", async () => {
			// The instanceof guard is load-bearing: a plain object carrying an
			// AbortError name is not an Error, so it must not be normalized and
			// must propagate unchanged.
			const fake = { name: "AbortError", message: "suspicious" }
			sharedMockCreate.mockImplementation(async () =>
				(async function* () {
					yield { choices: [{ delta: { content: "partial" } }] }
					throw fake
				})(),
			)

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
			})

			const error = await collectStream(
				handler.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: new AbortController().signal }),
				),
			).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toBe(fake)
		})

		it("rethrows a plain non-abort Error instance from the stream unchanged", async () => {
			// The name check must not over-normalize: a genuine Error whose
			// name is not "AbortError" must propagate unchanged — only real
			// aborts surface as the standardized AbortError.
			const boom = new Error("stream exploded")
			sharedMockCreate.mockImplementation(async () =>
				(async function* () {
					yield { choices: [{ delta: { content: "partial" } }] }
					throw boom
				})(),
			)

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
			})

			const error = await collectStream(
				handler.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: new AbortController().signal }),
				),
			).then(
				() => undefined,
				(e: unknown) => e,
			)
			// Identity, not shape: the rethrown error must be the very Error
			// instance the stream raised, not a normalized abort error.
			expect(error).toBe(boom)
		})

		it("surfaces a cancel when the SDK closes the stream without throwing", async () => {
			// The SDK consumes the body-read abort itself and can end the iterator normally, so the
			// provider must inspect the caller signal rather than read that quiet end as a completed turn.
			const controller = new AbortController()
			let lateChunkReads = 0
			sharedMockCreate.mockImplementationOnce(async () =>
				(async function* () {
					yield { choices: [{ delta: { content: "a" } }], index: 0 }
					controller.abort()
					// A frame still queued behind the cancel: pulling it is fine, reading it is not.
					yield {
						get choices() {
							lateChunkReads += 1
							return [{ delta: { content: "late" }, index: 0 }]
						},
						index: 0,
					}
				})(),
			)
			const handler = new UnboundHandler({ unboundApiKey: "test-key", unboundModelId: "openai/gpt-4o" })
			const error = await collectStream(
				handler.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({
						abortSignal: controller.signal,
					}),
				),
			).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Unbound request was aborted")
			expect(lateChunkReads).toBe(0) // the cancelled stream is not read again
		})

		it("does not emit the text item of a frame whose reasoning item was already taken", async () => {
			// A consumer that takes the reasoning item, cancels and pulls again resumes this generator inside the
			// same iteration, after the top-of-loop check has run: only a check in front of the text item can
			// keep a cancelled turn from emitting it.
			sharedMockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "thinking", content: "answer" } }], index: 0 },
				]),
			)
			const controller = new AbortController()
			const handler = new UnboundHandler({ unboundApiKey: "test-key", unboundModelId: "openai/gpt-4o" })
			const iterator = handler
				.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "reasoning", text: "thinking" })
			// Observable condition: this item reached the consumer; the frame still owes its next item.
			controller.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Unbound request was aborted")

			// The same frame with a live caller signal still delivers both items.
			sharedMockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "thinking", content: "answer" } }], index: 0 },
				]),
			)
			const live = new AbortController()
			const chunks = await collectStream(
				handler.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: live.signal }),
				),
			)
			expect(chunks.map((chunk: { type: string }) => chunk.type)).toEqual(["reasoning", "text"])
		})

		it("does not emit the rest of a tool-call chunk once the caller cancels", async () => {
			// Consumer-driven: take the first partial, cancel, then require the next call to reject without
			// building the second one. The getter variant aborted before either partial existed, so it could
			// not tell a per-partial check apart from a check in front of the whole frame.
			const controller = new AbortController()
			let laterToolCallReads = 0
			const toolCalls = [
				{
					index: 0,
					id: "call_1",
					type: "function",
					function: { name: "get_weather", arguments: '{"city":"NYC"}' },
				},
				{
					get index() {
						laterToolCallReads += 1
						return 0
					},
					id: "call_2",
					type: "function",
					function: { name: "get_time", arguments: '{"tz":"UTC"}' },
				},
			]
			sharedMockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([{ choices: [{ delta: { tool_calls: toolCalls } }], index: 0 }]),
			)
			const handler = new UnboundHandler({ unboundApiKey: "test-key", unboundModelId: "openai/gpt-4o" })
			const iterator = handler
				.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				[Symbol.asyncIterator]()

			const first = await iterator.next()
			expect(first.value).toMatchObject({ type: "tool_call_partial", id: "call_1" })
			// Observable condition: the first partial reached the consumer, so the cancel lands between partials.
			controller.abort()

			const settled = await iterator.next().then(
				(result) => result.value,
				(error: unknown) => error,
			)
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Unbound request was aborted")
			expect(laterToolCallReads).toBe(0) // the second partial is never built
		})

		it("settles the stream at once when the caller cancels while create() is pending", async () => {
			// The SDK waits out a Retry-After backoff without observing the signal, so an in-flight create
			// can outlive the cancel; a never-settling create reproduces that wait.
			sharedMockCreate.mockImplementation(() => new Promise<never>(() => {}))
			const controller = new AbortController()
			const handler = new UnboundHandler({ unboundApiKey: "test-key", unboundModelId: "openai/gpt-4o" })
			const collecting = collectStream(
				handler.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({
						abortSignal: controller.signal,
					}),
				),
			).then(
				() => "resolved",
				(e: unknown) => e,
			)
			// Cancel only once the lookup has settled and the SDK call is in flight: an earlier abort would
			// be answered by the model-lookup race rather than this one.
			await vi.waitFor(() => expect(sharedMockCreate).toHaveBeenCalledTimes(1))
			controller.abort()
			const settled = await Promise.race([collecting, observeWindow(200)])
			expect(settled).not.toBe("pending") // an in-flight create must not outlive the cancel
			expect(settled).not.toBe("resolved")
			expect(settled).toMatchObject({ name: "AbortError" })
			expect((settled as Error).message).toBe("The Unbound request was aborted")
		})

		it.each(["mid-stream throw", "rejected create()", "early gen.return()"] as const)(
			"detaches the bridged abort listener on %s",
			async (mode) => {
				const controller = new AbortController()
				let sdkSignal: AbortSignal | undefined
				const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener")
				const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener")

				// Every mode records the signal the provider handed the SDK. The model-lookup race registers
				// its own "abort" listener with { once: true } on the caller's signal, so without this capture
				// the assertions below could be satisfied by the race's listener without any request bridge.
				if (mode === "rejected create()") {
					sharedMockCreate.mockImplementationOnce(
						async (_params: unknown, options?: { signal?: AbortSignal }) => {
							sdkSignal = options?.signal
							throw new Error("boom")
						},
					)
				} else if (mode === "mid-stream throw") {
					sharedMockCreate.mockImplementationOnce(
						async (_params: unknown, options?: { signal?: AbortSignal }) => {
							sdkSignal = options?.signal
							return (async function* () {
								yield { choices: [{ delta: { content: "p" }, index: 0 }], index: 0 }
								throw new Error("boom")
							})()
						},
					)
				} else {
					sharedMockCreate.mockImplementationOnce(
						async (_params: unknown, options?: { signal?: AbortSignal }) => {
							sdkSignal = options?.signal
							return (async function* () {
								yield { choices: [{ delta: { content: "p" }, index: 0 }], index: 0 }
								await new Promise<void>(() => {})
							})()
						},
					)
				}

				const handler = new UnboundHandler({
					unboundApiKey: "test-key",
					unboundModelId: "openai/gpt-4o",
				})
				const iterator = handler
					.createMessage(
						"prompt",
						[{ role: "user", content: "hello" }],
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					)
					[Symbol.asyncIterator]()

				if (mode === "early gen.return()") {
					await iterator.next()
					await iterator.return?.(undefined)
				} else {
					await iterator.next().catch(() => undefined)
					await iterator.next().catch(() => undefined)
					await iterator.return?.(undefined)
				}

				const abortAddCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === "abort")
				const abortRemoveCalls = removeListenerSpy.mock.calls.filter(([event]) => event === "abort")
				const bridgeListener = abortAddCalls.at(-1)?.[1]
				expect(abortAddCalls.length).toBeGreaterThan(0)
				expect(abortRemoveCalls.some(([, listener]) => listener === bridgeListener)).toBe(true)
				// The SDK must receive the request bridge, not the caller's own signal: without it no bridge
				// listener is ever registered, and the removal above would be the lookup race's.
				expect(sdkSignal).toBeInstanceOf(AbortSignal)
				expect(sdkSignal).not.toBe(controller.signal)
			},
		)

		it("detaches the bridged abort listener when the request completes normally", async () => {
			// The listener is added with { once: true }, so it only detaches on
			// abort. A task-scoped signal spanning many requests must not
			// accumulate a listener per request: assert explicit removal after a
			// normal (non-aborted) completion.
			let sdkSignal: AbortSignal | undefined
			sharedMockCreate.mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				sdkSignal = options?.signal
				return asyncStreamFrom([
					{ choices: [{ delta: { content: "ok" } }] },
					{ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
				])
			})

			const controller = new AbortController()
			const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener")
			const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener")

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
			})

			const chunks = await collectStream(
				handler.createMessage(
					"system",
					[{ role: "user", content: "hi" }],
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				),
			)

			expect(chunks).toContainEqual({ type: "text", text: "ok" })
			// Assert the exact listener reference so a bridge that removes a
			// different callback than the one it registered cannot pass.
			// The rejectOnAbort race registers its own "abort" listener on the
			// same external signal during model resolution, so the first "abort"
			// registration is the race's, not the bridge's. Target the last
			// registration so the options/removal assertions below cannot be
			// satisfied by the race's listener.
			const abortAddCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === "abort")
			const addedListener = abortAddCalls[abortAddCalls.length - 1]?.[1]
			expect(typeof addedListener).toBe("function")
			// The listener is registered with { once: true } — assert the exact
			// options so a bridge that drops them (and relies on the finally
			// block alone for single-shot semantics) is caught.
			expect(addEventListenerSpy).toHaveBeenCalledWith("abort", addedListener, { once: true })
			expect(removeListenerSpy).toHaveBeenCalledWith("abort", addedListener)
			expect(controller.signal.aborted).toBe(false)
			// The SDK received the bridge rather than the caller's signal, so the listener above is the
			// request bridge's and not the model-lookup race's.
			expect(sdkSignal).toBeInstanceOf(AbortSignal)
			expect(sdkSignal).not.toBe(controller.signal)
		})

		it("streams normally when called without metadata", async () => {
			// metadata?.abortSignal must tolerate a missing metadata argument.
			sharedMockCreate.mockImplementation(async () =>
				asyncStreamFrom([{ choices: [{ delta: { content: "hi" } }] }]),
			)

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
			})

			const chunks = await collectStream(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			expect(chunks).toEqual([{ type: "text", text: "hi" }])
		})

		it("preserves abort identity when the SDK rejects with APIUserAbortError and no signal is aborted", async () => {
			// No external signal: the aborted-controller disjunct is false, so
			// the APIUserAbortError disjunct alone must normalize the rejection
			// to the DOM-standard AbortError.
			sharedMockCreate.mockRejectedValueOnce(new APIUserAbortError())

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
			})

			const error = await collectStream(
				handler.createMessage("system", [{ role: "user", content: "hi" }], { taskId: "t", tools: [] }),
			).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Unbound request was aborted")
		})

		it("preserves abort identity when the SDK rejects with a name-based AbortError", async () => {
			// No SDK abort class and no aborted signal: only the DOM-standard
			// name === "AbortError" check marks a cancelled pre-stream request.
			sharedMockCreate.mockRejectedValueOnce(Object.assign(new Error("raw"), { name: "AbortError" }))

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
			})

			const error = await collectStream(
				handler.createMessage("system", [{ role: "user", content: "hi" }], { taskId: "t", tools: [] }),
			).then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as Error).message).toBe("The Unbound request was aborted")
		})
	})

	describe("model catalog", () => {
		it("reports its cache scope", () => {
			const handler = new UnboundHandler({ unboundApiKey: "test-key", unboundModelId: "openai/gpt-4o" })
			expect(handler.getModelCacheScope()).toEqual({ urlScoped: false, keyScoped: false, authScoped: false })
		})

		it("populates this.models so getModel() stops returning the default info", async () => {
			const handler = new UnboundHandler({ unboundApiKey: "test-key", unboundModelId: "openai/gpt-4o" })

			expect(handler.getModel().info.description).toBe(unboundDefaultModelInfo.description)

			await handler.ensureModelFetched()

			expect(handler.getModel().info.description).toBe("GPT-4o")
			expect(handler.getModel().info.maxTokens).toBe(4096)
		})
	})
})
