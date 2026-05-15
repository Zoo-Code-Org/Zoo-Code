import type { ModelInfo } from "../model.js"

// https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html

export type BedrockModelId = keyof typeof bedrockModels

export const bedrockDefaultModelId: BedrockModelId = "anthropic.claude-sonnet-4-5-20250929-v1:0"

export const bedrockDefaultPromptRouterModelId: BedrockModelId = "anthropic.claude-3-sonnet-20240229-v1:0"

// March, 12 2025 - updated prices to match US-West-2 list price shown at
// https://aws.amazon.com/bedrock/pricing, including older models that are part
// of the default prompt routers AWS enabled for GA of the promot router
// feature.
export const bedrockModels = {
	"anthropic.claude-sonnet-4-5-20250929-v1:0": {
		// Mirrors anthropic-direct cap; AWS Bedrock accepts the same upstream maximum.
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningBudget: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		minTokensPerCachePoint: 1024,
		maxCachePoints: 4,
		cachableFields: ["system", "messages", "tools"],
		promptCacheTtl: "1h",
	},
	"anthropic.claude-sonnet-4-6": {
		// Mirrors anthropic-direct cap; AWS Bedrock accepts the same upstream maximum.
		maxTokens: 64_000,
		contextWindow: 200_000, // Default 200K, extendable to 1M with beta flag 'context-1m-2025-08-07'
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningBudget: true,
		inputPrice: 3.0, // $3 per million input tokens (≤200K context)
		outputPrice: 15.0, // $15 per million output tokens (≤200K context)
		cacheWritesPrice: 3.75, // $3.75 per million tokens
		cacheReadsPrice: 0.3, // $0.30 per million tokens
		minTokensPerCachePoint: 1024,
		maxCachePoints: 4,
		cachableFields: ["system", "messages", "tools"],
		// Tiered pricing for extended context (requires beta flag 'context-1m-2025-08-07')
		tiers: [
			{
				contextWindow: 1_000_000, // 1M tokens with beta flag
				inputPrice: 6.0, // $6 per million input tokens (>200K context)
				outputPrice: 22.5, // $22.50 per million output tokens (>200K context)
				cacheWritesPrice: 7.5, // $7.50 per million tokens (>200K context)
				cacheReadsPrice: 0.6, // $0.60 per million tokens (>200K context)
			},
		],
	},
	"amazon.nova-pro-v1:0": {
		maxTokens: 5000,
		contextWindow: 300_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0.8,
		outputPrice: 3.2,
		cacheWritesPrice: 0.8, // per million tokens
		cacheReadsPrice: 0.2, // per million tokens
		minTokensPerCachePoint: 1,
		maxCachePoints: 1,
		cachableFields: ["system"],
	},
	"amazon.nova-pro-latency-optimized-v1:0": {
		maxTokens: 5000,
		contextWindow: 300_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 1.0,
		outputPrice: 4.0,
		cacheWritesPrice: 1.0, // per million tokens
		cacheReadsPrice: 0.25, // per million tokens
		description: "Amazon Nova Pro with latency optimized inference",
	},
	"amazon.nova-lite-v1:0": {
		maxTokens: 5000,
		contextWindow: 300_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0.06,
		outputPrice: 0.24,
		cacheWritesPrice: 0.06, // per million tokens
		cacheReadsPrice: 0.015, // per million tokens
		minTokensPerCachePoint: 1,
		maxCachePoints: 1,
		cachableFields: ["system"],
	},
	"amazon.nova-2-lite-v1:0": {
		maxTokens: 65_535,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0.33,
		outputPrice: 2.75,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0.0825, // 75% less than input price
		minTokensPerCachePoint: 1,
		maxCachePoints: 1,
		cachableFields: ["system"],
		description: "Amazon Nova 2 Lite - Comparable to Claude Haiku 4.5",
	},
	"amazon.nova-micro-v1:0": {
		maxTokens: 5000,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.035,
		outputPrice: 0.14,
		cacheWritesPrice: 0.035, // per million tokens
		cacheReadsPrice: 0.00875, // per million tokens
		minTokensPerCachePoint: 1,
		maxCachePoints: 1,
		cachableFields: ["system"],
	},
	"anthropic.claude-sonnet-4-20250514-v1:0": {
		// Mirrors anthropic-direct cap; AWS Bedrock accepts the same upstream maximum.
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningBudget: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		minTokensPerCachePoint: 1024,
		maxCachePoints: 4,
		cachableFields: ["system", "messages", "tools"],
	},
	"anthropic.claude-opus-4-1-20250805-v1:0": {
		// Mirrors anthropic-direct cap; AWS Bedrock accepts the same upstream maximum.
		maxTokens: 32_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningBudget: true,
		inputPrice: 15.0,
		outputPrice: 75.0,
		cacheWritesPrice: 18.75,
		cacheReadsPrice: 1.5,
		minTokensPerCachePoint: 1024,
		maxCachePoints: 4,
		cachableFields: ["system", "messages", "tools"],
	},
	"anthropic.claude-opus-4-6-v1": {
		// Mirrors anthropic-direct cap; AWS Bedrock accepts the same upstream maximum.
		maxTokens: 128_000,
		contextWindow: 200_000, // Default 200K, extendable to 1M with beta flag 'context-1m-2025-08-07'
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningBudget: true,
		inputPrice: 5.0, // $5 per million input tokens (≤200K context)
		outputPrice: 25.0, // $25 per million output tokens (≤200K context)
		cacheWritesPrice: 6.25, // $6.25 per million tokens
		cacheReadsPrice: 0.5, // $0.50 per million tokens
		minTokensPerCachePoint: 1024,
		maxCachePoints: 4,
		cachableFields: ["system", "messages", "tools"],
		// Tiered pricing for extended context (requires beta flag 'context-1m-2025-08-07')
		tiers: [
			{
				contextWindow: 1_000_000, // 1M tokens with beta flag
				inputPrice: 10.0, // $10 per million input tokens (>200K context)
				outputPrice: 37.5, // $37.50 per million output tokens (>200K context)
				cacheWritesPrice: 12.5, // $12.50 per million tokens (>200K context)
				cacheReadsPrice: 1.0, // $1.00 per million tokens (>200K context)
			},
		],
	},
	"anthropic.claude-opus-4-7": {
		// Opus 4.7 ships with a 128K-token max output on Bedrock
		// (https://builder.aws.com/content/3Cl90CMMnqzCrkk6mXcmnGo1WTG/claude-opus-47-on-amazon-bedrock-apis-features-and-migration-guide).
		// We default to that ceiling here so the reasoning-budget slider isn't artificially
		// clamped to the legacy 8K floor used by older Anthropic-on-Bedrock entries.
		maxTokens: 128_000,
		// Opus 4.7 natively supports 1M context (no beta flag required) with FLAT $5/$25
		// pricing at any context length. We still keep a tier entry so the dropdown can
		// show a "128K" vs "1M" choice - the tier just toggles the context window the UI
		// budgets for; pricing is identical. The runtime must NOT send any anthropic_beta
		// flag for this model (see BEDROCK_NATIVE_1M_CONTEXT_MODEL_IDS below).
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningBudget: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
		minTokensPerCachePoint: 1024,
		maxCachePoints: 4,
		cachableFields: ["system", "messages", "tools"],
		description: "Claude Opus 4.7 - most capable Opus model for agentic coding (native 1M context)",
		tiers: [
			{
				contextWindow: 1_000_000,
				// Opus 4.7 pricing is flat, so the tier mirrors the base rates.
				inputPrice: 5.0,
				outputPrice: 25.0,
				cacheWritesPrice: 6.25,
				cacheReadsPrice: 0.5,
			},
		],
	},
	"anthropic.claude-opus-4-5-20251101-v1:0": {
		// Mirrors anthropic-direct cap; AWS Bedrock accepts the same upstream maximum.
		maxTokens: 32_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningBudget: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
		minTokensPerCachePoint: 1024,
		maxCachePoints: 4,
		cachableFields: ["system", "messages", "tools"],
		promptCacheTtl: "1h",
	},
	"anthropic.claude-opus-4-20250514-v1:0": {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningBudget: true,
		inputPrice: 15.0,
		outputPrice: 75.0,
		cacheWritesPrice: 18.75,
		cacheReadsPrice: 1.5,
		minTokensPerCachePoint: 1024,
		maxCachePoints: 4,
		cachableFields: ["system", "messages", "tools"],
	},
	"anthropic.claude-3-7-sonnet-20250219-v1:0": {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningBudget: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		minTokensPerCachePoint: 1024,
		maxCachePoints: 4,
		cachableFields: ["system", "messages", "tools"],
	},
	"anthropic.claude-3-5-sonnet-20241022-v2:0": {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		minTokensPerCachePoint: 1024,
		maxCachePoints: 4,
		cachableFields: ["system", "messages", "tools"],
	},
	"anthropic.claude-3-5-haiku-20241022-v1:0": {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.8,
		outputPrice: 4.0,
		cacheWritesPrice: 1.0,
		cacheReadsPrice: 0.08,
		minTokensPerCachePoint: 2048,
		maxCachePoints: 4,
		cachableFields: ["system", "messages", "tools"],
	},
	"anthropic.claude-haiku-4-5-20251001-v1:0": {
		// Mirrors anthropic-direct cap; AWS Bedrock accepts the same upstream maximum.
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningBudget: true,
		inputPrice: 1.0,
		outputPrice: 5.0,
		cacheWritesPrice: 1.25, // 5m cache writes
		cacheReadsPrice: 0.1, // cache hits / refreshes
		minTokensPerCachePoint: 2048,
		maxCachePoints: 4,
		cachableFields: ["system", "messages", "tools"],
		promptCacheTtl: "1h",
	},
	"anthropic.claude-3-5-sonnet-20240620-v1:0": {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 3.0,
		outputPrice: 15.0,
	},
	"anthropic.claude-3-opus-20240229-v1:0": {
		maxTokens: 4096,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 15.0,
		outputPrice: 75.0,
	},
	"anthropic.claude-3-sonnet-20240229-v1:0": {
		maxTokens: 4096,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 3.0,
		outputPrice: 15.0,
	},
	"anthropic.claude-3-haiku-20240307-v1:0": {
		maxTokens: 4096,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.25,
		outputPrice: 1.25,
	},
	"deepseek.r1-v1:0": {
		maxTokens: 32_768,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 1.35,
		outputPrice: 5.4,
	},
	"openai.gpt-oss-20b-1:0": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.5,
		outputPrice: 1.5,
		description: "GPT-OSS 20B - Optimized for low latency and local/specialized use cases",
	},
	"openai.gpt-oss-120b-1:0": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 2.0,
		outputPrice: 6.0,
		description: "GPT-OSS 120B - Production-ready, general-purpose, high-reasoning model",
	},
	"meta.llama3-3-70b-instruct-v1:0": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.72,
		outputPrice: 0.72,
		description: "Llama 3.3 Instruct (70B)",
	},
	"meta.llama3-2-90b-instruct-v1:0": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.72,
		outputPrice: 0.72,
		description: "Llama 3.2 Instruct (90B)",
	},
	"meta.llama3-2-11b-instruct-v1:0": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.16,
		outputPrice: 0.16,
		description: "Llama 3.2 Instruct (11B)",
	},
	"meta.llama3-2-3b-instruct-v1:0": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.15,
		description: "Llama 3.2 Instruct (3B)",
	},
	"meta.llama3-2-1b-instruct-v1:0": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.1,
		description: "Llama 3.2 Instruct (1B)",
	},
	"meta.llama3-1-405b-instruct-v1:0": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 2.4,
		outputPrice: 2.4,
		description: "Llama 3.1 Instruct (405B)",
	},
	"meta.llama3-1-70b-instruct-v1:0": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.72,
		outputPrice: 0.72,
		description: "Llama 3.1 Instruct (70B)",
	},
	"meta.llama3-1-70b-instruct-latency-optimized-v1:0": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.9,
		outputPrice: 0.9,
		description: "Llama 3.1 Instruct (70B) (w/ latency optimized inference)",
	},
	"meta.llama3-1-8b-instruct-v1:0": {
		maxTokens: 8192,
		contextWindow: 8_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.22,
		outputPrice: 0.22,
		description: "Llama 3.1 Instruct (8B)",
	},
	"meta.llama3-70b-instruct-v1:0": {
		maxTokens: 2048,
		contextWindow: 8_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 2.65,
		outputPrice: 3.5,
	},
	"meta.llama3-8b-instruct-v1:0": {
		maxTokens: 2048,
		contextWindow: 4_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 0.6,
	},
	"amazon.titan-text-lite-v1:0": {
		maxTokens: 4096,
		contextWindow: 8_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.2,
		description: "Amazon Titan Text Lite",
	},
	"amazon.titan-text-express-v1:0": {
		maxTokens: 4096,
		contextWindow: 8_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.2,
		outputPrice: 0.6,
		description: "Amazon Titan Text Express",
	},
	"moonshot.kimi-k2-thinking": {
		maxTokens: 32_000,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.6,
		outputPrice: 2.5,
		description: "Kimi K2 Thinking (1T parameter MoE model with 32B active parameters)",
	},
	"minimax.minimax-m2": {
		maxTokens: 16_384,
		contextWindow: 196_608,
		supportsImages: false,
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		description: "MiniMax M2 (230B parameter MoE model with 10B active parameters)",
	},
	"qwen.qwen3-next-80b-a3b": {
		maxTokens: 8192,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 1.2,
		description: "Qwen3 Next 80B (MoE model with 3B active parameters)",
	},
	"qwen.qwen3-coder-480b-a35b-v1:0": {
		maxTokens: 8192,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.45,
		outputPrice: 1.8,
		description: "Qwen3 Coder 480B (MoE model with 35B active parameters)",
	},
} as const satisfies Record<string, ModelInfo>

