import {
	dynamicProviders,
	getModelId,
	getProviderDefaultModelId,
	inferDefaultModelId,
	isSecretStateKey,
	providerIdentifiers,
	providerSettingsSchema,
} from "../index.js"

describe("Infer shared contract", () => {
	it("registers the stable dynamic-provider identity and default model", () => {
		expect(providerIdentifiers.infer).toBe("infer")
		expect(dynamicProviders).toContain(providerIdentifiers.infer)
		expect(getProviderDefaultModelId(providerIdentifiers.infer, {})).toBe(inferDefaultModelId)
		expect(inferDefaultModelId).toBe("infer/claude-opus-5-5:low-cost")
	})

	it("classifies the API key as secret and resolves the configured model", () => {
		expect(isSecretStateKey("inferApiKey")).toBe(true)
		const settings = providerSettingsSchema.parse({
			apiProvider: providerIdentifiers.infer,
			inferModelId: "infer/model:stable",
		})
		expect(getModelId(settings)).toBe("infer/model:stable")
	})
})
