import type { ModelInfo } from "../model.js"

// https://platform.deepseek.com/docs/api
// preserveReasoning enables interleaved thinking mode for tool calls:
// DeepSeek requires reasoning_content to be passed back during tool call
// continuation within the same turn. See: https://api-docs.deepseek.com/guides/thinking_mode
export type DeepSeekModelId = keyof typeof deepSeekModels

export const deepSeekDefaultModelId: DeepSeekModelId = "deepseek-v4-flash"

export const deepSeekModels = {
	"deepseek-v4-flash": {
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoningEffort: ["disable", "low", "medium", "high", "xhigh"],
		preserveReasoning: true,
		reasoningEffort: "high",
		inputPrice: 0.14, // $0.14 per million tokens (cache miss) - Updated Apr 29, 2026
		outputPrice: 0.28, // $0.28 per million tokens - Updated Apr 29, 2026
		cacheWritesPrice: 0.14, // $0.14 per million tokens (cache miss) - Updated Apr 29, 2026
		cacheReadsPrice: 0.0028, // $0.0028 per million tokens (cache hit) - Updated Apr 29, 2026
		description: `DeepSeek-V4-Flash is DeepSeek's fast, cost-efficient V4 model. It supports thinking and non-thinking modes, JSON output, tool calls, chat prefix completion (beta), and FIM completion (beta) in non-thinking mode.`,
	},
	"deepseek-v4-pro": {
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoningEffort: ["disable", "low", "medium", "high", "xhigh"],
		preserveReasoning: true,
		reasoningEffort: "high",
		// TODO(deepseek): Re-check V4 Pro discounted prices after DeepSeek's 2026-05-31 discount end date.
		inputPrice: 0.435, // $0.435 per million tokens (cache miss, discounted) - Updated Apr 29, 2026
		outputPrice: 0.87, // $0.87 per million tokens (discounted) - Updated Apr 29, 2026
		cacheWritesPrice: 0.435, // $0.435 per million tokens (cache miss, discounted) - Updated Apr 29, 2026
		cacheReadsPrice: 0.003625, // $0.003625 per million tokens (cache hit, discounted) - Updated Apr 29, 2026
		description: `DeepSeek-V4-Pro is DeepSeek's strongest V4 model for reasoning, coding, long-context, and agentic workloads. It supports thinking and non-thinking modes, JSON output, tool calls, chat prefix completion (beta), and FIM completion (beta) in non-thinking mode.`,
	},
	// TODO(deepseek): Remove this compatibility alias after DeepSeek's 2026-07-24 retirement date.
	"deepseek-chat": {
		maxTokens: 8192, // 8K max output
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.28, // $0.28 per million tokens (cache miss) - Updated Dec 9, 2025
		outputPrice: 0.42, // $0.42 per million tokens - Updated Dec 9, 2025
		cacheWritesPrice: 0.28, // $0.28 per million tokens (cache miss) - Updated Dec 9, 2025
		cacheReadsPrice: 0.028, // $0.028 per million tokens (cache hit) - Updated Dec 9, 2025
		description: `Legacy compatibility alias for the non-thinking mode of deepseek-v4-flash. DeepSeek plans to deprecate this model name on 2026-07-24.`,
	},
	// TODO(deepseek): Remove this compatibility alias after DeepSeek's 2026-07-24 retirement date.
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
		description: `Legacy compatibility alias for the thinking mode of deepseek-v4-flash. DeepSeek plans to deprecate this model name on 2026-07-24.`,
	},
} as const satisfies Record<string, ModelInfo>

// https://api-docs.deepseek.com/quick_start/parameter_settings
export const DEEP_SEEK_DEFAULT_TEMPERATURE = 0.3