export const BEDROCK_DEFAULT_TEMPERATURE = 0.3

export const BEDROCK_MAX_TOKENS = 4096

export const BEDROCK_DEFAULT_CONTEXT = 128_000

// Amazon Bedrock Inference Profile mapping based on official documentation
// https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html
// This mapping is pre-ordered by pattern length (descending) to ensure more specific patterns match first
export const AWS_INFERENCE_PROFILE_MAPPING: Array<[string, string]> = [
	// Australia regions (Sydney and Melbourne) → au. inference profile (most specific - 14 chars)
	["ap-southeast-2", "au."],
	["ap-southeast-4", "au."],
	// Japan regions (Tokyo and Osaka) → jp. inference profile (13 chars)
	["ap-northeast-", "jp."],
	// US Government Cloud → ug. inference profile (7 chars)
	["us-gov-", "ug."],
	// Americas regions → us. inference profile (3 chars)
	["us-", "us."],
	// Europe regions → eu. inference profile (3 chars)
	["eu-", "eu."],
	// Asia Pacific regions → apac. inference profile (3 chars)
	["ap-", "apac."],
	// Canada regions → ca. inference profile (3 chars)
	["ca-", "ca."],
	// South America regions → sa. inference profile (3 chars)
	["sa-", "sa."],
]

