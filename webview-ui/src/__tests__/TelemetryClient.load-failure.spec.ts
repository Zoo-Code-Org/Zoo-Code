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
	 */
	it("does not queue events captured after a failed load, even when a later load succeeds", async () => {
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

		// Second enable: the factory now succeeds, so a client exists and the queue is
		// flushed. Only the pre-failure event may be gone already (it was cleared), and
		// the post-failure event must never reach PostHog.
		await telemetryClient.updateTelemetryState("enabled", "test-key", "test-user")

		expect(posthogMocks.init).toHaveBeenCalledTimes(1)
		expect(posthogMocks.capture).not.toHaveBeenCalled()

		consoleWarn.mockRestore()
	})
})
