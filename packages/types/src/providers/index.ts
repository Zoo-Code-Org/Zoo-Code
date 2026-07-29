export * from "./anthropic.js"
export * from "./baseten.js"
export * from "./bedrock.js"
export * from "./deepseek.js"
export * from "./fireworks.js"
export * from "./friendli.js"
export * from "./gemini.js"
export * from "./lite-llm.js"
export * from "./lm-studio.js"
export * from "./mistral.js"
export * from "./moonshot.js"
export * from "./ollama.js"
export * from "./openai.js"
export * from "./openai-codex.js"
export * from "./openai-codex-rate-limits.js"
export * from "./openrouter.js"
export * from "./poe.js"
export * from "./qwen-code.js"
export * from "./requesty.js"
export * from "./sambanova.js"
export * from "./unbound.js"
export * from "./vertex.js"
export * from "./vscode-llm.js"
export * from "./xai.js"
export * from "./vercel-ai-gateway.js"
export * from "./opencode-go.js"
export * from "./kenari.js"
export * from "./kimi-code.js"
export * from "./zai.js"
export * from "./minimax.js"
export * from "./mimo.js"
export * from "./zoo-gateway.js"

import { anthropicDefaultModelId } from "./anthropic.js"
import { basetenDefaultModelId } from "./baseten.js"
import { bedrockDefaultModelId } from "./bedrock.js"
import { deepSeekDefaultModelId } from "./deepseek.js"
import { fireworksDefaultModelId } from "./fireworks.js"
import { friendliDefaultModelId } from "./friendli.js"
import { geminiDefaultModelId } from "./gemini.js"
import { litellmDefaultModelId } from "./lite-llm.js"
import { mistralDefaultModelId } from "./mistral.js"
import { moonshotDefaultModelId } from "./moonshot.js"
import { openAiCodexDefaultModelId } from "./openai-codex.js"
import { openRouterDefaultModelId } from "./openrouter.js"
import { poeDefaultModelId } from "./poe.js"
import { qwenCodeDefaultModelId } from "./qwen-code.js"
import { requestyDefaultModelId } from "./requesty.js"
import { sambaNovaDefaultModelId } from "./sambanova.js"
import { unboundDefaultModelId } from "./unbound.js"
import { vertexDefaultModelId } from "./vertex.js"
import { vscodeLlmDefaultModelId } from "./vscode-llm.js"
import { xaiDefaultModelId } from "./xai.js"
import { vercelAiGatewayDefaultModelId } from "./vercel-ai-gateway.js"
import { opencodeGoDefaultModelId } from "./opencode-go.js"
import { kenariDefaultModelId } from "./kenari.js"
import { kimiCodeDefaultModelId } from "./kimi-code.js"
import { internationalZAiDefaultModelId, mainlandZAiDefaultModelId } from "./zai.js"
import { minimaxDefaultModelId } from "./minimax.js"
import { mimoDefaultModelId } from "./mimo.js"
import { zooGatewayDefaultModelId } from "./zoo-gateway.js"

// Import the ProviderName type from provider-settings to avoid duplication
import type { ProviderName } from "../provider-settings.js"
import { providerIdentifiers } from "../provider-identifiers.js"

const NO_DEFAULT_MODEL_ID = ""

/**
 * Get the default model ID for a given provider.
 * This function returns only the provider's default model ID, without considering user configuration.
 * Used as a fallback when provider models are still loading.
 */
export function getProviderDefaultModelId(
	provider: ProviderName,
	options: { isChina?: boolean } = { isChina: false },
): string {
	switch (provider) {
		case providerIdentifiers.openrouter:
			return openRouterDefaultModelId
		case providerIdentifiers.requesty:
			return requestyDefaultModelId
		case providerIdentifiers.litellm:
			return litellmDefaultModelId
		case providerIdentifiers.xai:
			return xaiDefaultModelId
		case providerIdentifiers.baseten:
			return basetenDefaultModelId
		case providerIdentifiers.bedrock:
			return bedrockDefaultModelId
		case providerIdentifiers.vertex:
			return vertexDefaultModelId
		case providerIdentifiers.gemini:
			return geminiDefaultModelId
		case providerIdentifiers.deepseek:
			return deepSeekDefaultModelId
		case providerIdentifiers.moonshot:
			return moonshotDefaultModelId
		case providerIdentifiers.minimax:
			return minimaxDefaultModelId
		case providerIdentifiers.mimo:
			return mimoDefaultModelId
		case providerIdentifiers.zai:
			return options?.isChina ? mainlandZAiDefaultModelId : internationalZAiDefaultModelId
		case providerIdentifiers.openaiNative:
			// TODO(#992): Replace this stale fallback with openAiNativeDefaultModelId.
			return "gpt-4o" // Based on openai-native patterns
		case providerIdentifiers.openaiCodex:
			return openAiCodexDefaultModelId
		case providerIdentifiers.mistral:
			return mistralDefaultModelId
		case providerIdentifiers.openai:
		case providerIdentifiers.ollama:
		case providerIdentifiers.lmstudio:
			return NO_DEFAULT_MODEL_ID
		case providerIdentifiers.vscodeLm:
			return vscodeLlmDefaultModelId
		case providerIdentifiers.sambanova:
			return sambaNovaDefaultModelId
		case providerIdentifiers.fireworks:
			return fireworksDefaultModelId
		case providerIdentifiers.friendli:
			return friendliDefaultModelId
		case providerIdentifiers.qwenCode:
			return qwenCodeDefaultModelId
		case providerIdentifiers.poe:
			return poeDefaultModelId
		case providerIdentifiers.unbound:
			return unboundDefaultModelId
		case providerIdentifiers.vercelAiGateway:
			return vercelAiGatewayDefaultModelId
		case providerIdentifiers.opencodeGo:
			return opencodeGoDefaultModelId
		case providerIdentifiers.kenari:
			return kenariDefaultModelId
		case providerIdentifiers.kimiCode:
			return kimiCodeDefaultModelId
		case providerIdentifiers.zooGateway:
			return zooGatewayDefaultModelId
		case providerIdentifiers.anthropic:
		case providerIdentifiers.geminiCli:
		case providerIdentifiers.fakeAi:
		default:
			return anthropicDefaultModelId
	}
}
