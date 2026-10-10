import { z } from "zod"
import { DynamicProvider, LocalProvider } from "./provider-settings.js"

/**
 * ReasoningEffort
 */

export const reasoningEfforts = ["low", "medium", "high"] as const

export const reasoningEffortsSchema = z.enum(reasoningEfforts)

export type ReasoningEffort = z.infer<typeof reasoningEffortsSchema>

/**
 * ReasoningEffortWithMinimal
 */

export const reasoningEffortWithMinimalSchema = z.union([reasoningEffortsSchema, z.literal("minimal")])

export type ReasoningEffortWithMinimal = z.infer<typeof reasoningEffortWithMinimalSchema>

/**
 * Extended Reasoning Effort (includes "none" and "minimal")
 * Note: "disable" is a UI/control value, not a value sent as effort
 */
export const reasoningEffortsExtended = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export const reasoningEffortExtendedSchema = z.enum(reasoningEffortsExtended)

export type ReasoningEffortExtended = z.infer<typeof reasoningEffortExtendedSchema>

/**
 * Reasoning Effort user setting (includes "disable")
 */
export const reasoningEffortSettingValues = [
	"disable",
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const
export const reasoningEffortSettingSchema = z.enum(reasoningEffortSettingValues)

/**
 * Verbosity
 */

export const verbosityLevels = ["low", "medium", "high"] as const

export const verbosityLevelsSchema = z.enum(verbosityLevels)

export type VerbosityLevel = z.infer<typeof verbosityLevelsSchema>

/** Serialized service tier field used in provider request payloads and responses. */
export const SERVICE_TIER_KEY = "service_tier"

/**
 * Service tiers for the public OpenAI Responses API.
 */
export const OpenAiServiceTier = {
	Default: "default",
	Flex: "flex",
	Priority: "priority",
} as const

export const serviceTiers = [OpenAiServiceTier.Default, OpenAiServiceTier.Flex, OpenAiServiceTier.Priority] as const
export const serviceTierSchema = z.enum(serviceTiers)
export type ServiceTier = z.infer<typeof serviceTierSchema>

/**
 * Service tiers for Codex requests authenticated through a ChatGPT subscription.
 */
export const OpenAiCodexServiceTier = {
	Default: "default",
	Priority: "priority",
} as const

export const openAiCodexServiceTiers = [OpenAiCodexServiceTier.Default, OpenAiCodexServiceTier.Priority] as const
export const openAiCodexServiceTierSchema = z.enum(openAiCodexServiceTiers)
export type OpenAiCodexServiceTier = z.infer<typeof openAiCodexServiceTierSchema>

/**
 * ModelParameter
 */

export const modelParameters = ["max_tokens", "temperature", "reasoning", "include_reasoning"] as const

export const modelParametersSchema = z.enum(modelParameters)

export type ModelParameter = z.infer<typeof modelParametersSchema>

export const isModelParameter = (value: string): value is ModelParameter =>
	modelParameters.includes(value as ModelParameter)

/**
 * ModelInfo
 */

export const modelInfoSchema = z.object({
	maxTokens: z.number().nullish(),
	maxThinkingTokens: z.number().nullish(),
	contextWindow: z.number(),
	supportsImages: z.boolean().optional(),
	supportsPromptCache: z.boolean(),
	// Optional default prompt cache retention policy for providers that support it.
	// When set to "24h", extended prompt caching will be requested; when omitted
	// or set to "in_memory", the default in‑memory cache is used.
	promptCacheRetention: z.enum(["in_memory", "24h"]).optional(),
	// Capability flag to indicate whether the model supports an output verbosity parameter
	supportsVerbosity: z.boolean().optional(),
	// Capability flag to indicate whether the model exposes a user-configurable max output
	// tokens control in settings. When set, the settings UI surfaces a slider that persists
	// `modelMaxTokens`; when the user leaves it unset, the default output clamp is used.
	supportsMaxTokens: z.boolean().optional(),
	supportsReasoningBudget: z.boolean().optional(),
	// Capability flag to indicate whether the model supports simple on/off binary reasoning
	supportsReasoningBinary: z.boolean().optional(),
	// Capability flag to indicate whether the model supports temperature parameter
	supportsTemperature: z.boolean().optional(),
	defaultTemperature: z.number().optional(),
	requiredReasoningBudget: z.boolean().optional(),
	supportsReasoningEffort: z
		.union([z.boolean(), z.array(z.enum(["disable", "none", "minimal", "low", "medium", "high", "xhigh", "max"]))])
		.optional(),
	requiredReasoningEffort: z.boolean().optional(),
	preserveReasoning: z.boolean().optional(),
	// Some OpenAI-compatible gateways require a Responses-backed route for tool calls.
	requiresResponsesApi: z.boolean().optional(),
	supportedParameters: z.array(modelParametersSchema).optional(),
	inputPrice: z.number().optional(),
	outputPrice: z.number().optional(),
	cacheWritesPrice: z.number().optional(),
	cacheReadsPrice: z.number().optional(),
	longContextPricing: z
		.object({
			thresholdTokens: z.number(),
			inputPriceMultiplier: z.number().optional(),
			outputPriceMultiplier: z.number().optional(),
			cacheWritesPriceMultiplier: z.number().optional(),
			cacheReadsPriceMultiplier: z.number().optional(),
			appliesToServiceTiers: z.array(serviceTierSchema).optional(),
		})
		.optional(),
	description: z.string().optional(),
	displayName: z.string().optional(),
	// Default effort value for models that support reasoning effort
	reasoningEffort: reasoningEffortExtendedSchema.optional(),
	minTokensPerCachePoint: z.number().optional(),
	maxCachePoints: z.number().optional(),
	cachableFields: z.array(z.string()).optional(),
	// Flag to indicate if the model is deprecated and should not be used
	deprecated: z.boolean().optional(),
	// Flag to indicate if the model should hide vendor/company identity in responses
	isStealthModel: z.boolean().optional(),
	// Flag to indicate if the model is free (no cost)
	isFree: z.boolean().optional(),
	// Exclude specific native tools from being available (only applies to native protocol)
	// These tools will be removed from the set of tools available to the model
	excludedTools: z.array(z.string()).optional(),
	// Include specific native tools (only applies to native protocol)
	// These tools will be added if they belong to an allowed group in the current mode
	// Cannot force-add tools from groups the mode doesn't allow
	includedTools: z.array(z.string()).optional(),
	/**
	 * Service tiers with pricing information.
	 * Each tier can have a name (for OpenAI service tiers) and pricing overrides.
	 * The top-level input/output/cache* fields represent the default/standard tier.
	 */
	tiers: z
		.array(
			z.object({
				name: serviceTierSchema.optional(), // Service tier name (flex, priority, etc.)
				contextWindow: z.number(),
				inputPrice: z.number().optional(),
				outputPrice: z.number().optional(),
				cacheWritesPrice: z.number().optional(),
				cacheReadsPrice: z.number().optional(),
			}),
		)
		.optional(),
})

export type ModelInfo = z.infer<typeof modelInfoSchema>

/**
 * User-supplied model metadata for a model whose discovered metadata is
 * incomplete or unavailable.
 *
 * This mirrors the long-standing `openAiCustomModelInfo` contract: the stored
 * value is a complete snapshot that the settings UI prefills from the
 * discovered catalog entry. Resolution therefore stays a single expression at
 * every call site and a configured override can never resolve to `undefined`.
 *
 * Pricing is deliberately excluded. Router catalogs own prices and refresh
 * them, so a user-held price snapshot would go stale and silently corrupt cost
 * reporting.
 */
export const customModelInfoSchema = modelInfoSchema
	.omit({
		inputPrice: true,
		outputPrice: true,
		cacheWritesPrice: true,
		cacheReadsPrice: true,
		longContextPricing: true,
		tiers: true,
	})
	.extend({
		// `modelInfoSchema` accepts any number because a provider catalog is not
		// ours to validate. User input is, and these two values drive token
		// accounting and the outgoing max_completion_tokens, so reject the values
		// that would produce NaN percentages or a request the gateway rejects.
		contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
	})
	// `strict()` is what actually rejects a pricing field: omitting a key only
	// drops it from the shape, it does not make the value invalid.
	.strict()

export type CustomModelInfo = z.infer<typeof customModelInfoSchema>

export type CustomModelInfoSettings = {
	customModelInfo?: CustomModelInfo | null
}

/**
 * Strips provider-owned pricing so the settings UI can prefill the editor from
 * a discovered catalog entry.
 */
export const toCustomModelInfo = (info: ModelInfo): CustomModelInfo => {
	const {
		inputPrice: _inputPrice,
		outputPrice: _outputPrice,
		cacheWritesPrice: _cacheWritesPrice,
		cacheReadsPrice: _cacheReadsPrice,
		longContextPricing: _longContextPricing,
		tiers: _tiers,
		...rest
	} = info

	return rest
}

/**
 * Resolves the effective model metadata for providers that expose the custom
 * model info editor.
 *
 * A configured override replaces the discovered metadata wholesale; pricing is
 * always read back from the catalog entry. Without an override the discovered
 * metadata passes through untouched.
 */
export const applyCustomModelInfo = (
	info: ModelInfo | undefined,
	settings: CustomModelInfoSettings | undefined,
): ModelInfo | undefined => {
	const override = settings?.customModelInfo

	if (!override) {
		return info
	}

	// Copy only the price keys the catalog actually carries, so the result never
	// gains explicit `undefined` pricing fields.
	return {
		...override,
		...(info?.inputPrice !== undefined && { inputPrice: info.inputPrice }),
		...(info?.outputPrice !== undefined && { outputPrice: info.outputPrice }),
		...(info?.cacheWritesPrice !== undefined && { cacheWritesPrice: info.cacheWritesPrice }),
		...(info?.cacheReadsPrice !== undefined && { cacheReadsPrice: info.cacheReadsPrice }),
		...(info?.longContextPricing !== undefined && { longContextPricing: info.longContextPricing }),
		...(info?.tiers !== undefined && { tiers: info.tiers }),
	}
}

export type ModelRecord = Record<string, ModelInfo>

export type RouterModels = Record<DynamicProvider | LocalProvider, ModelRecord>

export const routerModelsMessageTypes = [
	"flushRouterModels",
	"requestRouterModels",
	"routerModels",
	"singleRouterModelFetchResponse",
] as const

export const routerModelsMessageTypeSchema = z.enum(routerModelsMessageTypes)

export const RouterModelsMessageType = routerModelsMessageTypeSchema.enum

export type RouterModelsMessageType = z.infer<typeof routerModelsMessageTypeSchema>

export const allRouterModelsProvider = "all" as const
