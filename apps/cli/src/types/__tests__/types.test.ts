import { isSupportedProvider, supportedProviders } from "../types.js"

describe("isSupportedProvider", () => {
	it.each(supportedProviders)("returns true for supported provider '%s'", (provider) => {
		expect(isSupportedProvider(provider)).toBe(true)
	})

	it("returns false for 'roo' (retired provider)", () => {
		expect(isSupportedProvider("roo")).toBe(false)
	})

	it("returns false for unknown provider", () => {
		expect(isSupportedProvider("not-a-provider")).toBe(false)
	})

	it("returns false for empty string", () => {
		expect(isSupportedProvider("")).toBe(false)
	})
})

describe("provider resolution fallback", () => {
	it("defaults to openrouter when no flag or setting is provided", () => {
		const flagProvider = undefined
		const settingsProvider = undefined
		const effectiveProvider = flagProvider ?? settingsProvider ?? "openrouter"

		expect(effectiveProvider).toBe("openrouter")
		expect(isSupportedProvider(effectiveProvider)).toBe(true)
	})

	it("uses flag provider over settings and default", () => {
		const flagProvider = "anthropic"
		const settingsProvider = "gemini"
		const effectiveProvider = flagProvider ?? settingsProvider ?? "openrouter"

		expect(effectiveProvider).toBe("anthropic")
	})

	it("uses settings provider when flag is not provided", () => {
		const flagProvider = undefined
		const settingsProvider = "gemini"
		const effectiveProvider = flagProvider ?? settingsProvider ?? "openrouter"

		expect(effectiveProvider).toBe("gemini")
	})
})
