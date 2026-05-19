import { type MimoModelId, mimoDefaultModelId, mimoModels, MIMO_DEFAULT_TEMPERATURE } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"

export class MiMoHandler extends BaseOpenAiCompatibleProvider<MimoModelId> {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "MiMo",
			baseURL: options.mimoBaseUrl || "https://api.mi.com/v1",
			apiKey: options.mimoApiKey,
			defaultProviderModelId: mimoDefaultModelId,
			providerModels: mimoModels,
			defaultTemperature: MIMO_DEFAULT_TEMPERATURE,
		})
	}
}
