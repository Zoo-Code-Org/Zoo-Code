import { z } from "zod"

import { providerDefinitionList, type ProviderDefinition } from "./provider-settings/index.js"
import { API_PROVIDER_FIELD, SETTINGS_SHAPE_FIELD } from "./provider-settings/common.js"
export {
	OPEN_AI_CODEX_SERVICE_TIER_KEY,
	parseOpenAiExtraBody,
	kimiCodeAuthMethodSchema,
	type KimiCodeAuthMethod,
	nanoGptDefaultRoutingPreference,
	nanoGptRoutingPreferences,
	nanoGptRoutingPreferenceSchema,
	type NanoGptRoutingPreference,
	zaiApiLineSchema,
	type ZaiApiLine,
} from "./provider-settings/index.js"

import { codebaseIndexProviderSchema } from "./codebase-index.js"
import type { UnionToIntersection } from "./type-fu.js"
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
	providerIdentifiers.nanogpt,
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
	[API_PROVIDER_FIELD]: providerNamesWithRetiredSchema.optional(),
	modelId: z.string().optional(),
})

export type ProviderSettingsEntry = z.infer<typeof providerSettingsEntrySchema>

/**
 * ProviderSettings
 */

type ListedProvider = (typeof providerDefinitionList)[number][typeof API_PROVIDER_FIELD]
const allProvidersAreDefined: Exclude<ProviderName, ListedProvider> extends never ? true : never = true
void allProvidersAreDefined

const indexProviderDefinitions = (
	definitions: readonly ProviderDefinition[],
): Partial<Record<ProviderName, ProviderDefinition>> => {
	const indexedDefinitions: Partial<Record<ProviderName, ProviderDefinition>> = {}

	// Keep registry construction non-throwing so a malformed definition cannot prevent the extension from starting in production.
	for (const definition of definitions) {
		if (indexedDefinitions[definition.apiProvider]) {
			console.warn(`Duplicate provider definition ignored: ${definition.apiProvider}`)
		}

		indexedDefinitions[definition.apiProvider] ??= definition
	}

	for (const provider of providerNames) {
		if (!indexedDefinitions[provider]) {
			console.warn(`Missing provider definition: ${provider}`)
		}
	}

	return indexedDefinitions
}

const providerDefinitions = indexProviderDefinitions(providerDefinitionList)

const defaultSchema = z.object({
	[API_PROVIDER_FIELD]: z.undefined(),
})

type ProviderDefinitionSchemas<D extends readonly ProviderDefinition[]> = {
	[K in keyof D]: D[K]["schema"]
}

const getDiscriminatedSchemas = <const D extends readonly [ProviderDefinition, ...ProviderDefinition[]]>(
	definitions: D,
): ProviderDefinitionSchemas<D> => {
	const [firstDefinition, ...remainingDefinitions] = definitions
	// Array mapping widens the tuple, so restore the per-definition schema tuple type expected by Zod.
	return [
		firstDefinition.schema,
		...remainingDefinitions.map((definition) => definition.schema),
	] as ProviderDefinitionSchemas<D>
}

const providerDiscriminatedSchemas = getDiscriminatedSchemas(providerDefinitionList)

export const providerSettingsSchemaDiscriminated = z.discriminatedUnion(API_PROVIDER_FIELD, [
	...providerDiscriminatedSchemas,
	defaultSchema,
])

type ProviderSettingsShape = UnionToIntersection<(typeof providerDefinitionList)[number][typeof SETTINGS_SHAPE_FIELD]>

const providerSettingsObjectSchema = providerDefinitionList.reduce<z.AnyZodObject>(
	(schema, definition) => schema.merge(z.object(definition[SETTINGS_SHAPE_FIELD])),
	z.object({}),
)

// `AnyZodObject.shape` loses the merged shape precision, so restore the type derived from the provider definitions.
const providerSettingsShape = providerSettingsObjectSchema.shape as ProviderSettingsShape

export const providerSettingsSchema = z.object({
	[API_PROVIDER_FIELD]: providerNamesWithRetiredSchema.optional(),
	...providerSettingsShape,
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
 * @deprecated Use `getModelId()` to resolve the model ID for the active provider.
 */
export type ModelIdKey = Extract<keyof ProviderSettingsShape, `${string}ModelId`>

/**
 * @deprecated Use `getModelId()` to resolve the model ID for the active provider.
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
	"nanoGptModelId",
	"zooGatewayModelId",
] as const satisfies readonly ModelIdKey[]

/**
 * @deprecated Provider categories should use the specific provider type guards.
 */
export type TypicalProvider = Exclude<ProviderName, InternalProvider | CustomProvider | FauxProvider>

/**
 * @deprecated Use the specific provider type guards instead.
 */
export const isTypicalProvider = (key: unknown): key is TypicalProvider =>
	isProviderName(key) && !isInternalProvider(key) && !isCustomProvider(key) && !isFauxProvider(key)

/**
 * @deprecated Use `getModelId()` instead. This map is retained for API compatibility.
 */
export const modelIdKeysByProvider = Object.fromEntries(
	providerDefinitionList.flatMap((definition) => {
		if (!isTypicalProvider(definition.apiProvider)) {
			return []
		}

		if (!definition.modelIdKey) {
			throw new Error(`Missing model ID key for provider definition: ${definition.apiProvider}`)
		}

		return [[definition.apiProvider, definition.modelIdKey] as const]
	}),
) as Record<TypicalProvider, ModelIdKey>

export function getModelId(settings: ProviderSettings): string | undefined {
	if (isProviderName(settings.apiProvider)) {
		return providerDefinitions[settings.apiProvider]?.getModelId(settings)
	}

	if (typeof settings.apiProvider === "string" && isRetiredProvider(settings.apiProvider)) {
		const modelIdKey = modelIdKeys.find((key) => settings[key])
		return modelIdKey ? settings[modelIdKey] : undefined
	}

	return undefined
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
		// OpenAI is custom-configured; Fake AI and Gemini CLI do not expose model lists.
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
	[providerIdentifiers.nanogpt]: { id: providerIdentifiers.nanogpt, label: "NanoGPT", models: [] },
	[providerIdentifiers.zooGateway]: { id: providerIdentifiers.zooGateway, label: "Zoo Gateway", models: [] },

	// Local providers; models discovered from localhost endpoints.
	[providerIdentifiers.lmstudio]: { id: providerIdentifiers.lmstudio, label: "LM Studio", models: [] },
	[providerIdentifiers.ollama]: { id: providerIdentifiers.ollama, label: "Ollama", models: [] },
}
