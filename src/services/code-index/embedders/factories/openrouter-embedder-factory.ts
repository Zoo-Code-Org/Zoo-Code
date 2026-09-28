import type { CodeIndexConfig } from "../../interfaces/config"
import type { IEmbedderFactory } from "../../interfaces/embedder-factory"
import { OpenRouterEmbedder } from "../openrouter"
import { requireSetting } from "./require-setting"

export class OpenRouterEmbedderFactory implements IEmbedderFactory {
	create({ openRouterOptions, modelId }: CodeIndexConfig): OpenRouterEmbedder {
		return new OpenRouterEmbedder(
			requireSetting(openRouterOptions?.apiKey, "embeddings:serviceFactory.openRouterConfigMissing"),
			modelId,
			undefined, // maxItemTokens
			openRouterOptions?.specificProvider,
		)
	}
}
