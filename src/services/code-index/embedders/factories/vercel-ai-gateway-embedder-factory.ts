import type { CodeIndexConfig } from "../../interfaces/config"
import type { IEmbedderFactory } from "../../interfaces/embedder-factory"
import { VercelAiGatewayEmbedder } from "../vercel-ai-gateway"
import { requireSetting } from "./require-setting"

export class VercelAiGatewayEmbedderFactory implements IEmbedderFactory {
	create({ vercelAiGatewayOptions, modelId }: CodeIndexConfig): VercelAiGatewayEmbedder {
		return new VercelAiGatewayEmbedder(
			requireSetting(vercelAiGatewayOptions?.apiKey, "embeddings:serviceFactory.vercelAiGatewayConfigMissing"),
			modelId,
		)
	}
}
