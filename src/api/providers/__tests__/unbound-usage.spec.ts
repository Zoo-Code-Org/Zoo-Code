import type OpenAI from "openai"

import { UnboundHandler } from "../unbound"
import { collectStream, sseResponse } from "../../../test-utils/stream"

vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn(async () => ({
		"test-model": {
			contextWindow: 128000,
			maxTokens: 4096,
			inputPrice: 2,
			outputPrice: 4,
			cacheReadsPrice: 0.5,
			cacheWritesPrice: 3,
		},
	})),
}))

type UnboundUsage = OpenAI.CompletionUsage & {
	cache_creation_input_tokens?: number
	cache_read_input_tokens?: number
}

const mockFetch = vi.fn<typeof fetch>()

// Synthetic protocol examples, not recorded Unbound responses.
async function runStream(usage?: UnboundUsage) {
	const header = { id: "chatcmpl_test", object: "chat.completion.chunk", created: 1, model: "test-model" }
	const events = [
		{
			...header,
			choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
			...(usage && { usage: { ...usage, completion_tokens: 1 } }),
		},
		{ ...header, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		...(usage ? [{ ...header, choices: [], usage }] : []),
	]
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
	mockFetch.mockResolvedValueOnce(sseResponse(body))
	const handler = new UnboundHandler({ unboundApiKey: "test-unbound-key", unboundModelId: "test-model" })
	return collectStream(handler.createMessage("Answer briefly.", [{ role: "user", content: "Hello" }]))
}

describe("UnboundHandler usage through the real OpenAI SDK", () => {
	beforeEach(() => {
		mockFetch.mockReset()
		vi.stubGlobal("fetch", mockFetch)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it.each([
		{ name: "cache reads and writes", cacheRead: 3, cacheWrite: 2, cost: 0.0000375 },
		{ name: "zero cache fields", cacheRead: 0, cacheWrite: 0, cost: 0.00004 },
	])("reports final cumulative totals once with $name", async ({ cacheRead, cacheWrite, cost }) => {
		const chunks = await runStream({
			prompt_tokens: 10,
			completion_tokens: 5,
			total_tokens: 15,
			cache_read_input_tokens: cacheRead,
			cache_creation_input_tokens: cacheWrite,
		})

		expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([{ type: "text", text: "Hello" }])
		const usage = chunks.filter((chunk) => chunk.type === "usage")
		expect(usage).toHaveLength(1)
		expect(usage[0]).toMatchObject({
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: cacheRead,
			cacheWriteTokens: cacheWrite,
		})
		expect(usage[0].totalCost).toBeCloseTo(cost, 12)
		expect(mockFetch).toHaveBeenCalledOnce()
		const [input, init] = mockFetch.mock.calls[0]
		const request = new Request(input, init)
		expect(request.url).toBe("https://api.getunbound.ai/v1/chat/completions")
		expect(request.headers.get("authorization")).toBe("Bearer test-unbound-key")
		await expect(request.json()).resolves.toMatchObject({ model: "test-model", stream: true })
	})

	it("defaults absent cache fields to zero and preserves zero token totals", async () => {
		const chunks = await runStream({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
			{ type: "usage", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 },
		])
	})

	it("does not invent usage when the stream has no usage fields", async () => {
		const chunks = await runStream()
		expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([{ type: "text", text: "Hello" }])
		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([])
	})
})
