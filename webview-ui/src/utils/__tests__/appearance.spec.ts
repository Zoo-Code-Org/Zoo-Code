import { globalSettingsSchema } from "@roo-code/types"

import { applyAppearanceVariables, clampAppearance } from "../appearance"

describe("clampAppearance", () => {
	it("passes through in-range integers", () => {
		expect(clampAppearance("interfaceFontScale", 110)).toBe(110)
		expect(clampAppearance("terminalFontSize", 14)).toBe(14)
	})

	// The bounds are written out here, not read from APPEARANCE_SETTINGS (the thing under test), and the host checks
	// the same bounds with globalSettingsSchema: a drift in either place fails one of these.
	const bounds = [
		["interfaceFontScale", 50, 200],
		["terminalFontSize", 8, 32],
		["editorFontSize", 8, 32],
		["spacingScale", 50, 200],
	] as const

	it.each(bounds)("%s is clamped to %i..%i", (key, min, max) => {
		expect(clampAppearance(key, min - 1)).toBe(min)
		expect(clampAppearance(key, 0)).toBe(min)
		expect(clampAppearance(key, min)).toBe(min)
		expect(clampAppearance(key, max)).toBe(max)
		expect(clampAppearance(key, max + 1)).toBe(max)
		expect(clampAppearance(key, 99999)).toBe(max)
	})

	it.each(bounds)("%s: the host's schema accepts the bounds and refuses a value outside them", (key, min, max) => {
		const schema = globalSettingsSchema.shape[key]
		expect(schema.safeParse(min).success).toBe(true)
		expect(schema.safeParse(max).success).toBe(true)
		expect(schema.safeParse(min - 1).success).toBe(false)
		expect(schema.safeParse(max + 1).success).toBe(false)
		// And what the stepper can produce is always accepted.
		for (const value of [min - 10, min, max, max + 10]) {
			expect(schema.safeParse(clampAppearance(key, value)).success).toBe(true)
		}
	})

	it("rounds fractional input", () => {
		expect(clampAppearance("spacingScale", 87.6)).toBe(88)
	})

	it("treats null/undefined/NaN as unset", () => {
		expect(clampAppearance("spacingScale", undefined)).toBeUndefined()
		expect(clampAppearance("spacingScale", null)).toBeUndefined()
		expect(clampAppearance("spacingScale", NaN)).toBeUndefined()
	})
})

describe("applyAppearanceVariables", () => {
	let root: HTMLElement

	beforeEach(() => {
		root = document.createElement("div")
	})

	it("writes percent settings as unitless multipliers and px settings as px", () => {
		applyAppearanceVariables(root, {
			interfaceFontScale: 120,
			terminalFontSize: 14,
			editorFontSize: 13,
			spacingScale: 80,
		})
		expect(root.style.getPropertyValue("--zoo-ui-scale")).toBe("1.2")
		expect(root.style.getPropertyValue("--zoo-terminal-font-size")).toBe("14px")
		expect(root.style.getPropertyValue("--zoo-editor-font-size")).toBe("13px")
		expect(root.style.getPropertyValue("--zoo-spacing-scale")).toBe("0.8")
	})

	it("removes overrides for unset values so stylesheet defaults apply", () => {
		applyAppearanceVariables(root, { interfaceFontScale: 120, terminalFontSize: 14 })
		applyAppearanceVariables(root, { interfaceFontScale: undefined, terminalFontSize: null })
		expect(root.style.getPropertyValue("--zoo-ui-scale")).toBe("")
		expect(root.style.getPropertyValue("--zoo-terminal-font-size")).toBe("")
	})

	it("marks the root only while an editor font size is set", () => {
		applyAppearanceVariables(root, { editorFontSize: 15 })
		expect(root.classList.contains("zoo-editor-font-set")).toBe(true)
		applyAppearanceVariables(root, { editorFontSize: undefined })
		expect(root.classList.contains("zoo-editor-font-set")).toBe(false)
	})

	it("clamps out-of-range values before writing", () => {
		applyAppearanceVariables(root, { spacingScale: 1000 })
		expect(root.style.getPropertyValue("--zoo-spacing-scale")).toBe("2")
	})
})
