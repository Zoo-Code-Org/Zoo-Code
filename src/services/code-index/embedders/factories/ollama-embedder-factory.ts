import type { CodeIndexConfig } from "../../interfaces/config"
import type { IEmbedderFactory } from "../../interfaces/embedder-factory"
import { CodeIndexOllamaEmbedder } from "../ollama"
import { requireSetting } from "./require-setting"

export class OllamaEmbedderFactory implements IEmbedderFactory {
	create({ ollamaOptions, modelId }: CodeIndexConfig): CodeIndexOllamaEmbedder {
		return new CodeIndexOllamaEmbedder({
			...ollamaOptions,
			ollamaBaseUrl: requireSetting(
				ollamaOptions?.ollamaBaseUrl,
				"embeddings:serviceFactory.ollamaConfigMissing",
			),
			ollamaModelId: modelId,
		})
	}
}