// Amazon Bedrock supported regions for the regions dropdown
// Based on official AWS documentation
export const BEDROCK_REGIONS = [
	{ value: "us-east-1", label: "us-east-1" },
	{ value: "us-east-2", label: "us-east-2" },
	{ value: "us-west-1", label: "us-west-1" },
	{ value: "us-west-2", label: "us-west-2" },
	{ value: "ap-northeast-1", label: "ap-northeast-1" },
	{ value: "ap-northeast-2", label: "ap-northeast-2" },
	{ value: "ap-northeast-3", label: "ap-northeast-3" },
	{ value: "ap-south-1", label: "ap-south-1" },
	{ value: "ap-south-2", label: "ap-south-2" },
	{ value: "ap-southeast-1", label: "ap-southeast-1" },
	{ value: "ap-southeast-2", label: "ap-southeast-2" },
	{ value: "ap-east-1", label: "ap-east-1" },
	{ value: "eu-central-1", label: "eu-central-1" },
	{ value: "eu-central-2", label: "eu-central-2" },
	{ value: "eu-west-1", label: "eu-west-1" },
	{ value: "eu-west-2", label: "eu-west-2" },
	{ value: "eu-west-3", label: "eu-west-3" },
	{ value: "eu-north-1", label: "eu-north-1" },
	{ value: "eu-south-1", label: "eu-south-1" },
	{ value: "eu-south-2", label: "eu-south-2" },
	{ value: "ca-central-1", label: "ca-central-1" },
	{ value: "sa-east-1", label: "sa-east-1" },
	{ value: "us-gov-east-1", label: "us-gov-east-1" },
	{ value: "us-gov-west-1", label: "us-gov-west-1" },
].sort((a, b) => a.value.localeCompare(b.value))

