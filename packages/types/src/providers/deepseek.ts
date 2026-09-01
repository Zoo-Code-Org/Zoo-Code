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
		supportsReasoningEffort: ["disable", "low", "high", "max"], // Updated 2026-08-13
		preserveReasoning: true,
		reasoningEffort: "high",
		inputPrice: 0, // the inputs are priced as cache read/write, so `inputPrice` should be 0
		// Static estimates use peak rates; off-peak rates are 50% lower. Effective 2026-08-16.
		outputPrice: 1.32,
		cacheWritesPrice: 0.44,
		cacheReadsPrice: 0.014,
		description: `DeepSeek-V4-Flash is DeepSeek's fast, cost-efficient V4 model. It supports thinking and non-thinking modes, JSON output, tool calls, chat prefix completion (beta), and FIM completion (beta) in non-thinking mode.`,
	},
	"deepseek-v4-pro": {
		displayName: "DeepSeek V4 Pro 0813",
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoningEffort: ["disable", "low", "high", "max"], // Updated 2026-08-13
		preserveReasoning: true,
		reasoningEffort: "high",
		inputPrice: 0, // the inputs are priced as cache read/write, so `inputPrice` should be 0
		// Static estimates use peak rates; off-peak rates are 50% lower. Effective 2026-08-16.
		outputPrice: 3.96,
		cacheWritesPrice: 1.32,
		cacheReadsPrice: 0.044,
		description: `DeepSeek-V4-Pro-0813 is DeepSeek's strongest V4 model for reasoning, coding, long-context, and agentic workloads. It supports thinking and non-thinking modes, JSON output, tool calls, chat prefix completion (beta), and FIM completion (beta) in non-thinking mode.`,
	},
	"deepseek-v4-flash-vision-exp": {
		displayName: "DeepSeek V4 Flash Vision Exp",
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["disable", "low", "high", "max"],
		preserveReasoning: true,
		reasoningEffort: "high",
		supportsTemperature: true,
		defaultTemperature: 1.0,
		inputPrice: 0,
		// Static estimates use peak rates; off-peak rates are 50% lower.
		outputPrice: 1.32,
		cacheWritesPrice: 0.44,
		cacheReadsPrice: 0.014,
		description: `DeepSeek-V4-Flash-Vision-Exp is an experimental multimodal model for text and image understanding. It supports thinking and non-thinking modes, JSON output, tool calls, and image input through Chat Completions, Responses, and Anthropic-compatible APIs.`,
	},
} as const satisfies Record<string, ModelInfo>

// https://api-docs.deepseek.com/quick_start/parameter_settings
export const DEEP_SEEK_DEFAULT_TEMPERATURE = 0.0
