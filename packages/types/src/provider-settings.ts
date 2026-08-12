import { z } from "zod"

import {
	modelInfoSchema,
	openAiCodexServiceTierSchema,
	reasoningEffortSettingSchema,
	verbosityLevelsSchema,
	serviceTierSchema,
} from "./model.js"
import { codebaseIndexProviderSchema } from "./codebase-index.js"
import {
	providerIdentifiers,
	retiredProviderIdentifiers,
	type ProviderIdentifier,
	type RetiredProviderIdentifier,
} from "./provider-identifiers.js"
import {
	anthropicModels,
	basetenModels,
	bedrockModels,
	deepSeekModels,
	fireworksModels,
	friendliModels,
	geminiModels,
	mistralModels,
	moonshotModels,
	openAiCodexModels,
	openAiNativeModels,
	qwenCodeModels,
	sambaNovaModels,
	vertexModels,
	vscodeLlmModels,
	xaiModels,
	internationalZAiModels,
	minimaxModels,
	mimoModels,
	isOpencodeGoAnthropicFormatModel,
	ANTHROPIC_API_PROTOCOL,
	OPENAI_API_PROTOCOL,
} from "./providers/index.js"

/**
 * constants
 */

export const DEFAULT_CONSECUTIVE_MISTAKE_LIMIT = 3
export const OPEN_AI_CODEX_SERVICE_TIER_KEY = "openAiCodexServiceTier"

/**
 * DynamicProvider
 *
 * Dynamic provider requires external API calls in order to get the model list.
 */

export const dynamicProviders = [
	providerIdentifiers.openrouter,
	providerIdentifiers.vercelAiGateway,
	providerIdentifiers.zooGateway,
	providerIdentifiers.litellm,
	providerIdentifiers.requesty,
	providerIdentifiers.unbound,
	providerIdentifiers.poe,
	providerIdentifiers.deepseek,
	providerIdentifiers.moonshot,
	providerIdentifiers.opencodeGo,
	providerIdentifiers.kenari,
	providerIdentifiers.kimiCode,
] as const

export type DynamicProvider = (typeof dynamicProviders)[number]

export const isDynamicProvider = (key: string): key is DynamicProvider =>
	dynamicProviders.includes(key as DynamicProvider)

/**
 * LocalProvider
 *
 * Local providers require localhost API calls in order to get the model list.
 */

export const localProviders = [providerIdentifiers.ollama, providerIdentifiers.lmstudio] as const

export type LocalProvider = (typeof localProviders)[number]

export const isLocalProvider = (key: string): key is LocalProvider => localProviders.includes(key as LocalProvider)

/**
 * InternalProvider
 *
 * Internal providers require internal VSCode API calls in order to get the
 * model list.
 */

export const internalProviders = [providerIdentifiers.vscodeLm] as const

export type InternalProvider = (typeof internalProviders)[number]

export const isInternalProvider = (key: string): key is InternalProvider =>
	internalProviders.includes(key as InternalProvider)

/**
 * CustomProvider
 *
 * Custom providers are completely configurable within Roo Code settings.
 */

export const customProviders = [providerIdentifiers.openai] as const

export type CustomProvider = (typeof customProviders)[number]

export const isCustomProvider = (key: string): key is CustomProvider => customProviders.includes(key as CustomProvider)

/**
 * FauxProvider
 *
 * Faux providers do not make external inference calls and therefore do not have
 * model lists.
 */

export const fauxProviders = [providerIdentifiers.fakeAi] as const

export type FauxProvider = (typeof fauxProviders)[number]

export const isFauxProvider = (key: string): key is FauxProvider => fauxProviders.includes(key as FauxProvider)

/**
 * ProviderName
 */

export const providerNames = Object.values(providerIdentifiers) as [ProviderIdentifier, ...ProviderIdentifier[]]

export const providerNamesSchema = z.enum(providerNames)

export type ProviderName = z.infer<typeof providerNamesSchema>

export const isProviderName = (key: unknown): key is ProviderName =>
	typeof key === "string" && providerNames.includes(key as ProviderName)

/**
 * RetiredProviderName
 */

export const retiredProviderNames = Object.values(retiredProviderIdentifiers) as [
	RetiredProviderIdentifier,
	...RetiredProviderIdentifier[],
]

