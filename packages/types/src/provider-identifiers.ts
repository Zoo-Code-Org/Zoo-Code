/**
 * Canonical provider identifiers.
 *
 * Values in this registry are persisted in settings and must remain stable.
 */
export const providerIdentifiers = {
	openrouter: "openrouter",
	vercelAiGateway: "vercel-ai-gateway",
	zooGateway: "zoo-gateway",
	litellm: "litellm",
	requesty: "requesty",
	unbound: "unbound",
	poe: "poe",
	deepseek: "deepseek",
	opencodeGo: "opencode-go",
	kenari: "kenari",
	ollama: "ollama",
	lmstudio: "lmstudio",
	vscodeLm: "vscode-lm",
	openai: "openai",
	fakeAi: "fake-ai",
	anthropic: "anthropic",
	bedrock: "bedrock",
	baseten: "baseten",
	fireworks: "fireworks",
	friendli: "friendli",
	gemini: "gemini",
	geminiCli: "gemini-cli",
	mistral: "mistral",
	moonshot: "moonshot",
	minimax: "minimax",
	mimo: "mimo",
	openaiCodex: "openai-codex",
	openaiNative: "openai-native",
	qwenCode: "qwen-code",
	sambanova: "sambanova",
	vertex: "vertex",
	xai: "xai",
	zai: "zai",
} as const

export type ProviderIdentifier = (typeof providerIdentifiers)[keyof typeof providerIdentifiers]

/** Provider identifiers retained only for compatibility with existing settings. */
export const retiredProviderIdentifiers = {
	cerebras: "cerebras",
	chutes: "chutes",
	deepinfra: "deepinfra",
	doubao: "doubao",
	featherless: "featherless",
	groq: "groq",
	huggingface: "huggingface",
	ioIntelligence: "io-intelligence",
	roo: "roo",
} as const

export type RetiredProviderIdentifier = (typeof retiredProviderIdentifiers)[keyof typeof retiredProviderIdentifiers]
