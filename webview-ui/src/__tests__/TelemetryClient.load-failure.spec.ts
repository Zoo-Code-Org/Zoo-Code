import { beforeEach, describe, expect, it, vi } from "vitest"

const posthogMocks = vi.hoisted(() => ({
	init: vi.fn(),
	reset: vi.fn(),
	identify: vi.fn(),
	capture: vi.fn(),
}))

// A failing factory makes the client's `import("posthog-js")` reject, which is how a
// failed chunk fetch surfaces at runtime. This lives in its own file because vitest
// caches a module factory for the whole file, so a per-test failure toggle would leak
// into the sibling specs.
vi.mock("posthog-js", () => {
	throw new Error("Failed to fetch dynamically imported module")
})

describe("TelemetryClient with an unloadable PostHog chunk", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("warns, skips init, and stops queueing events", async () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { telemetryClient } = await import("@src/utils/TelemetryClient")

		const enabling = telemetryClient.updateTelemetryState("enabled", "test-key", "test-user")
		telemetryClient.capture("queued_before_failure")
		await enabling

		expect(consoleWarn).toHaveBeenCalledWith("Failed to load PostHog:", expect.any(Error))
		expect(posthogMocks.init).not.toHaveBeenCalled()
		expect(posthogMocks.capture).not.toHaveBeenCalled()

		// A failed load must not keep queueing events forever.
		telemetryClient.capture("after_failure")
		expect(posthogMocks.capture).not.toHaveBeenCalled()

		consoleWarn.mockRestore()
	})
})
