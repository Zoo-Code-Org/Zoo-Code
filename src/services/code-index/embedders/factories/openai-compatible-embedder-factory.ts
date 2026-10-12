import type { CodeIndexConfig } from "../../interfaces/config"
import type { IEmbedderFactory } from "../../interfaces/embedder-factory"
import { OpenAICompatibleEmbedder } from "../openai-compatible"
import { requireSetting } from "./require-setting"

export class OpenAICompatibleEmbedderFactory implements IEmbedderFactory {
	create({ openAiCompatibleOptions, modelId }: CodeIndexConfig): OpenAICompatibleEmbedder {
		return new OpenAICompatibleEmbedder(
			requireSetting(openAiCompatibleOptions?.baseUrl, "embeddings:validation.baseUrlRequired"),
			requireSetting(openAiCompatibleOptions?.apiKey, "embeddings:validation.apiKeyRequired"),
			modelId,
		)
	}
}
