import { render, fireEvent, waitFor } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { UISettings } from "../UISettings"
import { telemetryClient } from "@/utils/TelemetryClient"

vi.mock("@/utils/TelemetryClient", () => ({
	telemetryClient: { capture: vi.fn() },
}))

describe("UISettings", () => {
	const defaultProps = {
		reasoningBlockCollapsed: false,
		enterBehavior: "send" as const,
		setCachedStateField: vi.fn(),
	}

	it("renders the collapse thinking checkbox", () => {
		const { getByTestId } = render(<UISettings {...defaultProps} />)
		const checkbox = getByTestId("collapse-thinking-checkbox")
		expect(checkbox).toBeTruthy()
	})

	it("displays the correct initial state", () => {
		const { getByTestId } = render(<UISettings {...defaultProps} reasoningBlockCollapsed={true} />)
		const checkbox = getByTestId("collapse-thinking-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(true)
	})

	it("calls setCachedStateField when checkbox is toggled", async () => {
		const setCachedStateField = vi.fn()
		const { getByTestId } = render(<UISettings {...defaultProps} setCachedStateField={setCachedStateField} />)

		const checkbox = getByTestId("collapse-thinking-checkbox")
		fireEvent.click(checkbox)

		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("reasoningBlockCollapsed", true)
		})
	})

	it("updates checkbox state when prop changes", () => {
		const { getByTestId, rerender } = render(<UISettings {...defaultProps} reasoningBlockCollapsed={false} />)
		const checkbox = getByTestId("collapse-thinking-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(false)

		rerender(<UISettings {...defaultProps} reasoningBlockCollapsed={true} />)
		expect(checkbox.checked).toBe(true)
	})

	describe("chat font size", () => {
		it("shows the default font size when unset (init)", () => {
			const { getByText, getByTestId } = render(<UISettings {...defaultProps} chatFontSize={undefined} />)
			expect(getByTestId("chat-font-size-slider")).toBeTruthy()
			// Default falls back to VS Code-equivalent default value.
			expect(getByText("13px")).toBeTruthy()
		})

		it("shows the configured font size when set", () => {
			const { getByText } = render(<UISettings {...defaultProps} chatFontSize={20} />)
			expect(getByText("20px")).toBeTruthy()
		})

		it("persists a user-edited font size via setCachedStateField", () => {
			const setCachedStateField = vi.fn()
			const { getByTestId } = render(
				<UISettings {...defaultProps} chatFontSize={14} setCachedStateField={setCachedStateField} />,
			)

			const slider = getByTestId("chat-font-size-slider").querySelector('[role="slider"]') as HTMLElement
			slider.focus()
			fireEvent.keyDown(slider, { key: "ArrowRight" })

			expect(setCachedStateField).toHaveBeenCalledWith("chatFontSize", 15)
			expect(telemetryClient.capture).toHaveBeenCalledWith("ui_settings_chat_font_size_changed", { value: 15 })
		})

		it("disables reset when unset and clears the value on reset", () => {
			const setCachedStateField = vi.fn()
			const { getByTestId, rerender } = render(
				<UISettings {...defaultProps} chatFontSize={undefined} setCachedStateField={setCachedStateField} />,
			)

			const resetUnset = getByTestId("chat-font-size-reset") as HTMLButtonElement
			expect(resetUnset.disabled).toBe(true)

			rerender(
				<UISettings {...defaultProps} chatFontSize={18} setCachedStateField={setCachedStateField} />,
			)
			const resetSet = getByTestId("chat-font-size-reset") as HTMLButtonElement
			expect(resetSet.disabled).toBe(false)

			fireEvent.click(resetSet)
			expect(setCachedStateField).toHaveBeenCalledWith("chatFontSize", undefined)
			expect(telemetryClient.capture).toHaveBeenCalledWith("ui_settings_chat_font_size_reset")
		})
	})
})