export const retiredProviderNamesSchema = z.enum(retiredProviderNames)

export type RetiredProviderName = z.infer<typeof retiredProviderNamesSchema>

export const isRetiredProvider = (value: string): value is RetiredProviderName =>
	retiredProviderNames.includes(value as RetiredProviderName)

export const providerNamesWithRetiredSchema = z.union([providerNamesSchema, retiredProviderNamesSchema])

export type ProviderNameWithRetired = z.infer<typeof providerNamesWithRetiredSchema>

/**
 * ProviderSettingsEntry
 */

export const providerSettingsEntrySchema = z.object({
	id: z.string(),
	name: z.string(),
	apiProvider: providerNamesWithRetiredSchema.optional(),
	modelId: z.string().optional(),
})

export type ProviderSettingsEntry = z.infer<typeof providerSettingsEntrySchema>

/**
 * ProviderSettings
 */

const baseProviderSettingsSchema = z.object({
	includeMaxTokens: z.boolean().optional(),
	todoListEnabled: z.boolean().optional(),
	modelTemperature: z.number().nullish(),
	rateLimitSeconds: z.number().optional(),
	consecutiveMistakeLimit: z.number().min(0).optional(),

	// Model reasoning.
	enableReasoningEffort: z.boolean().optional(),
	reasoningEffort: reasoningEffortSettingSchema.optional(),
	modelMaxTokens: z.number().optional(),
	modelMaxThinkingTokens: z.number().optional(),

	// Model verbosity.
	verbosity: verbosityLevelsSchema.optional(),
})

// Several of the providers share common model config properties.
const apiModelIdProviderModelSchema = baseProviderSettingsSchema.extend({
	apiModelId: z.string().optional(),
})

const anthropicSchema = apiModelIdProviderModelSchema.extend({
	apiKey: z.string().optional(),
	anthropicBaseUrl: z.string().optional(),
	anthropicUseAuthToken: z.boolean().optional(),
	anthropicBeta1MContext: z.boolean().optional(), // Enable 'context-1m-2025-08-07' beta for 1M context window.
})

const openRouterSchema = baseProviderSettingsSchema.extend({
	openRouterApiKey: z.string().optional(),
	openRouterModelId: z.string().optional(),
	openRouterBaseUrl: z.string().optional(),
	openRouterSpecificProvider: z.string().optional(),
})

const bedrockSchema = apiModelIdProviderModelSchema.extend({
	awsAccessKey: z.string().optional(),
	awsSecretKey: z.string().optional(),
	awsSessionToken: z.string().optional(),
	awsRegion: z.string().optional(),
	awsUseCrossRegionInference: z.boolean().optional(),
	awsUseGlobalInference: z.boolean().optional(), // Enable Global Inference profile routing when supported
	awsUsePromptCache: z.boolean().optional(),
	awsProfile: z.string().optional(),
	awsUseProfile: z.boolean().optional(),
	awsApiKey: z.string().optional(),
	awsUseApiKey: z.boolean().optional(),
	awsCustomArn: z.string().optional(),
	awsModelContextWindow: z.number().optional(),
	awsBedrockEndpointEnabled: z.boolean().optional(),
	awsBedrockEndpoint: z.string().optional(),
	awsBedrock1MContext: z.boolean().optional(), // Enable 'context-1m-2025-08-07' beta for 1M context window.
	awsBedrockServiceTier: z.enum(["STANDARD", "FLEX", "PRIORITY"]).optional(), // AWS Bedrock service tier selection
})

const vertexSchema = apiModelIdProviderModelSchema.extend({
	vertexKeyFile: z.string().optional(),
	vertexJsonCredentials: z.string().optional(),
	vertexProjectId: z.string().optional(),
	vertexRegion: z.string().optional(),
	vertex1MContext: z.boolean().optional(), // Enable 'context-1m-2025-08-07' beta for 1M context window.
})

const openAiSchema = baseProviderSettingsSchema.extend({
	openAiBaseUrl: z.string().optional(),
	openAiApiKey: z.string().optional(),
	openAiR1FormatEnabled: z.boolean().optional(),
	openAiModelId: z.string().optional(),
	openAiCustomModelInfo: modelInfoSchema.nullish(),
	openAiUseAzure: z.boolean().optional(),
	azureApiVersion: z.string().optional(),
	openAiStreamingEnabled: z.boolean().optional(),
	openAiHostHeader: z.string().optional(), // Keep temporarily for backward compatibility during migration.
	openAiHeaders: z.record(z.string(), z.string()).optional(),
})

