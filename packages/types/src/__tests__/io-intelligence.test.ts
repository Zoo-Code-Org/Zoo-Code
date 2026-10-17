import {
	dynamicProviders,
	getModelId,
	getProviderDefaultModelId,
	ioIntelligenceDefaultModelId,
	isSecretStateKey,
	providerIdentifiers,
	providerSettingsSchema,
} from "../index.js"

describe("IO Intelligence shared contract", () => {
	it("registers the stable dynamic-provider identity and default model", () => {
		expect(providerIdentifiers.ioIntelligence).toBe("io-intelligence")
		expect(dynamicProviders).toContain(providerIdentifiers.ioIntelligence)
		expect(getProviderDefaultModelId(providerIdentifiers.ioIntelligence)).toBe(ioIntelligenceDefaultModelId)
	})

	it("classifies the API key as secret and resolves the configured model", () => {
		expect(isSecretStateKey("ioIntelligenceApiKey")).toBe(true)
		const settings = providerSettingsSchema.parse({
			apiProvider: providerIdentifiers.ioIntelligence,
			ioIntelligenceModelId: "model",
		})
		expect(getModelId(settings)).toBe("model")
	})
})
