vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: { instance: { captureEvent: vi.fn() } },
}))
import { OpenAI } from "openai"
import { OpenAICompatibleEmbedder } from "../openai-compatible"
import { OpenRouterEmbedder } from "../openrouter"

import { ProviderPacerRegistry } from "../../provider-pacer"

vi.mock("openai")
vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))

const factories = [
	["OpenAI-compatible", () => new OpenAICompatibleEmbedder("https://example.test/v1", "test-key")],
	["OpenRouter", () => new OpenRouterEmbedder("test-key")],
] as const

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe.each(factories)("%s rate-limit boundary", (_name, createEmbedder) => {
	it("shares a workspace pause across instances without adding wrapper retries", async () => {
		const request = vi.fn()
		// This client double supplies only embeddings.create, the embedder transport.
		vi.mocked(OpenAI).mockImplementation(function () {
			return { embeddings: { create: request } } as unknown as OpenAI
		})
		const cause = Object.assign(new Error("rate limited"), {
			status: 429,
			headers: new Headers({ "retry-after": "60" }),
		})
		request.mockRejectedValueOnce(cause).mockResolvedValue({ data: [{ embedding: [0.25] }] })
		const first = createEmbedder()
		const second = createEmbedder()
		const registry = new ProviderPacerRegistry()
		const pacer = registry.get(first.rateLimitScope)
		const firstResult = pacer.run("first.ts", undefined, () => first.createEmbeddings(["first"]))
		await vi.advanceTimersByTimeAsync(0)
		const secondResult = pacer.run("second.ts", undefined, () => second.createEmbeddings(["second"]))
		await vi.advanceTimersByTimeAsync(59_999)
		expect(request).toHaveBeenCalledOnce()
		expect(first.rateLimitScope).toBe(second.rateLimitScope)
		await vi.advanceTimersByTimeAsync(1)
		await expect(firstResult).resolves.toMatchObject({ embeddings: [[0.25]] })
		await vi.advanceTimersByTimeAsync(375)
		await expect(secondResult).resolves.toMatchObject({ embeddings: [[0.25]] })
		expect(request).toHaveBeenCalledTimes(3)
	})
})