const ollamaSchema = baseProviderSettingsSchema.extend({
	ollamaModelId: z.string().optional(),
	ollamaBaseUrl: z.string().optional(),
	ollamaApiKey: z.string().optional(),
	ollamaNumCtx: z.number().int().min(128).optional(),
})

const vsCodeLmSchema = baseProviderSettingsSchema.extend({
	vsCodeLmModelSelector: z
		.object({
			vendor: z.string().optional(),
			family: z.string().optional(),
			version: z.string().optional(),
			id: z.string().optional(),
		})
		.optional(),
})

const lmStudioSchema = baseProviderSettingsSchema.extend({
	lmStudioModelId: z.string().optional(),
	lmStudioBaseUrl: z.string().optional(),
	lmStudioDraftModelId: z.string().optional(),
	lmStudioSpeculativeDecodingEnabled: z.boolean().optional(),
})

const geminiSchema = apiModelIdProviderModelSchema.extend({
	geminiApiKey: z.string().optional(),
	googleGeminiBaseUrl: z.string().optional(),
})

const geminiCliSchema = apiModelIdProviderModelSchema.extend({
	geminiCliOAuthPath: z.string().optional(),
	geminiCliProjectId: z.string().optional(),
})

const openAiCodexSchema = apiModelIdProviderModelSchema.extend({
	// Codex "Fast" mode maps to the Responses API priority service tier.
	[OPEN_AI_CODEX_SERVICE_TIER_KEY]: openAiCodexServiceTierSchema.optional(),
})

const openAiNativeSchema = apiModelIdProviderModelSchema.extend({
	openAiNativeApiKey: z.string().optional(),
	openAiNativeBaseUrl: z.string().optional(),
	// OpenAI Responses API service tier for openai-native provider only.
	// UI should only expose this when the selected model supports flex/priority.
	openAiNativeServiceTier: serviceTierSchema.optional(),
})

const mistralSchema = apiModelIdProviderModelSchema.extend({
	mistralApiKey: z.string().optional(),
	mistralCodestralUrl: z.string().optional(),
})

const deepSeekSchema = apiModelIdProviderModelSchema.extend({
	deepSeekBaseUrl: z.string().optional(),
	deepSeekApiKey: z.string().optional(),
})

const poeSchema = apiModelIdProviderModelSchema.extend({
	poeApiKey: z.string().optional(),
	poeBaseUrl: z.string().optional(),
})

const moonshotSchema = apiModelIdProviderModelSchema.extend({
	moonshotBaseUrl: z
		.union([z.literal("https://api.moonshot.ai/v1"), z.literal("https://api.moonshot.cn/v1")])
		.optional(),
	moonshotApiKey: z.string().optional(),
})

export const kimiCodeAuthMethodSchema = z.enum(["oauth", "api-key"])
export type KimiCodeAuthMethod = z.infer<typeof kimiCodeAuthMethodSchema>

const kimiCodeSchema = apiModelIdProviderModelSchema.extend({
	kimiCodeAuthMethod: kimiCodeAuthMethodSchema.optional(),
	kimiCodeApiKey: z.string().optional(),
})

const minimaxSchema = apiModelIdProviderModelSchema.extend({
	minimaxBaseUrl: z
		.union([z.literal("https://api.minimax.io/v1"), z.literal("https://api.minimaxi.com/v1")])
		.optional(),
	minimaxApiKey: z.string().optional(),
})

const mimoSchema = apiModelIdProviderModelSchema.extend({
	mimoBaseUrl: z
		.union([
			z.literal("https://api.xiaomimimo.com/v1"),
			z.literal("https://token-plan-cn.xiaomimimo.com/v1"),
			z.literal("https://token-plan-sgp.xiaomimimo.com/v1"),
			z.literal("https://token-plan-ams.xiaomimimo.com/v1"),
		])
		.optional(),
	mimoApiKey: z.string().optional(),
})

