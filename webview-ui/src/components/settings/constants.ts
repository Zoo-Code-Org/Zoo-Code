import { type ProviderName, getProviderLabel, providerIdentifiers } from "@roo-code/types"

// Labels are not duplicated here: `PROVIDERS` derives each one from the provider
// definition via `getProviderLabel`, so a new provider only needs its identifier
// and proxy flag added below.
const PROVIDER_ENTRIES: Array<{ value: ProviderName; proxy: boolean }> = [
	{ value: providerIdentifiers.openrouter, proxy: false },
	{ value: providerIdentifiers.anthropic, proxy: false },
	{ value: providerIdentifiers.gemini, proxy: false },
	{ value: providerIdentifiers.deepseek, proxy: false },
	{ value: providerIdentifiers.moonshot, proxy: false },
	{ value: providerIdentifiers.kimiCode, proxy: false },
	{ value: providerIdentifiers.openaiNative, proxy: false },
	{ value: providerIdentifiers.openaiCodex, proxy: false },
	{ value: providerIdentifiers.openai, proxy: true },
	{ value: providerIdentifiers.qwenCode, proxy: false },
	{ value: providerIdentifiers.vertex, proxy: false },
	{ value: providerIdentifiers.bedrock, proxy: false },
	{ value: providerIdentifiers.vscodeLm, proxy: false },
	{ value: providerIdentifiers.githubCopilot, proxy: false },
	{ value: providerIdentifiers.mistral, proxy: false },
	{ value: providerIdentifiers.lmstudio, proxy: true },
	{ value: providerIdentifiers.ollama, proxy: true },
	{ value: providerIdentifiers.requesty, proxy: false },
	{ value: providerIdentifiers.xai, proxy: false },
	{ value: providerIdentifiers.litellm, proxy: true },
	{ value: providerIdentifiers.sambanova, proxy: false },
	{ value: providerIdentifiers.zai, proxy: false },
	{ value: providerIdentifiers.fireworks, proxy: false },
	{ value: providerIdentifiers.friendli, proxy: false },
	{ value: providerIdentifiers.vercelAiGateway, proxy: false },
	{ value: providerIdentifiers.opencodeGo, proxy: false },
	{ value: providerIdentifiers.kenari, proxy: false },
	{ value: providerIdentifiers.ioIntelligence, proxy: false },
	{ value: providerIdentifiers.nanogpt, proxy: false },
	{ value: providerIdentifiers.zooGateway, proxy: false },
	{ value: providerIdentifiers.minimax, proxy: false },
	{ value: providerIdentifiers.mimo, proxy: false },
	{ value: providerIdentifiers.baseten, proxy: false },
	{ value: providerIdentifiers.unbound, proxy: false },
	{ value: providerIdentifiers.poe, proxy: false },
]

export const PROVIDERS: Array<{ value: string; label: string; proxy: boolean }> = PROVIDER_ENTRIES.map(
	({ value, proxy }) => ({ value, label: getProviderLabel(value), proxy }),
).sort((a, b) => a.label.localeCompare(b.label))
