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

			rerender(<UISettings {...defaultProps} chatFontSize={18} setCachedStateField={setCachedStateField} />)
			const resetSet = getByTestId("chat-font-size-reset") as HTMLButtonElement
			expect(resetSet.disabled).toBe(false)

			fireEvent.click(resetSet)
			expect(setCachedStateField).toHaveBeenCalledWith("chatFontSize", undefined)
			expect(telemetryClient.capture).toHaveBeenCalledWith("ui_settings_chat_font_size_reset")
		})
	})

	describe("auto-close Zoo-opened files checkboxes", () => {
		it("renders all three auto-close checkboxes", () => {
			const { getByTestId } = render(
				<UISettings
					{...defaultProps}
					autoCloseZooOpenedFiles={true}
					autoCloseZooOpenedFilesAfterUserEdited={false}
					autoCloseZooOpenedNewFiles={false}
				/>,
			)
			expect(getByTestId("auto-close-zoo-opened-files-checkbox")).toBeTruthy()
			expect(getByTestId("auto-close-zoo-opened-files-after-user-edited-checkbox")).toBeTruthy()
			expect(getByTestId("auto-close-zoo-opened-new-files-checkbox")).toBeTruthy()
		})

		it("autoCloseZooOpenedFiles checkbox reflects true prop", () => {
			const { getByTestId } = render(<UISettings {...defaultProps} autoCloseZooOpenedFiles={true} />)
			const checkbox = getByTestId("auto-close-zoo-opened-files-checkbox") as HTMLInputElement
			expect(checkbox.checked).toBe(true)
		})

		it("autoCloseZooOpenedFiles checkbox reflects false prop", () => {
			const { getByTestId } = render(<UISettings {...defaultProps} autoCloseZooOpenedFiles={false} />)
			const checkbox = getByTestId("auto-close-zoo-opened-files-checkbox") as HTMLInputElement
			expect(checkbox.checked).toBe(false)
		})

		it("autoCloseZooOpenedFiles checkbox defaults to unchecked when prop is unset", () => {
			// Omitting the prop simulates the opt-in default (false). A regression that
			// flips the fallback back to `?? true` would make this checkbox checked.
			const { getByTestId } = render(<UISettings {...defaultProps} />)
			const checkbox = getByTestId("auto-close-zoo-opened-files-checkbox") as HTMLInputElement
			expect(checkbox.checked).toBe(false)
		})

		it("calls setCachedStateField with autoCloseZooOpenedFiles when toggled", async () => {
			const setCachedStateField = vi.fn()
			const { getByTestId } = render(
				<UISettings
					{...defaultProps}
					autoCloseZooOpenedFiles={true}
					setCachedStateField={setCachedStateField}
				/>,
			)
			const checkbox = getByTestId("auto-close-zoo-opened-files-checkbox")
			fireEvent.click(checkbox)
			await waitFor(() => {
				expect(setCachedStateField).toHaveBeenCalledWith("autoCloseZooOpenedFiles", false)
			})
		})

		it("calls setCachedStateField with autoCloseZooOpenedFilesAfterUserEdited when toggled", async () => {
			const setCachedStateField = vi.fn()
			const { getByTestId } = render(
				<UISettings
					{...defaultProps}
					autoCloseZooOpenedFilesAfterUserEdited={false}
					setCachedStateField={setCachedStateField}
				/>,
			)
			const checkbox = getByTestId("auto-close-zoo-opened-files-after-user-edited-checkbox")
			fireEvent.click(checkbox)
			await waitFor(() => {
				expect(setCachedStateField).toHaveBeenCalledWith("autoCloseZooOpenedFilesAfterUserEdited", true)
			})
		})

		it("calls setCachedStateField with autoCloseZooOpenedNewFiles when toggled", async () => {
			const setCachedStateField = vi.fn()
			const { getByTestId } = render(
				<UISettings
					{...defaultProps}
					autoCloseZooOpenedNewFiles={false}
					setCachedStateField={setCachedStateField}
				/>,
			)
			const checkbox = getByTestId("auto-close-zoo-opened-new-files-checkbox")
			fireEvent.click(checkbox)
			await waitFor(() => {
				expect(setCachedStateField).toHaveBeenCalledWith("autoCloseZooOpenedNewFiles", true)
			})
		})
	})

	describe("appearance steppers", () => {
		const keys = ["interfaceFontScale", "terminalFontSize", "editorFontSize", "spacingScale"] as const

		it("renders all four size controls, in the design order, with defaults", () => {
			const { getByTestId } = render(<UISettings {...defaultProps} />)
			const inputs = keys.map((k) => (getByTestId(`appearance-${k}-input`) as HTMLInputElement).value)
			expect(inputs).toEqual(["100", "12", "13", "100"])
		})

		it("shows the saved values", () => {
			const { getByTestId } = render(
				<UISettings
					{...defaultProps}
					interfaceFontScale={120}
					terminalFontSize={14}
					editorFontSize={15}
					spacingScale={80}
				/>,
			)
			expect((getByTestId("appearance-interfaceFontScale-input") as HTMLInputElement).value).toBe("120")
			expect((getByTestId("appearance-terminalFontSize-input") as HTMLInputElement).value).toBe("14")
			expect((getByTestId("appearance-editorFontSize-input") as HTMLInputElement).value).toBe("15")
			expect((getByTestId("appearance-spacingScale-input") as HTMLInputElement).value).toBe("80")
		})

		it.each([
			["interfaceFontScale", 105],
			["terminalFontSize", 13],
			["editorFontSize", 14],
			["spacingScale", 105],
		] as const)("stores %s as %s when incremented from the default", (key, expected) => {
			const setCachedStateField = vi.fn()
			const { getByTestId } = render(<UISettings {...defaultProps} setCachedStateField={setCachedStateField} />)
			fireEvent.click(getByTestId(`appearance-${key}-increment`))
			expect(setCachedStateField).toHaveBeenCalledWith(key, expected)
		})

		it("reset clears the stored value (undefined → null on save)", () => {
			const setCachedStateField = vi.fn()
			const { getByTestId } = render(
				<UISettings {...defaultProps} terminalFontSize={20} setCachedStateField={setCachedStateField} />,
			)
			fireEvent.click(getByTestId("appearance-terminalFontSize-reset"))
			expect(setCachedStateField).toHaveBeenCalledWith("terminalFontSize", undefined)
		})

		it.each([
			["interfaceFontScale", 120],
			["terminalFontSize", 20],
			["editorFontSize", 18],
			["spacingScale", 80],
		] as const)("records a reset of %s as a null value, not a number", (key, current) => {
			vi.mocked(telemetryClient.capture).mockClear()
			const props = { ...defaultProps, [key]: current }
			const { getByTestId } = render(<UISettings {...props} />)

			fireEvent.click(getByTestId(`appearance-${key}-reset`))

			expect(telemetryClient.capture).toHaveBeenCalledTimes(1)
			expect(telemetryClient.capture).toHaveBeenCalledWith("ui_settings_appearance_changed", {
				key,
				value: null,
			})
		})

		it("records telemetry for changes", () => {
			const { getByTestId } = render(<UISettings {...defaultProps} />)
			fireEvent.click(getByTestId("appearance-editorFontSize-increment"))
			expect(telemetryClient.capture).toHaveBeenCalledWith("ui_settings_appearance_changed", {
				key: "editorFontSize",
				value: 14,
			})
		})

		it("previews the unsaved values live", () => {
			const { getByTestId } = render(<UISettings {...defaultProps} interfaceFontScale={150} spacingScale={50} />)
			const preview = getByTestId("appearance-preview")
			expect(preview.style.getPropertyValue("--zoo-ui-scale")).toBe("1.5")
			expect(preview.style.getPropertyValue("--zoo-spacing-scale")).toBe("0.5")
		})
	})
})