const requestySchema = baseProviderSettingsSchema.extend({
	requestyBaseUrl: z.string().optional(),
	requestyApiKey: z.string().optional(),
	requestyModelId: z.string().optional(),
})

const unboundSchema = baseProviderSettingsSchema.extend({
	unboundApiKey: z.string().optional(),
	unboundModelId: z.string().optional(),
})

const fakeAiSchema = baseProviderSettingsSchema.extend({
	fakeAi: z.unknown().optional(),
})

const xaiSchema = apiModelIdProviderModelSchema.extend({
	xaiApiKey: z.string().optional(),
})

const litellmSchema = baseProviderSettingsSchema.extend({
	litellmBaseUrl: z.string().optional(),
	litellmApiKey: z.string().optional(),
	litellmModelId: z.string().optional(),
	litellmUsePromptCache: z.boolean().optional(),
})

const sambaNovaSchema = apiModelIdProviderModelSchema.extend({
	sambaNovaApiKey: z.string().optional(),
})

export const zaiApiLineSchema = z.enum(["international_coding", "china_coding", "international_api", "china_api"])

export type ZaiApiLine = z.infer<typeof zaiApiLineSchema>

const zaiSchema = apiModelIdProviderModelSchema.extend({
	zaiApiKey: z.string().optional(),
	zaiApiLine: zaiApiLineSchema.optional(),
})

const fireworksSchema = apiModelIdProviderModelSchema.extend({
	fireworksApiKey: z.string().optional(),
})

const friendliSchema = apiModelIdProviderModelSchema.extend({
	friendliApiKey: z.string().optional(),
})

const qwenCodeSchema = apiModelIdProviderModelSchema.extend({
	qwenCodeOauthPath: z.string().optional(),
})

const vercelAiGatewaySchema = baseProviderSettingsSchema.extend({
	vercelAiGatewayApiKey: z.string().optional(),
	vercelAiGatewayModelId: z.string().optional(),
})

const opencodeGoSchema = baseProviderSettingsSchema.extend({
	opencodeGoApiKey: z.string().optional(),
	opencodeGoModelId: z.string().optional(),
})

const kenariSchema = baseProviderSettingsSchema.extend({
	kenariApiKey: z.string().optional(),
	kenariModelId: z.string().optional(),
})

const zooGatewaySchema = baseProviderSettingsSchema.extend({
	zooSessionToken: z.string().optional(),
	zooGatewayModelId: z.string().optional(),
	zooGatewayBaseUrl: z.string().optional(),
})

const basetenSchema = apiModelIdProviderModelSchema.extend({
	basetenApiKey: z.string().optional(),
})

const defaultSchema = z.object({
	apiProvider: z.undefined(),
})

export const providerSettingsSchemaDiscriminated = z.discriminatedUnion("apiProvider", [
	anthropicSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.anthropic) })),
	openRouterSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.openrouter) })),
	bedrockSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.bedrock) })),
	vertexSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.vertex) })),
	openAiSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.openai) })),
	ollamaSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.ollama) })),
	vsCodeLmSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.vscodeLm) })),
	lmStudioSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.lmstudio) })),
	geminiSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.gemini) })),
	geminiCliSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.geminiCli) })),
	openAiCodexSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.openaiCodex) })),
	openAiNativeSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.openaiNative) })),
	mistralSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.mistral) })),
	deepSeekSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.deepseek) })),
	poeSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.poe) })),
	moonshotSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.moonshot) })),
	kimiCodeSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.kimiCode) })),
	minimaxSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.minimax) })),
	mimoSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.mimo) })),
	requestySchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.requesty) })),
	unboundSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.unbound) })),
	fakeAiSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.fakeAi) })),
	xaiSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.xai) })),
	basetenSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.baseten) })),
	litellmSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.litellm) })),
	sambaNovaSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.sambanova) })),
	zaiSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.zai) })),
	fireworksSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.fireworks) })),
	friendliSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.friendli) })),
	qwenCodeSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.qwenCode) })),
	vercelAiGatewaySchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.vercelAiGateway) })),
	opencodeGoSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.opencodeGo) })),
	kenariSchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.kenari) })),
	zooGatewaySchema.merge(z.object({ apiProvider: z.literal(providerIdentifiers.zooGateway) })),
	defaultSchema,
])

