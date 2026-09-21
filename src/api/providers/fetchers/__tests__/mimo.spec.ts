import { mimoModels } from "@roo-code/types"

import { getMimoModels } from "../mimo"

describe("getMimoModels", () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it("merges API response with static model specs for known models", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [{ id: "mimo-v2.6-pro" }, { id: "mimo-v2.6-flash" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://token-plan-sgp.xiaomimimo.com/v1/models",
			expect.any(Object),
		)
		expect(models["mimo-v2.6-pro"]).toEqual(mimoModels["mimo-v2.6-pro"])
		expect(models["mimo-v2.6-flash"]).toEqual(mimoModels["mimo-v2.6-flash"])
	})

	it("provides MiMo-family defaults for unknown model IDs without pricing", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [{ id: "mimo-v3-future" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

		expect(models["mimo-v3-future"]).toEqual({
			maxTokens: 16_000,
			contextWindow: 262_144,
			supportsImages: false,
			supportsPromptCache: false,
			preserveReasoning: true,
			description: "MiMo model: mimo-v3-future",
		})
	})

	it("throws for HTTP errors", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			text: vi.fn().mockResolvedValue('{"error":{"message":"Invalid API key"}}'),
		}) as unknown as typeof fetch

		await expect(getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "invalid-key")).rejects.toThrow(
			"HTTP 401: Unauthorized",
		)
	})

	it("uses default Singapore base URL when none provided", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		}) as unknown as typeof fetch

		await getMimoModels(undefined, "mock-key")

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://token-plan-sgp.xiaomimimo.com/v1/models",
			expect.any(Object),
		)
	})

	it("keeps /v1 in base URL and strips trailing slash", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		}) as unknown as typeof fetch

		await getMimoModels("https://token-plan-cn.xiaomimimo.com/v1/", "mock-key")

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://token-plan-cn.xiaomimimo.com/v1/models",
			expect.any(Object),
		)
	})

	it("throws when response data is not an array", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: "not-an-array" }),
		}) as unknown as typeof fetch

		await expect(getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")).rejects.toThrow(
			"Unexpected response format",
		)
	})

	it("skips models with empty or non-string ID", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [{ id: "" }, { id: 123 }, { id: null }, { id: "mimo-v2.6-pro" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

		expect(Object.keys(models)).toHaveLength(1)
		expect(models["mimo-v2.6-pro"]).toBeDefined()
	})

	it("includes Authorization header when apiKey provided", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ data: [] }),
		}) as unknown as typeof fetch

		await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "my-secret-key")

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://token-plan-sgp.xiaomimimo.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer my-secret-key",
				}),
			}),
		)
	})

	it("mixes known and unknown models in same response", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({
				data: [{ id: "mimo-v2.6-pro" }, { id: "some-new-model" }],
			}),
		}) as unknown as typeof fetch

		const models = await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key")

		expect(models["mimo-v2.6-pro"]).toEqual(mimoModels["mimo-v2.6-pro"])
		expect(models["some-new-model"]).toEqual({
			maxTokens: 16_000,
			contextWindow: 262_144,
			supportsImages: false,
			supportsPromptCache: false,
			preserveReasoning: true,
			description: "MiMo model: some-new-model",
		})
	})

	it("passes the caller's abort signal to the request", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))
		const controller = new AbortController()

		await getMimoModels("https://token-plan-sgp.xiaomimimo.com/v1", "mock-key", { signal: controller.signal })

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://token-plan-sgp.xiaomimimo.com/v1/models",
			expect.objectContaining({ signal: controller.signal }),
		)
	})
})
