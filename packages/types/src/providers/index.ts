export * from "./anthropic.js"
export * from "./baseten.js"
export * from "./bedrock.js"
export * from "./deepseek.js"
export * from "./fake-ai.js"
export * from "./fireworks.js"
export * from "./friendli.js"
export * from "./gemini.js"
export * from "./gemini-cli.js"
export * from "./lite-llm.js"
export * from "./litellm.js"
export * from "./lm-studio.js"
export * from "./mistral.js"
export * from "./moonshot.js"
export * from "./ollama.js"
export * from "./openai.js"
export * from "./openai-codex.js"
export * from "./openai-codex-rate-limits.js"
export * from "./openai-native.js"
export * from "./openrouter.js"
export * from "./poe.js"
export * from "./qwen-code.js"
export * from "./requesty.js"
export * from "./sambanova.js"
export * from "./unbound.js"
export * from "./vertex.js"
export * from "./vscode-lm.js"
export * from "./vscode-llm.js"
export * from "./xai.js"
export * from "./vercel-ai-gateway.js"
export * from "./opencode-go.js"
export * from "./kenari.js"
export * from "./io-intelligence.js"
export * from "./nanogpt.js"
export * from "./kimi-code.js"
export * from "./zai.js"
export * from "./minimax.js"
export * from "./mimo.js"
export * from "./zoo-gateway.js"

export type { ProviderDefinition } from "./common.js"

import { anthropicProviderDefinition } from "./anthropic.js"
import { basetenProviderDefinition } from "./baseten.js"
import { bedrockProviderDefinition } from "./bedrock.js"
import { deepSeekProviderDefinition } from "./deepseek.js"
import { fakeAiProviderDefinition } from "./fake-ai.js"
import { fireworksProviderDefinition } from "./fireworks.js"
import { friendliProviderDefinition } from "./friendli.js"
import { geminiProviderDefinition } from "./gemini.js"
import { geminiCliProviderDefinition } from "./gemini-cli.js"
import { ioIntelligenceProviderDefinition } from "./io-intelligence.js"
import { kenariProviderDefinition } from "./kenari.js"
import { kimiCodeProviderDefinition } from "./kimi-code.js"
import { litellmProviderDefinition } from "./litellm.js"
import { lmStudioProviderDefinition } from "./lm-studio.js"
import { mimoProviderDefinition } from "./mimo.js"
import { minimaxProviderDefinition } from "./minimax.js"
import { mistralProviderDefinition } from "./mistral.js"
import { moonshotProviderDefinition } from "./moonshot.js"
import { nanoGptProviderDefinition } from "./nanogpt.js"
import { ollamaProviderDefinition } from "./ollama.js"
import { openAiProviderDefinition } from "./openai.js"
import { openAiCodexProviderDefinition } from "./openai-codex.js"
import { openAiNativeProviderDefinition } from "./openai-native.js"
import { opencodeGoProviderDefinition } from "./opencode-go.js"
import { openRouterProviderDefinition } from "./openrouter.js"
import { poeProviderDefinition } from "./poe.js"
import { qwenCodeProviderDefinition } from "./qwen-code.js"
import { requestyProviderDefinition } from "./requesty.js"
import { sambaNovaProviderDefinition } from "./sambanova.js"
import { unboundProviderDefinition } from "./unbound.js"
import { vercelAiGatewayProviderDefinition } from "./vercel-ai-gateway.js"
import { vertexProviderDefinition } from "./vertex.js"
import { githubCopilotProviderDefinition, vsCodeLmProviderDefinition } from "./vscode-lm.js"
import { xaiProviderDefinition } from "./xai.js"
import { zaiProviderDefinition } from "./zai.js"
import { zooGatewayProviderDefinition } from "./zoo-gateway.js"

import type { ProviderDefinition } from "./common.js"

export const providerDefinitionList = [
	anthropicProviderDefinition,
	openRouterProviderDefinition,
	bedrockProviderDefinition,
	vertexProviderDefinition,
	openAiProviderDefinition,
	ollamaProviderDefinition,
	vsCodeLmProviderDefinition,
	githubCopilotProviderDefinition,
	lmStudioProviderDefinition,
	geminiProviderDefinition,
	geminiCliProviderDefinition,
	openAiCodexProviderDefinition,
	openAiNativeProviderDefinition,
	mistralProviderDefinition,
	deepSeekProviderDefinition,
	poeProviderDefinition,
	moonshotProviderDefinition,
	kimiCodeProviderDefinition,
	minimaxProviderDefinition,
	mimoProviderDefinition,
	requestyProviderDefinition,
	unboundProviderDefinition,
	fakeAiProviderDefinition,
	xaiProviderDefinition,
	litellmProviderDefinition,
	sambaNovaProviderDefinition,
	zaiProviderDefinition,
	fireworksProviderDefinition,
	friendliProviderDefinition,
	qwenCodeProviderDefinition,
	vercelAiGatewayProviderDefinition,
	opencodeGoProviderDefinition,
	kenariProviderDefinition,
	nanoGptProviderDefinition,
	ioIntelligenceProviderDefinition,
	zooGatewayProviderDefinition,
	basetenProviderDefinition,
] as const satisfies readonly ProviderDefinition[]
