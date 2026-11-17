import { providerIdentifiers, retiredProviderIdentifiers, type ModelInfo } from "@roo-code/types"

import { getCustomModelId, getPickerSelection, isPickerModelAllowed } from "../customModel"

const info: ModelInfo = { contextWindow: 128000, supportsPromptCache: false }

describe("custom picker IDs", () => {
	it("uses the default provider's allowlist when no provider is configured", () => {
		expect(
			isPickerModelAllowed({}, "custom", { allowAll: false, providers: { openrouter: { allowAll: true } } }),
		).toBe(true)
	})
	it.each(Object.values(retiredProviderIdentifiers))("rejects retired provider %s", (apiProvider) => {
		expect(isPickerModelAllowed({ apiProvider }, "custom")).toBe(false)
	})
	it("honors global allowAll and denies a provider rule with no models", () => {
		expect(isPickerModelAllowed({}, "custom", { allowAll: true, providers: {} })).toBe(true)
		expect(
			isPickerModelAllowed({}, "custom", { allowAll: false, providers: { openrouter: { allowAll: false } } }),
		).toBe(false)
	})
	it("does not invent a selection when both sources are unset", () => {
		expect(getPickerSelection({}, {})).toEqual({ id: undefined, info: undefined })
	})
	it("returns matched metadata and never metadata from a different fallback", () => {
		const config = { apiProvider: providerIdentifiers.openrouter, openRouterModelId: "custom" }
		expect(getPickerSelection(config, { id: "custom", info })).toEqual({ id: "custom", info })
		expect(getPickerSelection(config, { id: "default", info })).toEqual({ id: "custom", info: undefined })
	})
	it("handles missing catalogs without re-offering the saved ID", () => {
		const config = { apiProvider: providerIdentifiers.openrouter, openRouterModelId: "saved" }
		expect(getCustomModelId(" new ", config, null)).toBe("new")
		expect(getCustomModelId(" saved ", config, null)).toBeUndefined()
		expect(getCustomModelId("   ", config, null)).toBeUndefined()
	})
	it("only accepts Bedrock's pseudo ID with an existing legitimate ARN", () => {
		const config = { apiProvider: providerIdentifiers.bedrock, awsCustomArn: "arn:existing" }
		expect(getCustomModelId(" custom-arn ", config, {})).toBe("custom-arn")
		expect(getCustomModelId(" arn:arbitrary ", config, {})).toBeUndefined()
		expect(getCustomModelId("new-model", config, {})).toBe("new-model")
	})
})
