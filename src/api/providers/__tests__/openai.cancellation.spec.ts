// npx vitest run api/providers/__tests__/openai.cancellation.spec.ts

import { OpenAiHandler } from "../openai"
import { makeApiHandlerOptions, makeCreateMessageMetadata } from "../../../test-utils/api"
import { asyncStreamFrom } from "../../../test-utils/stream"
import type { ApiStreamChunk } from "../../transform/stream"

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn().mockReturnValue(300_000),
}))

const mockCreate = vitest.fn()

vitest.mock("openai", () => {
	const mockConstructor = vitest.fn()
	return {
		__esModule: true,
		APIUserAbortError: class extends Error {},
		default: mockConstructor.mockImplementation(function () {
			return { chat: { completions: { create: mockCreate } } }
		}),
	}
})

const standardHandler = () =>
	new OpenAiHandler(
		makeApiHandlerOptions({
			openAiApiKey: "test-api-key",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "https://api.openai.com/v1",
		}),
	)

// The O-series dispatch is a model-id check in createMessage, so the same construct is reached
// through an o3 model id on the same handler class.
const oSeriesHandler = (streamingEnabled = true) =>
	new OpenAiHandler(
		makeApiHandlerOptions({
			openAiApiKey: "test-api-key",
			openAiModelId: "o3-mini",
			openAiBaseUrl: "https://api.openai.com/v1",
			openAiStreamingEnabled: streamingEnabled,
		}),
	)

const standardNonStreamingHandler = () =>
	new OpenAiHandler(
		makeApiHandlerOptions({
			openAiApiKey: "test-api-key",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "https://api.openai.com/v1",
			openAiStreamingEnabled: false,
		}),
	)

const toolCall = (index: number, id: string) => ({
	index,
	id,
	type: "function",
	function: { name: "test_tool_" + String(index), arguments: '{"arg":' + String(index) + "}" },
})

const usageFixture = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }

const nonStreamingResponse = (message: Record<string, unknown>) => ({
	id: "test-completion",
	choices: [{ message: { role: "assistant", refusal: null, ...message }, finish_reason: "stop", index: 0 }],
	usage: usageFixture,
})

/**
 * Consume a stream lazily, cancel the caller the moment its first event arrives, and record
 * every event that still reaches the caller afterwards. The assertions ask the question the row
 * asks - the complete subsequent event array must be empty - rather than checking only the
 * events the provider happens to drop.
 */
async function cancelAtFirstEvent(handler: OpenAiHandler): Promise<{
	preAbort: ApiStreamChunk[]
	postAbort: ApiStreamChunk[]
	failure: unknown
}> {
	const controller = new AbortController()
	const preAbort: ApiStreamChunk[] = []
	const postAbort: ApiStreamChunk[] = []
	const consuming = (async () => {
		try {
			for await (const event of handler.createMessage(
				"system prompt",
				[],
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)) {
				if (preAbort.length === 0) {
					preAbort.push(event)
					controller.abort()
					continue
				}
				postAbort.push(event)
			}
			return null
		} catch (error) {
			return error
		}
	})()
	return { preAbort, postAbort, failure: await consuming }
}

/**
 * Resolve the mocked request only once the caller has cancelled: the arrived answer exists, and
 * the provider is the one that has to decide what to do with it.
 */
function resolveAfterCallerCancels(controller: AbortController, value: unknown) {
	mockCreate.mockImplementationOnce(() => {
		if (controller.signal.aborted) {
			return Promise.resolve(value)
		}
		return new Promise((resolve) => {
			controller.signal.addEventListener("abort", () => resolve(value), { once: true })
		})
	})
}

const expectAbortContract = (failure: unknown) => {
	const error = failure as Error
	expect(error?.name, JSON.stringify(failure)).toBe("AbortError")
	expect(error.message.endsWith("request was aborted"), error.message).toBe(true)
}

describe("OpenAiHandler cancellation", () => {
	beforeEach(() => {
		mockCreate.mockReset()
	})

	describe("streaming: no events after the caller cancels", () => {
		it("releases nothing left in a chunk that mixed reasoning, content and tool calls (standard OpenAI)", async () => {
			// One chunk carries every event class at once: reasoning, content, two tool-call
			// partials and the finish_reason that would finalize them. A cancellation landing after
			// the first event must stop the rest instead of draining the chunk.
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									reasoning_content: "thinking",
									content: "tail",
									tool_calls: [toolCall(0, "call_1"), toolCall(1, "call_2")],
								},
								finish_reason: "tool_calls",
								index: 0,
							},
						],
					},
				]),
			)

			const { preAbort, postAbort, failure } = await cancelAtFirstEvent(standardHandler())

			expect(preAbort.length).toBeGreaterThan(0)
			expect(postAbort).toEqual([])
			expectAbortContract(failure)
		})

		it("releases nothing left in a chunk that mixed content and tool calls (O-series)", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: { content: "tail", tool_calls: [toolCall(0, "call_1"), toolCall(1, "call_2")] },
								finish_reason: "tool_calls",
								index: 0,
							},
						],
					},
				]),
			)

			const { preAbort, postAbort, failure } = await cancelAtFirstEvent(oSeriesHandler())

			expect(preAbort).toEqual([{ type: "text", text: "tail" }])
			expect(postAbort).toEqual([])
			expectAbortContract(failure)
		})
	})

	describe("non-streaming: the signal is re-read after the response arrives", () => {
		const mixedToolCallResponse = nonStreamingResponse({
			content: "answer",
			tool_calls: [toolCall(0, "call_1")],
		})

		const drainUntilCancelled = async (handler: OpenAiHandler, controller: AbortController) => {
			const released: ApiStreamChunk[] = []
			const done = (async () => {
				try {
					for await (const event of handler.createMessage(
						"system prompt",
						[],
						makeCreateMessageMetadata({ abortSignal: controller.signal }),
					)) {
						released.push(event)
					}
					return null
				} catch (error) {
					return error
				}
			})()
			controller.abort()
			return { released, failure: await done }
		}

		it("discards the arrived text and tool calls when the caller cancelled in flight (standard OpenAI)", async () => {
			const controller = new AbortController()
			resolveAfterCallerCancels(controller, mixedToolCallResponse)

			const { released, failure } = await drainUntilCancelled(standardNonStreamingHandler(), controller)

			expect(released).toEqual([])
			expectAbortContract(failure)
		})

		it("discards the arrived text and tool calls when the caller cancelled in flight (O-series)", async () => {
			const controller = new AbortController()
			resolveAfterCallerCancels(controller, mixedToolCallResponse)

			const { released, failure } = await drainUntilCancelled(oSeriesHandler(false), controller)

			expect(released).toEqual([])
			expectAbortContract(failure)
		})

		it("does not report a completed prompt when the caller cancelled while the answer was in flight", async () => {
			const controller = new AbortController()
			resolveAfterCallerCancels(controller, nonStreamingResponse({ content: "answer" }))

			const handler = standardNonStreamingHandler()
			const answered = handler.completePrompt("prompt", { abortSignal: controller.signal })
			controller.abort()
			const failure = await answered.then(
				(): unknown => null,
				(error: unknown) => error,
			)

			expectAbortContract(failure)
		})
	})
})
