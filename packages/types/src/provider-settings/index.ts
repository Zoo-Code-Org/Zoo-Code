import { anthropicProviderDefinition } from "./anthropic.js"
import { openRouterProviderDefinition } from "./openrouter.js"
import { bedrockProviderDefinition } from "./bedrock.js"
import { vertexProviderDefinition } from "./vertex.js"
import { openAiProviderDefinition } from "./openai.js"
import { ollamaProviderDefinition } from "./ollama.js"
import { vsCodeLmProviderDefinition } from "./vscode-lm.js"
import { lmStudioProviderDefinition } from "./lm-studio.js"
import { geminiProviderDefinition } from "./gemini.js"
import { geminiCliProviderDefinition } from "./gemini-cli.js"
import { openAiCodexProviderDefinition } from "./openai-codex.js"
import { openAiNativeProviderDefinition } from "./openai-native.js"
import { mistralProviderDefinition } from "./mistral.js"
import { deepSeekProviderDefinition } from "./deepseek.js"
import { poeProviderDefinition } from "./poe.js"
import { moonshotProviderDefinition } from "./moonshot.js"
import { kimiCodeProviderDefinition } from "./kimi-code.js"
import { minimaxProviderDefinition } from "./minimax.js"
import { mimoProviderDefinition } from "./mimo.js"
import { requestyProviderDefinition } from "./requesty.js"
import { unboundProviderDefinition } from "./unbound.js"
import { fakeAiProviderDefinition } from "./fake-ai.js"
import { xaiProviderDefinition } from "./xai.js"
import { litellmProviderDefinition } from "./litellm.js"
import { sambaNovaProviderDefinition } from "./sambanova.js"
import { zaiProviderDefinition } from "./zai.js"
import { fireworksProviderDefinition } from "./fireworks.js"
import { friendliProviderDefinition } from "./friendli.js"
import { qwenCodeProviderDefinition } from "./qwen-code.js"
import { vercelAiGatewayProviderDefinition } from "./vercel-ai-gateway.js"
import { opencodeGoProviderDefinition } from "./opencode-go.js"
import { kenariProviderDefinition } from "./kenari.js"
import { nanoGptProviderDefinition } from "./nanogpt.js"
import { zooGatewayProviderDefinition } from "./zoo-gateway.js"
import { basetenProviderDefinition } from "./baseten.js"

import type { ProviderDefinition } from "./common.js"

export { OPEN_AI_CODEX_SERVICE_TIER_KEY } from "./openai-codex.js"
export { OPENAI_EXTRA_BODY_RESERVED_KEYS, parseOpenAiExtraBody } from "./openai.js"
export { kimiCodeAuthMethodSchema, type KimiCodeAuthMethod } from "./kimi-code.js"
export { zaiApiLineSchema, type ZaiApiLine } from "./zai.js"
export {
	nanoGptDefaultRoutingPreference,
	nanoGptRoutingPreferences,
	nanoGptRoutingPreferenceSchema,
	type NanoGptRoutingPreference,
} from "./nanogpt.js"
export type { ProviderDefinition } from "./common.js"

export const providerDefinitionList = [
	anthropicProviderDefinition,
	openRouterProviderDefinition,
	bedrockProviderDefinition,
	vertexProviderDefinition,
	openAiProviderDefinition,
	ollamaProviderDefinition,
	vsCodeLmProviderDefinition,
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
	zooGatewayProviderDefinition,
	basetenProviderDefinition,
] as const satisfies readonly ProviderDefinition[]
