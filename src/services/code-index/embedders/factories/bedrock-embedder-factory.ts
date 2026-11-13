import type { CodeIndexConfig } from "../../interfaces/config"
import type { IEmbedderFactory } from "../../interfaces/embedder-factory"
import { ProviderPacerRegistry } from "../../provider-pacer"
import { BedrockEmbedder } from "../bedrock"
import { requireSetting } from "./require-setting"

export class BedrockEmbedderFactory implements IEmbedderFactory {
	create({ bedrockOptions, modelId }: CodeIndexConfig, pacers = new ProviderPacerRegistry()): BedrockEmbedder {
		return new BedrockEmbedder(
			requireSetting(bedrockOptions?.region, "embeddings:serviceFactory.bedrockConfigMissing"),
			bedrockOptions?.profile,
			modelId,
			pacers,
		)
	}
}
