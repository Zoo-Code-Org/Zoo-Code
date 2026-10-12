import type { CodeIndexConfig } from "../../interfaces/config"
import type { IEmbedderFactory } from "../../interfaces/embedder-factory"
import { OpenAiEmbedder } from "../openai"
import { requireSetting } from "./require-setting"

export class OpenAiEmbedderFactory implements IEmbedderFactory {
	create({ openAiOptions, modelId }: CodeIndexConfig): OpenAiEmbedder {
		return new OpenAiEmbedder({
			...openAiOptions,
			openAiNativeApiKey: requireSetting(
				openAiOptions?.openAiNativeApiKey,
				"embeddings:serviceFactory.openAiConfigMissing",
			),
			openAiEmbeddingModelId: modelId,
		})
	}
}
