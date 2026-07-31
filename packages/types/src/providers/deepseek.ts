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
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["disable", "low", "high", "max"], // Updated 2026-08-01
		preserveReasoning: true,
		reasoningEffort: "high",
		inputPrice: 0, // the inputs are priced as cache read/write, so `inputPrice` should be 0
		// the peak/off-peak pricing policy has not been implemented yet - Updated 2026-08-01
		outputPrice: 0.28, // $0.28 per million tokens - Updated 2026-08-01
		cacheWritesPrice: 0.14, // $0.14 per million tokens (cache miss) - Updated 2026-08-01
		cacheReadsPrice: 0.0028, // $0.0028 per million tokens (cache hit) - Updated 2026-08-01
		description: `DeepSeek-V4-Flash is DeepSeek's fast, cost-efficient V4 model. It supports thinking and non-thinking modes, JSON output, tool calls, chat prefix completion (beta), and FIM completion (beta) in non-thinking mode.`,
	},
	"deepseek-v4-pro": {
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["disable", "high", "max"], // Updated 2026-08-01
		preserveReasoning: true,
		reasoningEffort: "high",
		inputPrice: 0, // the inputs are priced as cache read/write, so `inputPrice` should be 0
		// the peak/off-peak pricing policy has not been implemented yet - Updated 2026-08-01
		outputPrice: 0.87, // $0.87 per million tokens - Updated 2026-08-01
		cacheWritesPrice: 0.435, // $0.435 per million tokens (cache miss) - Updated 2026-08-01
		cacheReadsPrice: 0.003625, // $0.003625 per million tokens (cache hit) - Updated 2026-08-01
		description: `DeepSeek-V4-Pro is DeepSeek's strongest V4 model for reasoning, coding, long-context, and agentic workloads. It supports thinking and non-thinking modes, JSON output, tool calls, chat prefix completion (beta), and FIM completion (beta) in non-thinking mode.`,
	},
} as const satisfies Record<string, ModelInfo>

// https://api-docs.deepseek.com/quick_start/parameter_settings
export const DEEP_SEEK_DEFAULT_TEMPERATURE = 0.0
