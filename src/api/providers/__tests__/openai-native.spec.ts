// npx vitest run api/providers/__tests__/openai-native.spec.ts

const mockCaptureException = vitest.fn()

vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: (...args: unknown[]) => mockCaptureException(...args),
		},
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { ApiProviderError, OpenAiServiceTier, SERVICE_TIER_KEY, serviceTiers } from "@roo-code/types"

import { OpenAiNativeHandler } from "../openai-native"
import type { ApiStreamChunk, ApiStreamTextChunk } from "../../../api/transform/stream"
import { ApiHandlerOptions } from "../../../shared/api"
import { Package } from "../../../shared/package"
import {
	expectRequestObjectContaining,
	makeApiHandlerOptions,
	makeCreateMessageMetadata,
} from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { deleteGlobalFetch } from "../../../test-utils/reset"
import { flushMacrotasks } from "../../../test-utils/timers"

// Mock OpenAI client - now everything uses Responses API
const mockResponsesCreate = vitest.fn()

const serviceTierPricingCases = [
	{
		requestedTier: OpenAiServiceTier.Default,
		resolvedTier: OpenAiServiceTier.Priority,
		expectedCost: 0.0016,
	},
	{
		requestedTier: OpenAiServiceTier.Priority,
		resolvedTier: OpenAiServiceTier.Flex,
		expectedCost: 0.0004,
	},
	{
		requestedTier: OpenAiServiceTier.Flex,
		resolvedTier: OpenAiServiceTier.Default,
		expectedCost: 0.0008,
	},
]

vitest.mock("openai", () => ({
	__esModule: true,
	default: vitest.fn().mockImplementation(function () {
		return {
			responses: {
				create: mockResponsesCreate,
			},
		}
	}),
}))