export const providerSettingsSchema = z.object({
	apiProvider: providerNamesWithRetiredSchema.optional(),
	...anthropicSchema.shape,
	...openRouterSchema.shape,
	...bedrockSchema.shape,
	...vertexSchema.shape,
	...openAiSchema.shape,
	...ollamaSchema.shape,
	...vsCodeLmSchema.shape,
	...lmStudioSchema.shape,
	...geminiSchema.shape,
	...geminiCliSchema.shape,
	...openAiCodexSchema.shape,
	...openAiNativeSchema.shape,
	...mistralSchema.shape,
	...deepSeekSchema.shape,
	...poeSchema.shape,
	...moonshotSchema.shape,
	...kimiCodeSchema.shape,
	...minimaxSchema.shape,
	...mimoSchema.shape,
	...requestySchema.shape,
	...unboundSchema.shape,
	...fakeAiSchema.shape,
	...xaiSchema.shape,
	...basetenSchema.shape,
	...litellmSchema.shape,
	...sambaNovaSchema.shape,
	...zaiSchema.shape,
	...fireworksSchema.shape,
	...friendliSchema.shape,
	...qwenCodeSchema.shape,
	...vercelAiGatewaySchema.shape,
	...opencodeGoSchema.shape,
	...kenariSchema.shape,
	...zooGatewaySchema.shape,
	...codebaseIndexProviderSchema.shape,
})

export type ProviderSettings = z.infer<typeof providerSettingsSchema>

export const providerSettingsWithIdSchema = providerSettingsSchema.extend({ id: z.string().optional() })

export const discriminatedProviderSettingsWithIdSchema = providerSettingsSchemaDiscriminated.and(
	z.object({ id: z.string().optional() }),
)

export type ProviderSettingsWithId = z.infer<typeof providerSettingsWithIdSchema>

export const PROVIDER_SETTINGS_KEYS = providerSettingsSchema.keyof().options

/**
 * ModelIdKey
 */

export const modelIdKeys = [
	"apiModelId",
	"openRouterModelId",
	"openAiModelId",
	"ollamaModelId",
	"lmStudioModelId",
	"lmStudioDraftModelId",
	"requestyModelId",
	"unboundModelId",
	"litellmModelId",
	"vercelAiGatewayModelId",
	"opencodeGoModelId",
	"kenariModelId",
	"zooGatewayModelId",
] as const satisfies readonly (keyof ProviderSettings)[]

export type ModelIdKey = (typeof modelIdKeys)[number]

export const getModelId = (settings: ProviderSettings): string | undefined => {
	const modelIdKey = modelIdKeys.find((key) => settings[key])
	return modelIdKey ? settings[modelIdKey] : undefined
}

/**
 * TypicalProvider
 */

export type TypicalProvider = Exclude<ProviderName, InternalProvider | CustomProvider | FauxProvider>

export const isTypicalProvider = (key: unknown): key is TypicalProvider =>
	isProviderName(key) && !isInternalProvider(key) && !isCustomProvider(key) && !isFauxProvider(key)

export const modelIdKeysByProvider: Record<TypicalProvider, ModelIdKey> = {
	[providerIdentifiers.anthropic]: "apiModelId",
	[providerIdentifiers.openrouter]: "openRouterModelId",
	[providerIdentifiers.bedrock]: "apiModelId",
	[providerIdentifiers.vertex]: "apiModelId",
	[providerIdentifiers.openaiCodex]: "apiModelId",
	[providerIdentifiers.openaiNative]: "openAiModelId",
	[providerIdentifiers.ollama]: "ollamaModelId",
	[providerIdentifiers.lmstudio]: "lmStudioModelId",
	[providerIdentifiers.gemini]: "apiModelId",
	[providerIdentifiers.geminiCli]: "apiModelId",
	[providerIdentifiers.mistral]: "apiModelId",
	[providerIdentifiers.moonshot]: "apiModelId",
	[providerIdentifiers.kimiCode]: "apiModelId",
	[providerIdentifiers.minimax]: "apiModelId",
	[providerIdentifiers.mimo]: "apiModelId",
	[providerIdentifiers.deepseek]: "apiModelId",
	[providerIdentifiers.poe]: "apiModelId",
	[providerIdentifiers.qwenCode]: "apiModelId",
	[providerIdentifiers.requesty]: "requestyModelId",
	[providerIdentifiers.unbound]: "unboundModelId",
	[providerIdentifiers.xai]: "apiModelId",
	[providerIdentifiers.baseten]: "apiModelId",
	[providerIdentifiers.litellm]: "litellmModelId",
	[providerIdentifiers.sambanova]: "apiModelId",
	[providerIdentifiers.zai]: "apiModelId",
	[providerIdentifiers.fireworks]: "apiModelId",
	[providerIdentifiers.friendli]: "apiModelId",
	[providerIdentifiers.vercelAiGateway]: "vercelAiGatewayModelId",
	[providerIdentifiers.opencodeGo]: "opencodeGoModelId",
	[providerIdentifiers.kenari]: "kenariModelId",
	[providerIdentifiers.zooGateway]: "zooGatewayModelId",
}

