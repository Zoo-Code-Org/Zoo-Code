import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as vscode from "vscode"
import {
	initZooCodeAuth,
	getCachedZooCodeToken,
	getCachedSubscriptionStatus,
	checkSubscriptionStatus,
	setZooCodeToken,
	clearZooCodeToken,
	getZooCodeBaseUrl,
	handleAuthCallback,
} from "../zoo-code-auth"

// Mock vscode
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((key: string, defaultValue?: string) => {
				if (key === "baseUrl") return undefined
				return defaultValue
			}),
		})),
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
	env: {
		asExternalUri: vi.fn(async (uri: any) => uri),
		openExternal: vi.fn(),
	},
	Uri: {
		parse: vi.fn((value: string) => ({ toString: () => value })),
	},
}))

// Mock fetch
const mockFetch = vi.fn()
global.fetch = mockFetch as any

describe("zoo-code-auth subscription checking", () => {
	let mockSecrets: any
	let mockContext: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockFetch.mockReset()

		// Create mock secret storage
		const secretStore: Record<string, string> = {}
		mockSecrets = {
			get: vi.fn(async (key: string) => secretStore[key]),
			store: vi.fn(async (key: string, value: string) => {
				secretStore[key] = value
			}),
			delete: vi.fn(async (key: string) => {
				delete secretStore[key]
			}),
			onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
		}

		mockContext = {
			secrets: mockSecrets,
		}
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("getCachedSubscriptionStatus", () => {
		it("should return 'unknown' initially", () => {
			expect(getCachedSubscriptionStatus()).toBe("unknown")
		})
	})

	describe("checkSubscriptionStatus", () => {
		it("should return 'inactive' when no token is present", async () => {
			await initZooCodeAuth(mockContext)
			const status = await checkSubscriptionStatus()
			expect(status).toBe("inactive")
			expect(mockFetch).not.toHaveBeenCalled()
		})

		it("should return 'active' when API returns isSubscriber true", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_test_token")

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ isSubscriber: true, planId: "pro", status: "active" }),
			})

			const status = await checkSubscriptionStatus()
			expect(status).toBe("active")
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("/api/subscription/status"),
				expect.objectContaining({
					headers: { Authorization: "Bearer zoo_ext_test_token" },
				}),
			)
		})

		it("should return 'inactive' when API returns isSubscriber false", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_test_token")

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ isSubscriber: false, planId: "free", status: "active" }),
			})

			const status = await checkSubscriptionStatus()
			expect(status).toBe("inactive")
		})

		it("should return 'unknown' when API request fails", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_test_token")

			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
			})

			const status = await checkSubscriptionStatus()
			expect(status).toBe("unknown")
		})

		it("should return 'unknown' when API throws error", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_test_token")

			mockFetch.mockRejectedValueOnce(new Error("Network error"))

			const status = await checkSubscriptionStatus()
			expect(status).toBe("unknown")
		})

		it("should use cached status when checked recently", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_test_token")

			// First call - should fetch from API
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ isSubscriber: true, planId: "pro", status: "active" }),
			})

			const status1 = await checkSubscriptionStatus()
			expect(status1).toBe("active")
			expect(mockFetch).toHaveBeenCalledTimes(1)

			// Second call immediately after - should use cache
			const status2 = await checkSubscriptionStatus()
			expect(status2).toBe("active")
			expect(mockFetch).toHaveBeenCalledTimes(1) // Still only 1 call
		})

		it("should handle timeout with AbortSignal", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_test_token")

			mockFetch.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"))

			const status = await checkSubscriptionStatus()
			expect(status).toBe("unknown")
		})
	})

	describe("getCachedZooCodeToken", () => {
		it("should return empty string when no token is set", async () => {
			// Clear any previous state
			await clearZooCodeToken()
			expect(getCachedZooCodeToken()).toBe("")
		})

		it("should return cached token after initialization", async () => {
			await mockSecrets.store("zoo-code-session-token", "zoo_ext_cached_token")
			await initZooCodeAuth(mockContext)
			expect(getCachedZooCodeToken()).toBe("zoo_ext_cached_token")
		})
	})

	describe("setZooCodeToken", () => {
		it("should reset subscription status when token changes", async () => {
			await initZooCodeAuth(mockContext)

			// Set initial token and check subscription
			await setZooCodeToken("zoo_ext_token1")
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ isSubscriber: true, planId: "pro", status: "active" }),
			})
			await checkSubscriptionStatus()
			expect(getCachedSubscriptionStatus()).toBe("active")

			// Change token - should reset status
			await setZooCodeToken("zoo_ext_token2")
			expect(getCachedSubscriptionStatus()).toBe("unknown")
		})
	})

	describe("handleAuthCallback", () => {
		it("does not persist invalid prefixed tokens", async () => {
			await initZooCodeAuth(mockContext)

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ valid: false }),
			})

			const success = await handleAuthCallback("zoo_ext_fake_token")

			expect(success).toBe(false)
			expect(getCachedZooCodeToken()).toBe("")
			expect(mockSecrets.store).not.toHaveBeenCalledWith("zoo-code-session-token", "zoo_ext_fake_token")
		})

		it("persists token only after backend verification succeeds", async () => {
			await initZooCodeAuth(mockContext)

			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ valid: true }),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ isSubscriber: true }),
				})

			const success = await handleAuthCallback("zoo_ext_real_token")

			expect(success).toBe(true)
			expect(getCachedZooCodeToken()).toBe("zoo_ext_real_token")
			expect(mockSecrets.store).toHaveBeenCalledWith("zoo-code-session-token", "zoo_ext_real_token")
		})
	})

	describe("clearZooCodeToken", () => {
		it("should reset subscription status when token is cleared", async () => {
			await initZooCodeAuth(mockContext)

			// Set token and check subscription
			await setZooCodeToken("zoo_ext_test_token")
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ isSubscriber: true, planId: "pro", status: "active" }),
			})
			await checkSubscriptionStatus()
			expect(getCachedSubscriptionStatus()).toBe("active")

			// Clear token - should reset status
			await clearZooCodeToken()
			expect(getCachedSubscriptionStatus()).toBe("unknown")
			expect(getCachedZooCodeToken()).toBe("")
		})
	})

	describe("getZooCodeBaseUrl", () => {
		it("should return default URL when not configured", () => {
			const baseUrl = getZooCodeBaseUrl()
			expect(baseUrl).toBe("https://www.zoocode.dev")
		})

		it("should respect ZOO_CODE_BASE_URL environment variable", () => {
			const originalEnv = process.env.ZOO_CODE_BASE_URL
			process.env.ZOO_CODE_BASE_URL = "https://staging.zoocode.dev"

			const baseUrl = getZooCodeBaseUrl()
			expect(baseUrl).toBe("https://staging.zoocode.dev")

			// Restore
			if (originalEnv) {
				process.env.ZOO_CODE_BASE_URL = originalEnv
			} else {
				delete process.env.ZOO_CODE_BASE_URL
			}
		})
	})
})
