import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { LanguageSettings } from "../LanguageSettings"

// Interpolate like i18next so the preview text (the thing under test) is observable.
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, string>) =>
			options ? Object.entries(options).reduce((acc, [k, v]) => `${acc} ${k}=${v}`, key) : key,
	}),
}))

const setup = (props: Partial<React.ComponentProps<typeof LanguageSettings>> = {}) => {
	const setCachedStateField = vi.fn()
	render(<LanguageSettings language="en" setCachedStateField={setCachedStateField} {...props} />)
	return { setCachedStateField }
}

const clock = () => screen.getByTestId("preview-chat").textContent!

describe("LanguageSettings – date & time (design mock 2)", () => {
	describe("time format (segmented control)", () => {
		it("offers Auto, 12-hour and 24-hour, with Auto active by default", () => {
			setup()
			expect(screen.getByTestId("time-format-auto").getAttribute("aria-checked")).toBe("true")
			expect(screen.getByTestId("time-format-12h").getAttribute("aria-checked")).toBe("false")
			expect(screen.getByTestId("time-format-24h").getAttribute("aria-checked")).toBe("false")
		})

		it.each(["auto", "12h", "24h"] as const)("saves %s when clicked", (format) => {
			const { setCachedStateField } = setup({ timeFormat: format === "auto" ? "12h" : "auto" })
			fireEvent.click(screen.getByTestId(`time-format-${format}`))
			expect(setCachedStateField).toHaveBeenCalledWith("timeFormat", format)
		})

		describe("keyboard", () => {
			const option = (format: "auto" | "12h" | "24h") => screen.getByTestId(`time-format-${format}`)

			it("is a horizontal radio group of three radios", () => {
				setup({ timeFormat: "12h" })

				const group = screen.getByRole("radiogroup")
				expect(group).toBe(screen.getByTestId("time-format-select"))
				expect(group).toHaveAttribute("aria-orientation", "horizontal")
				expect(group).toHaveAccessibleName("settings:language.timeFormat.label")
				expect(screen.getAllByRole("radio")).toHaveLength(3)
			})

			it("has one tab stop: the group, which hands focus to the selected option", () => {
				setup({ timeFormat: "12h" })

				// Before the group has focus, the group itself is the tab stop and the options are not. Radix then
				// moves the focus to the selected option, and makes that option the tab stop (see the browser test
				// in LanguageSettings.visual.tsx, where real focus exists: the unit test setup stubs `focus()`).
				expect(screen.getByRole("radiogroup")).toHaveAttribute("tabindex", "0")
				for (const format of ["auto", "12h", "24h"] as const) {
					expect(option(format)).toHaveAttribute("tabindex", "-1")
				}
				expect(screen.getByRole("radio", { checked: true })).toBe(option("12h"))
			})

			it("selects the option that receives focus", () => {
				const { setCachedStateField } = setup({ timeFormat: "auto" })

				fireEvent.focus(option("12h"))
				expect(setCachedStateField).toHaveBeenLastCalledWith("timeFormat", "12h")

				fireEvent.focus(option("24h"))
				expect(setCachedStateField).toHaveBeenLastCalledWith("timeFormat", "24h")
			})

			it("selects it without any key being held, so a quick tap on an arrow key cannot leave them apart", () => {
				const { setCachedStateField } = setup({ timeFormat: "auto" })

				// No keydown at all: only the focus arrives, as when the key was released before Radix moved it.
				fireEvent.focus(option("24h"))

				expect(setCachedStateField).toHaveBeenCalledTimes(1)
				expect(setCachedStateField).toHaveBeenCalledWith("timeFormat", "24h")
			})

			it("does nothing when the selected option receives focus", () => {
				const { setCachedStateField } = setup({ timeFormat: "12h" })

				fireEvent.focus(option("12h"))

				expect(setCachedStateField).not.toHaveBeenCalled()
			})
		})

		it("marks the stored value as the active segment", () => {
			setup({ timeFormat: "24h" })
			expect(screen.getByTestId("time-format-24h").getAttribute("aria-checked")).toBe("true")
		})

		it("previews 24-hour time without an AM/PM marker", () => {
			setup({ timeFormat: "24h" })
			expect(clock()).toContain("14:41")
			expect(clock()).not.toMatch(/\b(AM|PM)\b/i)
		})

		it("previews 12-hour time with an AM/PM marker", () => {
			setup({ timeFormat: "12h" })
			expect(clock()).toMatch(/2:41\s?PM/i)
		})
	})

	describe("display language (before Save)", () => {
		it("previews 'auto' in the language chosen in the picker, not the saved one", () => {
			// German writes 24-hour time, English 12-hour; the i18n language here is untouched.
			setup({ language: "de" })
			expect(clock()).toContain("14:41")
			expect(clock()).not.toMatch(/\b(AM|PM)\b/i)
		})

		it("changes the 'auto' preview when the picked language changes", () => {
			const setCachedStateField = vi.fn()
			const { rerender } = render(<LanguageSettings language="en" setCachedStateField={setCachedStateField} />)
			expect(clock()).toMatch(/2:41\s?PM/i)
			rerender(<LanguageSettings language="de" setCachedStateField={setCachedStateField} />)
			expect(clock()).toContain("14:41")
		})

		it("still honours an explicit 12-hour choice whatever language is picked", () => {
			setup({ language: "de", timeFormat: "12h" })
			expect(clock()).toMatch(/2:41\s?PM/i)
		})

		it("writes the date example in the picked language for 'auto'", () => {
			setup({ language: "de", dateFormat: "auto" })
			expect(screen.getByTestId("date-format-example").textContent).toContain(
				new Date(2026, 9, 27).toLocaleDateString("de", { dateStyle: "medium" }),
			)
		})
	})

	describe("date format", () => {
		it.each([
			["mdy", "10/27/2026"],
			["dmy", "27/10/2026"],
			["ymd", "2026-10-27"],
		] as const)("shows %s as %s in the example", (format, expected) => {
			setup({ dateFormat: format })
			expect(screen.getByTestId("date-format-example").textContent).toContain(expected)
		})

		it("renders the date format select", () => {
			setup()
			expect(screen.getByTestId("date-format-select")).toBeTruthy()
		})
	})

	describe("relative times checkbox", () => {
		it("is checked by default and previews a relative time with the hover value", () => {
			setup()
			expect((screen.getByTestId("relative-times-checkbox") as HTMLInputElement).checked).toBe(true)
			expect(screen.getByTestId("preview-history").textContent).toContain("relative")
			expect(screen.getByTestId("preview-history").textContent).toContain("hover")
		})

		it("previews the absolute date/time when off, honouring both formats", () => {
			setup({ showRelativeTimes: false, timeFormat: "24h", dateFormat: "ymd" })
			const text = screen.getByTestId("preview-history").textContent!
			expect(text).toContain("2026-10-27, 14:41")
			expect(text).not.toContain("relative")
		})

		it("saves the toggle", () => {
			const { setCachedStateField } = setup()
			fireEvent.click(screen.getByTestId("relative-times-checkbox"))
			expect(setCachedStateField).toHaveBeenCalledWith("showRelativeTimes", false)
		})
	})

	it("keeps the language selector", () => {
		const { container } = (() => {
			const r = render(<LanguageSettings language="en" setCachedStateField={vi.fn()} />)
			return r
		})()
		expect(container.querySelectorAll("[role=combobox]").length).toBeGreaterThanOrEqual(2)
	})
})
