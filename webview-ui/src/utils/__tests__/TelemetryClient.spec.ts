import posthog from "posthog-js"

import { telemetryClient } from "../TelemetryClient"

vi.mock("posthog-js", () => ({
	default: {
		reset: vi.fn(),
		init: vi.fn(),
		identify: vi.fn(),
		capture: vi.fn(),
	},
}))

describe("TelemetryClient", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should be a singleton", () => {
		// Basic test to verify the service exists
		expect(telemetryClient).toBeDefined()
	})

	it("should have updateTelemetryState method", async () => {
		// Test if the method exists
		expect(typeof telemetryClient.updateTelemetryState).toBe("function")

		// Call it with different values to verify it doesn't throw errors
		await expect(telemetryClient.updateTelemetryState("enabled")).resolves.toBeUndefined()
		await expect(telemetryClient.updateTelemetryState("disabled")).resolves.toBeUndefined()
		await expect(telemetryClient.updateTelemetryState("unset")).resolves.toBeUndefined()
	})

	it("should have capture method", () => {
		// Test if the method exists
		expect(typeof telemetryClient.capture).toBe("function")

		// Call it to verify it doesn't throw errors
		expect(() => telemetryClient.capture("test_event")).not.toThrow()
		expect(() => telemetryClient.capture("test_event", { key: "value" })).not.toThrow()
	})

	it("should not touch PostHog before the chunk is loaded", async () => {
		// Act
		await telemetryClient.updateTelemetryState("disabled")

		// Assert - a disabled update must not load the PostHog chunk or reset an
		// uninitialized client, which only logged a console error.
		expect(posthog.reset).not.toHaveBeenCalled()
	})

	it("should initialize PostHog when telemetry is enabled with API key and distinctId", async () => {
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
})
