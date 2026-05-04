import type { ModelInfo } from "../model.js"

// https://platform.deepseek.com/docs/api
// preserveReasoning enables interleaved thinking mode for tool calls:
// DeepSeek requires reasoning_content to be passed back during tool call
// continuation within the same turn. See: https://api-docs.deepseek.com/guides/thinking_mode
export type DeepSeekModelId = keyof typeof deepSeekModels

export const deepSeekDefaultModelId: DeepSeekModelId = "deepseek-v4-pro"

export const deepSeekModels = {
	"deepseek-v4-pro": {
		maxTokens: 384_000, // 384K max output
		contextWindow: 1_000_000, // 1M context
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		inputPrice: 1.74, // $1.74 per million tokens (cache miss)
		outputPrice: 3.48, // $3.48 per million tokens
		cacheWritesPrice: 1.74, // $1.74 per million tokens (cache miss)
		cacheReadsPrice: 0.145, // $0.145 per million tokens (cache hit)
		description:
			"DeepSeek-V4-Pro is an open-source model with 1.6T total and 49B active parameters. It excels in agentic coding benchmarks, possesses rich world knowledge, and demonstrates world-class reasoning capabilities in Math/STEM/Coding. Supports both Thinking and Non-Thinking modes, tool calls, and 1M context window.",
	},
	"deepseek-v4-flash": {
		maxTokens: 384_000, // 384K max output
		contextWindow: 1_000_000, // 1M context
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		inputPrice: 0.14, // $0.14 per million tokens (cache miss)
		outputPrice: 0.28, // $0.28 per million tokens
		cacheWritesPrice: 0.14, // $0.14 per million tokens (cache miss)
		cacheReadsPrice: 0.028, // $0.028 per million tokens (cache hit)
		description:
			"DeepSeek-V4-Flash is a fast, efficient, and economical model with 284B total and 13B active parameters. Its reasoning capabilities closely approach V4-Pro with smaller parameter size, faster response times, and cost-effective API pricing. Supports both Thinking and Non-Thinking modes, tool calls, and 1M context window.",
	},
	"deepseek-chat": {
		maxTokens: 8192, // 8K max output
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.28, // $0.28 per million tokens (cache miss) - Updated Dec 9, 2025
		outputPrice: 0.42, // $0.42 per million tokens - Updated Dec 9, 2025
		cacheWritesPrice: 0.28, // $0.28 per million tokens (cache miss) - Updated Dec 9, 2025
		cacheReadsPrice: 0.028, // $0.028 per million tokens (cache hit) - Updated Dec 9, 2025
		deprecated: true,
		description:
			"DeepSeek-V3.2 (Non-thinking Mode). Deprecated: will be removed on 2026/07/24. Use deepseek-v4-pro or deepseek-v4-flash instead.",
	},
	"deepseek-reasoner": {
		maxTokens: 8192, // 8K max output
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		inputPrice: 0.28, // $0.28 per million tokens (cache miss) - Updated Dec 9, 2025
		outputPrice: 0.42, // $0.42 per million tokens - Updated Dec 9, 2025
		cacheWritesPrice: 0.28, // $0.28 per million tokens (cache miss) - Updated Dec 9, 2025
		cacheReadsPrice: 0.028, // $0.028 per million tokens (cache hit) - Updated Dec 9, 2025
		deprecated: true,
		description:
			"DeepSeek-V3.2 (Thinking Mode). Deprecated: will be removed on 2026/07/24. Use deepseek-v4-pro or deepseek-v4-flash instead.",
	},
} as const satisfies Record<string, ModelInfo>

// https://api-docs.deepseek.com/quick_start/parameter_settings
export const DEEP_SEEK_DEFAULT_TEMPERATURE = 0.3
