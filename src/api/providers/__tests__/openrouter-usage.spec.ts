import { readFileSync } from "node:fs"

import { OpenRouterHandler } from "../openrouter"
import { collectStream, sseResponse } from "../../../test-utils/stream"

vi.mock("../fetchers/modelCache", () => ({ getModels: vi.fn(async () => ({})) }))
vi.mock("../fetchers/modelEndpointCache", () => ({ getModelEndpoints: vi.fn(async () => ({})) }))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureException: vi.fn() } },
}))

const modelId = "openai/gpt-4.1-nano"
const recordedStream = readFileSync(new URL("./fixtures/openrouter/gpt-4.1-nano.sse", import.meta.url), "utf8")
const mockFetch = vi.fn<typeof fetch>()

async function replay(body: string) {
	mockFetch.mockResolvedValueOnce(sseResponse(body))
	const handler = new OpenRouterHandler({ openRouterApiKey: "test-openrouter-key", openRouterModelId: modelId })
	const chunks = await collectStream(
		handler.createMessage("", [{ role: "user", content: "Reply with exactly: Hello." }]),
	)
	expect(mockFetch).toHaveBeenCalledOnce()
	return chunks
}

describe("OpenRouterHandler usage through the real SDK", () => {
	beforeEach(() => {
		mockFetch.mockReset()
		vi.stubGlobal("fetch", mockFetch)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("does not add upstream cost again for a recorded non-BYOK response", async () => {
		const chunks = await replay(recordedStream)

		expect(
			chunks
				.filter((chunk) => chunk.type === "text")
				.map((chunk) => chunk.text)
				.join(""),
		).toBe("Hello.")
		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
			{
				type: "usage",
				inputTokens: 13,
				outputTokens: 3,
				cacheReadTokens: 0,
				reasoningTokens: 0,
				totalCost: 0.0000025,
			},
		])

		const [input, init] = mockFetch.mock.calls[0]
		const request = new Request(input, init)
		expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions")
		expect(request.headers.get("authorization")).toBe("Bearer test-openrouter-key")
		const body: unknown = await request.json()
		expect(body).toMatchObject({ model: modelId, stream: true })
		expect(body).not.toHaveProperty("stream_options")
	})

	it.each([
		{
			name: "BYOK inference and router fee",
			billing: { is_byok: true, cost: 0.00002, cost_details: { upstream_inference_cost: 0.0004 } },
			expected: 0.00042,
		},
		{
			name: "BYOK inference with no router fee",
			billing: { is_byok: true, cost: 0, cost_details: { upstream_inference_cost: 0.0004 } },
			expected: 0.0004,
		},
		{
			name: "BYOK inference with a missing cost field",
			billing: { is_byok: true, cost_details: { upstream_inference_cost: 0.0004 } },
			expected: 0.0004,
		},
		{
			name: "BYOK fee with missing upstream details",
			billing: { is_byok: true, cost: 0.00002 },
			expected: 0.00002,
		},
		{
			name: "BYOK fee with null upstream details",
			billing: { is_byok: true, cost: 0.00002, cost_details: null },
			expected: 0.00002,
		},
		{
			name: "null cost fields",
			billing: { is_byok: true, cost: null, cost_details: { upstream_inference_cost: null } },
			expected: 0,
		},
		{
			name: "a free non-BYOK response with upstream cost",
			billing: { is_byok: false, cost: 0, cost_details: { upstream_inference_cost: 0.0004 } },
			expected: 0,
		},
		{
			name: "cost without a BYOK flag",
			billing: { cost: 0.0004, cost_details: { upstream_inference_cost: 0.0003 } },
			expected: 0.0004,
		},
		{ name: "missing cost fields", billing: {}, expected: 0 },
	])("reports final cost once for $name", async ({ billing, expected }) => {
		// Synthetic cases supplement the recorded non-BYOK response.
		const header = { id: "gen_test", object: "chat.completion.chunk", created: 1, model: modelId }
		const events = [
			{
				...header,
				choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
				usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: 1 },
			},
			{ ...header, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			{
				...header,
				choices: [],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, ...billing },
			},
		]
		const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
		const chunks = await replay(body)
		const usage = chunks.filter((chunk) => chunk.type === "usage")

		expect(usage).toHaveLength(1)
		expect(usage[0]).toMatchObject({ inputTokens: 10, outputTokens: 5 })
		expect(usage[0].totalCost).toBeCloseTo(expected, 12)
	})
})
