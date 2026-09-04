import { neuronpoolDefaultModelId, friendliDefaultModelId, providerIdentifiers } from "@roo-code/types"

import {
	PROVIDER_DEFAULT_MODEL_IDS,
	PROVIDER_SERVICE_CONFIG,
	getProviderModelConfig,
	getProviderServiceConfig,
} from "../providerModelConfig"

describe("NeuronPool provider model config", () => {
	it("exposes the live Worker dashboard as the service URL", () => {
		expect(PROVIDER_SERVICE_CONFIG[providerIdentifiers.neuronpool]).toEqual({
			serviceName: "NeuronPool",
			serviceUrl: "https://neuronpool.damnknee.workers.dev/dashboard",
		})
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
		expect(PROVIDER_DEFAULT_MODEL_IDS[providerIdentifiers.neuronpool]).toBe(neuronpoolDefaultModelId)
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
