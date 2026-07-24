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

	it("provides sane defaults for unknown model IDs without pricing", async () => {
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

	it("throws when response data is not an array", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: "not-an-array" }),
		}) as unknown as typeof fetch

		await expect(getMoonshotModels("https://api.moonshot.ai/v1", "mock-key")).rejects.toThrow(
			"Unexpected response format",
		)
	})

	it("throws when response data is missing", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({}),
		}) as unknown as typeof fetch

		await expect(getMoonshotModels("https://api.moonshot.ai/v1", "mock-key")).rejects.toThrow(
			"Unexpected response format",
		)
	})

	it("skips models with empty or non-string ID", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [{ id: "" }, { id: 123 }, { id: null }, { id: "kimi-k2-0905-preview" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMoonshotModels("https://api.moonshot.ai/v1", "mock-key")

		expect(Object.keys(models)).toHaveLength(1)
		expect(models["kimi-k2-0905-preview"]).toBeDefined()
	})

	it("includes Authorization header when apiKey provided", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		}) as unknown as typeof fetch

		await getMoonshotModels("https://api.moonshot.ai/v1", "my-secret-key")

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://api.moonshot.ai/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer my-secret-key",
				}),
			}),
		)
	})

	it("does not include Authorization header when no apiKey", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		}) as unknown as typeof fetch

		await getMoonshotModels("https://api.moonshot.ai/v1", undefined)

		const callArgs = (globalThis.fetch as any).mock.calls[0][1].headers
		expect(callArgs["Authorization"]).toBeUndefined()
	})

	it("mixes known and unknown models in same response", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [{ id: "kimi-k2-0905-preview" }, { id: "some-new-model" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMoonshotModels("https://api.moonshot.ai/v1", "mock-key")

		expect(models["kimi-k2-0905-preview"]).toEqual(moonshotModels["kimi-k2-0905-preview"])
		expect(models["some-new-model"]).toEqual({
			maxTokens: 16_000,
			contextWindow: 262_144,
			supportsImages: false,
			supportsPromptCache: true,
			description: "Moonshot model: some-new-model",
		})
	})

	it("handles HTTP error with unreadable body gracefully", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			text: vi.fn().mockRejectedValue(new Error("network error")),
		}) as unknown as typeof fetch

		await expect(getMoonshotModels("https://api.moonshot.ai/v1", "mock-key")).rejects.toThrow(
			"HTTP 500: Internal Server Error",
		)
	})
})
