import { DEFAULT_PROVIDER } from "@/types/index.js"
import { resolveProviderPreference } from "../run.js"

describe("run provider resolution", () => {
	it("defaults to the login-free provider when nothing is configured", () => {
		const result = resolveProviderPreference({})

		expect(result).toEqual({
			provider: DEFAULT_PROVIDER,
			fellBackFromStoredRooPreference: false,
			fellBackFromExplicitRooRequest: false,
		})
	})

	it("falls back from saved Roo preferences", () => {
		const result = resolveProviderPreference({
			settingsProvider: "roo",
		})

		expect(result).toEqual({
			provider: DEFAULT_PROVIDER,
			fellBackFromStoredRooPreference: true,
			fellBackFromExplicitRooRequest: false,
		})
	})

	it("falls back from an explicitly requested Roo provider selection", () => {
		const result = resolveProviderPreference({
			flagProvider: "roo",
		})

		expect(result).toEqual({
			provider: DEFAULT_PROVIDER,
			fellBackFromStoredRooPreference: false,
			fellBackFromExplicitRooRequest: true,
		})
	})

	it("preserves supported providers", () => {
		const result = resolveProviderPreference({
			settingsProvider: "anthropic",
		})

		expect(result).toEqual({
			provider: "anthropic",
			fellBackFromStoredRooPreference: false,
			fellBackFromExplicitRooRequest: false,
		})
	})
})
