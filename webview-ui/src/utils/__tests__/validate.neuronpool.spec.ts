import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

vi.mock("i18next", () => ({
	default: {
		t: (key: string) => key,
	},
}))

import { validateApiConfigurationExcludingModelErrors } from "../validate"

describe("NeuronPool key fallback", () => {
	it("returns an apiKey error when both neuronpoolApiKey and apiKey are missing", () => {
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

	it("accepts the apiKey fallback used by NeuronPoolHandler", () => {
		const config: ProviderSettings = {
			apiProvider: providerIdentifiers.neuronpool,
			apiKey: "fallback-key",
			apiModelId: "gpt-oss-20b",
		}
		expect(validateApiConfigurationExcludingModelErrors(config)).toBeUndefined()
	})
})
