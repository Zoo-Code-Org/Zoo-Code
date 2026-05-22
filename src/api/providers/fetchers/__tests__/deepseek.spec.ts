import { deepSeekModels } from "@roo-code/types"

import { getDeepSeekModels } from "../deepseek"

describe("getDeepSeekModels", () => {
	const originalFetch = globalThis.fetch
	const originalFallbackFlag = process.env.E2E_MOCK_MODEL_LIST_FALLBACK

	afterEach(() => {
		globalThis.fetch = originalFetch
		if (originalFallbackFlag === undefined) {
			delete process.env.E2E_MOCK_MODEL_LIST_FALLBACK
		} else {
			process.env.E2E_MOCK_MODEL_LIST_FALLBACK = originalFallbackFlag
		}
		vi.restoreAllMocks()
	})

	it("falls back to static models when explicit e2e fallback flag is enabled and /models returns 404", async () => {
		process.env.E2E_MOCK_MODEL_LIST_FALLBACK = "true"

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			statusText: "Not Found",
			text: vi.fn().mockResolvedValue('{"error":{"message":"Not found","type":"not_found"}}'),
		}) as unknown as typeof fetch

		const models = await getDeepSeekModels("http://127.0.0.1:43123/v1", "mock-key")

		expect(globalThis.fetch).toHaveBeenCalledWith("http://127.0.0.1:43123/models", expect.any(Object))
		expect(models["deepseek-v4-flash"]).toEqual(deepSeekModels["deepseek-v4-flash"])
		expect(models["deepseek-v4-pro"]).toEqual(deepSeekModels["deepseek-v4-pro"])
	})

	it("throws for 404 responses when fallback flag is not enabled", async () => {
		delete process.env.E2E_MOCK_MODEL_LIST_FALLBACK

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			statusText: "Not Found",
			text: vi.fn().mockResolvedValue('{"error":{"message":"Not found","type":"not_found"}}'),
		}) as unknown as typeof fetch

		await expect(getDeepSeekModels("http://127.0.0.1:43123/v1", "mock-key")).rejects.toThrow("HTTP 404: Not Found")
	})
})