export const BEDROCK_1M_CONTEXT_MODEL_IDS = [
	"anthropic.claude-sonnet-4-20250514-v1:0",
	"anthropic.claude-sonnet-4-5-20250929-v1:0",
	"anthropic.claude-sonnet-4-6",
	"anthropic.claude-opus-4-6-v1",
	"anthropic.claude-opus-4-7",
] as const

// Models whose 1M context window is NATIVE (no opt-in beta flag required). AWS Bedrock
// Converse rejects unknown anthropic_beta values for these models with "invalid beta
// flag", so we must never send `context-1m-2025-08-07` — nor other Anthropic-direct
// betas like `fine-grained-tool-streaming-2025-05-14` — when invoking them.
// See: https://github.com/continuedev/continue/pull/11969 for the Bedrock validation
// behavior that surfaced this issue.
export const BEDROCK_NATIVE_1M_CONTEXT_MODEL_IDS = ["anthropic.claude-opus-4-7"] as const

// Models that REJECT the legacy `thinking: { type: "enabled", budget_tokens: N }` payload
// on the Bedrock Converse API and instead require the newer adaptive thinking format:
//   additionalModelRequestFields.thinking       = { type: "adaptive" }
//   payload.output_config                       = { effort: "low" | "medium" | "high" }
//
// Attempting to send the legacy shape results in:
//   invalid_request_error: "thinking.type.enabled" is not supported for this model.
//   Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
export const BEDROCK_ADAPTIVE_THINKING_MODEL_IDS = ["anthropic.claude-opus-4-7"] as const

