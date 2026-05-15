import { type AetherapiModelId, aetherapiDefaultModelId, aetherapiModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"

export class AetherapiHandler extends BaseOpenAiCompatibleProvider<AetherapiModelId> {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "AetherAPI",
			baseURL: options.aetherapiBaseUrl || "https://api.aetherapi.dev/v1",
			apiKey: options.aetherapiApiKey,
			defaultProviderModelId: aetherapiDefaultModelId,
			providerModels: aetherapiModels,
			defaultTemperature: 0,
		})
	}
}
