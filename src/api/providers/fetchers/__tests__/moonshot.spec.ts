import { moonshotModels } from "@roo-code/types"

import { getMoonshotModels } from "../moonshot"

describe("getMoonshotModels", () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it("merges API response with static model specs for known models", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [{ id: "kimi-k2-0905-preview" }, { id: "kimi-k2-thinking" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMoonshotModels("https://api.moonshot.ai/v1", "mock-key")

		expect(globalThis.fetch).toHaveBeenCalledWith("https://api.moonshot.ai/v1/models", expect.any(Object))
		expect(models["kimi-k2-0905-preview"]).toEqual(moonshotModels["kimi-k2-0905-preview"])
		expect(models["kimi-k2-thinking"]).toEqual(moonshotModels["kimi-k2-thinking"])
	})

	it("provides sane defaults for unknown model IDs", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [{ id: "unknown-model-id" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMoonshotModels("https://api.moonshot.ai/v1", "mock-key")

		expect(models["unknown-model-id"]).toEqual({
			maxTokens: 16_000,
			contextWindow: 262_144,
			supportsImages: false,
			supportsPromptCache: true,
			inputPrice: 0.6,
			outputPrice: 2.5,
			cacheWritesPrice: 0,
			cacheReadsPrice: 0.15,
			description: "Moonshot model: unknown-model-id",
		})
	})

	it("throws for HTTP errors", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			text: vi.fn().mockResolvedValue('{"error":{"message":"Invalid API key"}}'),
		}) as unknown as typeof fetch

		await expect(getMoonshotModels("https://api.moonshot.ai/v1", "invalid-key")).rejects.toThrow(
			"HTTP 401: Unauthorized",
		)
	})

	it("uses default base URL when none provided", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		}) as unknown as typeof fetch

		await getMoonshotModels(undefined, "mock-key")

		expect(globalThis.fetch).toHaveBeenCalledWith("https://api.moonshot.ai/v1/models", expect.any(Object))
	})

	it("keeps /v1 in base URL and strips trailing slash", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		}) as unknown as typeof fetch

		await getMoonshotModels("https://api.moonshot.cn/v1/", "mock-key")

		expect(globalThis.fetch).toHaveBeenCalledWith("https://api.moonshot.cn/v1/models", expect.any(Object))
	})
})
