import { neuronpoolModels, providerIdentifiers } from "@roo-code/types"

import { MODELS_BY_PROVIDER, PROVIDERS } from "../constants"

describe("NeuronPool constants", () => {
	it("registers NeuronPool in the provider dropdown", () => {
		expect(PROVIDERS).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					value: providerIdentifiers.neuronpool,
					label: "NeuronPool",
					proxy: false,
				}),
			]),
		)
	})

	it("registers the static NeuronPool catalog", () => {
		expect(MODELS_BY_PROVIDER[providerIdentifiers.neuronpool]).toEqual(neuronpoolModels)
	})
})
