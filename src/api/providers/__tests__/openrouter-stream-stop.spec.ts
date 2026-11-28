import { OpenRouterHandler } from "../openrouter"
import { StreamStopError, matchChatCompletionsStreamStop } from "../utils/stream-stop-error"
import { sseResponse } from "../../../test-utils/stream"
import type { ApiStreamChunk } from "../../../api/transform/stream"

vi.mock("../fetchers/modelCache", () => ({ getModels: vi.fn(async () => ({})) }))
vi.mock("../fetchers/modelEndpointCache", () => ({ getModelEndpoints: vi.fn(async () => ({})) }))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureException: vi.fn() } },
}))

const modelId = "openai/gpt-4.1-nano"
const mockFetch = vi.fn<typeof fetch>()

const header = { id: "gen_test", object: "chat.completion.chunk", created: 1, model: modelId }

function sse(events: unknown[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
}

const stopChunk = { ...header, choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }
const usageChunk = {
	...header,
	choices: [],
	usage: { prompt_tokens: 1234, completion_tokens: 5, cost: 0.01 },
}

/** Collects chunks until the stream resolves or throws, and returns both. */
async function collectUntilStop(stream: AsyncIterable<ApiStreamChunk>): Promise<{
	chunks: ApiStreamChunk[]
	caught: unknown
}> {
	const chunks: ApiStreamChunk[] = []
	let caught: unknown
	try {
		for await (const chunk of stream) {
			chunks.push(chunk)
		}
	} catch (error) {
		caught = error
	}
	return { chunks, caught }
}

function openRouterStream(body: string): AsyncIterable<ApiStreamChunk> {
	mockFetch.mockResolvedValueOnce(sseResponse(body))
	const handler = new OpenRouterHandler({ openRouterApiKey: "test-api-key", openRouterModelId: modelId })
	return handler.createMessage("", [{ role: "user", content: "Reply with exactly: Hello." }])
}

describe("OpenRouterHandler stream stop reasons (issue 2769)", () => {
	beforeEach(() => {
		mockFetch.mockReset()
		vi.stubGlobal("fetch", mockFetch)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it.each([
		{
			name: "no text",
			events: [stopChunk, usageChunk],
			streamed: [],
		},
		{
			name: "reasoning only",
			events: [
				{ ...header, choices: [{ index: 0, delta: { reasoning: "thinking" }, finish_reason: null }] },
				stopChunk,
				usageChunk,
			],
			streamed: [{ type: "reasoning", text: "thinking" }],
		},
		{
			name: "partial text",
			events: [
				{ ...header, choices: [{ index: 0, delta: { content: "partial ans" }, finish_reason: null }] },
				stopChunk,
				usageChunk,
			],
			streamed: [{ type: "text", text: "partial ans" }],
		},
	])("rejects a content filter stop with $name before it counts as complete", async ({ events, streamed }) => {
		const { chunks, caught } = await collectUntilStop(openRouterStream(sse(events)))

		expect(caught).toBeInstanceOf(StreamStopError)
		const error = caught as StreamStopError
		expect(error.stopReason).toBe("content_filter")
		expect(error.message).toContain("content filter")

		// The chunks streamed before the stop still reached the consumer, but the
		// response never ends as complete: no usage chunk follows the error.
		expect(chunks).toEqual(streamed)

		// The stopped response's usage rides on the error instead of the stream.
		expect(error.usage).toMatchObject({ type: "usage", inputTokens: 1234, outputTokens: 5, totalCost: 0.01 })
	})

	it("rejects a stop that arrives with no usage chunk", async () => {
		const { chunks, caught } = await collectUntilStop(openRouterStream(sse([stopChunk])))

		expect(chunks).toEqual([])
		expect(caught).toBeInstanceOf(StreamStopError)
		expect((caught as StreamStopError).usage).toBeUndefined()
	})

	it("keeps usage when it arrives in the stop chunk itself", async () => {
		const combined = {
			...header,
			choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
			usage: { prompt_tokens: 1234, completion_tokens: 5, cost: 0.01 },
		}
		const { caught } = await collectUntilStop(openRouterStream(sse([combined])))

		expect(caught).toBeInstanceOf(StreamStopError)
		expect((caught as StreamStopError).usage).toMatchObject({ inputTokens: 1234, outputTokens: 5 })
	})

	it("rejects a refusal stop with its own reason", async () => {
		const refusalChunk = { ...header, choices: [{ index: 0, delta: {}, finish_reason: "refusal" }] }
		const { chunks, caught } = await collectUntilStop(openRouterStream(sse([refusalChunk, usageChunk])))

		expect(chunks).toEqual([])
		expect(caught).toBeInstanceOf(StreamStopError)
		const error = caught as StreamStopError
		expect(error.stopReason).toBe("refusal")
		expect(error.message).toContain("refusal")
		expect(error.usage).toMatchObject({ inputTokens: 1234 })
	})

	it("streams a normal stop response exactly as before", async () => {
		const { chunks, caught } = await collectUntilStop(
			openRouterStream(
				sse([
					{ ...header, choices: [{ index: 0, delta: { content: "Hello." }, finish_reason: null }] },
					{ ...header, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					usageChunk,
				]),
			),
		)

		expect(caught).toBeUndefined()
		expect(chunks).toEqual([
			{ type: "text", text: "Hello." },
			{
				type: "usage",
				inputTokens: 1234,
				outputTokens: 5,
				cacheReadTokens: undefined,
				reasoningTokens: undefined,
				totalCost: 0.01,
			},
		])
	})

	it("ignores a length stop like before (issue 425 stays out of scope)", async () => {
		const { chunks, caught } = await collectUntilStop(
			openRouterStream(
				sse([
					{ ...header, choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] },
					{ ...header, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
					usageChunk,
				]),
			),
		)

		expect(caught).toBeUndefined()
		expect(chunks.filter((chunk) => chunk.type === "usage")).toHaveLength(1)
	})

	it("treats an empty normal stream as an empty response, not a stop", async () => {
		const { chunks, caught } = await collectUntilStop(openRouterStream("data: [DONE]\n\n"))
		expect(caught).toBeUndefined()
		expect(chunks).toEqual([])
	})
})

describe("matchChatCompletionsStreamStop", () => {
	it.each(["content_filter", "refusal"] as const)("matches the $reason stop reason", (reason) => {
		const stop = matchChatCompletionsStreamStop(reason)
		expect(stop).toBeInstanceOf(StreamStopError)
		expect(stop?.stopReason).toBe(reason)
	})

	it.each([["stop"], ["length"], ["tool_calls"], ["function_call"], ["unknown"], [""]] as const)(
		"passes the %s finish reason through",
		(reason) => {
			expect(matchChatCompletionsStreamStop(reason)).toBeUndefined()
		},
	)

	it("passes null and undefined finish reasons through", () => {
		expect(matchChatCompletionsStreamStop(null)).toBeUndefined()
		expect(matchChatCompletionsStreamStop(undefined)).toBeUndefined()
	})
})
