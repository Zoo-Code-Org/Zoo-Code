import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import {
	checkSubscriptionStatus,
	clearZooCodeToken,
	clearZooCodeUserInfo,
	disconnectZooCode,
	getCachedSubscriptionStatus,
	getCachedZooCodeToken,
	getCachedZooCodeUserInfo,
	getZooCodeBaseUrl,
	handleAuthCallback,
	initZooCodeAuth,
	setZooCodeToken,
	setZooCodeUserInfo,
	verifyZooCodeToken,
} from "../zoo-code-auth"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((key: string, defaultValue?: string) => defaultValue),
		})),
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
}))

vi.mock("../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

const mockFetch = vi.fn()
global.fetch = mockFetch as any

describe("zoo-code-auth", () => {
	let mockSecrets: any
	let mockContext: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockFetch.mockReset()

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

	afterEach(async () => {
		await clearZooCodeToken()
		await clearZooCodeUserInfo()
		vi.restoreAllMocks()
	})

	describe("getCachedSubscriptionStatus", () => {
		it("returns unknown initially", () => {
			expect(getCachedSubscriptionStatus()).toBe("unknown")
		})
	})

	describe("checkSubscriptionStatus", () => {
		it("returns inactive when no token is present", async () => {
			await initZooCodeAuth(mockContext)

			const status = await checkSubscriptionStatus()

			expect(status).toBe("inactive")
			expect(mockFetch).not.toHaveBeenCalled()
		})

		it("returns active when the API reports an active subscriber", async () => {
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

		it("returns inactive when the API reports a free user", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_test_token")

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ isSubscriber: false, planId: "free", status: "active" }),
			})

			await expect(checkSubscriptionStatus()).resolves.toBe("inactive")
		})

		it("returns unknown when the API request fails", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_test_token")

			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
			})

			await expect(checkSubscriptionStatus()).resolves.toBe("unknown")
		})

		it("returns unknown when the API throws", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_test_token")
			mockFetch.mockRejectedValueOnce(new Error("Network error"))

			await expect(checkSubscriptionStatus()).resolves.toBe("unknown")
		})

		it("reuses the cached status when it was checked recently", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_test_token")

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ isSubscriber: true, planId: "pro", status: "active" }),
			})

			expect(await checkSubscriptionStatus()).toBe("active")
			expect(await checkSubscriptionStatus()).toBe("active")
			expect(mockFetch).toHaveBeenCalledTimes(1)
		})

		it("handles AbortSignal timeouts", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_test_token")
			mockFetch.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"))

			await expect(checkSubscriptionStatus()).resolves.toBe("unknown")
		})
	})

	describe("getCachedZooCodeToken", () => {
		it("returns an empty string when no token is set", async () => {
			await clearZooCodeToken()

			expect(getCachedZooCodeToken()).toBe("")
		})

		it("preloads the cached token during initialization", async () => {
			await mockSecrets.store("zoo-code-session-token", "zoo_ext_cached_token")
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ valid: true }),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ isSubscriber: true }),
				})

			await initZooCodeAuth(mockContext)
			await Promise.resolve()

			expect(getCachedZooCodeToken()).toBe("zoo_ext_cached_token")
		})
	})

	describe("initZooCodeAuth", () => {
		it("clears stored user info and token when the cached token is invalid", async () => {
			await mockSecrets.store("zoo-code-session-token", "zoo_ext_stale_token")
			await mockSecrets.store("zoo-code-user-name", "Jane Doe")
			await mockSecrets.store("zoo-code-user-email", "jane@example.com")
			await mockSecrets.store("zoo-code-user-image", "https://example.com/avatar.png")
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ valid: false }),
			})

			await initZooCodeAuth(mockContext)

			// Both token and user info should be cleared on a definitive invalid response
			expect(getCachedZooCodeToken()).toBe("")
			expect(getCachedZooCodeUserInfo()).toEqual({
				name: undefined,
				email: undefined,
				image: undefined,
			})
		})

		it("clears stored user info and token when backend returns HTTP error (invalid token)", async () => {
			await mockSecrets.store("zoo-code-session-token", "zoo_ext_stale_token")
			await mockSecrets.store("zoo-code-user-name", "Jane Doe")
			await mockSecrets.store("zoo-code-user-email", "jane@example.com")
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
			})

			await initZooCodeAuth(mockContext)

			expect(getCachedZooCodeToken()).toBe("")
			expect(getCachedZooCodeUserInfo()).toEqual({
				name: undefined,
				email: undefined,
				image: undefined,
			})
		})

		it("preserves token and user info when the backend is temporarily unreachable", async () => {
			await mockSecrets.store("zoo-code-session-token", "zoo_ext_valid_token")
			await mockSecrets.store("zoo-code-user-name", "Jane Doe")
			await mockSecrets.store("zoo-code-user-email", "jane@example.com")
			// Simulate a network error during verification
			mockFetch.mockRejectedValueOnce(new Error("Network error"))

			await initZooCodeAuth(mockContext)

			// Token and user info should be kept; subscription status should be unknown
			expect(getCachedZooCodeToken()).toBe("zoo_ext_valid_token")
			expect(getCachedZooCodeUserInfo().name).toBe("Jane Doe")
			expect(getCachedSubscriptionStatus()).toBe("unknown")
		})
	})

	describe("setZooCodeToken", () => {
		it("resets the cached subscription status when the token changes", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_token1")
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ isSubscriber: true, planId: "pro", status: "active" }),
			})
			await checkSubscriptionStatus()

			await setZooCodeToken("zoo_ext_token2")

			expect(getCachedSubscriptionStatus()).toBe("unknown")
		})
	})

	describe("clearZooCodeToken", () => {
		it("resets the cached subscription status when the token is cleared", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_test_token")
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ isSubscriber: true, planId: "pro", status: "active" }),
			})
			await checkSubscriptionStatus()

			await clearZooCodeToken()

			expect(getCachedSubscriptionStatus()).toBe("unknown")
			expect(getCachedZooCodeToken()).toBe("")
		})
	})

	describe("getZooCodeBaseUrl", () => {
		it("returns the default URL when ZOO_CODE_BASE_URL is not set", () => {
			const originalEnv = process.env.ZOO_CODE_BASE_URL
			delete process.env.ZOO_CODE_BASE_URL

			expect(getZooCodeBaseUrl()).toBe("https://www.zoocode.dev")

			if (originalEnv) {
				process.env.ZOO_CODE_BASE_URL = originalEnv
			}
		})

		it("respects ZOO_CODE_BASE_URL", () => {
			const originalEnv = process.env.ZOO_CODE_BASE_URL
			process.env.ZOO_CODE_BASE_URL = "https://staging.zoocode.dev"

			expect(getZooCodeBaseUrl()).toBe("https://staging.zoocode.dev")

			if (originalEnv) {
				process.env.ZOO_CODE_BASE_URL = originalEnv
			} else {
				delete process.env.ZOO_CODE_BASE_URL
			}
		})
	})

	describe("handleAuthCallback", () => {
		it("does not persist a token when backend verification fails", async () => {
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

		it("persists a token only after backend verification succeeds", async () => {
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

	describe("verifyZooCodeToken", () => {
		it("returns 'valid' when the backend confirms the token", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_valid_token")
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ valid: true }),
			})

			expect(await verifyZooCodeToken()).toBe("valid")
			// Token should NOT be cleared — no side effects
			expect(getCachedZooCodeToken()).toBe("zoo_ext_valid_token")
		})

		it("returns 'invalid' when the backend reports valid: false", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_invalid_token")
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ valid: false }),
			})

			expect(await verifyZooCodeToken()).toBe("invalid")
			// No side effects — caller decides what to do
			expect(getCachedZooCodeToken()).toBe("zoo_ext_invalid_token")
		})

		it("returns 'invalid' when the backend returns HTTP error", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_invalid_token")
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
			})

			expect(await verifyZooCodeToken()).toBe("invalid")
		})

		it("returns 'unreachable' when a network error occurs", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_token")
			mockFetch.mockRejectedValueOnce(new Error("Network error"))

			expect(await verifyZooCodeToken()).toBe("unreachable")
			// Token must NOT be cleared on network error
			expect(getCachedZooCodeToken()).toBe("zoo_ext_token")
		})

		it("returns 'invalid' when no token is stored", async () => {
			await initZooCodeAuth(mockContext)

			expect(await verifyZooCodeToken()).toBe("invalid")
		})
	})

	describe("setZooCodeUserInfo", () => {
		it("clears email when passed null", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeUserInfo({
				name: "Jane Doe",
				email: "jane@example.com",
				image: "https://example.com/avatar.png",
			})

			// Verify email is set
			expect(getCachedZooCodeUserInfo().email).toBe("jane@example.com")

			// Clear email with null
			await setZooCodeUserInfo({ email: null })

			// Email should be cleared, but other fields should remain
			const info = getCachedZooCodeUserInfo()
			expect(info.email).toBeUndefined()
			expect(info.name).toBe("Jane Doe")
			expect(info.image).toBe("https://example.com/avatar.png")
		})

		it("does not clear email when passed undefined", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeUserInfo({
				name: "Jane Doe",
				email: "jane@example.com",
				image: "https://example.com/avatar.png",
			})

			// Pass undefined for email - should preserve existing value
			await setZooCodeUserInfo({ name: "John Doe", email: undefined })

			const info = getCachedZooCodeUserInfo()
			expect(info.email).toBe("jane@example.com")
			expect(info.name).toBe("John Doe")
		})
	})

	describe("disconnectZooCode", () => {
		it("revokes the current token and clears cached auth state", async () => {
			await initZooCodeAuth(mockContext)
			await setZooCodeToken("zoo_ext_real_token")
			await setZooCodeUserInfo({
				name: "Jane Doe",
				email: "jane@example.com",
				image: "https://example.com/avatar.png",
			})
			mockFetch.mockResolvedValueOnce({ ok: true })

			await disconnectZooCode()

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("/api/extension/auth/revoke"),
				expect.objectContaining({
					method: "POST",
					headers: { Authorization: "Bearer zoo_ext_real_token" },
				}),
			)
			expect(getCachedZooCodeToken()).toBe("")
			expect(getCachedZooCodeUserInfo()).toEqual({
				name: undefined,
				email: undefined,
				image: undefined,
			})
		})
	})
})
