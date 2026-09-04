import { type NeuronPoolModelId, neuronpoolDefaultModelId, neuronpoolModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"

export const NEURONPOOL_DEFAULT_BASE_URL = "https://neuronpool.damnknee.workers.dev/v1"

export class NeuronPoolHandler extends BaseOpenAiCompatibleProvider<NeuronPoolModelId> {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "NeuronPool",
			baseURL: (options.neuronpoolBaseUrl || NEURONPOOL_DEFAULT_BASE_URL).replace(/\/+$/, ""),
			apiKey: options.neuronpoolApiKey ?? options.apiKey,
			defaultProviderModelId: neuronpoolDefaultModelId,
			providerModels: neuronpoolModels,
			defaultTemperature: 0,
		})
	}
}
