import { beforeEach, describe, expect, it, vi } from "vitest"

const posthogMocks = vi.hoisted(() => ({
	init: vi.fn(),
	reset: vi.fn(),
	identify: vi.fn(),
	capture: vi.fn(),
}))

const factoryState = vi.hoisted(() => ({ attempts: 0 }))

// The factory throws on its first evaluation and succeeds afterwards, which mirrors a
// transient chunk fetch failure followed by a successful retry. This lives in its own
// file because vitest caches a module factory for the whole file, so a per-test failure
// toggle would leak into the sibling specs.
vi.mock("posthog-js", () => {
	factoryState.attempts += 1

	if (factoryState.attempts === 1) {
		throw new Error("Failed to fetch dynamically imported module")
	}

	return { default: posthogMocks }
})

describe("TelemetryClient after a failed PostHog chunk load", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		factoryState.attempts = 0
	})

	it("warns and skips init when the chunk cannot be loaded", async () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.resetModules()
		const { telemetryClient } = await import("@src/utils/TelemetryClient")

		const enabling = telemetryClient.updateTelemetryState("enabled", "test-key", "test-user")
		telemetryClient.capture("queued_before_failure")
		await enabling

		expect(consoleWarn).toHaveBeenCalledWith("Failed to load PostHog:", expect.any(Error))
		expect(posthogMocks.init).not.toHaveBeenCalled()
		expect(posthogMocks.capture).not.toHaveBeenCalled()

		consoleWarn.mockRestore()
	})

	/**
	 * Regression guard for the `posthogLoadFailed` flag. A failed load must stop queueing,
	 * because the queue is only drained by a successful load and would otherwise grow
	 * until the cap and then replay events that were captured while telemetry had no
	 * client at all.
	 *
	 * The assertion is falsifiable because the retry makes a client observable: if the
	 * flag were removed, the post-failure captures would still be in the queue when the
	 * retry succeeds and would be replayed by flushPendingEvents.
	 *
	 * The same retry also pins the opposite edge: the flag is cleared when a load attempt
	 * starts, so events captured while the retry is in flight queue up and flush on
	 * success. Without that reset they would be dropped for the whole retry window.
	 */
	it("drops events captured after a failed load but queues those captured during the retry", async () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.resetModules()
		const { telemetryClient } = await import("@src/utils/TelemetryClient")

		// First enable: the factory throws, so the chunk load rejects.
		const failedEnabling = telemetryClient.updateTelemetryState("enabled", "test-key", "test-user")
		telemetryClient.capture("queued_before_failure")
		await failedEnabling

		expect(consoleWarn).toHaveBeenCalledWith("Failed to load PostHog:", expect.any(Error))
		expect(posthogMocks.init).not.toHaveBeenCalled()

		// Captured after the failure. With the flag these are dropped; without it they
		// would sit in the queue for the retry below to replay.
		telemetryClient.capture("captured_after_failure")

		// Second enable: the factory now succeeds. The capture below runs before this
		// promise resolves, which is the retry window the flag reset opens; init not
		// having run yet proves the window was genuinely open.
		const retrying = telemetryClient.updateTelemetryState("enabled", "test-key", "test-user")
		expect(posthogMocks.init).not.toHaveBeenCalled()
		telemetryClient.capture("captured_during_retry")
		await retrying

		// Only the in-flight retry event may reach PostHog: the pre-failure event was
		// cleared with the failed load, and the post-failure one was dropped by the flag.
		expect(posthogMocks.init).toHaveBeenCalledTimes(1)
		expect(posthogMocks.capture).toHaveBeenCalledTimes(1)
		expect(posthogMocks.capture).toHaveBeenCalledWith(
			"captured_during_retry",
			expect.objectContaining({ releaseChannel: "stable" }),
		)

		consoleWarn.mockRestore()
	})
})
