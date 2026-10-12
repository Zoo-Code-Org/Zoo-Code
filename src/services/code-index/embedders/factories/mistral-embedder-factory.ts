import type { CodeIndexConfig } from "../../interfaces/config"
import type { IEmbedderFactory } from "../../interfaces/embedder-factory"
import { MistralEmbedder } from "../mistral"
import { requireSetting } from "./require-setting"

export class MistralEmbedderFactory implements IEmbedderFactory {
	create({ mistralOptions, modelId }: CodeIndexConfig): MistralEmbedder {
		return new MistralEmbedder(
			requireSetting(mistralOptions?.apiKey, "embeddings:serviceFactory.mistralConfigMissing"),
			modelId,
		)
	}
}
