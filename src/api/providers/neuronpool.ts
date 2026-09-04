import { type NeuronPoolModelId, neuronpoolDefaultModelId, neuronpoolModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"

export const NEURONPOOL_DEFAULT_BASE_URL = "https://neuronpool.damnknee.workers.dev/v1"

/** Trim trailing slashes without a `/+` regex (CodeQL js/polynomial-redos). */
export function stripTrailingSlashes(url: string): string {
	let end = url.length
	// Stryker disable next-line ConditionalExpression: end>0 guard; charCodeAt(-1) is never 47
	while (end > 0 && url.charCodeAt(end - 1) === 47) {
		end -= 1
	}
	return url.slice(0, end)
}

export class NeuronPoolHandler extends BaseOpenAiCompatibleProvider<NeuronPoolModelId> {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "NeuronPool",
			baseURL: stripTrailingSlashes(options.neuronpoolBaseUrl || NEURONPOOL_DEFAULT_BASE_URL),
			apiKey: options.neuronpoolApiKey ?? options.apiKey,
			defaultProviderModelId: neuronpoolDefaultModelId,
			providerModels: neuronpoolModels,
			defaultTemperature: 0,
		})
	}
}
