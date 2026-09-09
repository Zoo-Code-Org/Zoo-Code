import { retiredProviderIdentifiers } from "@roo-code/types"

import { downgradeLegacyRooConfig, isLegacyRooConfig, LEGACY_ROO_PROVIDER } from "../routerRemoval"

describe("routerRemoval", () => {
	it("uses the canonical retired Roo provider identifier without changing its persisted value", () => {
		expect(LEGACY_ROO_PROVIDER).toBe("roo")
	})

	it("continues to recognize and downgrade persisted Roo provider settings", () => {
		const persistedConfig = {
			apiProvider: retiredProviderIdentifiers.roo,
			apiModelId: "roo/code-supernova",
			rooApiKey: "legacy-key",
			customSetting: "preserved",
		}

		expect(isLegacyRooConfig(persistedConfig)).toBe(true)
		expect(downgradeLegacyRooConfig(persistedConfig)).toEqual({
			config: { customSetting: "preserved" },
			migrated: true,
		})
	})

	it("leaves non-Roo retired provider settings unchanged", () => {
		const persistedConfig = {
			apiProvider: retiredProviderIdentifiers.groq,
			apiModelId: "legacy-model",
		}

		expect(isLegacyRooConfig(persistedConfig)).toBe(false)
		expect(downgradeLegacyRooConfig(persistedConfig)).toEqual({
			config: persistedConfig,
			migrated: false,
		})
	})

	it("rejects null and non-object input without throwing", () => {
		expect(isLegacyRooConfig(null)).toBe(false)
		expect(isLegacyRooConfig("roo")).toBe(false)
		expect(isLegacyRooConfig({ apiProvider: "some-other-provider" })).toBe(false)
	})
})
