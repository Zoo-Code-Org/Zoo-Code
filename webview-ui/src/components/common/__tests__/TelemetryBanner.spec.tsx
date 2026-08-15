import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import TelemetryBanner from "../TelemetryBanner"

const mockPostMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (message: any) => mockPostMessage(message),
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"welcome:telemetry.helpImprove": "Help Improve Zoo Code",
				"welcome:telemetry.helpImproveMessage": "Zoo Code collects error and usage data...",
				"welcome:telemetry.accept": "Accept",
				"welcome:telemetry.decline": "Decline",
			}
			return translations[key] || key
		},
	}),
}))

describe("TelemetryBanner", () => {
	beforeEach(() => {
		mockPostMessage.mockClear()
	})

	it("renders explicit Accept and Decline actions", () => {
		render(<TelemetryBanner />)

		expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument()
	})

	it("sends an enabled setting when Accept is clicked", () => {
		render(<TelemetryBanner />)

		fireEvent.click(screen.getByRole("button", { name: "Accept" }))

		expect(mockPostMessage).toHaveBeenCalledWith({ type: "telemetrySetting", text: "enabled" })
	})

	it("sends a disabled setting when Decline is clicked", () => {
		render(<TelemetryBanner />)

		fireEvent.click(screen.getByRole("button", { name: "Decline" }))

		expect(mockPostMessage).toHaveBeenCalledWith({ type: "telemetrySetting", text: "disabled" })
	})

	it("requires an explicit telemetry choice", () => {
		render(<TelemetryBanner />)

		expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Accept", "Decline"])
		expect(mockPostMessage).not.toHaveBeenCalled()
	})
})
