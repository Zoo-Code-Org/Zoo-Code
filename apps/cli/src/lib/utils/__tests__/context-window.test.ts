import { DEFAULT_CONTEXT_WINDOW, getContextWindow } from "../context-window.js"

describe("getContextWindow", () => {
	it.each([1, 32_000, 200_000, 1_048_576])("returns the window reported by the extension (%d)", (contextWindow) => {
		expect(getContextWindow(contextWindow)).toBe(contextWindow)
	})

	it.each([
		["undefined", undefined],
		["null", null],
		["zero", 0],
		["negative", -1],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["-Infinity", Number.NEGATIVE_INFINITY],
	])("returns the default when the reported window is %s", (_label, contextWindow) => {
		expect(getContextWindow(contextWindow)).toBe(DEFAULT_CONTEXT_WINDOW)
	})
})