// Previously Claude 4.6 Sonnet/Opus auto-advertised 1M. With the new dual dropdown
// (default-context + `:1m` variant) the UI always exposes both tiers explicitly, so
// we no longer auto-flip any model to 1M at resolve time. The opt-in toggle + `:1m`
// suffix remain the only triggers, keeping behavior predictable.
export const BEDROCK_1M_CONTEXT_DEFAULT_MODEL_IDS = [] as const

export const BEDROCK_1M_CONTEXT_OPT_IN_MODEL_IDS = BEDROCK_1M_CONTEXT_MODEL_IDS.filter(
	(modelId) => !(BEDROCK_1M_CONTEXT_DEFAULT_MODEL_IDS as readonly string[]).includes(modelId),
)
export type BedrockInvokeTargetKind =
	| "foundation-model"
	| "system-profile"
	| "application-profile"
	| "custom-arn"
	| "prompt-router"
	| "unknown"

export type BedrockContextSource = "default-1m" | "profile-id" | "toggle" | "base"

export interface BedrockDiscoveredTarget {
	id: string
	label: string
	baseModelId: string
	targetKind: Extract<BedrockInvokeTargetKind, "foundation-model" | "system-profile" | "application-profile">
	contextWindow: number
	contextSource: BedrockContextSource
	description?: string
	arn?: string
	region?: string
	status?: string
	isGlobal?: boolean
	isCrossRegion?: boolean
	supportsImages?: boolean
	supportsPromptCache?: boolean
}

type ParsedBedrockArn = {
	isArn: boolean
	region?: string
	modelType?: string
	resourceId?: string
}

const BEDROCK_PROFILE_PREFIXES = Array.from(
	new Set(["global.", ...AWS_INFERENCE_PROFILE_MAPPING.map(([, prefix]) => prefix)]),
)

const BEDROCK_1M_SUFFIX_PATTERNS = [/\[1m\]$/i, /:1m(?::fast)?$/i]

const cloneModelInfo = (info: ModelInfo): ModelInfo => ({
	...info,
	cachableFields: info.cachableFields ? [...info.cachableFields] : undefined,
	excludedTools: info.excludedTools ? [...info.excludedTools] : undefined,
	includedTools: info.includedTools ? [...info.includedTools] : undefined,
	supportedParameters: info.supportedParameters ? [...info.supportedParameters] : undefined,
	tiers: info.tiers?.map((tier) => ({ ...tier })),
	longContextPricing: info.longContextPricing ? { ...info.longContextPricing } : undefined,
})

export const stripBedrock1MContextSuffix = (targetId: string) =>
	BEDROCK_1M_SUFFIX_PATTERNS.reduce((value, pattern) => value.replace(pattern, ""), targetId.trim())

export const hasBedrock1MContextIndicator = (targetId?: string) => {
	if (!targetId) {
		return false
	}

	const normalized = targetId.trim().toLowerCase()
	return BEDROCK_1M_SUFFIX_PATTERNS.some((pattern) => pattern.test(normalized))
}

/**
 * Given a list of Bedrock targets, expand each 1M-capable entry into two dropdown
 * choices: the original (default context) and a synthetic twin with `:1m` appended
 * to its id, a (1M context) label suffix, and context-window/pricing from the 1M tier.
 *
 * The runtime recognizes `:1m` via {@link hasBedrock1MContextIndicator} and strips it
 * via {@link stripBedrock1MContextSuffix}, so the synthetic id round-trips correctly.
 *
 * Used by both the static `fallbackTargets` in the webview and by `discoverBedrockTargets`
 * on the extension side, so AWS discovery producing a single profile still yields two
 * dropdown choices (since the inference profile id is identical for 128K and 1M).
 */
