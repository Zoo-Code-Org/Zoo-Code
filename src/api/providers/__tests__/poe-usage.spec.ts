import { PoeHandler } from "../poe"
import { collectStream } from "../../../test-utils/stream"

// The provider creates a default client during import. Stub HTTP before that happens.
const { mockFetch } = vi.hoisted(() => {
	const mockFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: [] }))
	vi.stubGlobal("fetch", mockFetch)
	return { mockFetch }
})

vi.mock("../fetchers/modelCache", () => ({
	getModelsFromCache: vi.fn(() => undefined),
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureException: vi.fn() } },
}))

type StreamEvent = { event?: string; data: unknown }

// Synthetic protocol examples, not recorded Poe responses. Keep both SDK layers
// and extractUsageMetrics real so usage normalization runs before handler output.
async function runStream(modelId: string, endpoint: string, events: StreamEvent[]) {
	const body = events
		.map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`)
		.join("")
	const requests: Request[] = []
	mockFetch.mockImplementation(async (input, init) => {
		const request = new Request(input, init)
		if (request.url === "https://api.poe.com/v1/models") {
			return Response.json({ data: [] })
		}
		requests.push(request)
		return new Response(body, { headers: { "content-type": "text/event-stream" } })
	})
	const handler = new PoeHandler({ poeApiKey: "test-poe-key", apiModelId: modelId })
	const chunks = await collectStream(handler.createMessage("Answer briefly.", [{ role: "user", content: "Hello" }]))

	expect(requests).toHaveLength(1)
	expect(requests[0].url).toBe(`https://api.poe.com/v1/${endpoint}`)
	expect(requests[0].headers.get("authorization") ?? requests[0].headers.get("x-api-key")).toBe(
		endpoint === "messages" ? "test-poe-key" : "Bearer test-poe-key",
	)
	expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([])
	return chunks
}

describe("PoeHandler usage through the real SDK", () => {
	beforeEach(() => {
		mockFetch.mockClear()
		vi.stubGlobal("fetch", mockFetch)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("normalizes Anthropic cache reads and writes into one final usage chunk", async () => {
		const chunks = await runStream("anthropic/claude-sonnet-4", "messages", [
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: {
						id: "msg_test",
						type: "message",
						role: "assistant",
						model: "claude-sonnet-4",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: 10,
							output_tokens: 0,
							cache_creation_input_tokens: 20,
							cache_read_input_tokens: 30,
						},
					},
				},
			},
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{
				event: "message_delta",
				data: {
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 5 },
				},
			},
			{ event: "message_stop", data: { type: "message_stop" } },
		])

		expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([{ type: "text", text: "Hello" }])
		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
			{
				type: "usage",
				inputTokens: 60,
				outputTokens: 5,
				cacheReadTokens: 30,
				cacheWriteTokens: 20,
				reasoningTokens: undefined,
			},
		])
	})

	it.each([
		{ cached: 4, expected: 4 },
		{ cached: 0, expected: 0 },
	])("reads Chat Completions cache usage with $cached cached tokens", async ({ cached, expected }) => {
		const header = { id: "chatcmpl_test", object: "chat.completion.chunk", created: 1, model: "gemini-2.5-flash" }
		const chunks = await runStream("google/gemini-2.5-flash", "chat/completions", [
			{
				data: {
					...header,
					choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
				},
			},
			{ data: { ...header, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
			{
				data: {
					...header,
					choices: [],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 5,
						total_tokens: 15,
						prompt_tokens_details: { cached_tokens: cached },
					},
				},
			},
		])

		expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([{ type: "text", text: "Hello" }])
		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
			{
				type: "usage",
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: expected,
				cacheWriteTokens: undefined,
				reasoningTokens: 0,
			},
		])
	})

	it.each([
		{ cached: 40, reasoning: 6 },
		{ cached: 0, reasoning: 0 },
	])("reads Responses usage with $cached cached and $reasoning reasoning tokens", async ({ cached, reasoning }) => {
		const response = { id: "resp_test", created_at: 1, model: "gpt-4.1" }
		const chunks = await runStream("openai/gpt-4.1", "responses", [
			{ data: { type: "response.created", response } },
			{
				data: {
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_test" },
				},
			},
			{ data: { type: "response.output_text.delta", item_id: "msg_test", delta: "Hello" } },
			{ data: { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_test" } } },
			{
				data: {
					type: "response.completed",
					response: {
						...response,
						status: "completed",
						usage: {
							input_tokens: 100,
							input_tokens_details: { cached_tokens: cached },
							output_tokens: 15,
							output_tokens_details: { reasoning_tokens: reasoning },
							total_tokens: 115,
						},
					},
				},
			},
		])

		expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([{ type: "text", text: "Hello" }])
		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
			{
				type: "usage",
				inputTokens: 100,
				outputTokens: 15,
				cacheReadTokens: cached,
				cacheWriteTokens: undefined,
				reasoningTokens: reasoning,
			},
		])
	})
})
