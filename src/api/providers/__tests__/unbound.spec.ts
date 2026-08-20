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
		expect((error as Error).message.endsWith("aborted")).toBe(true)
		expect((error as Error).message).not.toContain("completion error")
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
		expect((error as Error).message.endsWith("aborted")).toBe(true)
		expect((error as Error).message).not.toContain("completion error")
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
			sharedMockCreate.mockImplementation(async () => {
				// The real SDK rejects with an AbortError when its request signal is aborted.
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
				message: "Unbound request aborted",
			})
			expect(requestError).toMatchObject({ name: "AbortError" })
		})

		it("aborts the in-flight request when the external signal fires mid-stream", async () => {
			let capturedSignal: AbortSignal | undefined
			sharedMockCreate.mockImplementation(async (_params: unknown, options: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal
				return (async function* () {
					yield { choices: [{ delta: { content: "partial" } }] }
					await new Promise((_resolve, reject) => {
						const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"))
						options?.signal?.addEventListener("abort", onAbort, { once: true })
					})
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

			await expect(consumed).rejects.toMatchObject({ name: "AbortError" })
			expect(capturedSignal?.aborted).toBe(true)
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
			expect(controller.signal.aborted).toBe(false)
		})
	})
})
