// npx vitest run src/api/providers/__tests__/kenari.spec.ts
// Mock vscode first to avoid import errors
vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { kenariDefaultModelId } from "@roo-code/types"

import { KenariHandler } from "../kenari"
import { getModels } from "../fetchers/modelCache"
import { ApiHandlerOptions } from "../../../shared/api"
import { makeCreateMessageMetadata } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"

vitest.mock("openai")
vitest.mock("delay", () => ({ default: vitest.fn(() => Promise.resolve()) }))
vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(() =>
		Promise.resolve({
			"glm-5-2": {
				maxTokens: 32768,
				contextWindow: 1048576,
				supportsImages: false,
				supportsPromptCache: false,
				description: "GLM 5.2",
			},
		}),
	),
	refreshModels: vitest.fn(async (options, handler) => {
		const { getModels } = await import("../fetchers/modelCache")
		return getModels(options, handler)
	}),
	getModelsFromCache: vitest.fn().mockReturnValue(undefined),
}))

// Typed to the SDK call shape so the callbacks and the asserted options are checked; the
// return stays loose because the fixtures are deliberate partial doubles.
const mockCreate =
	vitest.fn<(body: OpenAI.Chat.Completions.ChatCompletionCreateParams, options?: OpenAI.RequestOptions) => unknown>()

;(OpenAI as any).mockImplementation(function () {
	return {
		chat: { completions: { create: mockCreate } },
	}
})