/**
 * ANTHROPIC_STYLE_PROVIDERS
 */

// Providers that use Anthropic-style API protocol.
export const ANTHROPIC_STYLE_PROVIDERS: ProviderName[] = [
	providerIdentifiers.anthropic,
	providerIdentifiers.bedrock,
	providerIdentifiers.minimax,
]

const ANTHROPIC_MODEL_GATEWAY_PROVIDERS: ProviderName[] = [
	providerIdentifiers.vercelAiGateway,
	providerIdentifiers.zooGateway,
]

const ANTHROPIC_MODEL_ID_PREFIX = "anthropic/"
const CLAUDE_MODEL_ID_FRAGMENT = "claude"

export const getApiProtocol = (provider: ProviderName | undefined, modelId?: string): "anthropic" | "openai" => {
	if (provider && ANTHROPIC_STYLE_PROVIDERS.includes(provider)) {
		return ANTHROPIC_API_PROTOCOL
	}

	if (
		provider &&
		provider === providerIdentifiers.vertex &&
		modelId &&
		modelId.toLowerCase().includes(CLAUDE_MODEL_ID_FRAGMENT)
	) {
		return ANTHROPIC_API_PROTOCOL
	}

	// Vercel AI Gateway and Zoo Gateway use the anthropic protocol for anthropic models.
	if (
		provider &&
		ANTHROPIC_MODEL_GATEWAY_PROVIDERS.includes(provider) &&
		modelId &&
		modelId.toLowerCase().startsWith(ANTHROPIC_MODEL_ID_PREFIX)
	) {
		return ANTHROPIC_API_PROTOCOL
	}

	// Opencode Go routes a subset of its models (Qwen, MiniMax) through the
	// Anthropic Messages wire format (`/v1/messages`), which reports usage in
	// Anthropic style: `input_tokens` excludes cache tokens, with separate
	// `cache_creation_input_tokens` / `cache_read_input_tokens` fields. These
	// models must use the anthropic protocol so token/cost aggregation adds the
	// cache tokens back into the input total — otherwise the cached prefix is
	// dropped from `contextTokens`, undercounting context-window usage.
	if (
		provider &&
		provider === providerIdentifiers.opencodeGo &&
		modelId &&
		isOpencodeGoAnthropicFormatModel(modelId)
	) {
		return ANTHROPIC_API_PROTOCOL
	}

	return OPENAI_API_PROTOCOL
}

/**
 * MODELS_BY_PROVIDER
 */

export const MODELS_BY_PROVIDER: Record<
	Exclude<
		ProviderName,
		typeof providerIdentifiers.fakeAi | typeof providerIdentifiers.geminiCli | typeof providerIdentifiers.openai
	>,
	{ id: ProviderName; label: string; models: string[] }