describe("OpenAiNativeHandler", () => {
	let handler: OpenAiNativeHandler
	let mockOptions: ApiHandlerOptions
	const systemPrompt = "You are a helpful assistant."
	const messages: Anthropic.Messages.MessageParam[] = [
		{
			role: "user",
			content: "Hello!",
		},
	]

	beforeEach(() => {
		mockOptions = makeApiHandlerOptions()
		handler = new OpenAiNativeHandler(mockOptions)
		mockResponsesCreate.mockClear()
		mockCaptureException.mockClear()
		deleteGlobalFetch()
	})

	afterEach(() => {
		deleteGlobalFetch()
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(OpenAiNativeHandler)
			expect(handler.getModel().id).toBe(mockOptions.apiModelId)
		})

		it("should initialize with empty API key", () => {
			const handlerWithoutKey = new OpenAiNativeHandler({
				apiModelId: "gpt-4.1",
				openAiNativeApiKey: "",
			})
			expect(handlerWithoutKey).toBeInstanceOf(OpenAiNativeHandler)
		})

		it("should pass undefined baseURL when openAiNativeBaseUrl is empty string", () => {
			;(OpenAI as unknown as ReturnType<typeof vitest.fn>).mockClear()
			new OpenAiNativeHandler({
				apiModelId: "gpt-4.1",
				openAiNativeApiKey: "test-key",
				openAiNativeBaseUrl: "",
			})
			expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ baseURL: undefined }))
		})

		it("should pass custom baseURL when openAiNativeBaseUrl is a valid URL", () => {
			;(OpenAI as unknown as ReturnType<typeof vitest.fn>).mockClear()
			new OpenAiNativeHandler({
				apiModelId: "gpt-4.1",
				openAiNativeApiKey: "test-key",
				openAiNativeBaseUrl: "https://custom-openai.example.com/v1",
			})
			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({ baseURL: "https://custom-openai.example.com/v1" }),
			)
		})

		it("should identify itself as Zoo Code in request headers", () => {
			;(OpenAI as unknown as ReturnType<typeof vitest.fn>).mockClear()
			new OpenAiNativeHandler({
				apiModelId: "gpt-4.1",
				openAiNativeApiKey: "test-key",
			})

			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					defaultHeaders: expect.objectContaining({
						originator: "zoo-code",
						"User-Agent": expect.stringContaining(`zoo-code/${Package.version}`),
					}),
				}),
			)
		})
	})

	describe("createMessage", () => {
		function makeOpenStreamFetchMock() {
			type OpenStream = {
				controller?: ReadableStreamDefaultController<Uint8Array>
				fetchSignal: AbortSignal
			}
			const openStreams: OpenStream[] = []
			const mockFetch = vitest.fn().mockImplementation((_url: string, options?: RequestInit) => {
				const entry: OpenStream = { fetchSignal: options?.signal as AbortSignal }
				const body = new ReadableStream<Uint8Array>({
					start: (controller) => {
						entry.controller = controller
					},
				})
				openStreams.push(entry)
				return Promise.resolve({
					ok: true,
					body,
				})
			})
			const requireController = (index: number): ReadableStreamDefaultController<Uint8Array> => {
				const entry = openStreams[index]
				if (!entry?.controller) {
					throw new Error("expected fallback fetch to have started")
				}
				return entry.controller
			}
			return { openStreams, mockFetch, requireController }
		}

		it("shapes GPT-6 Astra requests for Responses tool calling", () => {
			const astraHandler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-6-astra",
				reasoningEffort: "none",
				modelTemperature: 0.7,
			})
			const model = astraHandler.getModel()
			const reasoningEffort = astraHandler["getReasoningEffort"](model)
			const body = astraHandler["buildRequestBody"](model, [], systemPrompt, undefined, reasoningEffort, {
				taskId: "test-task",
				tools: [
					{
						type: "function",
						function: {
							name: "read_file",
							description: "Read a file",
							parameters: { type: "object", properties: { path: { type: "string" } } },
						},
					},
				],
			})

			expect(body).toMatchObject({
				model: "gpt-6-astra",
				max_output_tokens: 128_000,
				reasoning: { effort: "medium", summary: "auto" },
				tools: [{ type: "function", name: "read_file", strict: true }],
			})
			expect(body.temperature).toBeUndefined()
			expect(body.top_p).toBeUndefined()
			expect(body.logprobs).toBeUndefined()
			expect(body.text).toBeUndefined()
		})

		it.each(["low", "medium", "high", "xhigh", "max"] as const)(
			"accepts the supported Astra %s reasoning effort",
			(reasoningEffort) => {
				const astraHandler = new OpenAiNativeHandler({
					...mockOptions,
					apiModelId: "gpt-6-astra",
					reasoningEffort,
				})
				expect(astraHandler["getReasoningEffort"](astraHandler.getModel())).toBe(reasoningEffort)
			},
		)

		it.each([
			["the configured effort is disabled", { reasoningEffort: "disable" as const }],
			["the reasoning toggle is disabled", { enableReasoningEffort: false }],
		])("uses Astra's required default when %s", (_description, options) => {
			const astraHandler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-6-astra",
				...options,
			})

			expect(astraHandler["getReasoningEffort"](astraHandler.getModel())).toBe("medium")
		})

		it.each(serviceTiers)("should include the selected %s service tier", async (serviceTier) => {
			mockResponsesCreate.mockResolvedValue(asyncStreamFrom([]))
			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.6-sol",
				openAiNativeServiceTier: serviceTier,
			})

			await collectStream(handler.createMessage(systemPrompt, messages))

			expect(mockResponsesCreate).toHaveBeenCalledWith(
				expectRequestObjectContaining({ [SERVICE_TIER_KEY]: serviceTier }),
				expect.any(Object),
			)
		})

		it.each(serviceTierPricingCases)(
			"prices SDK stream usage using resolved $resolvedTier tier instead of requested $requestedTier tier",
			async ({ requestedTier, resolvedTier, expectedCost }) => {
				mockResponsesCreate.mockResolvedValue(
					asyncStreamFrom([
						{
							type: "response.done",
							response: {
								[SERVICE_TIER_KEY]: resolvedTier,
								usage: { input_tokens: 100, output_tokens: 20 },
							},
						},
					]),
				)
				handler = new OpenAiNativeHandler({
					...mockOptions,
					apiModelId: "gpt-5.6-sol",
					openAiNativeServiceTier: requestedTier,
				})

				const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

				const usage = chunks.find((chunk) => chunk.type === "usage")
				expect(usage).toMatchObject({ type: "usage", inputTokens: 100, outputTokens: 20 })
				expect(usage?.totalCost).toBeCloseTo(expectedCost, 10)
			},
		)

		it.each([
			{
				name: "an explicitly selected default tier",
				modelId: "gpt-5.4" as const,
				requestedTier: OpenAiServiceTier.Default,
				resolvedTier: undefined,
				expectedCost: 0.22,
			},
			{
				name: "no selected service tier",
				modelId: "gpt-5.4" as const,
				requestedTier: undefined,
				resolvedTier: undefined,
				expectedCost: 0.22,
			},
			{
				name: "a resolved service tier without a pricing entry",
				modelId: "gpt-5.3-chat-latest" as const,
				requestedTier: OpenAiServiceTier.Default,
				resolvedTier: OpenAiServiceTier.Priority,
				expectedCost: 0.1575,
			},
		])("retains standard pricing for $name", async ({ modelId, requestedTier, resolvedTier, expectedCost }) => {
			mockResponsesCreate.mockResolvedValue(
				asyncStreamFrom([
					{
						type: "response.done",
						response: {
							...(resolvedTier ? { [SERVICE_TIER_KEY]: resolvedTier } : {}),
							usage: {
								input_tokens: 100_000,
								output_tokens: 1_000,
								cache_read_input_tokens: 20_000,
							},
						},
					},
				]),
			)
			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: modelId,
				openAiNativeServiceTier: requestedTier,
			})

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			const usageChunk = chunks.find((chunk) => chunk.type === "usage")
			expect(usageChunk).toBeDefined()
			expect(usageChunk?.totalCost).toBeCloseTo(expectedCost, 6)
		})

		it.each(serviceTierPricingCases)(
			"requests $requestedTier but prices manual SSE fallback usage using OpenAI's resolved $resolvedTier tier",
			async ({ requestedTier, resolvedTier, expectedCost }) => {
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))
				const mockFetch = vitest.fn().mockResolvedValue({
					ok: true,
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({
										type: "response.done",
										response: {
											[SERVICE_TIER_KEY]: resolvedTier,
											usage: { input_tokens: 100, output_tokens: 20 },
										},
									})}\n\n`,
								),
							)
							controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
							controller.close()
						},
					}),
				})
				global.fetch = mockFetch as typeof fetch
				handler = new OpenAiNativeHandler({
					...mockOptions,
					apiModelId: "gpt-5.6-sol",
					openAiNativeServiceTier: requestedTier,
				})

				const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

				const [, request] = mockFetch.mock.calls[0]
				expect(JSON.parse(request.body)).toMatchObject({ [SERVICE_TIER_KEY]: requestedTier })
				const usage = chunks.find((chunk) => chunk.type === "usage")
				expect(usage?.totalCost).toBeCloseTo(expectedCost, 10)
			},
		)

		it.each(serviceTierPricingCases)(
			"captures resolved $resolvedTier tier from a manual SSE completion event when $requestedTier was requested",
			async ({ requestedTier, resolvedTier, expectedCost }) => {
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))
				const mockFetch = vitest.fn().mockResolvedValue({
					ok: true,
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({
										type: "response.completed",
										response: { [SERVICE_TIER_KEY]: resolvedTier },
									})}\n\n`,
								),
							)
							controller.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({
										type: "response.usage",
										usage: { input_tokens: 100, output_tokens: 20 },
									})}\n\n`,
								),
							)
							controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
							controller.close()
						},
					}),
				})
				global.fetch = mockFetch as typeof fetch
				handler = new OpenAiNativeHandler({
					...mockOptions,
					apiModelId: "gpt-5.6-sol",
					openAiNativeServiceTier: requestedTier,
				})

				const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

				const usage = chunks.find((chunk) => chunk.type === "usage")
				expect(usage).toMatchObject({ type: "usage", inputTokens: 100, outputTokens: 20 })
				expect(usage?.totalCost).toBeCloseTo(expectedCost, 10)
			},
		)

		it("should handle streaming responses via Responses API", async () => {
			// Mock fetch for Responses API fallback
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode('data: {"type":"response.text.delta","delta":"Test"}\n\n'),
						)
						controller.enqueue(
							new TextEncoder().encode('data: {"type":"response.text.delta","delta":" response"}\n\n'),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.done","response":{"usage":{"prompt_tokens":10,"completion_tokens":2}}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail so it falls back to fetch
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(2)
			expect(textChunks[0].text).toBe("Test")
			expect(textChunks[1].text).toBe(" response")
		})

		it("should handle API errors", async () => {
			// Mock fetch to return error
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "Internal Server Error",
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const stream = handler.createMessage(systemPrompt, messages)
			await expect(async () => {
				for await (const _chunk of stream) {
					// Should not reach here
				}
			}).rejects.toThrow("OpenAI service error")
		})

		it("does not start the fallback POST when the abort signal is already aborted", async () => {
			const mockFetch = vitest.fn().mockImplementation((_url: string, options?: RequestInit) => {
				if (options?.signal?.aborted) {
					const error = new Error("This operation was aborted")
					error.name = "AbortError"
					return Promise.reject(error)
				}
				return new Promise<Response>(() => {})
			})
			global.fetch = mockFetch as typeof fetch

			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const controller = new AbortController()
			controller.abort()

			const stream = handler.createMessage(
				systemPrompt,
				messages,
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			await expect(collectStream(stream)).rejects.toMatchObject({ name: "AbortError" })
			// The pre-aborted signal must be honoured before the fallback request is attempted:
			// no POST is issued at all, and the caller sees the provider's abort contract.
			expect(mockFetch).not.toHaveBeenCalled()
		})

		it("should abort the fallback fetch when the external abortSignal is aborted mid-request", async () => {
			const mockFetch = vitest.fn().mockImplementation((_url: string, options?: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => {
							const error = new Error("This operation was aborted")
							error.name = "AbortError"
							reject(error)
						},
						{ once: true },
					)
				})
			})
			global.fetch = mockFetch as typeof fetch

			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const controller = new AbortController()
			const stream = handler.createMessage(
				systemPrompt,
				messages,
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const collected = collectStream(stream)
			// The abort must land mid-request, so poll the observable that the request
			// exists - the fetch double having been called - instead of a wall-clock delay.
			// The explicit timeout is what makes a condition that never fires fail the test.
			await vi.waitUntil(() => mockFetch.mock.calls.length > 0, { timeout: 2000, interval: 25 })
			controller.abort()

			await expect(collected).rejects.toMatchObject({ name: "AbortError" })
		})

		it("should not let a late abort from an earlier request cancel a later request", async () => {
			// Regression: the external-signal bridge must detach on request completion.
			// With a lingering listener (or one reading the mutable this.abortController
			// field), aborting the FIRST request's signal after completion would cancel
			// the SECOND request's controller.
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const { openStreams, mockFetch, requireController } = makeOpenStreamFetchMock()
			global.fetch = mockFetch as typeof fetch

			const firstController = new AbortController()
			const secondController = new AbortController()

			// First request: completes normally.
			const firstStream = handler.createMessage(
				systemPrompt,
				messages,
				makeCreateMessageMetadata({ abortSignal: firstController.signal }),
			)
			const firstCollected = collectStream(firstStream)
			// Observable: the first request has registered an in-flight stream. The
			// explicit timeout keeps a condition that never fires from idling to green.
			await vi.waitUntil(() => openStreams.length >= 1, { timeout: 2000, interval: 25 })
			requireController(0).enqueue(
				new TextEncoder().encode('data: {"type":"response.text.delta","delta":"one"}\n\n'),
			)
			requireController(0).enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
			requireController(0).close()

			const firstChunks = await firstCollected
			expect(firstChunks.some((chunk) => chunk.type === "text" && chunk.text === "one")).toBe(true)

			// Second request with a different external signal, left in-flight.
			const secondStream = handler.createMessage(
				systemPrompt,
				messages,
				makeCreateMessageMetadata({ abortSignal: secondController.signal }),
			)
			const secondCollected = collectStream(secondStream)
			// Observable: both requests are in flight; the length assertion stays because
			// polling replaces the sleep, not the assertion.
			await vi.waitUntil(() => openStreams.length >= 2, { timeout: 2000, interval: 25 })
			expect(openStreams).toHaveLength(2)

			// Aborting the FIRST request's signal must not leak into the second request.
			firstController.abort()

			// The second request's internal fetch signal must remain active...
			expect(openStreams[1].fetchSignal.aborted).toBe(false)

			// ...and the second stream must still complete normally.
			requireController(1).enqueue(
				new TextEncoder().encode('data: {"type":"response.text.delta","delta":"two"}\n\n'),
			)
			requireController(1).enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
			requireController(1).close()

			const secondChunks = await secondCollected
			expect(secondChunks.some((chunk) => chunk.type === "text" && chunk.text === "two")).toBe(true)
		})

		describe("abort-signal bridging", () => {
			// The bedrock-pattern bridge in executeRequest and makeResponsesApiRequest forwards
			// metadata?.abortSignal onto a request-local AbortController. These tests make every
			// branch observable: a resolving SDK mock exercises the executeRequest bridge
			// directly, a rejecting one exercises the fetch fallback bridge, and the
			// request-local signal handed to the SDK/fetch is captured for assertions.

			function makeAbortError(): Error {
				const error = new Error("This operation was aborted")
				error.name = "AbortError"
				return error
			}

			// A tick has no observable condition to poll here, so it uses the shared macrotask flush
			// (test-utils/timers, setImmediate-based) rather than a wall-clock timer.
			const tick = flushMacrotasks

			// The mocked stream must stay open until the abort arrives, with a bounded fallback so a
			// missing propagation cannot hang the test. AbortSignal.timeout is the platform's own
			// deadline primitive: no wall-clock sleep to clear and no listener to forget.
			function untilSignalAborted(signal: AbortSignal, timeoutMs = 200): Promise<void> {
				return new Promise<void>((resolve) => {
					if (signal.aborted) {
						resolve()
						return
					}
					const deadline = AbortSignal.timeout(timeoutMs)
					const settle = () => {
						deadline.removeEventListener("abort", settle)
						resolve()
					}
					signal.addEventListener("abort", settle, { once: true })
					deadline.addEventListener("abort", settle, { once: true })
				})
			}

			function textChunks(chunks: ApiStreamChunk[]): ApiStreamTextChunk[] {
				return chunks.filter((chunk): chunk is ApiStreamTextChunk => chunk.type === "text")
			}

			it("should register a once-only abort listener on the external signal and detach it when the SDK request completes", async () => {
				const controller = new AbortController()
				const addSpy = vi.spyOn(controller.signal, "addEventListener")
				const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
				let sdkSignal: AbortSignal | undefined
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					sdkSignal = options?.signal
					return Promise.resolve(
						asyncStreamFrom([
							{ type: "response.output_text.delta", delta: "one" },
							{ type: "response.output_text.delta", delta: " two" },
						]),
					)
				})

				try {
					const chunks = await collectStream(
						handler.createMessage(
							systemPrompt,
							messages,
							makeCreateMessageMetadata({ abortSignal: controller.signal }),
						),
					)

					expect(textChunks(chunks).map((chunk) => chunk.text)).toEqual(["one", " two"])
					expect(sdkSignal?.aborted).toBe(false)
					// The bridge must listen for the "abort" event with { once: true } ...
					expect(addSpy).toHaveBeenCalledTimes(1)
					expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true })
					// ... and detach that exact listener when the request completes.
					const registeredListener = addSpy.mock.calls.find(([type]) => type === "abort")?.[1]
					expect(registeredListener).toBeDefined()
					expect(removeSpy).toHaveBeenCalledTimes(1)
					expect(removeSpy).toHaveBeenCalledWith("abort", registeredListener)
					// The request-local controller is cleared once the request is done.
					expect(handler["abortController"]).toBeUndefined()
				} finally {
					addSpy.mockRestore()
					removeSpy.mockRestore()
				}
			})

			it("should abort the SDK request immediately when the external signal is already aborted", async () => {
				const controller = new AbortController()
				controller.abort()
				const addSpy = vi.spyOn(controller.signal, "addEventListener")
				let sdkSignal: AbortSignal | undefined
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					sdkSignal = options?.signal
					// A real SDK rejects immediately when its request signal is pre-aborted.
					if (options?.signal?.aborted) {
						return Promise.reject(makeAbortError())
					}
					return Promise.resolve(asyncStreamFrom([{ type: "response.output_text.delta", delta: "one" }]))
				})
				const mockFetch = vitest.fn().mockImplementation((_url: string, options?: RequestInit) => {
					if (options?.signal?.aborted) {
						return Promise.reject(makeAbortError())
					}
					return new Promise<Response>(() => {})
				})
				global.fetch = mockFetch as typeof fetch

				try {
					const stream = handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					)
					await expect(collectStream(stream)).rejects.toMatchObject({ name: "AbortError" })

					// The bridge must have pre-aborted the request-local controller ...
					expect(sdkSignal?.aborted).toBe(true)
					// ... instead of registering a listener on the already-aborted signal.
					expect(addSpy).not.toHaveBeenCalled()
				} finally {
					addSpy.mockRestore()
				}
			})

			it("should not pre-abort the SDK request for a pending external signal and should abort it mid-flight", async () => {
				const controller = new AbortController()
				let sdkSignal: AbortSignal | undefined
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					sdkSignal = options?.signal
					const signal = options?.signal
					return Promise.resolve(
						(async function* () {
							yield { type: "response.output_text.delta", delta: "one" }
							if (signal) {
								await untilSignalAborted(signal, 200)
							}
						})(),
					)
				})

				const stream = handler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				const collected = collectStream(stream)
				// Attach the handler before the abort fires: the post-loop check rejects the stream
				// as soon as the generator ends, so a late handler would surface as an unhandled
				// rejection.
				const settled = collected.catch((error) => error)
				await tick()

				expect(sdkSignal).toBeDefined()
				// A pending external signal must not abort the request up front.
				expect(sdkSignal?.aborted).toBe(false)

				controller.abort()
				await tick()
				// ... but it must abort the request as soon as it fires.
				expect(sdkSignal?.aborted).toBe(true)

				// The SDK iterator returns normally when the abort lands while it awaits the
				// next event, so the post-loop check must report the contract AbortError instead
				// of resolving with the partial stream.
				const error = await settled
				expect(error).toMatchObject({
					name: "AbortError",
					message: "The OpenAI Native request was aborted",
				})
			})

			it("should stop consuming the SDK stream once the external signal aborts the request", async () => {
				const controller = new AbortController()
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					const signal = options?.signal
					return Promise.resolve(
						(async function* () {
							yield { type: "response.output_text.delta", delta: "first" }
							if (signal) {
								await untilSignalAborted(signal, 200)
							}
							yield { type: "response.output_text.delta", delta: "second" }
						})(),
					)
				})

				const stream = handler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				const chunks: ApiStreamChunk[] = []
				// Consume from before the abort so both halves of the contract are visible: the stream
				// stops consuming before the post-abort event is processed, and it reports the
				// cancellation as the contract AbortError.
				const consumed = (async () => {
					try {
						for await (const chunk of stream) {
							chunks.push(chunk)
						}
					} catch (error) {
						return error
					}
					return undefined
				})()
				await tick()

				controller.abort()

				expect(await consumed).toMatchObject({
					name: "AbortError",
					message: "The OpenAI Native request was aborted",
				})
				expect(textChunks(chunks).map((chunk) => chunk.text)).toEqual(["first"])
			})

			it("should detach the external abort listener on completion so a late abort cannot abort the request signal", async () => {
				const controller = new AbortController()
				let openGate: (() => void) | undefined
				const gate = new Promise<void>((resolve) => {
					openGate = resolve
				})
				let sdkSignal: AbortSignal | undefined
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					sdkSignal = options?.signal
					return Promise.resolve(
						(async function* () {
							yield { type: "response.output_text.delta", delta: "one" }
							await gate
						})(),
					)
				})

				const stream = handler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				const collected = collectStream(stream)
				await tick()

				// Let the request complete normally, then abort the external signal late.
				if (!openGate) {
					throw new Error("expected the stream gate to be ready")
				}
				openGate()
				const chunks = await collected
				expect(textChunks(chunks).map((chunk) => chunk.text)).toEqual(["one"])

				controller.abort()
				await tick()

				// The bridging listener must have been detached: the late abort must
				// not reach the already-completed request's controller.
				expect(sdkSignal?.aborted).toBe(false)
				expect(handler["abortController"]).toBeUndefined()
			})

			it("should not call removeEventListener on the external signal when no listener was registered", async () => {
				const controller = new AbortController()
				controller.abort()
				const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					if (options?.signal?.aborted) {
						return Promise.reject(makeAbortError())
					}
					return Promise.resolve(asyncStreamFrom([{ type: "response.output_text.delta", delta: "one" }]))
				})
				const mockFetch = vitest.fn().mockImplementation((_url: string, options?: RequestInit) => {
					if (options?.signal?.aborted) {
						return Promise.reject(makeAbortError())
					}
					return new Promise<Response>(() => {})
				})
				global.fetch = mockFetch as typeof fetch

				try {
					const stream = handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					)
					await expect(collectStream(stream)).rejects.toMatchObject({ name: "AbortError" })

					// A pre-aborted signal registers no listener, so nothing may be removed.
					expect(removeSpy).not.toHaveBeenCalled()
				} finally {
					removeSpy.mockRestore()
				}
			})

			it("should preserve a later fallback request's controller when an earlier SDK request completes", async () => {
				// Request A: SDK path, in flight. Request B: SDK fails, so its fallback
				// fetch installs the handler's controller. When A completes, its finally
				// must not clear the controller owned by B's fallback.
				let aGateOpen: (() => void) | undefined
				const aGate = new Promise<void>((resolve) => {
					aGateOpen = resolve
				})
				let aSdkSignal: AbortSignal | undefined
				let sdkCalls = 0
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					sdkCalls += 1
					if (sdkCalls === 1) {
						aSdkSignal = options?.signal
						return Promise.resolve(
							(async function* () {
								yield { type: "response.output_text.delta", delta: "a-one" }
								await aGate
							})(),
						)
					}
					return Promise.reject(new Error("SDK not available"))
				})
				const { openStreams, mockFetch, requireController } = makeOpenStreamFetchMock()
				global.fetch = mockFetch as typeof fetch

				const streamA = handler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: new AbortController().signal }),
				)
				const collectedA = collectStream(streamA)
				await tick()
				expect(aSdkSignal?.aborted).toBe(false)

				const streamB = handler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: new AbortController().signal }),
				)
				const collectedB = collectStream(streamB)
				await tick()
				expect(openStreams).toHaveLength(1)

				// Complete A while B's fallback owns the handler's controller.
				if (!aGateOpen) {
					throw new Error("expected the stream gate to be ready")
				}
				aGateOpen()
				const chunksA = await collectedA
				expect(textChunks(chunksA).map((chunk) => chunk.text)).toEqual(["a-one"])
				expect(handler["abortController"]?.signal).toBe(openStreams[0].fetchSignal)

				// Let B finish; its finally chain clears the controller.
				requireController(0).enqueue(
					new TextEncoder().encode('data: {"type":"response.text.delta","delta":"b-one"}\n\n'),
				)
				requireController(0).enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
				requireController(0).close()
				const chunksB = await collectedB
				expect(textChunks(chunksB).map((chunk) => chunk.text)).toEqual(["b-one"])
				expect(handler["abortController"]).toBeUndefined()
			})

			it("should not clear a later SDK request's controller when a fallback request completes", async () => {
				// Mirror of the previous test: request B (fallback) starts first and
				// request A (SDK) takes over the handler's controller. When B's fallback
				// completes, its finally must not clear A's controller.
				let aGateOpen: (() => void) | undefined
				const aGate = new Promise<void>((resolve) => {
					aGateOpen = resolve
				})
				let aSdkSignal: AbortSignal | undefined
				let sdkCalls = 0
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					sdkCalls += 1
					if (sdkCalls === 1) {
						return Promise.reject(new Error("SDK not available"))
					}
					aSdkSignal = options?.signal
					return Promise.resolve(
						(async function* () {
							yield { type: "response.output_text.delta", delta: "a-one" }
							await aGate
						})(),
					)
				})
				const { openStreams, mockFetch, requireController } = makeOpenStreamFetchMock()
				global.fetch = mockFetch as typeof fetch

				const streamB = handler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: new AbortController().signal }),
				)
				const collectedB = collectStream(streamB)
				await tick()
				expect(openStreams).toHaveLength(1)

				const streamA = handler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: new AbortController().signal }),
				)
				const collectedA = collectStream(streamA)
				await tick()
				expect(aSdkSignal?.aborted).toBe(false)

				// Let B's fallback complete while A owns the handler's controller.
				requireController(0).enqueue(
					new TextEncoder().encode('data: {"type":"response.text.delta","delta":"b-one"}\n\n'),
				)
				requireController(0).enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
				requireController(0).close()
				const chunksB = await collectedB
				expect(textChunks(chunksB).map((chunk) => chunk.text)).toEqual(["b-one"])
				expect(handler["abortController"]?.signal).toBe(aSdkSignal)

				// Let A finish; its finally clears the controller.
				if (!aGateOpen) {
					throw new Error("expected the stream gate to be ready")
				}
				aGateOpen()
				const chunksA = await collectedA
				expect(textChunks(chunksA).map((chunk) => chunk.text)).toEqual(["a-one"])
				expect(handler["abortController"]).toBeUndefined()
			})

			it("should clear the handler's abortController after a fallback request completes", async () => {
				const mockFetch = vitest.fn().mockResolvedValue({
					ok: true,
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode('data: {"type":"response.text.delta","delta":"one"}\n\n'),
							)
							controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
							controller.close()
						},
					}),
				})
				global.fetch = mockFetch as typeof fetch
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

				const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

				expect(textChunks(chunks).map((chunk) => chunk.text)).toEqual(["one"])
				// The fallback installs its own controller and must clear it when done.
				expect(handler["abortController"]).toBeUndefined()
			})

			it("should register a once-only abort listener in the fallback path and detach it on completion", async () => {
				const controller = new AbortController()
				const addSpy = vi.spyOn(controller.signal, "addEventListener")
				const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
				const mockFetch = vitest.fn().mockResolvedValue({
					ok: true,
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode('data: {"type":"response.text.delta","delta":"one"}\n\n'),
							)
							controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
							controller.close()
						},
					}),
				})
				global.fetch = mockFetch as typeof fetch
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

				try {
					const chunks = await collectStream(
						handler.createMessage(
							systemPrompt,
							messages,
							makeCreateMessageMetadata({ abortSignal: controller.signal }),
						),
					)

					expect(textChunks(chunks).map((chunk) => chunk.text)).toEqual(["one"])
					// Both bridges (SDK path and fallback) listen for "abort" with
					// { once: true }, and both detach their own listener on completion.
					expect(addSpy).toHaveBeenCalledTimes(2)
					expect(removeSpy).toHaveBeenCalledTimes(2)
					for (const call of addSpy.mock.calls) {
						expect(call[0]).toBe("abort")
						expect(call[2]).toEqual({ once: true })
					}
					const registered = addSpy.mock.calls.map(([, listener]) => listener)
					const removed = removeSpy.mock.calls.map(([type, listener]) => {
						expect(type).toBe("abort")
						return listener
					})
					// Each bridge must detach its own listener exactly once.
					expect(new Set(removed).size).toBe(2)
					expect(new Set(removed)).toEqual(new Set(registered))
					expect(handler["abortController"]).toBeUndefined()
				} finally {
					addSpy.mockRestore()
					removeSpy.mockRestore()
				}
			})

			it("should detach the fallback's external abort listener on completion so a late abort cannot abort the fetch signal", async () => {
				const { openStreams, mockFetch, requireController } = makeOpenStreamFetchMock()
				global.fetch = mockFetch as typeof fetch
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

				const controller = new AbortController()
				const stream = handler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: controller.signal }),
				)
				const collected = collectStream(stream)
				await tick()
				expect(openStreams).toHaveLength(1)

				requireController(0).enqueue(
					new TextEncoder().encode('data: {"type":"response.text.delta","delta":"one"}\n\n'),
				)
				requireController(0).enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
				requireController(0).close()

				const chunks = await collected
				expect(textChunks(chunks).map((chunk) => chunk.text)).toEqual(["one"])

				// A late abort must not reach this request's own fetch signal.
				controller.abort()
				await tick()
				expect(openStreams[0].fetchSignal.aborted).toBe(false)
			})

			it("should surface the contract AbortError once when the fallback stream read rejects on external abort", async () => {
				// Force the fallback path and emulate undici: the body's reader.read()
				// stays pending and rejects with a DOMException AbortError when the
				// request signal aborts. Before the fix, handleStreamResponse wrapped
				// that error in a plain Error (defeating the caller's AbortError guard)
				// and the request was captured as an exception twice.
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))
				let fetchSignal: AbortSignal | undefined
				const mockFetch = vitest.fn().mockImplementation((_url: string, options?: RequestInit) => {
					const signal = options?.signal
					if (!signal) {
						return Promise.reject(new Error("expected the fallback fetch to carry a request signal"))
					}
					fetchSignal = signal
					const body = new ReadableStream<Uint8Array>({
						pull: () => {
							return new Promise((_resolve, reject) => {
								if (signal.aborted) {
									reject(new DOMException("This operation was aborted", "AbortError"))
									return
								}
								signal.addEventListener(
									"abort",
									() => reject(new DOMException("This operation was aborted", "AbortError")),
									{ once: true },
								)
							})
						},
					})
					return Promise.resolve({ ok: true, body })
				})
				global.fetch = mockFetch as typeof fetch

				const controller = new AbortController()
				const collected = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				)
				await tick()
				expect(fetchSignal).toBeDefined()

				// A user stop mid-stream must surface exactly one error, contract-named.
				controller.abort()
				await expect(collected).rejects.toMatchObject({
					name: "AbortError",
					message: "The OpenAI Native request was aborted",
				})
				// The provider must not report a user-triggered stop as an exception.
				expect(mockCaptureException).not.toHaveBeenCalled()
			})

			it("should reject with the contract AbortError when the signal aborts between successive SSE pulls", async () => {
				// Force the fallback path with a body that hands out exactly one SSE
				// chunk and then hangs on the next pull, so only the loop-boundary
				// abort check can settle the stream. Before the fix that check broke
				// out of the loop and createMessage resolved with the partial output
				// instead of surfacing the cancellation.
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))
				const mockFetch = vitest.fn().mockImplementation(() => {
					const encoder = new TextEncoder()
					let pulls = 0
					const body = new ReadableStream<Uint8Array>({
						pull: (streamController) => {
							pulls++
							if (pulls === 1) {
								streamController.enqueue(
									encoder.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'),
								)
								return
							}
							// Never settles: the between-pulls abort check is the only
							// exit for a cancelled consumer.
							return new Promise<void>(() => {})
						},
					})
					return Promise.resolve({ ok: true, body })
				})
				global.fetch = mockFetch as typeof fetch

				const signalController = new AbortController()
				const stream = handler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: signalController.signal }),
				)
				const iterator = stream[Symbol.asyncIterator]()
				const first = await iterator.next()
				expect(first.done).toBe(false)
				expect(first.value).toMatchObject({ type: "text", text: "partial" })

				// The cancellation lands after a chunk was handed out and before the
				// next pull: the loop-boundary check must throw, not break.
				signalController.abort()
				await expect(iterator.next()).rejects.toMatchObject({
					name: "AbortError",
					message: "The OpenAI Native request was aborted",
				})
				expect(mockCaptureException).not.toHaveBeenCalled()
			})

			it("rejects with the contract AbortError when the fallback body closes in the turn the caller aborts", async () => {
				// The loop-boundary check runs before reader.read(), so a done that lands while the
				// cancellation is pending used to end the generator normally: the caller received a
				// completed partial stream for a request it had already stopped. The pull after the
				// first chunk stays parked until this test releases it, which is the turn the abort
				// lands in; releasing it closes the body so read() resolves { done: true }.
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))
				let parkedOnSecondPull = false
				let releaseParkedPull: (() => void) | undefined
				const mockFetch = vitest.fn().mockImplementation(() => {
					const encoder = new TextEncoder()
					let pulls = 0
					const body = new ReadableStream<Uint8Array>({
						pull: (streamController) => {
							pulls++
							if (pulls === 1) {
								streamController.enqueue(
									encoder.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'),
								)
								return
							}
							parkedOnSecondPull = true
							return new Promise<void>((resolve) => {
								releaseParkedPull = () => {
									streamController.close()
									resolve()
								}
							})
						},
					})
					return Promise.resolve({ ok: true, body })
				})
				global.fetch = mockFetch as typeof fetch

				const signalController = new AbortController()
				const stream = handler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: signalController.signal }),
				)
				const iterator = stream[Symbol.asyncIterator]()
				const first = await iterator.next()
				expect(first.done).toBe(false)
				expect(first.value).toMatchObject({ type: "text", text: "partial" })

				// Start the next pull before cancelling, so the abort lands after the loop-boundary
				// check has passed and while read() is pending.
				const pending = iterator.next()
				await tick()
				expect(parkedOnSecondPull).toBe(true)
				signalController.abort()
				releaseParkedPull!()

				await expect(pending).rejects.toMatchObject({
					name: "AbortError",
					message: "The OpenAI Native request was aborted",
				})
				// A stop is not a provider failure to report.
				expect(mockCaptureException).not.toHaveBeenCalled()
			})

			it("cancels the open fallback body and releases the reader lock when the consumer abandons the stream", async () => {
				// Regression evidence for the failed pre-merge check: a consumer that stops early (the
				// stop-button path) must tear the socket down instead of leaving the body open. Nothing
				// here aborts, so the early exit alone has to do the cancelling.
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))
				let cancelCalls = 0
				// One SSE chunk, then the body stays open: no close, no abort, no error.
				const body = new ReadableStream<Uint8Array>({
					start: (streamController) => {
						streamController.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
							),
						)
					},
					cancel: () => {
						cancelCalls++
					},
				})
				const mockFetch = vitest.fn().mockResolvedValue({ ok: true, body })
				global.fetch = mockFetch as typeof fetch

				const stream = handler.createMessage(systemPrompt, messages, makeCreateMessageMetadata())
				const iterator = stream[Symbol.asyncIterator]()
				const first = await iterator.next()
				expect(first.done).toBe(false)
				expect(first.value).toMatchObject({ type: "text", text: "partial" })
				// The provider holds the only reader while the stream is live.
				expect(body.locked).toBe(true)

				// return() on the generator is the abandonment path a stop takes.
				const completed = await iterator.return(undefined)
				expect(completed.done).toBe(true)
				// The body was still open when the consumer stopped, so the finally had to cancel it.
				expect(cancelCalls).toBe(1)
				// A second reader is acquirable only once the lock was released: that is the observable
				// form of "its reader lock is released".
				expect(body.locked).toBe(false)
				expect(() => body.getReader()).not.toThrow()
				// Abandoning a stream is a stop, not a provider failure to report.
				expect(mockCaptureException).not.toHaveBeenCalled()
			})

			it("hands out every event delivered by one pull and only then observes the cancellation", async () => {
				// This row tests the bound the file states in its own comments: cancellation is observed
				// between pulls, never between chunks. One read carries three SSE events, so an abort
				// landing between the yields of that batch must not truncate it, and the next pull is
				// where the cancellation surfaces. Tightening the bound to per-chunk is a maintainer
				// decision, and changing it has to change this row.
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))
				const mockFetch = vitest.fn().mockImplementation(() => {
					const encoder = new TextEncoder()
					let pulls = 0
					const body = new ReadableStream<Uint8Array>({
						pull: (streamController) => {
							pulls++
							if (pulls === 1) {
								streamController.enqueue(
									encoder.encode(
										'data: {"type":"response.output_text.delta","delta":"one"}\n\n' +
											'data: {"type":"response.output_text.delta","delta":"two"}\n\n' +
											'data: {"type":"response.output_text.delta","delta":"three"}\n\n',
									),
								)
								return
							}
							// Never settles: the next pull is where the between-pulls check must fire.
							return new Promise<void>(() => {})
						},
					})
					return Promise.resolve({ ok: true, body })
				})
				global.fetch = mockFetch as typeof fetch

				const signalController = new AbortController()
				const stream = handler.createMessage(
					systemPrompt,
					messages,
					makeCreateMessageMetadata({ abortSignal: signalController.signal }),
				)
				const iterator = stream[Symbol.asyncIterator]()
				const one = await iterator.next()
				expect(one.value).toMatchObject({ type: "text", text: "one" })
				signalController.abort()
				// The rest of the batch was already pulled, so the declared bound hands it out.
				const two = await iterator.next()
				expect(two.done).toBe(false)
				expect(two.value).toMatchObject({ type: "text", text: "two" })
				const three = await iterator.next()
				expect(three.done).toBe(false)
				expect(three.value).toMatchObject({ type: "text", text: "three" })
				// Only the next pull is a cancellation point.
				await expect(iterator.next()).rejects.toMatchObject({
					name: "AbortError",
					message: "The OpenAI Native request was aborted",
				})
				expect(mockCaptureException).not.toHaveBeenCalled()
			})

			it("should not convert a non-abort stream error into an AbortError and keeps the full wrapper", async () => {
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))
				const mockFetch = vitest.fn().mockImplementation(() => {
					const body = new ReadableStream<Uint8Array>({
						pull: () => Promise.reject(new Error("socket hang up")),
					})
					return Promise.resolve({ ok: true, body })
				})
				global.fetch = mockFetch as typeof fetch

				// A status-less stream failure takes the wrapping path. Capture the rejection so
				// both halves of the contract are pinned: a mutation that skips the wrapper (e.g.
				// forcing hasNumericHttpStatus() to true) fails the message, and a mutation that
				// renames the failure to the cancellation contract fails the name.
				const error = await collectStream(handler.createMessage(systemPrompt, messages)).then(
					() => undefined,
					(e: unknown) => e,
				)
				expect(error).toBeInstanceOf(Error)
				expect((error as Error).name).toBe("Error")
				expect((error as Error).message).toBe(
					"Failed to connect to Responses API: Error processing response stream: socket hang up",
				)
			})

			it("should keep a status-carrying API failure that races the caller's abort", async () => {
				// A 429 can land in the same tick the caller's signal aborts. Reporting
				// it as a cancellation would hide the provider error and its retry
				// hints, so the failure keeps its status and message.
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))
				const rateLimited = Object.assign(new Error("Rate limit exceeded"), { status: 429 })
				let releaseStream!: () => void
				const streamGate = new Promise<void>((resolve) => {
					releaseStream = resolve
				})
				let pullStarted = false
				const mockFetch = vitest.fn().mockImplementation(() => {
					const body = new ReadableStream<Uint8Array>({
						pull: async () => {
							pullStarted = true
							await streamGate
							throw rateLimited
						},
					})
					return Promise.resolve({ ok: true, body })
				})
				global.fetch = mockFetch as typeof fetch

				const controller = new AbortController()
				const collected = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				)
				// Abort first, then let the stream fail: the failure is the real outcome.
				// Observable: the reader has entered pull and is parked on the gate. Polling it, then
				// flushing one macrotask so the pending read is registered, replaces the fixed 10ms sleep.
				await vi.waitUntil(() => pullStarted, { timeout: 2000, interval: 10 })
				await flushMacrotasks()
				controller.abort()
				releaseStream()

				const error = await collected.then(
					() => undefined,
					(e: unknown) => e,
				)
				// The exact stream failure object must reach the caller unchanged (same
				// reference): retry/backoff read its status, so a wrapper or clone that
				// copies status and message would silently break them.
				expect(error).toBe(rateLimited)
			})

			it("should not let an earlier request's external abort affect a later request on the same handler", async () => {
				// Request 1 streams under external signal A while request 2 starts under
				// external signal B. Aborting A while both are in flight must abort only
				// request 1's request-local controller; request 2 completes normally.
				const firstExternal = new AbortController()
				const secondExternal = new AbortController()
				let firstGateOpen: (() => void) | undefined
				const firstGate = new Promise<void>((resolve) => {
					firstGateOpen = resolve
				})
				let firstSdkSignal: AbortSignal | undefined
				let secondSdkSignal: AbortSignal | undefined
				let secondStreamFinished = false
				let secondGateOpen: (() => void) | undefined
				const secondGate = new Promise<void>((resolve) => {
					secondGateOpen = resolve
				})
				let sdkCalls = 0
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					sdkCalls += 1
					if (sdkCalls === 1) {
						firstSdkSignal = options?.signal
						return Promise.resolve(
							(async function* () {
								yield { type: "response.output_text.delta", delta: "one" }
								await firstGate
							})(),
						)
					}
					secondSdkSignal = options?.signal
					return Promise.resolve(
						(async function* () {
							yield { type: "response.output_text.delta", delta: "two-a" }
							yield { type: "response.output_text.delta", delta: " two-b" }
							// Hold the stream open until the abort below has been observed, so the signal
							// assertions run while this request is genuinely in flight.
							await secondGate
							secondStreamFinished = true
						})(),
					)
				})

				const collected1 = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: firstExternal.signal }),
					),
				)
				await tick()
				expect(firstSdkSignal).toBeDefined()

				const collected2 = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: secondExternal.signal }),
					),
				)
				await tick()
				expect(secondSdkSignal).toBeDefined()

				// Abort the first request's external signal while the second is in flight.
				firstExternal.abort()
				await tick()
				expect(firstSdkSignal?.aborted).toBe(true)
				expect(secondSdkSignal?.aborted).toBe(false)
				// Liveness proof for the two assertions above: with an ungated stream this
				// second request can drain during the ticks, and the same signal assertions would
				// pass even if the first request's abort leaked into it.
				expect(secondStreamFinished).toBe(false)

				// The second request completes normally with its own content.
				secondGateOpen?.()

				const chunks2 = await collected2
				expect(textChunks(chunks2).map((chunk) => chunk.text)).toEqual(["two-a", " two-b"])
				expect(secondExternal.signal.aborted).toBe(false)

				// Let the first request wind down: it is the aborted one, so it hands back
				// the contract AbortError rather than ending as a partial stream.
				if (!firstGateOpen) {
					throw new Error("expected the first stream gate to be ready")
				}
				firstGateOpen()
				await expect(collected1).rejects.toMatchObject({
					name: "AbortError",
					message: "The OpenAI Native request was aborted",
				})
			})

			it("should not issue a fallback POST when the SDK request was aborted by this request's own signal", async () => {
				// Regression: the SDK catch path used to fall through to the manual SSE
				// fallback for every error, including the AbortError raised when this
				// request's own controller aborted — issuing a second POST for a request
				// the caller already cancelled.
				const mockFetch = vitest.fn()
				global.fetch = mockFetch as typeof fetch
				const controller = new AbortController()
				let sdkSignal: AbortSignal | undefined
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					sdkSignal = options?.signal
					// Emulate the SDK: an aborted in-flight request rejects with AbortError.
					return new Promise((_resolve, reject) => {
						if (!sdkSignal) {
							reject(new Error("expected the SDK request to carry a request signal"))
							return
						}
						if (sdkSignal.aborted) {
							reject(makeAbortError())
							return
						}
						sdkSignal.addEventListener("abort", () => reject(makeAbortError()), { once: true })
					})
				})

				const collected = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				)
				await tick()
				expect(sdkSignal).toBeDefined()
				expect(sdkSignal?.aborted).toBe(false)

				controller.abort()
				await expect(collected).rejects.toMatchObject({ name: "AbortError" })

				// The fallback must not run: a cancelled request must not trigger a second POST.
				expect(mockFetch).not.toHaveBeenCalled()
			})

			it("should normalize SDK APIUserAbortError without entering the fallback when the request's own signal aborts", async () => {
				// Regression: the SDK catch path only recognized native AbortErrors, so the
				// OpenAI SDK's own APIUserAbortError fell through into the manual SSE
				// fallback — an unnecessary fallback path for a request the caller already
				// cancelled.
				const mockFetch = vitest.fn().mockImplementation((_url: unknown, options: { signal?: AbortSignal }) => {
					if (options?.signal?.aborted) {
						const error = new Error("This operation was aborted")
						error.name = "AbortError"
						return Promise.reject(error)
					}
					return new Promise(() => undefined)
				})
				global.fetch = mockFetch as typeof fetch
				const controller = new AbortController()
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					return new Promise((_resolve, reject) => {
						const error = new Error("Request was aborted.")
						error.name = "APIUserAbortError"
						if (options?.signal?.aborted) {
							reject(error)
							return
						}
						options?.signal?.addEventListener("abort", () => reject(error), { once: true })
					})
				})

				const collected = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				)
				await tick()
				controller.abort()

				await expect(collected).rejects.toMatchObject({
					name: "AbortError",
					message: "The OpenAI Native request was aborted",
				})
				expect(mockFetch).not.toHaveBeenCalled()
			})

			it("should not take the fallback when the request's own signal aborted even if the SDK error is not a cancellation", async () => {
				// A cancelled request must not start fallback work. The SDK can fail with a terminal
				// error in the same tick the caller aborts; the catch path reports the cancellation
				// contract and never issues the second POST the fallback would make.
				const mockFetch = vitest.fn()
				global.fetch = mockFetch as typeof fetch
				const controller = new AbortController()
				const terminalError = new Error("SDK connection reset")
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					return new Promise((_resolve, reject) => {
						if (options?.signal?.aborted) {
							reject(terminalError)
							return
						}
						options?.signal?.addEventListener("abort", () => reject(terminalError), { once: true })
					})
				})

				const collected = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				)
				await tick()
				controller.abort()

				await expect(collected).rejects.toMatchObject({
					name: "AbortError",
					message: "The OpenAI Native request was aborted",
				})
				// No fallback POST for a cancelled request, even though the SDK failure was terminal.
				expect(mockFetch).not.toHaveBeenCalled()
			})

			it("should keep a terminal status-carrying SDK error that races the caller's abort", async () => {
				// A 429 can land in the same tick the caller cancels: the numeric status is what
				// retry, backoff and the UI read, so it is propagated (no fallback POST either).
				const mockFetch = vitest.fn()
				global.fetch = mockFetch as typeof fetch
				const controller = new AbortController()
				const rateLimited = Object.assign(new Error("Rate limit exceeded"), { status: 429 })
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					return new Promise((_resolve, reject) => {
						if (options?.signal?.aborted) {
							reject(rateLimited)
							return
						}
						options?.signal?.addEventListener("abort", () => reject(rateLimited), { once: true })
					})
				})

				const collected = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				)
				await tick()
				controller.abort()

				const error = await collected.then(
					() => undefined,
					(e: unknown) => e,
				)
				// The exact SDK error object must reach the caller unchanged (same reference):
				// retry/backoff read its status, so a wrapper or clone would break them.
				expect(error).toBe(rateLimited)
				expect(mockFetch).not.toHaveBeenCalled()
				// The terminal failure is captured once for provider telemetry before the
				// original error object is propagated: an abort-raced 429 must not vanish
				// from error reporting just because the abort won the race.
				expect(mockCaptureException).toHaveBeenCalledTimes(1)
				expect(mockCaptureException).toHaveBeenCalledWith(expect.any(ApiProviderError))
				// The attribution is the reason for capturing it: retry and the error surface read
				// operation, so an empty or missing one has to fail here rather than pass quietly.
				expect(mockCaptureException.mock.calls[0]?.[0]).toMatchObject({ operation: "createMessage" })
			})

			it("propagates the original SDK error when the abort-race telemetry capture itself throws", async () => {
				// The capture sits between the status branch and the rethrow, so a throwing telemetry
				// client (or an uninitialized singleton getter) must not become the error the caller
				// sees: the guard contains it and the exact SDK object still propagates.
				const mockFetch = vitest.fn()
				global.fetch = mockFetch as typeof fetch
				const controller = new AbortController()
				const rateLimited = Object.assign(new Error("Rate limit exceeded"), { status: 429 })
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					return new Promise((_resolve, reject) => {
						options?.signal?.addEventListener("abort", () => reject(rateLimited), { once: true })
					})
				})
				// Force the guarded path: the capture throws once, on the way to the rethrow.
				mockCaptureException.mockImplementationOnce(() => {
					throw new Error("Telemetry client unavailable")
				})

				const collected = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				)
				await tick()
				controller.abort()

				const error = await collected.then(
					() => undefined,
					(e: unknown) => e,
				)
				// Not the telemetry failure and not a wrapper: the SDK object retry needs to read.
				expect(error).toBe(rateLimited)
				// Containment is not suppression: the failure still has to be reported.
				expect(mockCaptureException).toHaveBeenCalledTimes(1)
				expect(mockFetch).not.toHaveBeenCalled()
			})

			it("keeps the provider's own error text out of the abort-race telemetry capture", async () => {
				// A 400 body can echo request content — an address, a prompt fragment — and the
				// telemetry client forwards error.message to PostHog, so an abort-raced failure
				// must be reported as fixed text plus the numeric status, never as its own text.
				const mockFetch = vitest.fn()
				global.fetch = mockFetch as typeof fetch
				const controller = new AbortController()
				const sensitiveText = "400 Invalid request: someone@example.com sent 120000 tokens"
				const leaky = Object.assign(new Error(sensitiveText), { status: 400 })
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					return new Promise((_resolve, reject) => {
						if (options?.signal?.aborted) {
							reject(leaky)
							return
						}
						options?.signal?.addEventListener("abort", () => reject(leaky), { once: true })
					})
				})

				const collected = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				)
				await tick()
				controller.abort()

				const error = await collected.then(
					() => undefined,
					(e: unknown) => e,
				)
				// The caller still receives the provider's own object, provider text included.
				expect(error).toBe(leaky)
				expect(mockFetch).not.toHaveBeenCalled()
				expect(mockCaptureException).toHaveBeenCalledTimes(1)
				const [captured] = mockCaptureException.mock.calls[0] ?? []
				const capturedError = captured instanceof ApiProviderError ? captured : undefined
				expect(capturedError).toBeDefined()
				expect(capturedError?.message).toBe(
					"OpenAI Native createMessage request failed with a status-bearing error after the caller aborted",
				)
				expect(capturedError?.message).not.toContain("someone@example.com")
				expect(capturedError?.errorCode).toBe(400)
			})

			it("should keep a streaming request's controller when completePrompt uses its own signal", async () => {
				// completePrompt is a request-local signal path: it must not take over or clear the
				// controller owned by an in-flight createMessage on the same handler, and aborting
				// the completion signal must not cancel the stream.
				const streamExternal = new AbortController()
				const completeExternal = new AbortController()
				let streamSdkSignal: AbortSignal | undefined
				let completeSdkSignal: AbortSignal | undefined
				let releaseStream!: () => void
				const streamGate = new Promise<void>((resolve) => {
					releaseStream = resolve
				})
				mockResponsesCreate.mockImplementationOnce((_body: unknown, options: { signal?: AbortSignal }) => {
					streamSdkSignal = options?.signal
					return Promise.resolve(
						(async function* () {
							yield { type: "response.output_text.delta", delta: "one" }
							await streamGate
							yield { type: "response.output_text.delta", delta: " two" }
						})(),
					)
				})
				mockResponsesCreate.mockImplementationOnce((_body: unknown, options: { signal?: AbortSignal }) => {
					completeSdkSignal = options?.signal
					return Promise.resolve({
						output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
					})
				})

				const streaming = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: streamExternal.signal }),
					),
				)
				await tick()
				expect(streamSdkSignal).toBeDefined()

				const completion = await handler.completePrompt("prompt", {
					abortSignal: completeExternal.signal,
				})
				expect(completion).toBe("done")
				// The completion used its own request signal, not the streaming request's.
				expect(completeSdkSignal).toBeDefined()
				expect(completeSdkSignal).not.toBe(streamSdkSignal)
				expect(completion === "done" && streamSdkSignal?.aborted).toBe(false)
				// The streaming request still owns the handler's controller.
				expect(handler["abortController"]?.signal).toBe(streamSdkSignal)

				// Aborting the completion signal after the fact must not cancel the stream.
				completeExternal.abort()
				expect(streamSdkSignal?.aborted).toBe(false)

				releaseStream()
				const chunks = await streaming
				expect(textChunks(chunks).map((chunk) => chunk.text)).toEqual(["one", " two"])
			})

			it("should rethrow a native AbortError from the SDK as-is instead of normalizing it", async () => {
				// Regression guard for the name check: a native AbortError from the SDK must
				// be rethrown as-is, not replaced by the normalized contract error.
				const mockFetch = vitest.fn()
				global.fetch = mockFetch as typeof fetch
				const controller = new AbortController()
				const nativeError = new Error("socket closed by abort")
				nativeError.name = "AbortError"
				mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
					return new Promise((_resolve, reject) => {
						if (options?.signal?.aborted) {
							reject(nativeError)
							return
						}
						options?.signal?.addEventListener("abort", () => reject(nativeError), { once: true })
					})
				})

				const collected = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					),
				)
				await tick()
				controller.abort()

				await expect(collected).rejects.toBe(nativeError)
				expect(mockFetch).not.toHaveBeenCalled()
			})

			it("should cancel only the aborted fallback body when overlapping requests share a handler", async () => {
				// Regression: the SSE loop gated on the shared this.abortController
				// field, so with two overlapping fallback reads an abort of one
				// request's signal could terminate (or be ignored by) the other
				// request's stream. Each request must react only to its own
				// request-local controller, and the aborted request's body must be
				// cancelled before the reader lock is released so the socket is
				// torn down.
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

				const firstExternal = new AbortController()
				const secondExternal = new AbortController()
				let firstReadSettled = false
				const cancelCalls = [false, false]
				let fetchCall = 0
				const mockFetch = vitest.fn().mockImplementation(() => {
					fetchCall += 1
					if (fetchCall === 1) {
						// First request's body: one chunk now, then a pull that stays
						// pending until this request's external signal aborts, where it
						// enqueues an empty [DONE] chunk so the loop's next per-request
						// abort check is the only exit.
						const body = new ReadableStream<Uint8Array>({
							start: (startController) => {
								startController.enqueue(
									new TextEncoder().encode('data: {"type":"response.text.delta","delta":"one"}\n\n'),
								)
							},
							pull: (pullController) =>
								new Promise<void>((resolve) => {
									const onAbort = () => {
										if (!firstReadSettled) {
											firstReadSettled = true
											pullController.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
										}
										resolve()
									}
									if (firstExternal.signal.aborted) {
										onAbort()
										return
									}
									firstExternal.signal.addEventListener("abort", onAbort, { once: true })
								}),
							cancel: () => {
								cancelCalls[0] = true
							},
						})
						return Promise.resolve({ ok: true, body })
					}
					// Second request's body: completes normally.
					const body = new ReadableStream<Uint8Array>({
						start: (startController) => {
							startController.enqueue(
								new TextEncoder().encode('data: {"type":"response.text.delta","delta":"two"}\n\n'),
							)
							startController.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
							startController.close()
						},
						cancel: () => {
							cancelCalls[1] = true
						},
					})
					return Promise.resolve({ ok: true, body })
				})
				global.fetch = mockFetch as typeof fetch

				const collected1 = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: firstExternal.signal }),
					),
				)
				await tick()
				const collected2 = collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: secondExternal.signal }),
					),
				)
				await tick()

				// Abort only the first request's signal while both fallback reads are open.
				firstExternal.abort()

				// The second request must complete normally with its own content and
				// must not have its body cancelled.
				const chunks2 = await collected2
				expect(textChunks(chunks2).map((chunk) => chunk.text)).toEqual(["two"])
				expect(secondExternal.signal.aborted).toBe(false)
				expect(cancelCalls[1]).toBe(false)

				// The first request reacts to its own abort: once the pending read
				// settles, the loop-boundary check throws the contract AbortError (a
				// cancelled request must not resolve with its partial output), and its
				// body is cancelled before the lock is released. No second POST is
				// issued for the aborted request.
				await expect(collected1).rejects.toMatchObject({
					name: "AbortError",
					message: "The OpenAI Native request was aborted",
				})
				expect(cancelCalls[0]).toBe(true)
				expect(fetchCall).toBe(2)
			})

			it("should carry the numeric status on a synthesized non-2xx fallback error", async () => {
				// The fallback used to throw a plain Error for non-2xx responses, so retry,
				// backoff and the UI — which read the numeric status, not the message text —
				// saw a generic failure for every provider error.
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))
				const mockFetch = vitest.fn().mockResolvedValue({
					ok: false,
					status: 418,
					text: async () => "teapot body",
				})
				global.fetch = mockFetch as typeof fetch

				const error = await collectStream(
					handler.createMessage(
						systemPrompt,
						messages,
						makeCreateMessageMetadata({ abortSignal: new AbortController().signal }),
					),
				).then(
					() => undefined,
					(e: unknown) => e,
				)
				expect(error).toMatchObject({ status: 418 })
				expect((error as Error).message).toContain("418")
				// Captured exactly once through the provider telemetry path.
				expect(mockCaptureException).toHaveBeenCalledTimes(1)
			})
		})
	})

	describe("completePrompt", () => {
		it("should handle non-streaming completion using Responses API", async () => {
			// Mock the responses.create method to return a non-streaming response
			mockResponsesCreate.mockResolvedValue({
				output: [
					{
						type: "message",
						content: [
							{
								type: "output_text",
								text: "This is the completion response",
							},
						],
					},
				],
			})

			const result = await handler.completePrompt("Test prompt")

			expect(result).toBe("This is the completion response")
			expect(mockResponsesCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "gpt-4.1",
					stream: false,
					store: false,
					input: [
						{
							role: "user",
							content: [{ type: "input_text", text: "Test prompt" }],
						},
					],
				}),
				expect.objectContaining({
					signal: expect.any(Object),
				}),
			)
		})

		it.each(serviceTiers)("should include the selected %s service tier", async (serviceTier) => {
			mockResponsesCreate.mockResolvedValue({ output: [] })
			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.6-sol",
				openAiNativeServiceTier: serviceTier,
			})

			await handler.completePrompt("Test prompt")

			expect(mockResponsesCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					stream: false,
					[SERVICE_TIER_KEY]: serviceTier,
				}),
				expect.any(Object),
			)
		})

		it("should omit the service tier when none is configured", async () => {
			mockResponsesCreate.mockResolvedValue({ output: [] })

			await handler.completePrompt("Test prompt")

			const [request] = mockResponsesCreate.mock.calls[0]
			expect(request.stream).toBe(false)
			expect(request).not.toHaveProperty(SERVICE_TIER_KEY)
		})

		it("should omit a configured service tier that the model does not support", async () => {
			mockResponsesCreate.mockResolvedValue({ output: [] })
			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.3-chat-latest",
				openAiNativeServiceTier: OpenAiServiceTier.Priority,
			})

			await handler.completePrompt("Test prompt")

			const [request] = mockResponsesCreate.mock.calls[0]
			expect(request.stream).toBe(false)
			expect(request).not.toHaveProperty(SERVICE_TIER_KEY)
		})

		it("should handle SDK errors in completePrompt", async () => {
			// Mock SDK to throw an error
			mockResponsesCreate.mockRejectedValue(new Error("API Error"))

			await expect(handler.completePrompt("Test prompt")).rejects.toThrow(
				"OpenAI Native completion error: API Error",
			)
		})

		it("should return empty string when no text in response", async () => {
			// Mock the responses.create method to return a response without text
			mockResponsesCreate.mockResolvedValue({
				output: [
					{
						type: "message",
						content: [],
					},
				],
			})

			const result = await handler.completePrompt("Test prompt")

			expect(result).toBe("")
		})
		it("should pass the external abort signal through to the SDK request", async () => {
			mockResponsesCreate.mockResolvedValue({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "response" }],
					},
				],
			})

			const controller = new AbortController()
			await handler.completePrompt("Test prompt", { abortSignal: controller.signal })

			// Without a timeout the merged signal is the external signal itself
			expect(mockResponsesCreate.mock.calls[0][1].signal).toBe(controller.signal)
		})

		it("should work without options (backward compatible)", async () => {
			mockResponsesCreate.mockResolvedValue({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "response" }],
					},
				],
			})

			const result = await handler.completePrompt("Test prompt")

			expect(result).toBe("response")
			expect(mockResponsesCreate.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
		})

		it("completePrompt should abort its request signal when timeoutMs is reached", async () => {
			// Node's AbortSignal.timeout() uses internal timers that vi.useFakeTimers() does not
			// intercept, so this relies on a short real timeout instead of fake timers.
			let requestSignal: AbortSignal | undefined
			let requestTimeoutOption: number | undefined
			mockResponsesCreate.mockImplementationOnce(
				async (_body: unknown, options: { signal?: AbortSignal; timeout?: number }) => {
					requestSignal = options.signal
					requestTimeoutOption = options.timeout
					// Stay pending until the merged timeout signal aborts the request
					await new Promise<void>((resolve) => {
						options.signal?.addEventListener("abort", () => resolve(), { once: true })
					})
					return {
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: "response" }],
							},
						],
					}
				},
			)

			const result = await handler.completePrompt("Test prompt", { timeoutMs: 50 })

			expect(result).toBe("response")
			expect(requestSignal).toBeInstanceOf(AbortSignal)
			expect(requestSignal?.aborted).toBe(true)
			// The SDK must receive the requested deadline as its own per-request timeout
			// option too: without it the SDK aborts each attempt at the client default and
			// a completion that needs longer fails before the caller’s deadline.
			expect(requestTimeoutOption).toBe(50)
		})

		it("completePrompt should report a deadline as TimeoutError rather than AbortError", async () => {
			// The locked SDK surfaces its own abort error once the request signal aborts; a deadline that
			// fired must not be reported as a caller stop.
			mockResponsesCreate.mockImplementationOnce(async (_body: unknown, options: { signal?: AbortSignal }) => {
				await new Promise<void>((resolve) => {
					options.signal?.addEventListener("abort", () => resolve(), { once: true })
				})
				const abortLike = new Error("Request was aborted.")
				abortLike.name = "APIUserAbortError"
				throw abortLike
			})

			await expect(handler.completePrompt("Test prompt", { timeoutMs: 50 })).rejects.toMatchObject({
				name: "TimeoutError",
				// Assert the full message too: name-only passes even if the phase is
				// wrong, and the phase is what separates a completion deadline from a
				// discovery deadline for callers.
				message: "The OpenAI Native completion request timed out",
			})
		})
		it("completePrompt should merge the external signal and timeoutMs together", async () => {
			const controller = new AbortController()
			mockResponsesCreate.mockResolvedValue({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "response" }],
					},
				],
			})

			await handler.completePrompt("Test prompt", { abortSignal: controller.signal, timeoutMs: 10000 })

			const mergedSignal = mockResponsesCreate.mock.calls[0][1].signal as AbortSignal
			expect(mergedSignal).toBeInstanceOf(AbortSignal)

			// Aborting the external signal must abort the merged signal synchronously
			controller.abort()
			expect(mergedSignal.aborted).toBe(true)
		})

		it("completePrompt should normalize an SDK AbortError when no options are passed", async () => {
			// With no options the request signal is a fresh controller whose reason is
			// undefined: the optional guard on the reason read must hold, and the SDK’s
			// own AbortError must still normalize to the contract error.
			mockResponsesCreate.mockImplementationOnce(async () => {
				const abortError = new Error("socket closed by abort")
				abortError.name = "AbortError"
				throw abortError
			})

			await expect(handler.completePrompt("Test prompt")).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenAI Native request was aborted",
			})
		})

		it("completePrompt should reject with AbortError when the abortSignal is already aborted", async () => {
			mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
				if (options?.signal?.aborted) {
					const error = new Error("This operation was aborted")
					error.name = "AbortError"
					return Promise.reject(error)
				}
				return Promise.resolve({
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: "response" }],
						},
					],
				})
			})

			const controller = new AbortController()
			controller.abort()

			await expect(
				handler.completePrompt("Test prompt", { abortSignal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
			})
		})

		it("completePrompt should normalize SDK APIUserAbortError to the contract AbortError without telemetry", async () => {
			// The locked OpenAI SDK raises APIUserAbortError (message
			// "Request was aborted.") instead of a native AbortError when the
			// request signal aborts. Cancellations must surface as the contract
			// AbortError and must never be captured as provider telemetry.
			let sdkRequestStarted = false
			mockResponsesCreate.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
				return new Promise((_resolve, reject) => {
					sdkRequestStarted = true
					const error = new Error("Request was aborted.")
					error.name = "APIUserAbortError"
					if (options?.signal?.aborted) {
						reject(error)
						return
					}
					options?.signal?.addEventListener("abort", () => reject(error), { once: true })
				})
			})

			const controller = new AbortController()
			const pending = handler.completePrompt("Test prompt", { abortSignal: controller.signal })
			// Observable: the SDK call has been issued with the request signal, so the abort now
			// arrives mid-request instead of after a wall-clock delay.
			await vi.waitUntil(() => sdkRequestStarted, { timeout: 2000, interval: 25 })
			controller.abort()

			await expect(pending).rejects.toMatchObject({
				name: "AbortError",
				message: "The OpenAI Native request was aborted",
			})
			expect(mockCaptureException).not.toHaveBeenCalled()
		})
		it("completePrompt should not reclassify a terminal SDK error as a cancellation when the signal aborts", async () => {
			// Regression: classifying cancellation from requestSignal instead of the
			// error let a signal that aborts after a terminal SDK error convert that
			// error into an AbortError and skip telemetry.
			mockResponsesCreate.mockRejectedValue(new Error("API Error"))
			const controller = new AbortController()
			controller.abort()

			await expect(handler.completePrompt("Test prompt", { abortSignal: controller.signal })).rejects.toThrow(
				"OpenAI Native completion error: API Error",
			)
			expect(mockCaptureException).toHaveBeenCalledTimes(1)
		})

		it("completePrompt should rethrow non-Error failures after telemetry", async () => {
			mockResponsesCreate.mockRejectedValue("string failure")

			await expect(handler.completePrompt("Test prompt")).rejects.toBe("string failure")
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "string failure",
					provider: "OpenAI Native",
					modelId: "gpt-4.1",
					operation: "completePrompt",
				}),
			)
		})

		it("completePrompt should return direct response text fallback", async () => {
			mockResponsesCreate.mockResolvedValue({ text: "fallback response" })

			const result = await handler.completePrompt("Test prompt")

			expect(result).toBe("fallback response")
		})

		it("completePrompt should include supported service tier, reasoning, verbosity, and prompt cache retention", async () => {
			const configuredHandler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.1",
				openAiNativeServiceTier: "flex",
				enableResponsesReasoningSummary: true,
			})
			mockResponsesCreate.mockResolvedValue({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "response" }],
					},
				],
			})

			await configuredHandler.completePrompt("Test prompt")

			const requestBody = mockResponsesCreate.mock.calls[0][0]
			expect(requestBody.service_tier).toBe("flex")
			expect(requestBody.include).toEqual(["reasoning.encrypted_content"])
			expect(requestBody.reasoning).toEqual({ effort: "medium", summary: "auto" })
			expect(requestBody.text).toEqual({ verbosity: "medium" })
			expect(requestBody.prompt_cache_retention).toBe("24h")
		})

		it("should expose response id and encrypted reasoning content", () => {
			handler["lastResponseId"] = "resp_123"
			handler["lastResponseOutput"] = [
				{ type: "message" },
				{ type: "reasoning", encrypted_content: "encrypted", id: "reasoning_1" },
			]

			expect(handler.getResponseId()).toBe("resp_123")
			expect(handler.getEncryptedContent()).toEqual({ encrypted_content: "encrypted", id: "reasoning_1" })
		})

		it("should return undefined when encrypted reasoning content is absent", () => {
			expect(handler.getEncryptedContent()).toBeUndefined()

			handler["lastResponseOutput"] = [{ type: "reasoning" }]

			expect(handler.getEncryptedContent()).toBeUndefined()
		})

		it("should scope the prompt_cache_key to the handler session", async () => {
			mockResponsesCreate.mockResolvedValue({ output: [] })

			await handler.completePrompt("Test prompt")

			const [request] = mockResponsesCreate.mock.calls[0]
			expect(request.prompt_cache_key).toBe(handler["sessionId"])
			expect(request.prompt_cache_key).toEqual(expect.any(String))
		})

		it("should omit the prompt_cache_key when the model does not support prompt caching", async () => {
			mockResponsesCreate.mockResolvedValue({ output: [] })
			handler = new OpenAiNativeHandler({ ...mockOptions, apiModelId: "codex-mini-latest" })

			await handler.completePrompt("Test prompt")

			const [request] = mockResponsesCreate.mock.calls[0]
			expect(request).not.toHaveProperty("prompt_cache_key")
		})
	})

	describe("getModel", () => {
		it("should return model info", () => {
			const modelInfo = handler.getModel()
			expect(modelInfo.id).toBe(mockOptions.apiModelId)
			expect(modelInfo.info).toBeDefined()
			expect(modelInfo.info.maxTokens).toBe(32768)
			expect(modelInfo.info.contextWindow).toBe(1047576)
		})

		it("should return GPT-5.3 Codex model info when selected", () => {
			const codexHandler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.3-codex",
			})

			const modelInfo = codexHandler.getModel()
			expect(modelInfo.id).toBe("gpt-5.3-codex")
			expect(modelInfo.info.maxTokens).toBe(128000)
			expect(modelInfo.info.contextWindow).toBe(400000)
			expect(modelInfo.info.supportsReasoningEffort).toEqual(["low", "medium", "high", "xhigh"])
		})

		it("should return GPT-5.5 model info when selected", () => {
			const gpt55Handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.5",
			})

			const modelInfo = gpt55Handler.getModel()
			expect(modelInfo.id).toBe("gpt-5.5")
			expect(modelInfo.info.maxTokens).toBe(128000)
			expect(modelInfo.info.contextWindow).toBe(1_050_000)
			expect(modelInfo.info.supportsVerbosity).toBe(true)
			expect(modelInfo.info.supportsReasoningEffort).toEqual(["none", "low", "medium", "high", "xhigh"])
			expect(modelInfo.info.reasoningEffort).toBe("medium")
		})

		it("should return GPT-5.4 model info when selected", () => {
			const gpt54Handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.4",
			})

			const modelInfo = gpt54Handler.getModel()
			expect(modelInfo.id).toBe("gpt-5.4")
			expect(modelInfo.info.maxTokens).toBe(128000)
			expect(modelInfo.info.contextWindow).toBe(1_050_000)
			expect(modelInfo.info.supportsVerbosity).toBe(true)
			expect(modelInfo.info.supportsReasoningEffort).toEqual(["none", "low", "medium", "high", "xhigh"])
			expect(modelInfo.info.reasoningEffort).toBe("none")
		})

		it("should return GPT-5.4 Mini model info when selected", () => {
			const gpt54MiniHandler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.4-mini",
			})

			const modelInfo = gpt54MiniHandler.getModel()
			expect(modelInfo.id).toBe("gpt-5.4-mini")
			expect(modelInfo.info.maxTokens).toBe(128000)
			expect(modelInfo.info.contextWindow).toBe(400000)
			expect(modelInfo.info.supportsVerbosity).toBe(true)
			expect(modelInfo.info.supportsReasoningEffort).toEqual(["none", "low", "medium", "high", "xhigh"])
			expect(modelInfo.info.reasoningEffort).toBe("none")
			expect(modelInfo.info.longContextPricing).toBeUndefined()
		})

		it("should return GPT-5.4 Nano model info when selected", () => {
			const gpt54NanoHandler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.4-nano",
			})

			const modelInfo = gpt54NanoHandler.getModel()
			expect(modelInfo.id).toBe("gpt-5.4-nano")
			expect(modelInfo.info.maxTokens).toBe(128000)
			expect(modelInfo.info.contextWindow).toBe(400000)
			expect(modelInfo.info.supportsVerbosity).toBe(true)
			expect(modelInfo.info.supportsReasoningEffort).toEqual(["none", "low", "medium", "high", "xhigh"])
			expect(modelInfo.info.reasoningEffort).toBe("none")
			expect(modelInfo.info.outputPrice).toBe(1.25)
			expect(modelInfo.info.longContextPricing).toBeUndefined()
			expect(modelInfo.info.tiers).toEqual([
				expect.objectContaining({
					name: OpenAiServiceTier.Flex,
					outputPrice: 0.625,
				}),
			])
		})

		it("should return GPT-5.3 Chat model info when selected", () => {
			const chatHandler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.3-chat-latest",
			})

			const modelInfo = chatHandler.getModel()
			expect(modelInfo.id).toBe("gpt-5.3-chat-latest")
			expect(modelInfo.info.maxTokens).toBe(16_384)
			expect(modelInfo.info.contextWindow).toBe(128000)
			expect(modelInfo.info.supportsImages).toBe(true)
		})

		it("should handle undefined model ID", () => {
			const handlerWithoutModel = new OpenAiNativeHandler({
				openAiNativeApiKey: "test-api-key",
			})
			const modelInfo = handlerWithoutModel.getModel()
			expect(modelInfo.id).toBe("gpt-5.6-sol") // Default model
			expect(modelInfo.info).toBeDefined()
		})
	})

	describe("GPT-5 models", () => {
		it("should handle GPT-5 model with Responses API", async () => {
			// Mock fetch for Responses API
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						// Simulate actual GPT-5 Responses API SSE stream format
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.created","response":{"id":"test","status":"in_progress"}}\n\n',
							),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"Hello"}}\n\n',
							),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":" world"}}\n\n',
							),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.done","response":{"usage":{"prompt_tokens":10,"completion_tokens":2}}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail so it uses fetch
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.1",
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify Responses API is called with correct parameters
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"Content-Type": "application/json",
						Authorization: "Bearer test-api-key",
					}),
					body: expect.any(String),
				}),
			)
			const body1 = (mockFetch.mock.calls[0][1] as any).body as string
			const parsedBody = JSON.parse(body1)
			expect(parsedBody.model).toBe("gpt-5.1")
			expect(parsedBody.instructions).toBe("You are a helpful assistant.")
			// Now using structured format with content arrays (no system prompt in input; it's provided via `instructions`)
			expect(parsedBody.input).toEqual([
				{
					role: "user",
					content: [{ type: "input_text", text: "Hello!" }],
				},
			])
			expect(parsedBody.reasoning?.effort).toBe("medium")
			expect(parsedBody.reasoning?.summary).toBe("auto")
			expect(parsedBody.text?.verbosity).toBe("medium")
			// GPT-5 models don't include temperature
			expect(parsedBody.temperature).toBeUndefined()
			expect(parsedBody.max_output_tokens).toBeDefined()

			// Verify the streamed content
			const textChunks = chunks.filter((c) => c.type === "text")
			expect(textChunks).toHaveLength(2)
			expect(textChunks[0].text).toBe("Hello")
			expect(textChunks[1].text).toBe(" world")
		})

		it("should handle GPT-5.5 model with Responses API", async () => {
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"GPT-5.5 reply"}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.5",
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.objectContaining({
					body: expect.any(String),
				}),
			)
			const body = (mockFetch.mock.calls[0][1] as any).body as string
			const parsedBody = JSON.parse(body)
			expect(parsedBody.model).toBe("gpt-5.5")
			expect(parsedBody.max_output_tokens).toBe(128000)
			expect(parsedBody.temperature).toBeUndefined()
			expect(parsedBody.include).toEqual(["reasoning.encrypted_content"])
			expect(parsedBody.reasoning?.effort).toBe("medium")
			expect(parsedBody.text?.verbosity).toBe("medium")

			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("GPT-5.5 reply")
		})

		it("should handle GPT-5.4 model with Responses API", async () => {
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"GPT-5.4 reply"}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.4",
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.objectContaining({
					body: expect.any(String),
				}),
			)
			const body = (mockFetch.mock.calls[0][1] as any).body as string
			const parsedBody = JSON.parse(body)
			expect(parsedBody.model).toBe("gpt-5.4")
			expect(parsedBody.max_output_tokens).toBe(128000)
			expect(parsedBody.temperature).toBeUndefined()
			expect(parsedBody.include).toEqual(["reasoning.encrypted_content"])
			expect(parsedBody.reasoning?.effort).toBe("none")
			expect(parsedBody.text?.verbosity).toBe("medium")

			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("GPT-5.4 reply")
		})

		it("should handle GPT-5.3 Chat model with Responses API", async () => {
			// Mock fetch for Responses API
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"Chat reply"}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail so it uses fetch
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.3-chat-latest",
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.objectContaining({
					body: expect.any(String),
				}),
			)
			const body = (mockFetch.mock.calls[0][1] as any).body as string
			const parsedBody = JSON.parse(body)
			expect(parsedBody.model).toBe("gpt-5.3-chat-latest")
			expect(parsedBody.max_output_tokens).toBe(16_384)
			expect(parsedBody.temperature).toBe(0)
			expect(parsedBody.reasoning?.effort).toBeUndefined()
			expect(parsedBody.text?.verbosity).toBeUndefined()

			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Chat reply")
		})

		it("should handle GPT-5-mini model with Responses API", async () => {
			// Mock fetch for Responses API
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"Response"}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5-mini-2025-08-07",
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify correct model and default parameters
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.objectContaining({
					body: expect.stringContaining('"model":"gpt-5-mini-2025-08-07"'),
				}),
			)
		})

		it("should handle GPT-5-nano model with Responses API", async () => {
			// Mock fetch for Responses API
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"Nano response"}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5-nano-2025-08-07",
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify correct model
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.objectContaining({
					body: expect.stringContaining('"model":"gpt-5-nano-2025-08-07"'),
				}),
			)
		})

		it("should support verbosity control for GPT-5", async () => {
			// Mock fetch for Responses API
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"Low verbosity"}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.1",
				verbosity: "low", // Set verbosity through options
			})

			// Create a message to verify verbosity is passed
			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify that verbosity is passed in the request
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.objectContaining({
					body: expect.stringContaining('"verbosity":"low"'),
				}),
			)
		})

		it("should replace an unsupported GPT-5.1 reasoning effort with the model default", async () => {
			// Mock fetch for Responses API
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"Minimal effort"}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.1",
				reasoningEffort: "minimal" as any, // GPT-5 supports minimal
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// GPT-5.1 does not support minimal, so use the catalog's medium default.
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.objectContaining({
					body: expect.stringContaining('"effort":"medium"'),
				}),
			)
		})

		it("should support xhigh reasoning effort for GPT-5.1 Codex Max", async () => {
			// Mock fetch for Responses API
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"XHigh effort"}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.1-codex-max",
				reasoningEffort: "xhigh",
			})

			const stream = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream) {
				// drain
			}

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.objectContaining({
					body: expect.stringContaining('"effort":"xhigh"'),
				}),
			)
		})

		it("should omit reasoning when selection is 'disable'", async () => {
			// Mock fetch for Responses API
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"No reasoning"}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.1",
				reasoningEffort: "disable" as any,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			for await (const _ of stream) {
				// drain
			}

			const bodyStr = (mockFetch.mock.calls[0][1] as any).body as string
			const parsed = JSON.parse(bodyStr)
			expect(parsed.reasoning).toBeUndefined()
			expect(parsed.include).toBeUndefined()
		})

		it("should support low reasoning effort for GPT-5", async () => {
			// Mock fetch for Responses API
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"Low effort response"}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.1",
				reasoningEffort: "low",
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Should use Responses API with low reasoning effort
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.objectContaining({
					body: expect.any(String),
				}),
			)
			const body2 = (mockFetch.mock.calls[0][1] as any).body as string
			const parsedBody = JSON.parse(body2)
			expect(parsedBody.model).toBe("gpt-5.1")
			expect(parsedBody.reasoning?.effort).toBe("low")
			expect(parsedBody.reasoning?.summary).toBe("auto")
			expect(parsedBody.text?.verbosity).toBe("medium")
			// GPT-5 models don't include temperature
			expect(parsedBody.temperature).toBeUndefined()
			expect(parsedBody.max_output_tokens).toBeDefined()
		})

		it("should support verbosity while normalizing an unsupported GPT-5 effort", async () => {
			// Mock fetch for Responses API
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"High verbosity minimal effort"}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.1",
				verbosity: "high",
				reasoningEffort: "minimal" as any,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Should use Responses API with both parameters
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.objectContaining({
					body: expect.any(String),
				}),
			)
			const body3 = (mockFetch.mock.calls[0][1] as any).body as string
			const parsedBody = JSON.parse(body3)
			expect(parsedBody.model).toBe("gpt-5.1")
			expect(parsedBody.reasoning?.effort).toBe("medium")
			expect(parsedBody.reasoning?.summary).toBe("auto")
			expect(parsedBody.text?.verbosity).toBe("high")
			// GPT-5 models don't include temperature
			expect(parsedBody.temperature).toBeUndefined()
			expect(parsedBody.max_output_tokens).toBeDefined()
		})

		it("should handle actual GPT-5 Responses API format", async () => {
			// Mock fetch with actual response format from GPT-5
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						// Test actual GPT-5 response format
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.created","response":{"id":"test","status":"in_progress"}}\n\n',
							),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.in_progress","response":{"status":"in_progress"}}\n\n',
							),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"First text"}}\n\n',
							),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":" Second text"}}\n\n',
							),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"reasoning","text":"Some reasoning"}}\n\n',
							),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.done","response":{"usage":{"prompt_tokens":100,"completion_tokens":20}}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.1",
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Should handle the actual format correctly
			const textChunks = chunks.filter((c) => c.type === "text")
			const reasoningChunks = chunks.filter((c) => c.type === "reasoning")

			expect(textChunks).toHaveLength(2)
			expect(textChunks[0].text).toBe("First text")
			expect(textChunks[1].text).toBe(" Second text")

			expect(reasoningChunks).toHaveLength(1)
			expect(reasoningChunks[0].text).toBe("Some reasoning")

			// Should also have usage information with cost
			const usageChunks = chunks.filter((c) => c.type === "usage")
			expect(usageChunks).toHaveLength(1)
			expect(usageChunks[0]).toMatchObject({
				type: "usage",
				inputTokens: 100,
				outputTokens: 20,
				totalCost: expect.any(Number),
			})

			// Verify cost calculation (GPT-5 pricing: input $1.25/M, output $10/M)
			const expectedInputCost = (100 / 1_000_000) * 1.25
			const expectedOutputCost = (20 / 1_000_000) * 10.0
			const expectedTotalCost = expectedInputCost + expectedOutputCost
			expect(usageChunks[0].totalCost).toBeCloseTo(expectedTotalCost, 10)
		})

		it("should handle Responses API with no content gracefully", async () => {
			// Mock fetch with empty response
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('data: {"someField":"value"}\n\n'))
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.1",
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []

			// Should not throw, just warn
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Should have no content chunks when stream is empty
			const contentChunks = chunks.filter((c) => c.type === "text" || c.type === "reasoning")

			expect(contentChunks).toHaveLength(0)
		})

		it("should handle unhandled stream events gracefully", async () => {
			// Mock fetch for the fallback SSE path
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"Hello"}}\n\n',
							),
						)
						// This event is not handled, so it should be ignored
						controller.enqueue(
							new TextEncoder().encode('data: {"type":"response.audio.delta","delta":"..."}\n\n'),
						)
						controller.enqueue(new TextEncoder().encode('data: {"type":"response.done","response":{}}\n\n'))
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.1",
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			const errors: any[] = []

			try {
				for await (const chunk of stream) {
					chunks.push(chunk)
				}
			} catch (error) {
				errors.push(error)
			}

			expect(errors.length).toBe(0)
			const textChunks = chunks.filter((c) => c.type === "text")
			expect(textChunks.length).toBeGreaterThan(0)
			expect(textChunks[0].text).toBe("Hello")
		})

		it("should format full conversation correctly", async () => {
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_item.added","item":{"type":"text","text":"Response"}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const gpt5Handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "gpt-5.1",
			})

			const stream = gpt5Handler.createMessage(systemPrompt, messages, {
				taskId: "task1",
			})
			for await (const _chunk of stream) {
				// consume
			}

			const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
			expect(callBody.input).toEqual([
				{
					role: "user",
					content: [{ type: "input_text", text: "Hello!" }],
				},
			])
			expect(callBody.previous_response_id).toBeUndefined()
		})

		it("sends a task-scoped prompt_cache_key in the body and no session_id header", async () => {
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as typeof fetch
			// Force the hand-built SSE path so the wire body and headers are inspectable.
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const cacheHandler = new OpenAiNativeHandler({ ...mockOptions, apiModelId: "gpt-5.1" })

			for (const taskId of ["task-cache-one", "task-cache-one", "task-cache-two"]) {
				for await (const _chunk of cacheHandler.createMessage(systemPrompt, messages, { taskId })) {
					// consume
				}
			}

			const bodies = mockFetch.mock.calls.map(([, init]) => JSON.parse(init.body))
			expect(bodies).toHaveLength(3)
			expect(bodies[0].prompt_cache_key).toBe("task-cache-one")
			// Same task, second turn: the key must not drift, or the growing prefix loses affinity.
			expect(bodies[1].prompt_cache_key).toBe(bodies[0].prompt_cache_key)
			// A different task must not share the bucket.
			expect(bodies[2].prompt_cache_key).toBe("task-cache-two")
			expect(bodies[2].prompt_cache_key).not.toBe(bodies[0].prompt_cache_key)

			// The retention control is untouched by this change.
			expect(bodies[0].prompt_cache_retention).toBe("24h")

			// The affinity header is gone: OpenAI ignores it for caching and hardened
			// gateways reject underscore header names outright.
			for (const [, init] of mockFetch.mock.calls) {
				expect(init.headers).not.toHaveProperty("session_id")
			}
		})

		it("keeps two over-long task ids distinct instead of truncating them to one bucket", async () => {
			// Task ids are uuidv7 today (36 chars), so this guards the wire contract for
			// any caller that sends a longer id: a 64-char slice drops the distinguishing
			// tail, so two ids sharing a 64-char prefix would land in one routing bucket.
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as typeof fetch
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const cacheHandler = new OpenAiNativeHandler({ ...mockOptions, apiModelId: "gpt-5.1" })
			// 70 characters: identical for the first 64, different in the tail.
			const sharedPrefix = "a".repeat(64)
			const longTaskIds = [`${sharedPrefix}-one`, `${sharedPrefix}-two`]

			for (const taskId of longTaskIds) {
				for await (const _chunk of cacheHandler.createMessage(systemPrompt, messages, { taskId })) {
					// consume
				}
			}

			const bodies = mockFetch.mock.calls.map(([, init]) => JSON.parse(init.body))
			expect(bodies).toHaveLength(2)
			// OpenAI rejects keys over 64 characters, so the key must still fit.
			expect(bodies[0].prompt_cache_key.length).toBeLessThanOrEqual(64)
			expect(bodies[1].prompt_cache_key.length).toBeLessThanOrEqual(64)
			// ...but the two tasks must not collide on that shortened form.
			expect(bodies[1].prompt_cache_key).not.toBe(bodies[0].prompt_cache_key)
		})

		it("sends the task-scoped prompt_cache_key through the SDK path", async () => {
			mockResponsesCreate.mockResolvedValue(asyncStreamFrom([]))

			const cacheHandler = new OpenAiNativeHandler({ ...mockOptions, apiModelId: "gpt-5.1" })

			for (const taskId of ["sdk-task-one", "sdk-task-one", "sdk-task-two"]) {
				await collectStream(cacheHandler.createMessage(systemPrompt, messages, { taskId }))
			}

			const bodies = mockResponsesCreate.mock.calls.map(([body]) => body)
			expect(bodies[0].prompt_cache_key).toBe("sdk-task-one")
			expect(bodies[1].prompt_cache_key).toBe(bodies[0].prompt_cache_key)
			expect(bodies[2].prompt_cache_key).toBe("sdk-task-two")
			expect(bodies[0].prompt_cache_retention).toBe("24h")
			expect(mockResponsesCreate.mock.calls[0][1].headers).not.toHaveProperty("session_id")
		})

		it("keys completePrompt off the task id when the caller supplies one", async () => {
			// Prompt enhancement builds a fresh handler per request, so a session-scoped key
			// would start a new cache bucket every time. The task id keeps repeated
			// enhancements of one task on the same bucket.
			mockResponsesCreate.mockResolvedValue({ output: [] })

			const first = new OpenAiNativeHandler({ ...mockOptions, apiModelId: "gpt-5.1" })
			const second = new OpenAiNativeHandler({ ...mockOptions, apiModelId: "gpt-5.1" })

			await first.completePrompt("enhance me", { taskId: "task-enhance" })
			await second.completePrompt("enhance me", { taskId: "task-enhance" })

			const bodies = mockResponsesCreate.mock.calls.map(([body]) => body)
			expect(bodies).toHaveLength(2)
			expect(bodies[0].prompt_cache_key).toBe("task-enhance")
			// Different handler instances, same task: the key must not drift.
			expect(bodies[1].prompt_cache_key).toBe(bodies[0].prompt_cache_key)
		})

		it("falls back to the handler session id when completePrompt gets no task id", async () => {
			mockResponsesCreate.mockResolvedValue({ output: [] })

			const cacheHandler = new OpenAiNativeHandler({ ...mockOptions, apiModelId: "gpt-5.1" })

			await cacheHandler.completePrompt("enhance me")

			const [body] = mockResponsesCreate.mock.calls[0]
			expect(body.prompt_cache_key).toBe(cacheHandler["sessionId"])
		})

		it("should provide helpful error messages for different error codes", async () => {
			const testCases = [
				{ status: 400, expectedMessage: "Invalid request to Responses API" },
				{ status: 401, expectedMessage: "Authentication failed" },
				{ status: 403, expectedMessage: "Access denied" },
				{ status: 404, expectedMessage: "Responses API endpoint not found" },
				{ status: 429, expectedMessage: "Rate limit exceeded" },
				{ status: 500, expectedMessage: "OpenAI service error" },
			]

			for (const { status, expectedMessage } of testCases) {
				// Mock fetch with error response
				const mockFetch = vitest.fn().mockResolvedValue({
					ok: false,
					status,
					statusText: "Error",
					text: async () => JSON.stringify({ error: { message: "Test error" } }),
				})
				global.fetch = mockFetch as any

				// Mock SDK to fail
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

				handler = new OpenAiNativeHandler({
					...mockOptions,
					apiModelId: "gpt-5.1",
				})

				const stream = handler.createMessage(systemPrompt, messages)

				await expect(async () => {
					for await (const _chunk of stream) {
						// Should throw before yielding anything
					}
				}).rejects.toThrow(expectedMessage)

				// Clean up
				delete (global as any).fetch
			}
		})
	})

	describe("error telemetry", () => {
		const errorMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: "Hello",
			},
		]

		const errorSystemPrompt = "You are a helpful assistant"

		beforeEach(() => {
			mockCaptureException.mockClear()
		})
		it("should keep the numeric status when the error-response body read fails on a 429", async () => {
			// The 429 headers are already in hand and only the body read fails. A connection
			// failure that drops the status would leave retry and backoff without the number
			// they act on, so the synthesized failure has to carry it.
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: false,
				status: 429,
				statusText: "Too Many Requests",
				text: () => Promise.reject(new Error("socket hang up while reading the error body")),
			})
			global.fetch = mockFetch as typeof fetch

			// Mock SDK to fail so it falls back to fetch
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({ ...mockOptions, apiModelId: "gpt-5.1" })

			const error = await collectStream(handler.createMessage(errorSystemPrompt, errorMessages)).then(
				() => undefined,
				(e: unknown) => e,
			)

			expect(error).toMatchObject({ status: 429 })
			expect(error).toBeInstanceOf(Error)
			expect((error as Error).message).toContain("Rate limit exceeded")
			expect((error as Error).message).toContain("could not be read")
			// Captured once, as every other terminal failure is: the read failure must not
			// double-report the request just because the body never arrived.
			expect(mockCaptureException).toHaveBeenCalledTimes(1)
			expect(mockCaptureException).toHaveBeenCalledWith(expect.any(ApiProviderError))
			deleteGlobalFetch()
		})

		it("should keep the contract AbortError when the caller aborts during the error body read", async () => {
			// The cancellation is the caller's act, not a failed read: it must still surface as
			// the AbortError the abort contract promises, with no status invented for it.
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: false,
				status: 503,
				statusText: "Service Unavailable",
				text: () =>
					Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
			})
			global.fetch = mockFetch as typeof fetch

			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({ ...mockOptions, apiModelId: "gpt-5.1" })

			const error = await collectStream(handler.createMessage(errorSystemPrompt, errorMessages)).then(
				() => undefined,
				(e: unknown) => e,
			)

			expect(error).toMatchObject({ name: "AbortError" })
			expect((error as { status?: unknown }).status).toBeUndefined()
			deleteGlobalFetch()
		})

		it("should capture telemetry on createMessage error", async () => {
			// Mock fetch to return error
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "Internal Server Error",
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail so it falls back to fetch
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const stream = handler.createMessage(errorSystemPrompt, errorMessages)

			await expect(async () => {
				for await (const _chunk of stream) {
					// Should throw before yielding any chunks
				}
			}).rejects.toThrow()

			// Verify telemetry was captured
			expect(mockCaptureException).toHaveBeenCalledTimes(1)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining("OpenAI service error"),
					provider: "OpenAI Native",
					modelId: "gpt-4.1",
					operation: "createMessage",
				}),
			)

			// Verify it's an ApiProviderError
			const capturedError = mockCaptureException.mock.calls[0][0]
			expect(capturedError).toBeInstanceOf(ApiProviderError)
		})

		it("should capture telemetry on stream processing error", async () => {
			// Mock fetch to return a stream with an error event
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.error","error":{"message":"Model overloaded"}}\n\n',
							),
						)
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail so it falls back to fetch
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const stream = handler.createMessage(errorSystemPrompt, errorMessages)

			await expect(async () => {
				for await (const _chunk of stream) {
					// Should throw when encountering error event
				}
			}).rejects.toThrow()

			// A stream failure must be captured exactly once (handleStreamResponse rethrows to createMessage).
			expect(mockCaptureException).toHaveBeenCalledTimes(1)

			const streamErrorCall = mockCaptureException.mock.calls.find((call: any[]) =>
				call[0]?.message?.includes("Model overloaded"),
			)
			expect(streamErrorCall).toBeDefined()
			expect(streamErrorCall![0]).toMatchObject({
				provider: "OpenAI Native",
				modelId: "gpt-4.1",
				operation: "createMessage",
			})

			// Verify it's an ApiProviderError
			expect(streamErrorCall![0]).toBeInstanceOf(ApiProviderError)
		})

		it("should capture telemetry on completePrompt error", async () => {
			// Mock SDK to throw an error
			mockResponsesCreate.mockRejectedValue(new Error("API Error"))

			await expect(handler.completePrompt("Test prompt")).rejects.toThrow()

			// Verify telemetry was captured
			expect(mockCaptureException).toHaveBeenCalledTimes(1)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "API Error",
					provider: "OpenAI Native",
					modelId: "gpt-4.1",
					operation: "completePrompt",
				}),
			)

			// Verify it's an ApiProviderError
			const capturedError = mockCaptureException.mock.calls[0][0]
			expect(capturedError).toBeInstanceOf(ApiProviderError)
		})

		it("should still throw the error after capturing telemetry", async () => {
			// Mock fetch to return error
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "Internal Server Error",
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const stream = handler.createMessage(errorSystemPrompt, errorMessages)

			// Verify the error is still thrown
			await expect(async () => {
				for await (const _chunk of stream) {
					// Should throw
				}
			}).rejects.toThrow()

			// Telemetry should have been captured before the error was thrown
			expect(mockCaptureException).toHaveBeenCalled()
		})

		it("captures a status-carrying SSE body failure once and rethrows it unchanged", async () => {
			// Regression: handleStreamResponse rethrows status-carrying errors
			// unchanged, so the capture has to happen before that rethrow or a
			// 401/429/5xx raised while reading the stream body is dropped from
			// telemetry entirely.
			const statusError = Object.assign(new Error("Rate limit exceeded"), { status: 429 })

			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
							),
						)
						controller.error(statusError)
					},
				}),
			})
			vitest.stubGlobal("fetch", mockFetch)

			// Force the SSE fallback path (the SDK stream is unavailable).
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const stream = handler.createMessage(errorSystemPrompt, errorMessages)
			const error = await collectStream(stream).catch((caught: unknown) => caught)

			// The provider failure keeps its own identity (the numeric status must
			// survive for retry/backoff) and is reported exactly once.
			expect(error).toBe(statusError)
			expect(mockCaptureException).toHaveBeenCalledTimes(1)
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "Rate limit exceeded",
					provider: "OpenAI Native",
					operation: "createMessage",
				}),
			)
			expect(mockCaptureException.mock.calls[0][0]).toBeInstanceOf(ApiProviderError)
		})
	})
})

// Additional tests for GPT-5 streaming event coverage
describe("GPT-5 streaming event coverage (additional)", () => {
	afterEach(() => {
		if ((global as any).fetch) {
			delete (global as any).fetch
		}
	})

	it("should handle reasoning delta events for GPT-5", async () => {
		const mockFetch = vitest.fn().mockResolvedValue({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							'data: {"type":"response.reasoning.delta","delta":"Thinking about the problem..."}\n\n',
						),
					)
					controller.enqueue(
						new TextEncoder().encode('data: {"type":"response.text.delta","delta":"The answer is..."}\n\n'),
					)
					controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
					controller.close()
				},
			}),
		})
		global.fetch = mockFetch as any

		// Mock SDK to fail
		mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

		const handler = new OpenAiNativeHandler({
			apiModelId: "gpt-5.1",
			openAiNativeApiKey: "test-api-key",
		})

		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello!" }]
		const stream = handler.createMessage(systemPrompt, messages)

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const reasoningChunks = chunks.filter((c) => c.type === "reasoning")
		const textChunks = chunks.filter((c) => c.type === "text")

		expect(reasoningChunks).toHaveLength(1)
		expect(reasoningChunks[0].text).toBe("Thinking about the problem...")
		expect(textChunks).toHaveLength(1)
		expect(textChunks[0].text).toBe("The answer is...")
	})

	it("should handle refusal delta events for GPT-5 and prefix output", async () => {
		const mockFetch = vitest.fn().mockResolvedValue({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							'data: {"type":"response.refusal.delta","delta":"I cannot comply with this request."}\n\n',
						),
					)
					controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
					controller.close()
				},
			}),
		})
		global.fetch = mockFetch as any

		// Mock SDK to fail
		mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

		const handler = new OpenAiNativeHandler({
			apiModelId: "gpt-5.1",
			openAiNativeApiKey: "test-api-key",
		})

		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Do something disallowed" }]
		const stream = handler.createMessage(systemPrompt, messages)

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks).toHaveLength(1)
		expect(textChunks[0].text).toBe("[Refusal] I cannot comply with this request.")
	})

	it("should ignore malformed JSON lines in SSE stream", async () => {
		const mockFetch = vitest.fn().mockResolvedValue({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							'data: {"type":"response.output_item.added","item":{"type":"text","text":"Before"}}\n\n',
						),
					)
					// Malformed JSON line
					controller.enqueue(
						new TextEncoder().encode('data: {"type":"response.text.delta","delta":"Bad"\n\n'),
					)
					// Valid line after malformed
					controller.enqueue(
						new TextEncoder().encode(
							'data: {"type":"response.output_item.added","item":{"type":"text","text":"After"}}\n\n',
						),
					)
					controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
					controller.close()
				},
			}),
		})
		global.fetch = mockFetch as any

		// Mock SDK to fail
		mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

		const handler = new OpenAiNativeHandler({
			apiModelId: "gpt-5.1",
			openAiNativeApiKey: "test-api-key",
		})

		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello!" }]
		const stream = handler.createMessage(systemPrompt, messages)

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		// It should not throw and still capture the valid texts around the malformed line
		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.map((c: any) => c.text)).toEqual(["Before", "After"])
	})

	describe("Codex Mini Model", () => {
		let handler: OpenAiNativeHandler
		const mockOptions: ApiHandlerOptions = {
			openAiNativeApiKey: "test-api-key",
			apiModelId: "codex-mini-latest",
		}

		it("should handle codex-mini-latest streaming response", async () => {
			// Mock fetch for Codex Mini responses API
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						// Codex Mini uses the same responses API format
						controller.enqueue(
							new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Hello"}\n\n'),
						)
						controller.enqueue(
							new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":" from"}\n\n'),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_text.delta","delta":" Codex"}\n\n',
							),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_text.delta","delta":" Mini!"}\n\n',
							),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.done","response":{"usage":{"prompt_tokens":50,"completion_tokens":10}}}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "codex-mini-latest",
			})

			const systemPrompt = "You are a helpful coding assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Write a hello world function" },
			]

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify text chunks
			const textChunks = chunks.filter((c) => c.type === "text")
			expect(textChunks).toHaveLength(4)
			expect(textChunks.map((c) => c.text).join("")).toBe("Hello from Codex Mini!")

			// Verify usage data from API
			const usageChunks = chunks.filter((c) => c.type === "usage")
			expect(usageChunks).toHaveLength(1)
			expect(usageChunks[0]).toMatchObject({
				type: "usage",
				inputTokens: 50,
				outputTokens: 10,
				totalCost: expect.any(Number), // Codex Mini has pricing: $1.5/M input, $6/M output
			})

			// Verify cost is calculated correctly based on API usage data
			const expectedCost = (50 / 1_000_000) * 1.5 + (10 / 1_000_000) * 6
			expect(usageChunks[0].totalCost).toBeCloseTo(expectedCost, 10)

			// Verify the request was made with correct parameters
			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"Content-Type": "application/json",
						Authorization: "Bearer test-api-key",
					}),
					body: expect.any(String),
				}),
			)

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
			expect(requestBody).toMatchObject({
				model: "codex-mini-latest",
				instructions: "You are a helpful coding assistant.",
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: "Write a hello world function" }],
					},
				],
				stream: true,
			})
		})

		it("should handle codex-mini-latest non-streaming completion", async () => {
			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "codex-mini-latest",
			})

			// Mock the responses.create method to return a non-streaming response
			mockResponsesCreate.mockResolvedValue({
				output: [
					{
						type: "message",
						content: [
							{
								type: "output_text",
								text: "def hello_world():\n    print('Hello, World!')",
							},
						],
					},
				],
			})

			const result = await handler.completePrompt("Write a hello world function in Python")

			expect(result).toBe("def hello_world():\n    print('Hello, World!')")
			expect(mockResponsesCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "codex-mini-latest",
					stream: false,
					store: false,
				}),
				expect.objectContaining({
					signal: expect.any(Object),
				}),
			)
		})

		it("should handle codex-mini-latest API errors", async () => {
			// Mock fetch with error response
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: false,
				status: 429,
				statusText: "Too Many Requests",
				text: async () => "Rate limit exceeded",
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "codex-mini-latest",
			})

			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			const stream = handler.createMessage(systemPrompt, messages)

			// Should throw an error (using the same error format as GPT-5)
			await expect(async () => {
				for await (const _chunk of stream) {
					// consume stream
				}
			}).rejects.toThrow("Rate limit exceeded")
		})

		it("should handle codex-mini-latest with multiple user messages", async () => {
			// Mock fetch for streaming response
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_text.delta","delta":"Combined response"}\n\n',
							),
						)
						controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'))
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "codex-mini-latest",
			})

			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "First question" },
				{ role: "assistant", content: "First answer" },
				{ role: "user", content: "Second question" },
			]

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify the request body includes full conversation in structured format (without embedding system prompt)
			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
			expect(requestBody.instructions).toBe("You are a helpful assistant.")
			expect(requestBody.input).toEqual([
				{
					role: "user",
					content: [{ type: "input_text", text: "First question" }],
				},
				{
					role: "assistant",
					content: [{ type: "output_text", text: "First answer" }],
				},
				{
					role: "user",
					content: [{ type: "input_text", text: "Second question" }],
				},
			])
		})

		it("should handle codex-mini-latest stream error events", async () => {
			// Mock fetch with error event in stream
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
							),
						)
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.error","error":{"message":"Model overloaded"}}\n\n',
							),
						)
						// The error handler will throw, but we still need to close the stream
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			// Mock SDK to fail
			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			handler = new OpenAiNativeHandler({
				...mockOptions,
				apiModelId: "codex-mini-latest",
			})

			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			const stream = handler.createMessage(systemPrompt, messages)

			// Should throw an error when encountering error event
			await expect(async () => {
				await collectStream(stream)
			}).rejects.toThrow("Responses API error: Model overloaded")
		})

		// New tests: ensure text.verbosity is omitted for models without supportsVerbosity
		describe("Verbosity gating for non-GPT-5 models", () => {
			it("should omit text.verbosity for gpt-4.1", async () => {
				const mockFetch = vitest.fn().mockResolvedValue({
					ok: true,
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode('data: {"type":"response.done","response":{}}\n\n'),
							)
							controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
							controller.close()
						},
					}),
				})
				;(global as any).fetch = mockFetch as any

				// Force SDK path to fail so we use fetch fallback
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

				const handler = new OpenAiNativeHandler({
					apiModelId: "gpt-4.1",
					openAiNativeApiKey: "test-api-key",
					verbosity: "high",
				})

				const systemPrompt = "You are a helpful assistant."
				const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello!" }]
				const stream = handler.createMessage(systemPrompt, messages)

				for await (const _ of stream) {
					// drain
				}

				const bodyStr = (mockFetch.mock.calls[0][1] as any).body as string
				const parsedBody = JSON.parse(bodyStr)
				expect(parsedBody.model).toBe("gpt-4.1")
				expect(parsedBody.text).toBeUndefined()
				expect(bodyStr).not.toContain('"verbosity"')
			})

			it("should omit text.verbosity for gpt-4o", async () => {
				const mockFetch = vitest.fn().mockResolvedValue({
					ok: true,
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode('data: {"type":"response.done","response":{}}\n\n'),
							)
							controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
							controller.close()
						},
					}),
				})
				;(global as any).fetch = mockFetch as any

				// Force SDK path to fail so we use fetch fallback
				mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

				const handler = new OpenAiNativeHandler({
					apiModelId: "gpt-4o",
					openAiNativeApiKey: "test-api-key",
					verbosity: "low",
				})

				const systemPrompt = "You are a helpful assistant."
				const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello!" }]
				const stream = handler.createMessage(systemPrompt, messages)

				for await (const _ of stream) {
					// drain
				}

				const bodyStr = (mockFetch.mock.calls[0][1] as any).body as string
				const parsedBody = JSON.parse(bodyStr)
				expect(parsedBody.model).toBe("gpt-4o")
				expect(parsedBody.text).toBeUndefined()
				expect(bodyStr).not.toContain('"verbosity"')
			})
		})
	})

	describe("URL image handling", () => {
		it("should skip URL-sourced images in formatFullConversation (only base64 emits input_image)", async () => {
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const localHandler = new OpenAiNativeHandler({
				apiModelId: "gpt-4.1",
				openAiNativeApiKey: "test-api-key",
			})

			const urlImageMessages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: "Look at this:" },
						{
							type: "image",
							source: { type: "url", url: "https://example.com/img.png" } as any,
						},
					],
				},
			]

			const stream = localHandler.createMessage("You are a helpful assistant.", urlImageMessages)
			for await (const _ of stream) {
				// consume
			}

			const bodyStr = (mockFetch.mock.calls[0][1] as any).body as string
			const parsedBody = JSON.parse(bodyStr)
			// URL image is skipped; only the text part is in the input
			const userMsg = parsedBody.input[0]
			expect(userMsg.content).toEqual([{ type: "input_text", text: "Look at this:" }])
			expect(bodyStr).not.toContain("input_image")
		})

		it("should emit input_image for base64 images in formatFullConversation", async () => {
			const mockFetch = vitest.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'),
						)
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
						controller.close()
					},
				}),
			})
			global.fetch = mockFetch as any

			mockResponsesCreate.mockRejectedValue(new Error("SDK not available"))

			const localHandler = new OpenAiNativeHandler({
				apiModelId: "gpt-4.1",
				openAiNativeApiKey: "test-api-key",
			})

			const b64ImageMessages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: "Look at this:" },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
					],
				},
			]

			const stream = localHandler.createMessage("You are a helpful assistant.", b64ImageMessages)
			for await (const _ of stream) {
				// consume
			}

			const bodyStr = (mockFetch.mock.calls[0][1] as any).body as string
			const parsedBody = JSON.parse(bodyStr)
			const userMsg = parsedBody.input[0]
			expect(userMsg.content).toContainEqual({
				type: "input_image",
				image_url: "data:image/png;base64,abc123",
			})
		})
	})
})
