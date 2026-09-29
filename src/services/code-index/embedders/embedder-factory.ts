import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { t } from "../../../i18n"
import type { CodeIndexConfig } from "../interfaces/config"
import type { IEmbedder } from "../interfaces"
import type { IEmbedderFactory } from "../interfaces/embedder-factory"
import { OpenAiEmbedderFactory } from "./factories/openai-embedder-factory"
import { OllamaEmbedderFactory } from "./factories/ollama-embedder-factory"
import { OpenAICompatibleEmbedderFactory } from "./factories/openai-compatible-embedder-factory"
import { GeminiEmbedderFactory } from "./factories/gemini-embedder-factory"
import { MistralEmbedderFactory } from "./factories/mistral-embedder-factory"
import { VercelAiGatewayEmbedderFactory } from "./factories/vercel-ai-gateway-embedder-factory"
import { BedrockEmbedderFactory } from "./factories/bedrock-embedder-factory"
import { OpenRouterEmbedderFactory } from "./factories/openrouter-embedder-factory"

type VectorEmbedderProvider = Exclude<CodeIndexConfig["embedderProvider"], "semble">

export class EmbedderFactory implements IEmbedderFactory {
	// Each provider owns its constructor arguments and validation. The record requires
	// an entry for every vector embedder provider when the supported union changes.
	// TODO: Inject the provider factory registry via DI instead of constructing factories here.
	// https://github.com/Zoo-Code-Org/Zoo-Code/issues/1817
	private readonly embedderFactories: Readonly<Record<VectorEmbedderProvider, IEmbedderFactory>> = {
		[providerIdentifiers.openai]: new OpenAiEmbedderFactory(),
		[providerIdentifiers.ollama]: new OllamaEmbedderFactory(),
		"openai-compatible": new OpenAICompatibleEmbedderFactory(),
		[providerIdentifiers.gemini]: new GeminiEmbedderFactory(),
		[providerIdentifiers.mistral]: new MistralEmbedderFactory(),
		[providerIdentifiers.vercelAiGateway]: new VercelAiGatewayEmbedderFactory(),
		[providerIdentifiers.bedrock]: new BedrockEmbedderFactory(),
		[providerIdentifiers.openrouter]: new OpenRouterEmbedderFactory(),
	}

	public create(config: CodeIndexConfig): IEmbedder {
		const provider = config.embedderProvider

		// Semble is a self-contained search binary, not a vector embedder.
		if (provider === "semble") {
			throw new Error(
				"Semble provider handles its own embedding. Do not call createEmbedder() for semble — use SembleProvider instead.",
			)
		}

		// Keep a runtime guard for invalid persisted configuration, including prototype keys.
		if (!Object.prototype.hasOwnProperty.call(this.embedderFactories, provider)) {
			throw new Error(t("embeddings:serviceFactory.invalidEmbedderType", { embedderProvider: provider }))
		}

		return this.embedderFactories[provider].create(config)
	}
}
