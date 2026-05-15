import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
	mockCheckSubscriptionStatus,
	mockGetCachedSubscriptionStatus,
	mockGetCachedZooCodeToken,
	mockGetZooCodeBaseUrl,
} = vi.hoisted(() => ({
	mockCheckSubscriptionStatus: vi.fn(),
	mockGetCachedSubscriptionStatus: vi.fn(),
	mockGetCachedZooCodeToken: vi.fn(),
	mockGetZooCodeBaseUrl: vi.fn(),
}))

vi.mock("../zoo-code-auth", () => ({
	checkSubscriptionStatus: mockCheckSubscriptionStatus,
	getCachedSubscriptionStatus: mockGetCachedSubscriptionStatus,
	getCachedZooCodeToken: mockGetCachedZooCodeToken,
	getZooCodeBaseUrl: mockGetZooCodeBaseUrl,
}))

import { sendLlmTelemetry } from "../zoo-telemetry"

describe("sendLlmTelemetry", () => {
	const payload = {
		taskId: "task-123",
		provider: "anthropic",
		model: "claude-sonnet-4",
		mode: "code",
		inputTokens: 11,
		outputTokens: 7,
		cacheReadTokens: 3,
		cacheWriteTokens: 5,
		totalCost: 1.23,
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockGetZooCodeBaseUrl.mockReturnValue("https://www.zoocode.dev")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("skips telemetry when there is no cached token", async () => {
		mockGetCachedZooCodeToken.mockReturnValue("")
		global.fetch = vi.fn()

		await sendLlmTelemetry(payload)

		expect(global.fetch).not.toHaveBeenCalled()
	})

	it("refreshes an unknown subscription status before sending", async () => {
		mockGetCachedZooCodeToken.mockReturnValue("zoo_ext_test_token")
		mockGetCachedSubscriptionStatus.mockReturnValue("unknown")
		mockCheckSubscriptionStatus.mockResolvedValue("inactive")
		global.fetch = vi.fn()

		await sendLlmTelemetry(payload)

		expect(mockCheckSubscriptionStatus).toHaveBeenCalled()
		expect(global.fetch).not.toHaveBeenCalled()
	})

	it("fires the observability request without waiting for it to settle", async () => {
		mockGetCachedZooCodeToken.mockReturnValue("zoo_ext_test_token")
		mockGetCachedSubscriptionStatus.mockReturnValue("active")

		let resolveFetch: ((value: unknown) => void) | undefined
		global.fetch = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveFetch = resolve
				}),
		) as typeof fetch

		const result = await Promise.race([
			sendLlmTelemetry(payload).then(() => "resolved"),
			new Promise((resolve) => setTimeout(() => resolve("timeout"), 20)),
		])

		expect(result).toBe("resolved")
		expect(global.fetch).toHaveBeenCalledWith(
			"https://www.zoocode.dev/api/observability/events",
			expect.objectContaining({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer zoo_ext_test_token",
				},
				signal: expect.any(AbortSignal),
			}),
		)
		expect(JSON.parse((global.fetch as any).mock.calls[0][1].body)).toMatchObject({
			...payload,
			status: "completed",
			editor: "vscode",
		})

		resolveFetch?.({ ok: true })
	})

	it("sends cancelled status when provided in payload", async () => {
		mockGetCachedZooCodeToken.mockReturnValue("zoo_ext_test_token")
		mockGetCachedSubscriptionStatus.mockReturnValue("active")

		global.fetch = vi.fn().mockResolvedValue({ ok: true })

		await sendLlmTelemetry({ ...payload, status: "cancelled" })

		expect(JSON.parse((global.fetch as any).mock.calls[0][1].body)).toMatchObject({
			...payload,
			status: "cancelled",
			editor: "vscode",
		})
	})

	it("defaults to completed status when not provided", async () => {
		mockGetCachedZooCodeToken.mockReturnValue("zoo_ext_test_token")
		mockGetCachedSubscriptionStatus.mockReturnValue("active")

		global.fetch = vi.fn().mockResolvedValue({ ok: true })

		await sendLlmTelemetry(payload)

		expect(JSON.parse((global.fetch as any).mock.calls[0][1].body)).toMatchObject({
			status: "completed",
		})
	})
})
