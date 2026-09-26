import type { CodeIndexConfig } from "../../interfaces/config"
import type { IEmbedderFactory } from "../../interfaces/embedder-factory"
import { GeminiEmbedder } from "../gemini"
import { requireSetting } from "./require-setting"

export class GeminiEmbedderFactory implements IEmbedderFactory {
	create({ geminiOptions, modelId }: CodeIndexConfig): GeminiEmbedder {
		return new GeminiEmbedder(
			requireSetting(geminiOptions?.apiKey, "embeddings:serviceFactory.geminiConfigMissing"),
			modelId,
		)
	}
}