describe("KenariHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		kenariApiKey: "test-key",
		kenariModelId: "glm-5-2",
	}

	beforeEach(() => {
		clearAllMocks()
		mockCreate.mockClear()
	})

	it("initializes the OpenAI client with the Kenari base URL and key", () => {
		const handler = new KenariHandler(mockOptions)
		expect(handler).toBeInstanceOf(KenariHandler)
		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://kenari.id/v1",
				apiKey: "test-key",
			}),
		)
	})

	describe("fetchModel", () => {
		it("returns the configured model info", async () => {
			const handler = new KenariHandler(mockOptions)
			const result = await handler.fetchModel()
			expect(result.id).toBe("glm-5-2")
			expect(result.info.maxTokens).toBe(32768)
			expect(result.info.contextWindow).toBe(1048576)
			expect(result.info.supportsPromptCache).toBe(false)
		})

		it("falls back to the default model id when none is configured", async () => {
			const handler = new KenariHandler({ kenariApiKey: "test-key" })
			const result = await handler.fetchModel()
			expect(result.id).toBe(kenariDefaultModelId)
		})
	})

	describe("createMessage", () => {
		beforeEach(() => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									content: "Hello",
									reasoning_content: "thinking…",
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											function: { name: "read_file", arguments: '{"path":' },
										},
									],
								},
								index: 0,
							},
						],
						usage: null,
					},
					{
						choices: [{ delta: {}, index: 0 }],
						usage: {
							prompt_tokens: 12,
							completion_tokens: 7,
							total_tokens: 19,
							prompt_tokens_details: { cached_tokens: 4 },
						},
					},
				]),
			)
		})

		it("streams text, reasoning, tool-call and usage chunks", async () => {
			const handler = new KenariHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("You are helpful.", messages))

			expect(chunks).toContainEqual({ type: "text", text: "Hello" })
			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking…" })
			expect(chunks).toContainEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_1",
				name: "read_file",
				arguments: '{"path":',
			})
			expect(chunks).toContainEqual({
				type: "usage",
				inputTokens: 12,
				outputTokens: 7,
				cacheReadTokens: 4,
			})
		})

		it("yields nothing for a chunk whose delta has no content, reasoning or tool calls", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: {}, index: 0 }], usage: null },
					{ choices: [], usage: null },
				]),
			)

			const handler = new KenariHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(chunks).toEqual([])
		})

		it("streams tool call chunks even when the function name and arguments are missing", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { tool_calls: [{ index: 1 }] }, index: 0 }],
						usage: null,
					},
				]),
			)

			const handler = new KenariHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(chunks).toEqual([
				{
					type: "tool_call_partial",
					index: 1,
					id: undefined,
					name: undefined,
					arguments: undefined,
				},
			])
		})

		it("reports undefined cache reads when usage has no prompt_tokens_details", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
					},
				]),
			)

			const handler = new KenariHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(chunks).toEqual([
				{
					type: "usage",
					inputTokens: 3,
					outputTokens: 2,
					cacheReadTokens: undefined,
				},
			])
		})

		it("skips the reasoning chunk when reasoning_content is an empty string", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "Hi", reasoning_content: "" }, index: 0 }],
						usage: null,
					},
				]),
			)

			const handler = new KenariHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(chunks).toEqual([{ type: "text", text: "Hi" }])
		})

		it("emits reasoning from the OpenRouter-style `reasoning` field when reasoning_content is absent", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "Hi", reasoning: "thinking…" }, index: 0 }],
						usage: null,
					},
				]),
			)

			const handler = new KenariHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking…" })
		})

		it("omits temperature for models that do not support it", async () => {
			vitest.mocked(getModels).mockResolvedValueOnce({
				"openai/o3-mini": {
					maxTokens: 4096,
					contextWindow: 128000,
					supportsImages: false,
					supportsPromptCache: false,
					description: "o3-mini via Kenari",
				},
			})

			const handler = new KenariHandler({ kenariApiKey: "test-key", kenariModelId: "openai/o3-mini" })
			await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "openai/o3-mini",
					temperature: undefined,
				}),
			)
		})

		it("sends an explicitly configured model temperature", async () => {
			const handler = new KenariHandler({ ...mockOptions, modelTemperature: 0.7 })
			await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.7 }))
		})

		it("honors metadata.parallelToolCalls false", async () => {
			const handler = new KenariHandler(mockOptions)
			await collectStream(
				handler.createMessage("sys", [{ role: "user", content: "Hi" }], {
					taskId: "task-1",
					parallelToolCalls: false,
				}),
			)

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ parallel_tool_calls: false }))
		})

		it("reports zero usage when the upstream counts are zero", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "x" }, index: 0 }],
						usage: { prompt_tokens: 0, completion_tokens: 0 },
					},
				]),
			)

			const handler = new KenariHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(chunks).toContainEqual({
				type: "usage",
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: undefined,
			})
		})

		it("requests a streaming completion with usage included", async () => {
			const handler = new KenariHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			await collectStream(handler.createMessage("sys", messages))

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5-2",
					stream: true,
					stream_options: { include_usage: true },
					max_completion_tokens: 32768,
					temperature: expect.any(Number),
				}),
			)
		})
	})

	describe("completePrompt", () => {
		it("returns the message content for a non-streaming completion", async () => {
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "the answer" } }] })
			const handler = new KenariHandler(mockOptions)
			expect(await handler.completePrompt("ping")).toBe("the answer")
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5-2",
					stream: false,
					max_completion_tokens: 32768,
				}),
			)
		})

		it("returns an empty string when the completion has no content", async () => {
			mockCreate.mockResolvedValue({ choices: [{ message: { content: null } }] })
			const handler = new KenariHandler(mockOptions)
			expect(await handler.completePrompt("ping")).toBe("")
		})

		it("wraps errors with a Kenari-specific message", async () => {
			mockCreate.mockRejectedValue(new Error("boom"))
			const handler = new KenariHandler(mockOptions)
			await expect(handler.completePrompt("ping")).rejects.toThrow("Kenari completion error: boom")

			mockCreate.mockResolvedValue({})
			await expect(handler.completePrompt("ping")).rejects.toThrow("Kenari completion error:")
			const live = new AbortController() // a non-Error rejection passes through even with a live signal
			mockCreate.mockRejectedValue("string failure")
			await expect(handler.completePrompt("ping", { abortSignal: live.signal })).rejects.toBe("string failure")
		})

		it("re-throws non-Error rejections unchanged", async () => {
			mockCreate.mockRejectedValue("string failure")
			const handler = new KenariHandler(mockOptions)
			await expect(handler.completePrompt("ping")).rejects.toBe("string failure")
		})

		it("omits temperature for models that do not support it", async () => {
			vitest.mocked(getModels).mockResolvedValueOnce({
				"openai/o3-mini": {
					maxTokens: 4096,
					contextWindow: 128000,
					supportsImages: false,
					supportsPromptCache: false,
					description: "o3-mini via Kenari",
				},
			})
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "ok" } }] })

			const handler = new KenariHandler({ kenariApiKey: "test-key", kenariModelId: "openai/o3-mini" })
			expect(await handler.completePrompt("ping")).toBe("ok")

			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.model).toBe("openai/o3-mini")
			expect("temperature" in callArgs).toBe(false)
		})
	})

	describe("cancellation", () => {
		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
		const aborted = (provider: string) => ({ name: "AbortError", message: `The ${provider} request was aborted` })

		describe("createMessage", () => {
			const streamWith = (handler: KenariHandler, abortSignal?: AbortSignal) =>
				handler.createMessage(
					"sys",
					messages,
					abortSignal ? makeCreateMessageMetadata({ abortSignal }) : undefined,
				)

			const okStream = () => asyncStreamFrom([{ choices: [{ delta: { content: "ok" }, index: 0 }], usage: null }])
			function yieldsThenThrows(failure: Error) {
				return (async function* () {
					yield { choices: [{ delta: { content: "Hello" }, index: 0 }], usage: null }
					throw failure
				})()
			}

			it("forwards the caller abort signal to the SDK request options", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				let requestOptions: OpenAI.RequestOptions | undefined
				mockCreate.mockImplementation((_body, options) => {
					requestOptions = options
					return Promise.resolve(okStream()) // the real SDK returns a thenable, which the race awaits
				})

				const chunks = await collectStream(streamWith(handler, caller.signal))
				expect(requestOptions?.signal).toBeInstanceOf(AbortSignal)
				expect(requestOptions?.signal).not.toBe(caller.signal)
				expect(chunks).toEqual([{ type: "text", text: "ok" }])
			})

			it("detaches the SDK abort listener the stream request attached", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				const added = vitest.spyOn(caller.signal, "addEventListener")
				const removed = vitest.spyOn(caller.signal, "removeEventListener")
				mockCreate.mockResolvedValue(okStream())
				const stream = streamWith(handler, caller.signal)

				expect(await collectStream(stream)).toEqual([{ type: "text", text: "ok" }])
				const attached = added.mock.calls.filter(([type]) => type === "abort").map(([, l]) => l)
				expect(attached).toHaveLength(1)
				expect(removed.mock.calls.filter(([type]) => type === "abort").map(([, l]) => l)).toEqual(attached)
			})

			it("rejects a stream that never starts once the caller cancels", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				mockCreate.mockImplementation(() => new Promise(() => {}))
				const pending = collectStream(streamWith(handler, caller.signal))
				await vitest.waitFor(() => expect(mockCreate).toHaveBeenCalled())
				caller.abort()

				await expect(pending).rejects.toMatchObject(aborted("Kenari"))
			})

			it("detaches the bridge when the catalog rejects with the caller still live", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				const added = vitest.spyOn(caller.signal, "addEventListener")
				const removed = vitest.spyOn(caller.signal, "removeEventListener")
				const { getModels } = await import("../fetchers/modelCache")
				vitest.mocked(getModels).mockRejectedValueOnce(new Error("catalog unavailable"))

				await expect(collectStream(streamWith(handler, caller.signal))).rejects.toThrow("catalog unavailable")

				const attached = added.mock.calls.filter(([type]) => type === "abort").map(([, l]) => l)
				expect(attached).toHaveLength(1)
				expect(removed.mock.calls.filter(([type]) => type === "abort").map(([, l]) => l)).toEqual(attached)
			})

			it("keeps the one-argument SDK call when the caller gives no signal", async () => {
				const handler = new KenariHandler(mockOptions)
				mockCreate.mockResolvedValue(okStream())
				expect(await collectStream(streamWith(handler))).toEqual([{ type: "text", text: "ok" }])
				expect(mockCreate.mock.calls[0]).toHaveLength(1)
			})

			it("rejects a pre-aborted caller before the model lookup and the SDK call", async () => {
				const { getModels } = await import("../fetchers/modelCache")
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				caller.abort()

				await expect(collectStream(streamWith(handler, caller.signal))).rejects.toMatchObject(aborted("Kenari"))
				expect(getModels).not.toHaveBeenCalled()
				expect(mockCreate).not.toHaveBeenCalled()
			})

			it("rejects with an AbortError when the signal aborts during model lookup", async () => {
				const { getModels } = await import("../fetchers/modelCache")
				vitest.mocked(getModels).mockImplementationOnce(() => new Promise(() => {}))
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				const pending = collectStream(streamWith(handler, caller.signal))
				await vitest.waitFor(() => expect(getModels).toHaveBeenCalled())
				caller.abort()

				await expect(pending).rejects.toMatchObject(aborted("Kenari"))
				expect(mockCreate).not.toHaveBeenCalled()
			})

			it("normalizes an SDK abort at stream creation into the provider AbortError", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				mockCreate.mockImplementation(() => Promise.reject(new Error("Request was aborted.")))

				await expect(collectStream(streamWith(handler, caller.signal))).rejects.toMatchObject(aborted("Kenari"))
			})

			it("normalizes an abort raised mid-iteration after the chunks that already arrived", async () => {
				const handler = new KenariHandler(mockOptions)
				const stream = streamWith(handler, new AbortController().signal)
				mockCreate.mockResolvedValue(yieldsThenThrows(new Error("Request was aborted.")))

				await expect(stream.next()).resolves.toMatchObject({
					done: false,
					value: { type: "text", text: "Hello" },
				})
				await expect(stream.next()).rejects.toMatchObject(aborted("Kenari"))
			})

			it("rejects with an AbortError when the caller aborts just as the stream completes", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				const stream = streamWith(handler, caller.signal)
				mockCreate.mockResolvedValue(
					asyncStreamFrom([{ choices: [{ delta: { content: "ok" }, index: 0 }], usage: null }]),
				)

				await expect(stream.next()).resolves.toMatchObject({ done: false, value: { type: "text", text: "ok" } })
				caller.abort()
				await expect(stream.next()).rejects.toMatchObject(aborted("Kenari"))
			})
			it("refuses to emit the remaining tool calls of a chunk once the caller cancels", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				const call = (index: number) => ({ index, id: "c" + index, function: { arguments: "{}" } })
				const toolChunk = { choices: [{ delta: { tool_calls: [call(0), call(1)] }, index: 0 }], usage: null }
				mockCreate.mockResolvedValue(asyncStreamFrom([toolChunk]))
				const stream = streamWith(handler, caller.signal)

				await expect(stream.next()).resolves.toMatchObject({ value: { type: "tool_call_partial", index: 0 } })
				caller.abort()
				await expect(stream.next()).rejects.toMatchObject(aborted("Kenari"))
			})

			it("does not pull a buffered chunk once the caller cancels", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				const buffered = { choices: [{ delta: { content: "buffered" }, index: 0 }], usage: null }
				mockCreate.mockResolvedValue(
					asyncStreamFrom([{ choices: [{ delta: { content: "ok" }, index: 0 }], usage: null }, buffered]),
				)
				const stream = streamWith(handler, caller.signal)

				await expect(stream.next()).resolves.toMatchObject({ value: { type: "text", text: "ok" } })
				caller.abort()
				await expect(stream.next()).rejects.toMatchObject(aborted("Kenari"))
			})
			it("propagates an ordinary mid-iteration failure unchanged while the caller signal is live", async () => {
				const handler = new KenariHandler(mockOptions)
				const failure = new Error("upstream returned 500")
				const stream = streamWith(handler, new AbortController().signal)
				mockCreate.mockResolvedValue(yieldsThenThrows(failure))

				await expect(collectStream(stream)).rejects.toBe(failure)
			})
		})

		describe("completePrompt", () => {
			beforeEach(() => {
				mockCreate.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "the answer" } }] })
			})

			it("bridges the caller signal, with or without a timeout, before handing it to the SDK", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()

				const withTimeout = await handler.completePrompt("ping", {
					abortSignal: caller.signal,
					timeoutMs: 5_000,
				})
				const requestOptions = mockCreate.mock.calls[0][1]
				expect(requestOptions?.signal).toBeInstanceOf(AbortSignal)
				expect(requestOptions?.signal).not.toBe(caller.signal)
				expect(requestOptions?.timeout).toBe(5_000)
				const signalOnly = await handler.completePrompt("ping", { abortSignal: new AbortController().signal })
				const signalOnlyOptions = mockCreate.mock.calls[1][1]
				expect(signalOnlyOptions?.signal).toBeInstanceOf(AbortSignal)
				expect(signalOnlyOptions?.timeout).toBeUndefined()
				expect([withTimeout, signalOnly]).toEqual(["the answer", "the answer"])
			})

			it("sends no request options with no caller signal or no usable timeout", async () => {
				const handler = new KenariHandler(mockOptions)
				expect(await handler.completePrompt("ping")).toBe("the answer")
				expect(mockCreate.mock.calls[0]).toHaveLength(1)
				expect(await handler.completePrompt("ping", { timeoutMs: 0 })).toBe("the answer")
				expect(mockCreate.mock.calls[1]).toHaveLength(1)
			})

			it("forwards a timeout alone as an SDK timeout and its own abort signal", async () => {
				const handler = new KenariHandler(mockOptions)

				expect(await handler.completePrompt("ping", { timeoutMs: 1_200 })).toBe("the answer")

				const requestOptions = mockCreate.mock.calls[0][1] as { signal?: AbortSignal; timeout?: number }
				expect(requestOptions.timeout).toBe(1_200)
				expect(requestOptions.signal).toBeInstanceOf(AbortSignal)
			})

			it("returns an empty string when the completion carries no choices", async () => {
				const handler = new KenariHandler(mockOptions)
				mockCreate.mockResolvedValue({ choices: [] })

				await expect(handler.completePrompt("ping")).resolves.toBe("")
			})

			it("rejects a pre-aborted signal before the model lookup and the SDK call", async () => {
				const { getModels } = await import("../fetchers/modelCache")
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				caller.abort()

				await expect(handler.completePrompt("ping", { abortSignal: caller.signal })).rejects.toMatchObject(
					aborted("Kenari"),
				)
				expect(getModels).not.toHaveBeenCalled()
				expect(mockCreate).not.toHaveBeenCalled()
			})

			it("rejects with an AbortError when the timeout alone expires during the SDK call", async () => {
				const handler = new KenariHandler(mockOptions)
				let sdkSignal: AbortSignal | null | undefined
				mockCreate.mockImplementation((_body, options) => {
					sdkSignal = options?.signal
					return new Promise(() => {})
				})

				await expect(handler.completePrompt("ping", { timeoutMs: 20 })).rejects.toMatchObject(aborted("Kenari"))
				expect(sdkSignal?.aborted).toBe(true)
			})

			it("rejects with an AbortError when the timeout alone expires during model lookup", async () => {
				const { getModels } = await import("../fetchers/modelCache")
				vitest.mocked(getModels).mockImplementationOnce(() => new Promise(() => {}))
				const handler = new KenariHandler(mockOptions)

				await expect(handler.completePrompt("ping", { timeoutMs: 20 })).rejects.toMatchObject(aborted("Kenari"))
				expect(mockCreate).not.toHaveBeenCalled()
			})

			it("rejects with an AbortError when the signal aborts during model lookup", async () => {
				const { getModels } = await import("../fetchers/modelCache")
				vitest.mocked(getModels).mockImplementationOnce(() => new Promise(() => {}))
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()

				const pending = handler.completePrompt("ping", { abortSignal: caller.signal })
				await vitest.waitFor(() => expect(getModels).toHaveBeenCalled())
				caller.abort()

				await expect(pending).rejects.toMatchObject(aborted("Kenari"))
				expect(mockCreate).not.toHaveBeenCalled()
			})

			it("does not return a completion that resolves just before the caller aborts", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				let resolveCompletion: (value: unknown) => void = () => {}
				const completion = new Promise((resolve) => {
					resolveCompletion = resolve
				})
				mockCreate.mockImplementation(() => completion)

				const pending = handler.completePrompt("ping", { abortSignal: caller.signal })
				await vitest.waitFor(() => expect(mockCreate).toHaveBeenCalled())
				void completion.then(() => caller.abort())
				resolveCompletion({ choices: [{ message: { role: "assistant", content: "late" } }] })

				await expect(pending).rejects.toMatchObject(aborted("Kenari"))
			})

			it("reports an SDK abort error after the caller aborts as an AbortError, not a completion error", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				mockCreate.mockImplementation(async () => {
					caller.abort()
					throw new Error("Request was aborted.")
				})

				await expect(handler.completePrompt("ping", { abortSignal: caller.signal })).rejects.toMatchObject(
					{ name: "AbortError" }, // the entry guard rethrows the caller's own abort reason
				)
			})

			it("normalizes an SDK abort raised by the completion into the provider AbortError", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController() // the caller signal stays live while the SDK aborts on its own
				mockCreate.mockRejectedValue(new Error("Request was aborted."))
				const pending = handler.completePrompt("ping", { abortSignal: caller.signal })

				await expect(pending).rejects.toMatchObject(aborted("Kenari"))
			})
			it("detaches the bridge after completion, failure, and cancellation alike", async () => {
				const handler = new KenariHandler(mockOptions)
				const caller = new AbortController()
				const liveCall = () => handler.completePrompt("ping", { abortSignal: caller.signal })
				const added = vitest.spyOn(caller.signal, "addEventListener")
				const removed = vitest.spyOn(caller.signal, "removeEventListener")

				await expect(liveCall()).resolves.toBe("the answer")
				expect(caller.signal.aborted).toBe(false) // the success and failure rows never cancel
				mockCreate.mockRejectedValue(new Error("boom"))
				await expect(liveCall()).rejects.toThrow("Kenari completion error: boom")
				mockCreate.mockImplementation(() => new Promise(() => {}))
				const pending = liveCall().catch((error: unknown) => error)
				await vitest.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(3))
				caller.abort()
				expect(await pending).toMatchObject(aborted("Kenari")) // the cancel must surface as AbortError, not any rejection
				const aborts = added.mock.calls.filter(([type]) => type === "abort").map(([, listener]) => listener)
				expect(aborts).toHaveLength(3)
				expect(removed.mock.calls.filter(([type]) => type === "abort").map(([, l]) => l)).toEqual(aborts)
			})
		})
	})

	describe("model catalog", () => {
		it("reports its cache scope", () => {
			const handler = new KenariHandler(mockOptions)
			expect(handler.getModelCacheScope()).toEqual({ urlScoped: false, keyScoped: false, authScoped: false })
		})
	})
})
