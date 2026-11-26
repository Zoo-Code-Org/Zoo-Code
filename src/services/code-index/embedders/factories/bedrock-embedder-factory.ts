import type { CodeIndexConfig } from "../../interfaces/config"
import type { IEmbedderFactory } from "../../interfaces/embedder-factory"
import type { ProviderPacerRegistry } from "../../provider-pacer"
import { BedrockEmbedder } from "../bedrock"
import { requireSetting } from "./require-setting"

export class BedrockEmbedderFactory implements IEmbedderFactory {
	create({ bedrockOptions, modelId }: CodeIndexConfig, pacers: ProviderPacerRegistry): BedrockEmbedder {
		return new BedrockEmbedder(
			requireSetting(bedrockOptions?.region, "embeddings:serviceFactory.bedrockConfigMissing"),
			bedrockOptions?.profile,
			modelId,
			pacers,
		)
	}
}