> = {
	[providerIdentifiers.anthropic]: {
		id: providerIdentifiers.anthropic,
		label: "Anthropic",
		models: Object.keys(anthropicModels),
	},
	[providerIdentifiers.bedrock]: {
		id: providerIdentifiers.bedrock,
		label: "Amazon Bedrock",
		models: Object.keys(bedrockModels),
	},
	[providerIdentifiers.deepseek]: {
		id: providerIdentifiers.deepseek,
		label: "DeepSeek",
		models: Object.keys(deepSeekModels),
	},
	[providerIdentifiers.fireworks]: {
		id: providerIdentifiers.fireworks,
		label: "Fireworks",
		models: Object.keys(fireworksModels),
	},
	[providerIdentifiers.friendli]: {
		id: providerIdentifiers.friendli,
		label: "Friendli",
		models: Object.keys(friendliModels),
	},
	[providerIdentifiers.gemini]: {
		id: providerIdentifiers.gemini,
		label: "Google Gemini",
		models: Object.keys(geminiModels),
	},
	[providerIdentifiers.mistral]: {
		id: providerIdentifiers.mistral,
		label: "Mistral",
		models: Object.keys(mistralModels),
	},
	[providerIdentifiers.moonshot]: {
		id: providerIdentifiers.moonshot,
		label: "Moonshot",
		models: Object.keys(moonshotModels),
	},
	[providerIdentifiers.kimiCode]: {
		id: providerIdentifiers.kimiCode,
		label: "Kimi Code",
		models: [],
	},
	[providerIdentifiers.minimax]: {
		id: providerIdentifiers.minimax,
		label: "MiniMax",
		models: Object.keys(minimaxModels),
	},
	[providerIdentifiers.mimo]: {
		id: providerIdentifiers.mimo,
		label: "Xiaomi MiMo",
		models: Object.keys(mimoModels),
	},
	[providerIdentifiers.openaiCodex]: {
		id: providerIdentifiers.openaiCodex,
		label: "OpenAI - ChatGPT Plus/Pro",
		models: Object.keys(openAiCodexModels),
	},
	[providerIdentifiers.openaiNative]: {
		id: providerIdentifiers.openaiNative,
		label: "OpenAI",
		models: Object.keys(openAiNativeModels),
	},
	[providerIdentifiers.qwenCode]: {
		id: providerIdentifiers.qwenCode,
		label: "Qwen Code",
		models: Object.keys(qwenCodeModels),
	},
	[providerIdentifiers.sambanova]: {
		id: providerIdentifiers.sambanova,
		label: "SambaNova",
		models: Object.keys(sambaNovaModels),
	},
	[providerIdentifiers.vertex]: {
		id: providerIdentifiers.vertex,
		label: "GCP Vertex AI",
		models: Object.keys(vertexModels),
	},
	[providerIdentifiers.vscodeLm]: {
		id: providerIdentifiers.vscodeLm,
		label: "VS Code LM API",
		models: Object.keys(vscodeLlmModels),
	},
	[providerIdentifiers.xai]: { id: providerIdentifiers.xai, label: "xAI (Grok)", models: Object.keys(xaiModels) },
	[providerIdentifiers.zai]: {
		id: providerIdentifiers.zai,
		label: "Z.ai",
		models: Object.keys(internationalZAiModels),
	},
	[providerIdentifiers.baseten]: {
		id: providerIdentifiers.baseten,
		label: "Baseten",
		models: Object.keys(basetenModels),
	},

	// Dynamic providers; models pulled from remote APIs.
	[providerIdentifiers.poe]: { id: providerIdentifiers.poe, label: "Poe", models: [] },
	[providerIdentifiers.litellm]: { id: providerIdentifiers.litellm, label: "LiteLLM", models: [] },
	[providerIdentifiers.openrouter]: { id: providerIdentifiers.openrouter, label: "OpenRouter", models: [] },
	[providerIdentifiers.requesty]: { id: providerIdentifiers.requesty, label: "Requesty", models: [] },
	[providerIdentifiers.unbound]: { id: providerIdentifiers.unbound, label: "Unbound", models: [] },
	[providerIdentifiers.vercelAiGateway]: {
		id: providerIdentifiers.vercelAiGateway,
		label: "Vercel AI Gateway",
		models: [],
	},
	[providerIdentifiers.opencodeGo]: { id: providerIdentifiers.opencodeGo, label: "Opencode Go", models: [] },
	[providerIdentifiers.kenari]: { id: providerIdentifiers.kenari, label: "Kenari", models: [] },
	[providerIdentifiers.zooGateway]: { id: providerIdentifiers.zooGateway, label: "Zoo Gateway", models: [] },

	// Local providers; models discovered from localhost endpoints.
	[providerIdentifiers.lmstudio]: { id: providerIdentifiers.lmstudio, label: "LM Studio", models: [] },
	[providerIdentifiers.ollama]: { id: providerIdentifiers.ollama, label: "Ollama", models: [] },
}
