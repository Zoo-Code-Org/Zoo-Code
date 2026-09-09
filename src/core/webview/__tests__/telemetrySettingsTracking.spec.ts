import { describe, it, expect, vi, beforeEach } from "vitest"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName, type TelemetrySetting, isTelemetryOptedIn } from "@roo-code/types"

describe("Telemetry Settings Tracking", () => {
	let mockTelemetryService: {
		captureTelemetrySettingsChanged: ReturnType<typeof vi.fn>
		updateTelemetryState: ReturnType<typeof vi.fn>
		hasInstance: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		// Reset mocks
		vi.clearAllMocks()

		// Create mock service
		mockTelemetryService = {
			captureTelemetrySettingsChanged: vi.fn(),
			updateTelemetryState: vi.fn(),
			hasInstance: vi.fn().mockReturnValue(true),
		}

		// Mock the TelemetryService
		vi.spyOn(TelemetryService, "hasInstance").mockReturnValue(true)
		vi.spyOn(TelemetryService, "instance", "get").mockReturnValue(mockTelemetryService as any)
	})

	describe("when telemetry is turned OFF", () => {
		it("should fire event BEFORE disabling telemetry", () => {
			const previousSetting = "enabled" as TelemetrySetting
			const newSetting = "disabled" as TelemetrySetting

			// Simulate the logic from webviewMessageHandler
			const isOptedIn = isTelemetryOptedIn(newSetting)
			const wasPreviouslyOptedIn = isTelemetryOptedIn(previousSetting)

			// If turning telemetry OFF, fire event BEFORE disabling
			if (wasPreviouslyOptedIn && !isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			// Update the telemetry state
			TelemetryService.instance.updateTelemetryState(isOptedIn)

			// Verify the event was captured before updateTelemetryState
			expect(mockTelemetryService.captureTelemetrySettingsChanged).toHaveBeenCalledWith("enabled", "disabled")
			expect(mockTelemetryService.captureTelemetrySettingsChanged).toHaveBeenCalledBefore(
				mockTelemetryService.updateTelemetryState as any,
			)
			expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledWith(false)
		})

		it("should fire an opt-out event when going from unset to disabled (explicit Decline)", () => {
			const previousSetting = "unset" as TelemetrySetting
			const newSetting = "disabled" as TelemetrySetting

			const isOptedIn = isTelemetryOptedIn(newSetting)
			const wasPreviouslyOptedIn = isTelemetryOptedIn(previousSetting)

			if (wasPreviouslyOptedIn && !isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			TelemetryService.instance.updateTelemetryState(isOptedIn)

			// "unset" is opted in under the disclosed opt-out default, so unset -> disabled
			// is a genuine opt-out transition.
			expect(mockTelemetryService.captureTelemetrySettingsChanged).toHaveBeenCalledWith("unset", "disabled")
			expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledWith(false)
		})
	})

	describe("when telemetry is turned ON", () => {
		it("should fire event AFTER enabling telemetry", () => {
			const previousSetting = "disabled" as TelemetrySetting
			const newSetting = "enabled" as TelemetrySetting

			const isOptedIn = isTelemetryOptedIn(newSetting)
			const wasPreviouslyOptedIn = isTelemetryOptedIn(previousSetting)

			// Update the telemetry state first
			TelemetryService.instance.updateTelemetryState(isOptedIn)

			// If turning telemetry ON, fire event AFTER enabling
			if (!wasPreviouslyOptedIn && isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			// Verify the event was captured after updateTelemetryState
			expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledWith(true)
			expect(mockTelemetryService.captureTelemetrySettingsChanged).toHaveBeenCalledWith("disabled", "enabled")
			expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledBefore(
				mockTelemetryService.captureTelemetrySettingsChanged as any,
			)
		})

		it("should not fire event when going from enabled to enabled", () => {
			const previousSetting = "enabled" as TelemetrySetting
			const newSetting = "enabled" as TelemetrySetting

			const isOptedIn = isTelemetryOptedIn(newSetting)
			const wasPreviouslyOptedIn = isTelemetryOptedIn(previousSetting)

			// Neither condition should be met
			if (wasPreviouslyOptedIn && !isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			TelemetryService.instance.updateTelemetryState(isOptedIn)

			if (!wasPreviouslyOptedIn && isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			// Should not fire any telemetry events
			expect(mockTelemetryService.captureTelemetrySettingsChanged).not.toHaveBeenCalled()
			expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledWith(true)
		})

		it("should not fire an event when going from unset to enabled (already opted in by default)", () => {
			const previousSetting = "unset" as TelemetrySetting
			const newSetting = "enabled" as TelemetrySetting

			const isOptedIn = isTelemetryOptedIn(newSetting)
			const wasPreviouslyOptedIn = isTelemetryOptedIn(previousSetting)

			if (wasPreviouslyOptedIn && !isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			TelemetryService.instance.updateTelemetryState(isOptedIn)

			if (!wasPreviouslyOptedIn && isOptedIn && TelemetryService.hasInstance()) {
				TelemetryService.instance.captureTelemetrySettingsChanged(previousSetting, newSetting)
			}

			// "unset" is already opted in under the disclosed opt-out default, so explicit
			// Accept (unset -> enabled) is a no-op transition, not a new opt-in.
			expect(mockTelemetryService.captureTelemetrySettingsChanged).not.toHaveBeenCalled()
			expect(mockTelemetryService.updateTelemetryState).toHaveBeenCalledWith(true)
		})
	})

	describe("neutral banner dismiss ('unset' left as-is)", () => {
		it("leaves the disclosed opt-out default in effect while the setting remains unset", () => {
			// A neutral dismiss of the consent banner sends no telemetrySetting message at
			// all, so the stored setting stays "unset". Confirm "unset" alone -- with no
			// transition, and no affirmative choice recorded either way -- resolves to the
			// disclosed default (telemetry on) rather than silently opting the user in via
			// dismissal itself.
			expect(isTelemetryOptedIn("unset" as TelemetrySetting)).toBe(true)
		})
	})

	describe("TelemetryService.captureTelemetrySettingsChanged", () => {
		it("should call captureEvent with correct parameters", () => {
			// Create a real instance to test the method
			const mockCaptureEvent = vi.fn()
			const service = new (TelemetryService as any)([])
			service.captureEvent = mockCaptureEvent

			service.captureTelemetrySettingsChanged("enabled", "disabled")

			expect(mockCaptureEvent).toHaveBeenCalledWith(TelemetryEventName.TELEMETRY_SETTINGS_CHANGED, {
				previousSetting: "enabled",
				newSetting: "disabled",
			})
		})
	})
})
