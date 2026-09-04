import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

vi.mock("i18next", () => ({
	default: {
		t: (key: string) => key,
	},
}))

import { validateApiConfigurationExcludingModelErrors } from "../validate"

describe("NeuronPool key validation", () => {
	it("returns an apiKey error when neuronpoolApiKey is missing", () => {
		const config: ProviderSettings = {
			apiProvider: providerIdentifiers.neuronpool,
			apiModelId: "gpt-oss-20b",
		}
		expect(validateApiConfigurationExcludingModelErrors(config)).toBe("settings:validation.apiKey")
	})

	it("accepts neuronpoolApiKey", () => {
		const config: ProviderSettings = {
			apiProvider: providerIdentifiers.neuronpool,
			neuronpoolApiKey: "valid-key",
			apiModelId: "gpt-oss-20b",
		}
		expect(validateApiConfigurationExcludingModelErrors(config)).toBeUndefined()
	})

	it("does not accept a generic apiKey as the NeuronPool credential", () => {
		const config: ProviderSettings = {
			apiProvider: providerIdentifiers.neuronpool,
			apiKey: "sk-ant-should-not-leak",
			apiModelId: "gpt-oss-20b",
		}
		expect(validateApiConfigurationExcludingModelErrors(config)).toBe("settings:validation.apiKey")
	})
})