export const expandBedrockTargetsWith1MVariants = (targets: BedrockDiscoveredTarget[]): BedrockDiscoveredTarget[] => {
	const oneMillionCapable = new Set<string>(BEDROCK_1M_CONTEXT_MODEL_IDS as readonly string[])
	const result: BedrockDiscoveredTarget[] = []

	for (const target of targets) {
		result.push(target)

		if (!oneMillionCapable.has(target.baseModelId)) {
			continue
		}

		// Skip if the incoming target ALREADY represents a 1M variant (avoid double-adding).
		if (hasBedrock1MContextIndicator(target.id) || target.contextWindow >= 1_000_000) {
			continue
		}

		const modelInfo = bedrockModels[target.baseModelId as keyof typeof bedrockModels] as ModelInfo | undefined
		const tier = modelInfo?.tiers?.[0]
		const oneMContextWindow = tier?.contextWindow ?? 1_000_000

		result.push({
			...target,
			id: `${target.id}:1m`,
			label: `${target.label} (1M context)`,
			contextWindow: oneMContextWindow,
			contextSource: "profile-id",
		})
	}

	return result
}

export const parseBedrockArn = (targetId?: string): ParsedBedrockArn => {
	if (!targetId?.startsWith("arn:")) {
		return { isArn: false }
	}

	const arnRegex = /^arn:[^:]+:(?:bedrock|sagemaker):([^:]+):([^:]*):(?:([^/]+)\/([\w.\-:]+)|([^/]+))$/
	const match = targetId.match(arnRegex)

	if (!match) {
		return { isArn: true }
	}

	return {
		isArn: true,
		region: match[1],
		modelType: match[3],
		resourceId: match[4],
	}
}

export const parseBedrockBaseModelId = (targetId: string): string => {
	if (!targetId) {
		return targetId
	}

	const normalizedTargetId = stripBedrock1MContextSuffix(targetId)
	const parsedArn = parseBedrockArn(normalizedTargetId)
	const value = parsedArn.resourceId ?? normalizedTargetId

	for (const prefix of BEDROCK_PROFILE_PREFIXES) {
		if (value.startsWith(prefix)) {
			return value.substring(prefix.length)
		}
	}

	return value
}

export const inferBedrockInvokeTargetKind = ({
	targetId,
	explicitKind,
}: {
	targetId?: string
	explicitKind?: BedrockInvokeTargetKind
}): BedrockInvokeTargetKind => {
	if (explicitKind) {
		return explicitKind
	}

	if (!targetId) {
		return "unknown"
	}

	if (targetId.startsWith("arn:")) {
		const parsedArn = parseBedrockArn(targetId)
		switch (parsedArn.modelType) {
			case "foundation-model":
				return "foundation-model"
			case "inference-profile":
				if (
					parsedArn.resourceId &&
					BEDROCK_PROFILE_PREFIXES.some((prefix) => parsedArn.resourceId!.startsWith(prefix))
				) {
					return "system-profile"
				}
				return "application-profile"
			case "application-inference-profile":
				return "application-profile"
			case "default-prompt-router":
			case "prompt-router":
				return "prompt-router"
			default:
				return "custom-arn"
		}
	}

	if (
		targetId.startsWith("global.") ||
		AWS_INFERENCE_PROFILE_MAPPING.some(([, prefix]) => targetId.startsWith(prefix))
	) {
		return "system-profile"
	}

	return "foundation-model"
}

export const usesBedrockDefault1MContext = (baseModelId?: string) =>
	!!baseModelId &&
	BEDROCK_1M_CONTEXT_DEFAULT_MODEL_IDS.includes(baseModelId as (typeof BEDROCK_1M_CONTEXT_DEFAULT_MODEL_IDS)[number])

const getBedrockRegionPrefix = (region?: string): string | undefined => {
	if (!region) return undefined
	for (const [pattern, prefix] of AWS_INFERENCE_PROFILE_MAPPING) {
		if (region.startsWith(pattern)) return prefix
	}
	return undefined
}

