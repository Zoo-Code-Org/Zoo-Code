import { providerIdentifiers, retiredProviderIdentifiers } from "../provider-identifiers.js"
import {
	DEFAULT_API_PROVIDER,
	getActiveProvider,
	isRetiredProvider,
	resolveProviderSettings,
	type ProviderSettings,
} from "../provider-settings.js"

describe("resolveProviderSettings", () => {
	it("uses the shared default provider when none is set", () => {
		expect(DEFAULT_API_PROVIDER).toBe(providerIdentifiers.anthropic)
		expect(resolveProviderSettings({}).apiProvider).toBe(DEFAULT_API_PROVIDER)
	})

	it.each([
		{ name: "explicit provider", settings: { apiProvider: providerIdentifiers.openrouter } },
		{ name: "retired provider", settings: { apiProvider: retiredProviderIdentifiers.roo } },
	] as const)("keeps an $name unchanged", ({ settings }) => {
		expect(resolveProviderSettings(settings).apiProvider).toBe(settings.apiProvider)
	})

	it("keeps retired providers instead of replacing them", () => {
		const resolved = resolveProviderSettings({ apiProvider: retiredProviderIdentifiers.groq })

		expect(resolved.apiProvider).toBe(retiredProviderIdentifiers.groq)
		expect(isRetiredProvider(resolved.apiProvider)).toBe(true)
	})

	it("preserves the remaining settings", () => {
		const resolved = resolveProviderSettings({ apiModelId: "claude-sonnet-4-5", apiKey: "test-key" })

		expect(resolved).toEqual({
			apiProvider: DEFAULT_API_PROVIDER,
			apiModelId: "claude-sonnet-4-5",
			apiKey: "test-key",
		})
	})

	it("returns a new object and does not mutate the input", () => {
		const settings: ProviderSettings = {}
		const resolved = resolveProviderSettings(settings)

		expect(resolved).not.toBe(settings)
		expect(settings.apiProvider).toBeUndefined()
	})
})

describe("getActiveProvider", () => {
	it.each([
		{ name: "active provider", provider: providerIdentifiers.openrouter, expected: providerIdentifiers.openrouter },
		{ name: "retired provider", provider: retiredProviderIdentifiers.roo, expected: undefined },
	] as const)("returns $expected for an $name", ({ provider, expected }) => {
		expect(getActiveProvider(resolveProviderSettings({ apiProvider: provider }))).toBe(expected)
	})
})
