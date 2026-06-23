import { novitaDefaultModelId, novitaModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { getModelParams } from "../transform/model-params"

import { OpenAICompatibleHandler, OpenAICompatibleConfig } from "./openai-compatible"

export class NovitaHandler extends OpenAICompatibleHandler {
	constructor(options: ApiHandlerOptions) {
		const modelId = options.apiModelId ?? novitaDefaultModelId
		const modelInfo = novitaModels[modelId as keyof typeof novitaModels] || novitaModels[novitaDefaultModelId]

		const config: OpenAICompatibleConfig = {
			providerName: "novita",
			baseURL: options.novitaBaseUrl || "https://api.novita.ai/openai",
			apiKey: options.novitaApiKey ?? "not-provided",
			modelId,
			modelInfo,
			modelMaxTokens: options.modelMaxTokens ?? undefined,
			temperature: options.modelTemperature ?? undefined,
		}

		super(options, config)
	}

	override getModel() {
		const id = this.options.apiModelId ?? novitaDefaultModelId
		const info = novitaModels[id as keyof typeof novitaModels] || novitaModels[novitaDefaultModelId]
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: info.defaultTemperature ?? 0,
		})
		return { id, info, ...params }
	}
}