/**
 * Returns the AWS-side target id that the Bedrock runtime would invoke against, given a
 * provider-settings snapshot. Mirrors the resolution `AwsBedrockHandler.getModel()` does
 * before sending a Converse command, so that callers outside the runtime (e.g. the
 * settings-page max-tokens probe) can hit the exact same target the user's profile is
 * configured to invoke.
 *
 * Resolution order:
 *  1. `awsCustomArn` wins if present (the user provided a literal ARN).
 *  2. If `awsBedrockTargetKind` (or the inferred kind) is an explicit profile / prompt
 *     router selection, use `awsBedrockInvokeTarget` verbatim, stripping the synthetic
 *     `:1m` UI suffix.
 *  3. Otherwise we have a foundation-model selection. Apply Global Inference (`global.`)
 *     when enabled and supported, else apply the regional cross-region inference prefix
 *     (`us.`, `eu.`, etc.) when enabled.
 */
export interface ResolveBedrockInvokeTargetIdOptions {
	awsCustomArn?: string
	awsBedrockInvokeTarget?: string
	awsBedrockTargetKind?: BedrockInvokeTargetKind
	apiModelId?: string
	awsUseGlobalInference?: boolean
	awsUseCrossRegionInference?: boolean
	awsRegion?: string
}

export const resolveBedrockInvokeTargetId = (options: ResolveBedrockInvokeTargetIdOptions): string => {
	if (options.awsCustomArn) {
		return options.awsCustomArn
	}

	const configuredTargetId = options.awsBedrockInvokeTarget || options.apiModelId || ""
	const explicitKind = options.awsBedrockTargetKind
	const targetKind = inferBedrockInvokeTargetKind({
		targetId: configuredTargetId,
		explicitKind,
	})

	if (
		targetKind === "system-profile" ||
		targetKind === "application-profile" ||
		targetKind === "prompt-router" ||
		targetKind === "custom-arn"
	) {
		return stripBedrock1MContextSuffix(configuredTargetId)
	}

	const baseModelId = parseBedrockBaseModelId(configuredTargetId)

	if (
		options.awsUseGlobalInference &&
		BEDROCK_GLOBAL_INFERENCE_MODEL_IDS.includes(baseModelId as (typeof BEDROCK_GLOBAL_INFERENCE_MODEL_IDS)[number])
	) {
		return `global.${baseModelId}`
	}

	if (options.awsUseCrossRegionInference) {
		const prefix = getBedrockRegionPrefix(options.awsRegion)
		if (prefix) {
			return `${prefix}${baseModelId}`
		}
	}

	return baseModelId
}

export const shouldUseBedrock1MContext = ({
	targetId,
	baseModelId,
	optIn1MContext,
}: {
	targetId?: string
	baseModelId?: string
	optIn1MContext?: boolean
}): { enabled: boolean; source: BedrockContextSource } => {
	if (hasBedrock1MContextIndicator(targetId)) {
		return { enabled: true, source: "profile-id" }
	}

	if (usesBedrockDefault1MContext(baseModelId)) {
		return { enabled: true, source: "default-1m" }
	}

	if (
		optIn1MContext &&
		baseModelId &&
		BEDROCK_1M_CONTEXT_MODEL_IDS.includes(baseModelId as (typeof BEDROCK_1M_CONTEXT_MODEL_IDS)[number])
	) {
		return { enabled: true, source: "toggle" }
	}

	return { enabled: false, source: "base" }
}

