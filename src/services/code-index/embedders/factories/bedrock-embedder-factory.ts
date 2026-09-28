import type { CodeIndexConfig } from "../../interfaces/config"
import type { IEmbedderFactory } from "../../interfaces/embedder-factory"
import { BedrockEmbedder } from "../bedrock"
import { requireSetting } from "./require-setting"

export class BedrockEmbedderFactory implements IEmbedderFactory {
	create({ bedrockOptions, modelId }: CodeIndexConfig): BedrockEmbedder {
		return new BedrockEmbedder(
			requireSetting(bedrockOptions?.region, "embeddings:serviceFactory.bedrockConfigMissing"),
			bedrockOptions?.profile,
			modelId,
		)
	}
}
