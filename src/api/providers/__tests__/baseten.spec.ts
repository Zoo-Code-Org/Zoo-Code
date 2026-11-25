import { readFileSync } from "node:fs"

import { basetenDefaultModelId, basetenModels } from "@roo-code/types"

import { BasetenHandler } from "../baseten"
import { collectStream } from "../../../test-utils/stream"

// Keep the SDK and handler real. Only the HTTP transport is replaced.
const mockFetch = vi.fn<typeof fetch>()
const recordedStream = readFileSync(new URL("./fixtures/baseten/gpt-oss-120b.sse", import.meta.url), "utf8")

function makeHandler(options: ConstructorParameters<typeof BasetenHandler>[0] = {}) {
	return new BasetenHandler({ basetenApiKey: "test-baseten-key", ...options })
}

function streamResponse(body = recordedStream) {
	return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

async function sentRequest() {
	expect(mockFetch).toHaveBeenCalledOnce()
	const [input, init] = mockFetch.mock.calls[0]
	const request = new Request(input, init)
	const body: unknown = await request.json()
	return { request, body }
}

describe("BasetenHandler", () => {
	beforeEach(() => {
		mockFetch.mockReset()
		vi.stubGlobal("fetch", mockFetch)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("requires a Baseten key instead of using another provider's key", () => {
		expect(() => new BasetenHandler({ apiKey: "unrelated-provider-key" })).toThrow("API key is required")
	})

	it("sends the Baseten key, endpoint, default model and streaming options", async () => {
		mockFetch.mockResolvedValueOnce(streamResponse("data: [DONE]\n\n"))
		const handler = makeHandler({ apiKey: "unrelated-provider-key" })

		expect(handler.getModel()).toEqual({
			id: basetenDefaultModelId,
			info: basetenModels[basetenDefaultModelId],
		})
		await collectStream(handler.createMessage("Answer briefly.", [{ role: "user", content: "Hello" }]))

		const { request, body } = await sentRequest()
		expect(request.url).toBe("https://inference.baseten.co/v1/chat/completions")
		expect(request.method).toBe("POST")
		expect(request.headers.get("authorization")).toBe("Bearer test-baseten-key")
		expect(body).toMatchObject({
			model: basetenDefaultModelId,
			temperature: 0.5,
			messages: [
				{ role: "system", content: "Answer briefly." },
				{ role: "user", content: "Hello" },
			],
			stream: true,
			stream_options: { include_usage: true },
		})
	})

	it("replays recorded reasoning, text and final cumulative usage through the SDK", async () => {
		mockFetch.mockResolvedValueOnce(streamResponse())
		const handler = makeHandler({ apiModelId: "openai/gpt-oss-120b" })
		const chunks = await collectStream(
			handler.createMessage("", [{ role: "user", content: "Say hello. Use only one word." }]),
		)

		expect(
			chunks
				.filter((chunk) => chunk.type === "text")
				.map((chunk) => chunk.text)
				.join(""),
		).toBe("Hello")
		expect(
			chunks
				.filter((chunk) => chunk.type === "reasoning")
				.map((chunk) => chunk.text)
				.join(""),
		).toBe(
			' user wants: "Say hello. Use only one word." So output a single word, presumably "Hello". That\'s a one-word greeting. Should obey.',
		)
		const usage = chunks.filter((chunk) => chunk.type === "usage")
		expect(usage).toEqual([
			{
				type: "usage",
				inputTokens: 86,
				outputTokens: 39,
				cacheReadTokens: 64,
				cacheWriteTokens: undefined,
				totalCost: expect.any(Number),
			},
		])
		// The current catalog charges 22 uncached inputs and 39 outputs for this record.
		expect(usage[0].totalCost).toBeCloseTo(0.0000217, 12)
	})

	it("sends the configured model and temperature without a catalog fallback", async () => {
		mockFetch.mockResolvedValueOnce(streamResponse("data: [DONE]\n\n"))
		const handler = makeHandler({ apiModelId: "custom-baseten-model", modelTemperature: 0.2 })
		await collectStream(handler.createMessage("", []))

		const { body } = await sentRequest()
		expect(body).toMatchObject({ model: "custom-baseten-model", temperature: 0.2 })
	})

	it("completes a prompt with the configured Baseten model", async () => {
		mockFetch.mockResolvedValueOnce(
			Response.json({ choices: [{ message: { role: "assistant", content: "Hello" } }] }),
		)
		const handler = makeHandler({ apiModelId: "openai/gpt-oss-120b" })

		await expect(handler.completePrompt("Say hello.")).resolves.toBe("Hello")
		const { request, body } = await sentRequest()
		expect(request.url).toBe("https://inference.baseten.co/v1/chat/completions")
		expect(request.headers.get("authorization")).toBe("Bearer test-baseten-key")
		expect(body).toEqual({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "Say hello." }] })
	})

	it.each([
		{ status: 401, mode: "stream" },
		{ status: 401, mode: "completion" },
		{ status: 429, mode: "stream" },
		{ status: 429, mode: "completion" },
	])("preserves HTTP $status for $mode failures", async ({ status, mode }) => {
		mockFetch.mockResolvedValueOnce(
			Response.json(
				{ error: { message: "Baseten request rejected", type: "api_error", code: "test_error" } },
				{ status, headers: { "x-should-retry": "false" } },
			),
		)
		const handler = makeHandler()
		const result = mode === "stream" ? collectStream(handler.createMessage("", [])) : handler.completePrompt("Hi")

		await expect(result).rejects.toMatchObject({
			status,
			message: expect.stringContaining("Baseten request rejected"),
		})
		expect(mockFetch).toHaveBeenCalledOnce()
	})
})
