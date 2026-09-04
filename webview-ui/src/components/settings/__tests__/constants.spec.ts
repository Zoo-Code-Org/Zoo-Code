import { neuronpoolModels, providerIdentifiers } from "@roo-code/types"

import { MODELS_BY_PROVIDER, PROVIDERS } from "../constants"

const pinnedProviders = [
	{ value: providerIdentifiers.friendli, label: "Friendli", proxy: false },
	{ value: providerIdentifiers.neuronpool, label: "NeuronPool", proxy: false },
	{ value: providerIdentifiers.vercelAiGateway, label: "Vercel AI Gateway", proxy: false },
] as const

describe("settings provider constants", () => {
	it("keeps NeuronPool and its adjacent dropdown rows intact", () => {
		for (const row of pinnedProviders) {
			expect(PROVIDERS.find((provider) => provider.value === row.value)).toEqual(row)
		}
	})

	it("registers the static NeuronPool catalog", () => {
		expect(MODELS_BY_PROVIDER[providerIdentifiers.neuronpool]).toEqual(neuronpoolModels)
	})
})
