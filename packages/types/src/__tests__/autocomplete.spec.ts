import {
	AUTOCOMPLETE_DEFAULTS,
	autocompleteConfigSchema,
	resolveAutocompleteConfig,
	type AutocompleteConfig,
} from "../autocomplete.js"
import { GLOBAL_SECRET_KEYS, globalSettingsSchema, isSecretStateKey } from "../global-settings.js"

describe("autocompleteConfigSchema", () => {
	it("accepts an empty object so partially-persisted settings round-trip", () => {
		expect(autocompleteConfigSchema.parse({})).toEqual({})
	})

	it("rejects out-of-range numeric fields", () => {
		expect(autocompleteConfigSchema.safeParse({ debounceMs: -1 }).success).toBe(false)
		expect(autocompleteConfigSchema.safeParse({ debounceMs: 2_001 }).success).toBe(false)
		expect(autocompleteConfigSchema.safeParse({ temperature: 2.5 }).success).toBe(false)
		expect(autocompleteConfigSchema.safeParse({ maxOutputTokens: 0 }).success).toBe(false)
	})

	it("rejects non-integer token budgets", () => {
		expect(autocompleteConfigSchema.safeParse({ maxPrefixTokens: 512.5 }).success).toBe(false)
	})

	it("rejects unknown provider and template ids", () => {
		expect(autocompleteConfigSchema.safeParse({ provider: "copilot" }).success).toBe(false)
		expect(autocompleteConfigSchema.safeParse({ fimTemplate: "gpt4" }).success).toBe(false)
	})

	it("caps stop sequences", () => {
		const tooMany = Array.from({ length: 17 }, (_, i) => `stop-${i}`)
		expect(autocompleteConfigSchema.safeParse({ stopSequences: tooMany }).success).toBe(false)
		expect(autocompleteConfigSchema.safeParse({ stopSequences: tooMany.slice(0, 16) }).success).toBe(true)
	})
})

describe("resolveAutocompleteConfig", () => {
	it("applies every default when nothing is persisted", () => {
		const resolved = resolveAutocompleteConfig(undefined)

		expect(resolved.enabled).toBe(AUTOCOMPLETE_DEFAULTS.ENABLED)
		expect(resolved.provider).toBe(AUTOCOMPLETE_DEFAULTS.PROVIDER)
		expect(resolved.baseUrl).toBe(AUTOCOMPLETE_DEFAULTS.BASE_URL)
		expect(resolved.triggerMode).toBe(AUTOCOMPLETE_DEFAULTS.TRIGGER_MODE)
		expect(resolved.debounceMs).toBe(AUTOCOMPLETE_DEFAULTS.DEBOUNCE_MS)
		expect(resolved.multilineMode).toBe(AUTOCOMPLETE_DEFAULTS.MULTILINE_MODE)
		expect(resolved.temperature).toBe(AUTOCOMPLETE_DEFAULTS.TEMPERATURE)
		expect(resolved.fimTemplate).toBe(AUTOCOMPLETE_DEFAULTS.FIM_TEMPLATE)
		expect(resolved.disabledLanguages).toEqual([])
	})

	it("is defaulted-not-empty for an empty persisted object", () => {
		expect(resolveAutocompleteConfig({})).toEqual(resolveAutocompleteConfig(undefined))
	})

	it("preserves explicitly persisted values", () => {
		const config: AutocompleteConfig = {
			enabled: true,
			provider: "codestral",
			modelId: "codestral-latest",
			baseUrl: "https://example.test",
			triggerMode: "manual",
			debounceMs: 0,
			temperature: 0.5,
			disabledLanguages: ["markdown"],
		}

		const resolved = resolveAutocompleteConfig(config)

		expect(resolved).toMatchObject(config)
	})

	it("keeps falsy overrides instead of falling back to defaults", () => {
		// `?? ` rather than `||` matters here: 0ms debounce and temperature 0 are meaningful.
		const resolved = resolveAutocompleteConfig({ debounceMs: 0, temperature: 0, useOpenTabs: false })

		expect(resolved.debounceMs).toBe(0)
		expect(resolved.temperature).toBe(0)
		expect(resolved.useOpenTabs).toBe(false)
	})

	it("leaves fields without a sensible default undefined", () => {
		const resolved = resolveAutocompleteConfig({})

		expect(resolved.modelId).toBeUndefined()
		expect(resolved.chatFallbackProvider).toBeUndefined()
		expect(resolved.stopSequences).toBeUndefined()
	})

	it("produces a value the schema still accepts", () => {
		expect(autocompleteConfigSchema.safeParse(resolveAutocompleteConfig(undefined)).success).toBe(true)
	})
})

describe("autocomplete settings storage wiring", () => {
	it("exposes autocompleteConfig and autocompleteApiKey on globalSettingsSchema", () => {
		const keys = globalSettingsSchema.keyof().options as string[]

		expect(keys).toContain("autocompleteConfig")
		expect(keys).toContain("autocompleteApiKey")
	})

	it("routes autocompleteApiKey to secret storage", () => {
		expect(GLOBAL_SECRET_KEYS).toContain("autocompleteApiKey")
		expect(isSecretStateKey("autocompleteApiKey")).toBe(true)
	})

	it("does not treat autocompleteConfig as a secret", () => {
		expect(isSecretStateKey("autocompleteConfig")).toBe(false)
	})
})
