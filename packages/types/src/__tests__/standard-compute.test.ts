import {
	dynamicProviders,
	getModelId,
	getProviderDefaultModelId,
	standardComputeDefaultModelId,
	isSecretStateKey,
	providerIdentifiers,
	providerSettingsSchema,
} from "../index.js"

describe("Standard Compute shared contract", () => {
	it("registers the stable dynamic-provider identity and default model", () => {
		expect(providerIdentifiers.standardCompute).toBe("standard-compute")
		expect(dynamicProviders).toContain(providerIdentifiers.standardCompute)
		expect(getProviderDefaultModelId(providerIdentifiers.standardCompute, {})).toBe(standardComputeDefaultModelId)
	})

	it("classifies the API key as secret and resolves the configured model", () => {
		expect(isSecretStateKey("standardComputeApiKey")).toBe(true)
		const settings = providerSettingsSchema.parse({
			apiProvider: providerIdentifiers.standardCompute,
			standardComputeModelId: "model",
		})
		expect(getModelId(settings)).toBe("model")
	})
})
