import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { AppearancePreview } from "../AppearancePreview"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const root = () => screen.getByTestId("appearance-preview")

describe("AppearancePreview", () => {
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

	it("sizes the editor sample like the live code block when no editor size is set (0.95em of the chat text)", () => {
		const { container } = render(<AppearancePreview values={{}} />)
		const sample = container.querySelector("pre")!
		expect(sample.style.fontSize).toBe("var(--zoo-editor-font-size, 0.95em)")
	})
})
