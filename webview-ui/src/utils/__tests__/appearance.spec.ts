import { globalSettingsSchema } from "@roo-code/types"

import { applyAppearanceVariables, clampAppearance, isChatFontSize, renderedAppearanceDefault } from "../appearance"

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

describe("isChatFontSize", () => {
	it("accepts exactly what the host's schema accepts", () => {
		const schema = globalSettingsSchema.shape.chatFontSize
		for (const value of [
			7,
			8,
			9,
			16,
			31,
			32,
			33,
			12.5,
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			"12",
			null,
			undefined,
			{},
		]) {
			expect(isChatFontSize(value)).toBe(typeof value === "number" && schema.safeParse(value).success)
		}
	})
})

describe("renderedAppearanceDefault", () => {
	it("follows the editor font size of VS Code for the terminal, which the terminal uses while no size is set", () => {
		expect(renderedAppearanceDefault("terminalFontSize", { vscodeEditorFontSize: 14 })).toBe(14)
		expect(renderedAppearanceDefault("terminalFontSize", { vscodeEditorFontSize: 13.6 })).toBe(14)
	})

	it.each([
		[
			"the chat text, with the interface scale",
			{ chatFontSize: 20, interfaceFontScale: 100, vscodeFontSize: 13 },
			19,
		],
		["VS Code's text when no chat size is set", { vscodeFontSize: 14 }, 13],
		["the scaled chat text", { chatFontSize: 20, interfaceFontScale: 150 }, 29],
		["a chat size the host would not accept is not used", { chatFontSize: 99, vscodeFontSize: 14 }, 13],
	])("gives the editor the 0.95 of %s", (_name, context, expected) => {
		expect(renderedAppearanceDefault("editorFontSize", context)).toBe(expected)
	})

	it("stays inside the range of the setting", () => {
		expect(renderedAppearanceDefault("terminalFontSize", { vscodeEditorFontSize: 200 })).toBe(32)
		expect(renderedAppearanceDefault("terminalFontSize", { vscodeEditorFontSize: 2 })).toBe(8)
		expect(renderedAppearanceDefault("editorFontSize", { vscodeFontSize: 100, interfaceFontScale: 200 })).toBe(32)
	})

	it.each([
		["terminalFontSize", 12],
		["editorFontSize", 13],
		["interfaceFontScale", 100],
		["spacingScale", 100],
	] as const)("falls back to the fixed value of %s when what it follows is not known", (key, fallback) => {
		expect(renderedAppearanceDefault(key)).toBe(fallback)
		expect(renderedAppearanceDefault(key, { vscodeFontSize: NaN, vscodeEditorFontSize: 0 })).toBe(fallback)
	})

	it("leaves the scales alone: they do not follow a font size", () => {
		expect(renderedAppearanceDefault("interfaceFontScale", { vscodeFontSize: 20, vscodeEditorFontSize: 20 })).toBe(
			100,
		)
		expect(renderedAppearanceDefault("spacingScale", { vscodeFontSize: 20, interfaceFontScale: 150 })).toBe(100)
	})
})
