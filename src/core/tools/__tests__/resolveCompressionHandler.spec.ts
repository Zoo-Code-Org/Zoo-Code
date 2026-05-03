// npx vitest run core/tools/__tests__/resolveCompressionHandler.spec.ts

import { resolveCompressionHandler, clearSubscriptionCache } from "../resolveCompressionHandler"
import { ZooGatewayApiHandler } from "../../../api/providers/zoo-gateway"

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch as any

// AbortSignal.timeout may not be available in the test environment
if (!AbortSignal.timeout) {
	AbortSignal.timeout = (_ms: number) => new AbortController().signal
}

describe("resolveCompressionHandler", () => {
	beforeEach(() => {
		mockFetch.mockReset()
		// Clear the module-level subscription cache before each test
		clearSubscriptionCache()
	})

	it("returns null when zooCodeApiKey is undefined", async () => {
		const result = await resolveCompressionHandler(undefined)
		expect(result).toBeNull()
		expect(mockFetch).not.toHaveBeenCalled()
	})

	it("returns null when zooCodeApiKey is an empty string", async () => {
		const result = await resolveCompressionHandler("")
		expect(result).toBeNull()
		expect(mockFetch).not.toHaveBeenCalled()
	})

	it("returns null when zooCodeApiKey is whitespace only", async () => {
		const result = await resolveCompressionHandler("   ")
		expect(result).toBeNull()
		expect(mockFetch).not.toHaveBeenCalled()
	})

	it("returns null when fetch throws a network error (fail open)", async () => {
		mockFetch.mockRejectedValue(new Error("Network error"))

		const result = await resolveCompressionHandler("zoo_sk_test")
		expect(result).toBeNull()
	})

	it("returns null when subscription API returns non-ok response", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 401,
			json: async () => ({ error: "Unauthorized" }),
		})

		const result = await resolveCompressionHandler("zoo_sk_test")
		expect(result).toBeNull()
	})

	it("returns null when subscription API returns { isSubscriber: false }", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ isSubscriber: false }),
		})

		const result = await resolveCompressionHandler("zoo_sk_test")
		expect(result).toBeNull()
	})

	it("returns a ZooGatewayApiHandler when subscription API returns { isSubscriber: true }", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ isSubscriber: true }),
		})

		const result = await resolveCompressionHandler("zoo_sk_test")
		expect(result).not.toBeNull()
		expect(result).toBeInstanceOf(ZooGatewayApiHandler)
	})

	it("uses the provided baseUrl in the fetch request", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ isSubscriber: true }),
		})

		await resolveCompressionHandler("zoo_sk_test", "https://custom.example.com")

		expect(mockFetch).toHaveBeenCalledWith(
			"https://custom.example.com/api/subscription/status",
			expect.objectContaining({
				headers: { Authorization: "Bearer zoo_sk_test" },
			}),
		)
	})

	it("caches subscription status and only fetches once for repeated calls with the same key", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ isSubscriber: true }),
		})

		const result1 = await resolveCompressionHandler("zoo_sk_cached")
		const result2 = await resolveCompressionHandler("zoo_sk_cached")

		expect(mockFetch).toHaveBeenCalledTimes(1)
		expect(result1).toBeInstanceOf(ZooGatewayApiHandler)
		expect(result2).toBeInstanceOf(ZooGatewayApiHandler)
	})

	it("caches non-subscriber status and only fetches once for repeated calls with the same key", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ isSubscriber: false }),
		})

		const result1 = await resolveCompressionHandler("zoo_sk_free")
		const result2 = await resolveCompressionHandler("zoo_sk_free")

		expect(mockFetch).toHaveBeenCalledTimes(1)
		expect(result1).toBeNull()
		expect(result2).toBeNull()
	})

	it("fetches again after clearSubscriptionCache is called for the specific key", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ isSubscriber: true }),
		})

		await resolveCompressionHandler("zoo_sk_refresh")
		clearSubscriptionCache("zoo_sk_refresh")
		await resolveCompressionHandler("zoo_sk_refresh")

		expect(mockFetch).toHaveBeenCalledTimes(2)
	})
})
