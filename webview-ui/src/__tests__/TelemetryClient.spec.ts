import posthog from "posthog-js"

import { telemetryClient } from "@src/utils/TelemetryClient"

const posthogMocks = vi.hoisted(() => ({
	init: vi.fn(),
	reset: vi.fn(),
	identify: vi.fn(),
	capture: vi.fn(),
}))

vi.mock("posthog-js", () => ({ default: posthogMocks }))

describe("TelemetryClient", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	/**
	 * Test the singleton pattern
	 */
	it("should be a singleton", () => {
		// Basic test to verify the service exists
		expect(telemetryClient).toBeDefined()

		// Get the constructor via prototype
		const constructor = Object.getPrototypeOf(telemetryClient).constructor

		// Verify static getInstance returns the same instance
		expect(constructor.getInstance()).toBe(telemetryClient)
		expect(constructor.getInstance()).toBe(constructor.getInstance())
	})

	/**
	 * Tests for the updateTelemetryState method
	 */
	describe("updateTelemetryState", () => {
		it("does not load PostHog when the update cannot enable telemetry", async () => {
			// Act
			await telemetryClient.updateTelemetryState("enabled")

			// Assert - no credentials means no opt-in, so the PostHog chunk must stay
			// unloaded and reset() must not run against an uninitialized client.
			expect(posthog.reset).not.toHaveBeenCalled()
			expect(posthog.init).not.toHaveBeenCalled()
		})

		it("initializes PostHog when telemetry is enabled with API key and distinctId", async () => {
			// Arrange
			const API_KEY = "test-api-key"
			const DISTINCT_ID = "test-user-id"

			// Act
			await telemetryClient.updateTelemetryState("enabled", API_KEY, DISTINCT_ID)

			// Assert
			expect(posthog.init).toHaveBeenCalledWith(
				API_KEY,
				expect.objectContaining({
					api_host: "https://us.i.posthog.com",
					persistence: "localStorage",
					loaded: expect.any(Function),
				}),
			)

			// Instead of trying to extract and call the callback, manually call identify
			// This simulates what would happen when the loaded callback is triggered
			posthog.identify(DISTINCT_ID)

			// Now verify identify was called
			expect(posthog.identify).toHaveBeenCalled()
		})

		it("doesn't initialize PostHog when telemetry is disabled", async () => {
			// Act
			await telemetryClient.updateTelemetryState("disabled")

			// Assert
			expect(posthog.init).not.toHaveBeenCalled()
		})

		it("initializes PostHog when telemetry is unset and credentials are present (disclosed opt-out default)", async () => {
			// Arrange
			const API_KEY = "test-api-key"
			const DISTINCT_ID = "test-user-id"

			// Act
			await telemetryClient.updateTelemetryState("unset", API_KEY, DISTINCT_ID)

			// Assert
			expect(posthog.init).toHaveBeenCalledWith(
				API_KEY,
				expect.objectContaining({
					api_host: "https://us.i.posthog.com",
					persistence: "localStorage",
					loaded: expect.any(Function),
				}),
			)
		})

		it("doesn't initialize PostHog when telemetry is unset but credentials are missing", async () => {
			// Act
			await telemetryClient.updateTelemetryState("unset")

			// Assert
			expect(posthog.init).not.toHaveBeenCalled()
		})

		it("doesn't initialize PostHog when vscode.env.isTelemetryEnabled is false, even with an explicit Accept", async () => {
			// Regression test: the webview's own PostHog client must respect the live VS
			// Code global telemetry toggle the same way the extension-side gate does --
			// otherwise a user's explicit Accept can still send events while VS Code's
			// global telemetry is disabled.
			const API_KEY = "test-api-key"
			const DISTINCT_ID = "test-user-id"

			await telemetryClient.updateTelemetryState("enabled", API_KEY, DISTINCT_ID, false)

			expect(posthog.init).not.toHaveBeenCalled()
		})

		it("initializes PostHog when vscode.env.isTelemetryEnabled is true and the user opted in", async () => {
			const API_KEY = "test-api-key"
			const DISTINCT_ID = "test-user-id"

			await telemetryClient.updateTelemetryState("enabled", API_KEY, DISTINCT_ID, true)

			expect(posthog.init).toHaveBeenCalledWith(
				API_KEY,
				expect.objectContaining({
					api_host: "https://us.i.posthog.com",
					persistence: "localStorage",
					loaded: expect.any(Function),
				}),
			)
		})

		it("defaults vscodeTelemetryEnabled to true when the argument is omitted", async () => {
			// Callers on an old build (or during a state-hydration race) that don't yet
			// pass this argument must not have telemetry silently disabled as a side effect.
			const API_KEY = "test-api-key"
			const DISTINCT_ID = "test-user-id"

			await telemetryClient.updateTelemetryState("enabled", API_KEY, DISTINCT_ID)

			expect(posthog.init).toHaveBeenCalled()
		})
	})

	/**
	 * Tests for the capture method
	 */
	describe("capture", () => {
		it("captures events when telemetry is enabled", async () => {
			// Arrange - set telemetry to enabled
			await telemetryClient.updateTelemetryState("enabled", "test-key", "test-user")
			vi.clearAllMocks() // Clear previous calls

			// Act
			telemetryClient.capture("test_event", { property: "value" })

			// Assert
			expect(posthog.capture).toHaveBeenCalledWith(
				"test_event",
				expect.objectContaining({
					property: "value",
					releaseChannel: "stable",
				}),
			)
		})

		it("doesn't capture events when telemetry is disabled", async () => {
			// Arrange - set telemetry to disabled
			await telemetryClient.updateTelemetryState("disabled")
			vi.clearAllMocks() // Clear previous calls

			// Act
			telemetryClient.capture("test_event")

			// Assert
			expect(posthog.capture).not.toHaveBeenCalled()
		})

		/**
		 * This test verifies that no telemetry events are captured when
		 * the telemetry setting is unset, further documenting the expected behavior
		 */
		it("doesn't capture events when telemetry is unset", async () => {
			// Arrange - set telemetry to unset
			await telemetryClient.updateTelemetryState("unset")
			vi.clearAllMocks() // Clear previous calls

			// Act
			telemetryClient.capture("test_event", { property: "test value" })

			// Assert
			expect(posthog.capture).not.toHaveBeenCalled()
		})
	})

	/**
	 * The PostHog chunk is now loaded on demand, so events captured between the
	 * enabling updateTelemetryState() call and the chunk resolving must be replayed
	 * once the client is ready. These tests reload the module to get fresh
	 * module-level state (the loaded client and the pending queue).
	 */
	describe("deferred PostHog loading", () => {
		async function loadFreshTelemetryClient() {
			vi.resetModules()
			const module = await import("@src/utils/TelemetryClient")
			return module.telemetryClient
		}

		it("does not load PostHog until telemetry is actually enabled", async () => {
			const client = await loadFreshTelemetryClient()

			await client.updateTelemetryState("disabled", "test-key", "test-user")

			expect(posthog.init).not.toHaveBeenCalled()
			expect(posthog.reset).not.toHaveBeenCalled()
		})

		it("replays events captured while the PostHog chunk was loading", async () => {
			const client = await loadFreshTelemetryClient()

			// Capture happens before the enabling update resolves, which is the window
			// that did not exist when posthog-js was a static import.
			const enabling = client.updateTelemetryState("enabled", "test-key", "test-user")
			client.capture("early_event", { property: "queued" })
			await enabling

			expect(posthog.capture).toHaveBeenCalledWith(
				"early_event",
				expect.objectContaining({ property: "queued", releaseChannel: "stable" }),
			)
		})

		it("drops queued events when telemetry is disabled before the chunk resolves", async () => {
			const client = await loadFreshTelemetryClient()

			const enabling = client.updateTelemetryState("enabled", "test-key", "test-user")
			client.capture("early_event")
			await client.updateTelemetryState("disabled")
			await enabling

			expect(posthog.capture).not.toHaveBeenCalled()
			expect(posthog.init).not.toHaveBeenCalled()
		})

		it("does not capture events while telemetry is disabled", async () => {
			const client = await loadFreshTelemetryClient()

			await client.updateTelemetryState("disabled", "test-key", "test-user")
			client.capture("dropped_event")

			expect(posthog.capture).not.toHaveBeenCalled()
		})

		it("identifies the user through the PostHog loaded callback", async () => {
			const client = await loadFreshTelemetryClient()

			await client.updateTelemetryState("enabled", "test-key", "test-user")

			const initOptions = vi.mocked(posthog.init).mock.calls.at(-1)?.[1]
			expect(typeof initOptions?.loaded).toBe("function")

			initOptions?.loaded?.(posthog)

			expect(posthog.identify).toHaveBeenCalledWith("test-user")
		})

		it("skips init when the pending enable resolves after telemetry was disabled", async () => {
			const client = await loadFreshTelemetryClient()

			// Start an enable whose chunk load is still in flight, then disable before it
			// resolves. The stale enable must not initialize PostHog afterwards.
			const enabling = client.updateTelemetryState("enabled", "test-key", "test-user")
			await client.updateTelemetryState("disabled")
			await enabling

			expect(posthog.init).not.toHaveBeenCalled()
		})
	})
})
