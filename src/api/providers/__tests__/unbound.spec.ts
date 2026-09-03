import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { APIConnectionTimeoutError, APIUserAbortError } from "openai"

import { UnboundHandler } from "../unbound"
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
	refreshModels: vi.fn(async (options) => {
		const { getModels } = await import("../fetchers/modelCache")
		return getModels(options)
	}),
}))

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

		expect(chunks).toContainEqual({
			type: "tool_call_partial",
			index: 0,
			id: "call_1",
			name: "get_weather",
			arguments: '{"city": "NYC"}',
		})
		expect(chunks).toContainEqual({ type: "text", text: "done" })
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
			asyncStreamFrom([{ choices: [{ delta: { content: "hi", tool_calls: null } }] }]),
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

	it("completePrompt should pass abort signal through to client", async () => {
		const controller = new AbortController()
		sharedMockCreate.mockResolvedValue({
			choices: [{ message: { content: "completed text" } }],
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		await handler.completePrompt("Write a haiku", { abortSignal: controller.signal })
		expect(sharedMockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: expect.any(String) }),
			expect.objectContaining({ signal: controller.signal }),
		)
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

	it("completePrompt should preserve abort identity when the caller aborts", async () => {
		// Emulate the OpenAI SDK: an aborted request signal rejects with
		// APIUserAbortError ("Request was aborted." — the trailing period would
		// fail task-level abort detection, so the provider must normalize it).
		sharedMockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
			if (options?.signal?.aborted) {
				throw new APIUserAbortError()
			}
			throw new Error("boom")
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})
		const controller = new AbortController()
		controller.abort()

		const error = await handler.completePrompt("Write a haiku", { abortSignal: controller.signal }).then(
			() => undefined,
			(e: unknown) => e,
		)
		expect(error).toMatchObject({ name: "AbortError" })
		expect((error as Error).message).toBe("The Unbound request was aborted")
	})

	it("completePrompt should surface request timeouts as an AbortError", async () => {
		// Emulate the OpenAI SDK: when the request timeout fires, the SDK
		// surfaces APIConnectionTimeoutError ("Request timed out.") once retries
		// are exhausted — verified against openai v5.23.2 against a hung server.
		sharedMockCreate.mockImplementation(async (_params: unknown, options: { timeout?: number }) => {
			await new Promise((resolve) => setTimeout(resolve, options?.timeout ?? 50))
			throw new APIConnectionTimeoutError()
		})

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

	it("completePrompt should preserve abort identity when the signal is pre-aborted with a plain error", async () => {
		// The aborted-signal disjunct alone must normalize a plain rejection
		// (not just SDK abort classes) to the DOM-standard AbortError.
		sharedMockCreate.mockRejectedValueOnce(new Error("boom"))
		const controller = new AbortController()
		controller.abort()
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

	describe("createMessage abort signal bridging", () => {
		it("rejects the request with an AbortError when the external signal is already aborted", async () => {
			let requestError: unknown
			let capturedSignal: AbortSignal | undefined
			sharedMockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				// The real SDK rejects with an AbortError when its request signal is aborted.
				capturedSignal = options?.signal
				requestError = new DOMException("The operation was aborted.", "AbortError")
				throw requestError
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

			// The bridge surfaces a DOM-standard AbortError (series standard)
			// instead of the wrapped completion error.
			await expect(collectStream(stream)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Unbound request was aborted",
			})
			// An already-aborted external signal must abort the INTERNAL
			// controller before the request starts.
			expect(capturedSignal?.aborted).toBe(true)
			expect(requestError).toMatchObject({ name: "AbortError" })
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
					for (let i = 0; i < 40 && !capturedSignal?.aborted; i++) {
						await new Promise((resolve) => setTimeout(resolve, 5))
					}
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
			await new Promise((resolve) => setTimeout(resolve, 25))
			controller.abort()

			// createMessage's stream loop has no catch: the raw SDK rejection
			// propagates once the bridge aborts the in-flight request.
			const error = await consumed.then(
				() => undefined,
				(e: unknown) => e,
			)
			expect(capturedSignal?.aborted).toBe(true)
			expect((error as Error).message).toBe("boom")
		})

		it("detaches the bridged abort listener when the request completes normally", async () => {
			// The listener is added with { once: true }, so it only detaches on
			// abort. A task-scoped signal spanning many requests must not
			// accumulate a listener per request: assert explicit removal after a
			// normal (non-aborted) completion.
			sharedMockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "ok" } }] },
					{ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
				]),
			)

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
			expect(removeListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function))
			// The listener is registered with { once: true } — assert the exact
			// options so a bridge that drops them (and relies on the finally
			// block alone for single-shot semantics) is caught.
			expect(addEventListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true })
			expect(controller.signal.aborted).toBe(false)
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
})
