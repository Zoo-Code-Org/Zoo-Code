import type { ModelInfo } from "../model.js"

// https://docs.anthropic.com/en/docs/about-claude/models
// https://platform.claude.com/docs/en/about-claude/pricing

export type AnthropicModelId = keyof typeof anthropicModels
export const anthropicDefaultModelId: AnthropicModelId = "claude-sonnet-4-5"

export const anthropicModels = {
	"claude-sonnet-4-6": {
		maxTokens: 64_000, // Overridden to 8k if `enableReasoningEffort` is false.
		contextWindow: 200_000, // Default 200K, extendable to 1M with beta flag 'context-1m-2025-08-07'
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0, // $3 per million input tokens (≤200K context)
		outputPrice: 15.0, // $15 per million output tokens (≤200K context)
		cacheWritesPrice: 3.75, // $3.75 per million tokens
		cacheReadsPrice: 0.3, // $0.30 per million tokens
		supportsReasoningBudget: true,
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
	"claude-sonnet-5": {
		maxTokens: 128_000, // Overridden to 8k if `enableReasoningEffort` is false.
		contextWindow: 1_000_000, // 1M context window native (no beta header required)
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 2.0, // $2 per million input tokens (introductory pricing through Aug 31, 2026)
		outputPrice: 10.0, // $10 per million output tokens (introductory pricing through Aug 31, 2026)
		cacheWritesPrice: 2.5, // $2.50 per million tokens (introductory pricing through Aug 31, 2026)
		cacheReadsPrice: 0.2, // $0.20 per million tokens (introductory pricing through Aug 31, 2026)
		// Sonnet 5 uses the same adaptive-thinking / binary-toggle convention as
		// Opus 4.7+ and Fable 5 on the direct Anthropic provider path. Manual
		// extended thinking (budget_tokens) is removed and returns a 400, and
		// setting sampling parameters (temperature/top_p/top_k) returns a 400.
		supportsReasoningBudget: true,
		supportsReasoningBinary: true,
		supportsTemperature: false,
		description:
			"Claude Sonnet 5 is the best combination of speed and intelligence, optimized for coding, tool use, and agentic workflows.",
	},
	"claude-sonnet-4-5": {
		maxTokens: 64_000, // Overridden to 8k if `enableReasoningEffort` is false.
		contextWindow: 200_000, // Default 200K, extendable to 1M with beta flag 'context-1m-2025-08-07'
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0, // $3 per million input tokens (≤200K context)
		outputPrice: 15.0, // $15 per million output tokens (≤200K context)
		cacheWritesPrice: 3.75, // $3.75 per million tokens
		cacheReadsPrice: 0.3, // $0.30 per million tokens
		supportsReasoningBudget: true,
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
	"claude-sonnet-4-20250514": {
		maxTokens: 64_000, // Overridden to 8k if `enableReasoningEffort` is false.
		contextWindow: 200_000, // Default 200K, extendable to 1M with beta flag 'context-1m-2025-08-07'
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0, // $3 per million input tokens (≤200K context)
		outputPrice: 15.0, // $15 per million output tokens (≤200K context)
		cacheWritesPrice: 3.75, // $3.75 per million tokens
		cacheReadsPrice: 0.3, // $0.30 per million tokens
		supportsReasoningBudget: true,
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
	"claude-opus-4-6": {
		maxTokens: 128_000, // Overridden to 8k if `enableReasoningEffort` is false.
		contextWindow: 200_000, // Default 200K, extendable to 1M with beta flag
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 5.0, // $5 per million input tokens (≤200K context)
		outputPrice: 25.0, // $25 per million output tokens (≤200K context)
		cacheWritesPrice: 6.25, // $6.25 per million tokens
		cacheReadsPrice: 0.5, // $0.50 per million tokens
		supportsReasoningBudget: true,
		// Tiered pricing for extended context (requires beta flag)
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
	"claude-opus-4-7": {
		maxTokens: 128_000, // Overridden to 8k if `enableReasoningEffort` is false.
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 5.0, // $5 per million input tokens
		outputPrice: 25.0, // $25 per million output tokens
		cacheWritesPrice: 6.25, // $6.25 per million tokens
		cacheReadsPrice: 0.5, // $0.50 per million tokens
		// Keep the hybrid-reasoning capability so Anthropic token-cap handling and
		// stored max-token overrides behave the same as before.
		supportsReasoningBudget: true,
		// Direct Anthropic Opus 4.7 no longer accepts budget-token thinking payloads,
		// so the UI should still present a simple on/off toggle on this provider path.
		supportsReasoningBinary: true,
		supportsTemperature: false,
	},
	"claude-opus-4-8": {
		maxTokens: 128_000, // Overridden to 8k if `enableReasoningEffort` is false.
		contextWindow: 1_000_000, // 1M context window native (no beta header required, same as 4.7)
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 5.0, // $5 per million input tokens (regular tier)
		outputPrice: 25.0, // $25 per million output tokens (regular tier)
		cacheWritesPrice: 6.25, // $6.25 per million tokens
		cacheReadsPrice: 0.5, // $0.50 per million tokens
		// 4.8 inherits the adaptive-thinking model introduced in 4.7 — no breaking
		// API changes. supportsReasoningBudget is kept true so the existing token-cap
		// handling and max-token overrides behave identically.
		supportsReasoningBudget: true,
		// 4.8 still rejects budget_tokens-style thinking payloads, so the UI must
		// expose reasoning as a binary on/off toggle on this provider path.
		supportsReasoningBinary: true,
		supportsTemperature: false,
	},
	"claude-fable-5": {
		maxTokens: 128_000, // Overridden to 8k if `enableReasoningEffort` is false.
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 10.0, // $10 per million input tokens
		outputPrice: 50.0, // $50 per million output tokens
		cacheWritesPrice: 12.5, // $12.50 per million tokens
		cacheReadsPrice: 1.0, // $1.00 per million tokens
		// Fable 5 uses the same adaptive-thinking / binary-toggle convention as
		// Opus 4.7+ on the direct Anthropic provider path.
		supportsReasoningBudget: true,
		supportsReasoningBinary: true,
		supportsTemperature: false,
		description:
			"Claude Fable 5 is Anthropic's most capable widely released model for the most demanding reasoning and long-horizon agentic work.",
	},
	"claude-opus-4-5-20251101": {
		maxTokens: 32_000, // Overridden to 8k if `enableReasoningEffort` is false.
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 5.0, // $5 per million input tokens
		outputPrice: 25.0, // $25 per million output tokens
		cacheWritesPrice: 6.25, // $6.25 per million tokens
		cacheReadsPrice: 0.5, // $0.50 per million tokens
		supportsReasoningBudget: true,
	},
	"claude-opus-4-1-20250805": {
		maxTokens: 32_000, // Overridden to 8k if `enableReasoningEffort` is false.
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 15.0, // $15 per million input tokens
		outputPrice: 75.0, // $75 per million output tokens
		cacheWritesPrice: 18.75, // $18.75 per million tokens
		cacheReadsPrice: 1.5, // $1.50 per million tokens
		supportsReasoningBudget: true,
	},
	"claude-opus-4-20250514": {
		maxTokens: 32_000, // Overridden to 8k if `enableReasoningEffort` is false.
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 15.0, // $15 per million input tokens
		outputPrice: 75.0, // $75 per million output tokens
		cacheWritesPrice: 18.75, // $18.75 per million tokens
		cacheReadsPrice: 1.5, // $1.50 per million tokens
		supportsReasoningBudget: true,
	},
	"claude-3-7-sonnet-20250219:thinking": {
		maxTokens: 128_000, // Unlocked by passing `beta` flag to the model. Otherwise, it's 64k.
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0, // $3 per million input tokens
		outputPrice: 15.0, // $15 per million output tokens
		cacheWritesPrice: 3.75, // $3.75 per million tokens
		cacheReadsPrice: 0.3, // $0.30 per million tokens
		supportsReasoningBudget: true,
		requiredReasoningBudget: true,
	},
	"claude-3-7-sonnet-20250219": {
		maxTokens: 8192, // Since we already have a `:thinking` virtual model we aren't setting `supportsReasoningBudget: true` here.
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0, // $3 per million input tokens
		outputPrice: 15.0, // $15 per million output tokens
		cacheWritesPrice: 3.75, // $3.75 per million tokens
		cacheReadsPrice: 0.3, // $0.30 per million tokens
	},
	"claude-3-5-sonnet-20241022": {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3.0, // $3 per million input tokens
		outputPrice: 15.0, // $15 per million output tokens
		cacheWritesPrice: 3.75, // $3.75 per million tokens
		cacheReadsPrice: 0.3, // $0.30 per million tokens
	},
	"claude-3-5-haiku-20241022": {
		maxTokens: 8192,
		contextWindow: 200_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 1.0,
		outputPrice: 5.0,
		cacheWritesPrice: 1.25,
		cacheReadsPrice: 0.1,
	},
	"claude-3-opus-20240229": {
		maxTokens: 4096,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 15.0,
		outputPrice: 75.0,
		cacheWritesPrice: 18.75,
		cacheReadsPrice: 1.5,
	},
	"claude-3-haiku-20240307": {
		maxTokens: 4096,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0.25,
		outputPrice: 1.25,
		cacheWritesPrice: 0.3,
		cacheReadsPrice: 0.03,
	},
	"claude-haiku-4-5-20251001": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 1.0,
		outputPrice: 5.0,
		cacheWritesPrice: 1.25,
		cacheReadsPrice: 0.1,
		supportsReasoningBudget: true,
		description:
			"Claude Haiku 4.5 delivers near-frontier intelligence at lightning speeds with extended thinking, vision, and multilingual support.",
	},
} as const satisfies Record<string, ModelInfo>

export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192
