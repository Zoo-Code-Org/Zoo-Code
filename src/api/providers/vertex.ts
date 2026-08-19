import { type ModelInfo, type VertexModelId, vertexDefaultModelId, vertexModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { getModelParams } from "../transform/model-params"

import { GeminiHandler } from "./gemini"
import { SingleCompletionHandler } from "../index"

export class VertexHandler extends GeminiHandler implements SingleCompletionHandler {
	constructor(options: ApiHandlerOptions) {
		super({ ...options, isVertex: true })
	}

	override getModel() {
		const modelId = this.options.apiModelId
		let id: string
		let info: ModelInfo

		if (modelId && Object.hasOwn(vertexModels, modelId)) {
			id = modelId
			info = vertexModels[modelId as VertexModelId]
		} else if (
			modelId?.endsWith(":thinking") &&
			Object.hasOwn(vertexModels, modelId.slice(0, -":thinking".length))
		) {
			const baseModelId = modelId.slice(0, -":thinking".length) as VertexModelId
			id = modelId
			info = vertexModels[baseModelId]
		} else if (modelId && modelId.toLowerCase().startsWith("gemini-")) {
			id = modelId
			const baseModelId = modelId.endsWith(":thinking") ? modelId.slice(0, -":thinking".length) : modelId
			const fallbackModelId: VertexModelId = (
				Object.hasOwn(vertexModels, baseModelId)
					? baseModelId
					: "gemini-3.7-flash" in vertexModels
						? "gemini-3.7-flash"
						: "gemini-3.1-pro-preview" in vertexModels
							? "gemini-3.1-pro-preview"
							: vertexDefaultModelId
			) as VertexModelId
			const baseInfo = vertexModels[fallbackModelId] || vertexModels[vertexDefaultModelId]
			info = {
				...baseInfo,
				inputPrice: undefined,
				outputPrice: undefined,
				cacheReadsPrice: undefined,
				cacheWritesPrice: undefined,
				tiers: undefined,
			}
		} else {
			const defaultGeminiModel: VertexModelId = (
				"gemini-3.7-flash" in vertexModels
					? "gemini-3.7-flash"
					: "gemini-3.1-pro-preview" in vertexModels
						? "gemini-3.1-pro-preview"
						: vertexDefaultModelId
			) as VertexModelId
			id = defaultGeminiModel
			info = vertexModels[defaultGeminiModel]
		}

		const params = getModelParams({
			format: "gemini",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: info.defaultTemperature ?? 1,
		})

		// Vertex Gemini models perform better with the edit tool instead of apply_diff.
		info = {
			...info,
			excludedTools: [...new Set([...(info.excludedTools || []), "apply_diff"])],
			includedTools: [...new Set([...(info.includedTools || []), "edit"])],
		}

		// The `:thinking` suffix indicates that the model is a "Hybrid"
		// reasoning model and that reasoning is required to be enabled.
		// The actual model ID honored by Gemini's API does not have this
		// suffix.
		return { id: id.endsWith(":thinking") ? id.replace(":thinking", "") : id, info, ...params }
	}
}