export const guessBedrockModelInfoFromId = (modelId: string): Partial<ModelInfo> => {
	const modelConfigMap: Record<string, Partial<ModelInfo>> = {
		"claude-4": {
			maxTokens: 8192,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
		"claude-3-7": {
			maxTokens: 8192,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
		"claude-3-5": {
			maxTokens: 8192,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
		"claude-4-opus": {
			maxTokens: 4096,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
		"claude-3-opus": {
			maxTokens: 4096,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
		"claude-3-haiku": {
			maxTokens: 4096,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
	}

	const normalizedId = modelId.toLowerCase()
	for (const [pattern, config] of Object.entries(modelConfigMap)) {
		if (normalizedId.includes(pattern)) {
			return config
		}
	}

	return {
		maxTokens: BEDROCK_MAX_TOKENS,
		contextWindow: BEDROCK_DEFAULT_CONTEXT,
		supportsImages: false,
		supportsPromptCache: false,
	}
}

export const resolveBedrockModelInfo = ({
	baseModelId,
	targetId,
	optIn1MContext,
	modelMaxTokens,
	contextWindowOverride,
	maxOutputTokensOverride,
}: {
	baseModelId?: string
	targetId?: string
	optIn1MContext?: boolean
	// Request-time "how many tokens to ask for" knob (slider value). Mirrors the historic behaviour.
	modelMaxTokens?: number
	contextWindowOverride?: number
	// Static cap override (e.g. empirically detected by the AWS probe). When set, this widens the
	// effective `info.maxTokens` ceiling that downstream UI and request builders see, even if the
	// user has not explicitly bumped the slider.
	maxOutputTokensOverride?: number
}): { baseModelId: string; info: ModelInfo; uses1MContext: boolean; contextSource: BedrockContextSource } => {
	const resolvedBaseModelId = parseBedrockBaseModelId(baseModelId || targetId || bedrockDefaultModelId)

	const baseInfo =
		resolvedBaseModelId in bedrockModels
			? cloneModelInfo(bedrockModels[resolvedBaseModelId as keyof typeof bedrockModels])
			: {
					...cloneModelInfo(bedrockModels[bedrockDefaultModelId]),
					...guessBedrockModelInfoFromId(resolvedBaseModelId),
				}

	const oneMillionContext = shouldUseBedrock1MContext({
		targetId,
		baseModelId: resolvedBaseModelId,
		optIn1MContext,
	})

	let info: ModelInfo = baseInfo
	if (oneMillionContext.enabled) {
		const tier = info.tiers?.[0]
		info = {
			...info,
			contextWindow: tier?.contextWindow ?? 1_000_000,
			inputPrice: tier?.inputPrice ?? info.inputPrice,
			outputPrice: tier?.outputPrice ?? info.outputPrice,
			cacheWritesPrice: tier?.cacheWritesPrice ?? info.cacheWritesPrice,
			cacheReadsPrice: tier?.cacheReadsPrice ?? info.cacheReadsPrice,
		}
	}

	// Apply the static-cap override BEFORE the request-time `modelMaxTokens` so users can
	// explicitly request fewer tokens than the model's headroom (e.g. cost control) without
	// having the override silently clobber their slider value.
	if (maxOutputTokensOverride && maxOutputTokensOverride > 0) {
		info.maxTokens = maxOutputTokensOverride
	}
	if (modelMaxTokens && modelMaxTokens > 0) {
		info.maxTokens = modelMaxTokens
	}
	if (contextWindowOverride && contextWindowOverride > 0) {
		info.contextWindow = contextWindowOverride
	}

	return {
		baseModelId: resolvedBaseModelId,
		info,
		uses1MContext: oneMillionContext.enabled,
		contextSource: oneMillionContext.source,
	}
}

// Amazon Bedrock models that support Global Inference profiles
// As of Apr 2026, AWS supports Global Inference for:
// - Claude Sonnet 4
// - Claude Sonnet 4.5
// - Claude Sonnet 4.6
// - Claude Haiku 4.5
// - Claude Opus 4.5
// - Claude Opus 4.6
// - Claude Opus 4.7
export const BEDROCK_GLOBAL_INFERENCE_MODEL_IDS = [
	"anthropic.claude-sonnet-4-20250514-v1:0",
	"anthropic.claude-sonnet-4-5-20250929-v1:0",
	"anthropic.claude-sonnet-4-6",
	"anthropic.claude-haiku-4-5-20251001-v1:0",
	"anthropic.claude-opus-4-5-20251101-v1:0",
	"anthropic.claude-opus-4-6-v1",
	"anthropic.claude-opus-4-7",
] as const

// Amazon Bedrock Service Tier types
export type BedrockServiceTier = "STANDARD" | "FLEX" | "PRIORITY"

// Models that support service tiers based on AWS documentation
// https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html
export const BEDROCK_SERVICE_TIER_MODEL_IDS = [
	// Amazon Nova models
	"amazon.nova-lite-v1:0",
	"amazon.nova-2-lite-v1:0",
	"amazon.nova-pro-v1:0",
	"amazon.nova-pro-latency-optimized-v1:0",
	// DeepSeek models
	"deepseek.r1-v1:0",
	// Qwen models
	"qwen.qwen3-next-80b-a3b",
	"qwen.qwen3-coder-480b-a35b-v1:0",
	// OpenAI GPT-OSS models
	"openai.gpt-oss-20b-1:0",
	"openai.gpt-oss-120b-1:0",
] as const

// Service tier pricing multipliers
export const BEDROCK_SERVICE_TIER_PRICING = {
	STANDARD: 1.0, // Base price
	FLEX: 0.5, // 50% discount from standard
	PRIORITY: 1.75, // 75% premium over standard
} as const
