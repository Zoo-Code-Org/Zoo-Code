import { neuronpoolDefaultModelId, friendliDefaultModelId, providerIdentifiers } from "@roo-code/types"

import { getProviderModelConfig, getProviderServiceConfig } from "../utils/providerModelConfig"

describe("NeuronPool provider model config", () => {
	it("exposes the live Worker dashboard as the service URL", () => {
		expect(getProviderServiceConfig(providerIdentifiers.neuronpool)).toEqual({
			serviceName: "NeuronPool",
			serviceUrl: "https://neuronpool.damnknee.workers.dev/dashboard",
		})
		expect(getProviderServiceConfig(providerIdentifiers.friendli)).toEqual({
			serviceName: "Friendli",
			serviceUrl: "https://friendli.ai",
		})
	})

	it("wires apiModelId to the NeuronPool default model", () => {
		expect(getProviderModelConfig(providerIdentifiers.neuronpool)).toEqual({
			field: "apiModelId",
			default: neuronpoolDefaultModelId,
		})
		expect(getProviderModelConfig(providerIdentifiers.friendli)).toEqual({
			field: "apiModelId",
			default: friendliDefaultModelId,
		})
	})
})
