import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { AppearancePreview } from "../AppearancePreview"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const root = () => screen.getByTestId("appearance-preview")

describe("AppearancePreview", () => {
	it("is a named group, so that its accessible name is exposed (a div without a role cannot carry one)", () => {
		render(<AppearancePreview values={{}} />)

		const group = screen.getByRole("group", { name: "settings:ui.appearance.preview" })

		expect(group).toBe(root())
	})

	it("resets every unset value to `initial`, so the live CSS fallback chain applies and nothing is inherited from <html>", () => {
		render(<AppearancePreview values={{}} />)
		const style = root().style
		for (const cssVar of [
			"--zoo-terminal-font-size",
			"--zoo-editor-font-size",
			"--zoo-ui-scale",
			"--zoo-spacing-scale",
			"--zoo-chat-font-size",
		]) {
			expect(style.getPropertyValue(cssVar)).toBe("initial")
		}
	})

	it("is not affected by a saved value on the root: a reset shows before Save", () => {
		document.documentElement.style.setProperty("--zoo-terminal-font-size", "30px")
		try {
			render(<AppearancePreview values={{ terminalFontSize: undefined }} />)
			// The preview sets its own value for the property, so the root's 30px cannot reach it.
			expect(root().style.getPropertyValue("--zoo-terminal-font-size")).toBe("initial")
		} finally {
			document.documentElement.style.removeProperty("--zoo-terminal-font-size")
		}
	})

	it("sets the values the user has set, converted the way the live UI converts them, and resets the rest", () => {
		render(
			<AppearancePreview values={{ terminalFontSize: 18, interfaceFontScale: 120, spacingScale: undefined }} />,
		)
		const style = root().style
		expect(style.getPropertyValue("--zoo-terminal-font-size")).toBe("18px")
		expect(style.getPropertyValue("--zoo-ui-scale")).toBe("1.2")
		expect(style.getPropertyValue("--zoo-spacing-scale")).toBe("initial")
		expect(style.getPropertyValue("--zoo-editor-font-size")).toBe("initial")
	})

	it("clamps out-of-range values like the live UI", () => {
		render(<AppearancePreview values={{ spacingScale: 1000 }} />)
		expect(root().style.getPropertyValue("--zoo-spacing-scale")).toBe("2")
	})

	it("applies the chat font size only when one is set", () => {
		const { rerender } = render(<AppearancePreview values={{}} />)
		expect(root().style.getPropertyValue("--zoo-chat-font-size")).toBe("initial")
		rerender(<AppearancePreview values={{}} chatFontSize={16} />)
		expect(root().style.getPropertyValue("--zoo-chat-font-size")).toBe("16px")
	})

	it.each([8, 16, 32])("writes a chat font size of %i into the style", (size) => {
		render(<AppearancePreview values={{}} chatFontSize={size} />)
		expect(root().style.getPropertyValue("--zoo-chat-font-size")).toBe(`${size}px`)
	})

	it.each([
		["below the range", 7],
		["above the range", 33],
		["zero", 0],
		["negative", -12],
		["fractional", 12.5],
		["not a number", Number.NaN],
		["infinite", Number.POSITIVE_INFINITY],
		["a string that would break out of the declaration", "12px; background: url(x)"],
		["an object", { size: 12 }],
	])("leaves a chat font size that is %s out of the style", (_name, size) => {
		render(<AppearancePreview values={{}} chatFontSize={size as never} />)
		expect(root().style.getPropertyValue("--zoo-chat-font-size")).toBe("initial")
		expect(root().getAttribute("style")).not.toContain("background")
	})

	describe("isolation from the page root", () => {
		const rootCssVars = [
			"--zoo-terminal-font-size",
			"--zoo-editor-font-size",
			"--zoo-ui-scale",
			"--zoo-spacing-scale",
			"--zoo-chat-font-size",
		]
		const rootState = () => ({
			style: document.documentElement.getAttribute("style"),
			className: document.documentElement.className,
			vars: rootCssVars.map((cssVar) => document.documentElement.style.getPropertyValue(cssVar)),
		})

		beforeEach(() => {
			rootCssVars.forEach((cssVar, index) =>
				document.documentElement.style.setProperty(cssVar, `${index + 10}px`),
			)
			document.documentElement.classList.add("zoo-editor-font-set")
		})

		afterEach(() => {
			rootCssVars.forEach((cssVar) => document.documentElement.style.removeProperty(cssVar))
			document.documentElement.classList.remove("zoo-editor-font-set")
		})

		it("leaves the root variables and the editor font class as they were, for set values, a reset and an unmount", () => {
			const before = rootState()
			expect(before.vars).toEqual(["10px", "11px", "12px", "13px", "14px"])

			const { rerender, unmount } = render(
				<AppearancePreview
					values={{ terminalFontSize: 18, editorFontSize: 20, interfaceFontScale: 120, spacingScale: 150 }}
					chatFontSize={16}
				/>,
			)
			expect(root().style.getPropertyValue("--zoo-terminal-font-size")).toBe("18px")
			expect(rootState()).toEqual(before)

			rerender(<AppearancePreview values={{}} />)
			expect(root().style.getPropertyValue("--zoo-terminal-font-size")).toBe("initial")
			expect(rootState()).toEqual(before)

			unmount()
			expect(rootState()).toEqual(before)
			expect(document.documentElement.classList.contains("zoo-editor-font-set")).toBe(true)
		})
	})

	it("sizes the editor sample like the live code block when no editor size is set (0.95em of 0.95em of the chat text: its pre and the code inside it)", () => {
		const { container } = render(<AppearancePreview values={{}} />)
		const sample = container.querySelector("pre")!
		expect(sample.style.fontSize).toBe("var(--zoo-editor-font-size, 0.9025em)")
	})
})
