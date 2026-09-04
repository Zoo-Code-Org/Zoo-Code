import { type NeuronPoolModelId, neuronpoolDefaultModelId, neuronpoolModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"

export function neuronpoolDefaultBaseUrl(): string {
	return ["https://neuronpool.damnknee.workers.dev", "v1"].join("/")
}

export const NEURONPOOL_DEFAULT_BASE_URL = neuronpoolDefaultBaseUrl()

/** Trim trailing slashes without a `/+` regex (CodeQL js/polynomial-redos). */
export function stripTrailingSlashes(url: string): string {
	let end = url.length
	// Stryker disable next-line ConditionalExpression,EqualityOperator: end>0 vs >=0 is equivalent; charCodeAt(-1) is never 47
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
			baseURL: stripTrailingSlashes(options.neuronpoolBaseUrl || neuronpoolDefaultBaseUrl()),
			apiKey: options.neuronpoolApiKey ?? options.apiKey,
			defaultProviderModelId: neuronpoolDefaultModelId,
			providerModels: neuronpoolModels,
			defaultTemperature: 0,
		})
	}
}
