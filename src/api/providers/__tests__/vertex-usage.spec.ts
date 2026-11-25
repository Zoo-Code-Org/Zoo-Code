import { readFileSync } from "node:fs"
import { GoogleGenAI } from "@google/genai"

import { VertexHandler } from "../vertex"
import { collectStream, sseResponse } from "../../../test-utils/stream"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureException: vi.fn() } },
}))

const recordedStream = readFileSync(new URL("./fixtures/vertex/gemini-3-flash-preview.sse", import.meta.url), "utf8")

describe("VertexHandler recorded usage through the Google SDK", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("reports the final token totals from a recorded Vertex response", async () => {
		const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(sseResponse(recordedStream))
		vi.stubGlobal("fetch", mockFetch)
		const handler = new VertexHandler({
			apiModelId: "gemini-3-flash-preview",
			vertexProjectId: "test-project",
			vertexRegion: "global",
		})
		// Use API-key authentication for offline replay so the real SDK needs no ADC credentials.
		handler["client"] = new GoogleGenAI({ vertexai: true, apiKey: "test-vertex-key" })
		const chunks = await collectStream(
			handler.createMessage("", [{ role: "user", content: "Reply with exactly: Hello." }]),
		)

		expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([{ type: "text", text: "Hello." }])
		expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
			expect.objectContaining({ type: "usage", inputTokens: 6, outputTokens: 2, reasoningTokens: 26 }),
		])
		// Catalog prices per million tokens: $0.50 input and $3 output, including thoughts.
		expect(chunks.find((chunk) => chunk.type === "usage")?.totalCost).toBeCloseTo(0.000087, 12)
		expect(mockFetch).toHaveBeenCalledOnce()
	})
})
