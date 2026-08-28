import type { ModelInfo } from "../model.js"

// Opencode "Go" plan — OpenAI-compatible gateway.
// https://opencode.ai/docs/go/ · base URL: https://opencode.ai/zen/go/v1
//
// Model IDs are fetched dynamically from `https://opencode.ai/zen/go/v1/models`
// so models can be switched on the fly. The endpoint currently omits metadata,
// so Zoo Code supplies limits and capabilities from the registries below.
export const opencodeGoDefaultModelId = "glm-5.2"

export const opencodeGoDefaultModelInfo: ModelInfo = {
	maxTokens: 32_768,
	contextWindow: 200_000,
	supportsImages: false,
	supportsPromptCache: false,
	// Pricing is intentionally omitted: ModelInfoView renders a `0` field as "$0.00 / 1M tokens"
	// (implying the service is free), so we leave it unknown — consistent with the dynamically
	// fetched models, which also leave price fields absent. See PR #319 review.
	description: "Opencode Go plan model. Model IDs are fetched dynamically; metadata uses Zoo Code's model registry.",
}

export const OPENCODE_GO_DEFAULT_TEMPERATURE = 0

/**
 * Native per-model configuration for the Opencode Go plan.
 *
 * The Go `/v1/models` endpoint only reliably returns `id` and (sometimes)
 * `context_window`/`max_tokens`. It does NOT advertise capability flags such
 * as `supportsReasoningEffort`, `preserveReasoning`, `supportsMaxTokens`,
 * `supportsPromptCache`, or pricing — all of which are required for the
 * extension to drive reasoning controls, interleaved-thinking tool calls,
 * the max-output-tokens slider, and accurate cost reporting.
 *
 * This registry encodes the native capabilities of each curated Go model,
 * sourced from the same vendor specs used by the dedicated providers
 * (zai/moonshot/mimo/minimax/deepseek/qwen) and the Go pricing table at
 * https://opencode.ai/docs/go/#usage-limits. It also includes explicitly
 * curated Responses-format models whose gateway metadata is not available
 * through `/models`. The fetcher merges the live `/models` payload on top of
 * these defaults so that context-window and max-token values stay in sync
 * with the gateway while capability flags and pricing remain correct.
 *
 * `supportsPromptCache` has two distinct meanings depending on the wire format:
 *
 *   - Anthropic-format models (Qwen/MiniMax): `true` enables client-side
 *     `cache_control` breakpoint injection in the handler's `/v1/messages`
 *     path. The gateway then reports `cache_creation_input_tokens` /
 *     `cache_read_input_tokens`, which are priced via `cacheWritesPrice` /
 *     `cacheReadsPrice`.
 *   - OpenAI-compatible models (GLM/Kimi/DeepSeek/MiMo): there is no
 *     client-side `cache_control` concept, so the flag is NOT used to build
 *     the request. The gateway performs server-side caching and reports
 *     `cached_tokens` in `prompt_tokens_details`, which the handler forwards
 *     as `cacheReadTokens` and prices via `cacheReadsPrice` regardless of the
 *     flag. MiMo therefore declares `supportsPromptCache: false` (no
 *     client-side injection, matching the dedicated `mimo` provider) while
 *     still carrying a `cacheReadsPrice` for its server-side cache reads.
 */
export const opencodeGoModels: Record<string, ModelInfo> = {
	// --- Zhipu GLM ---
	"glm-5": {
		maxTokens: 16_384,
		contextWindow: 202_752,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoningEffort: ["disable", "medium"],
		reasoningEffort: "medium",
		preserveReasoning: true,
		inputPrice: 1.0,
		outputPrice: 3.2,
		cacheReadsPrice: 0.2,
		description:
			"GLM-5 is Zhipu's next-generation model with a 202k context window and built-in thinking capabilities. Available via the Opencode Go plan.",
	},
	"glm-5.1": {
		maxTokens: 131_072,
		contextWindow: 204_800,
		supportsImages: false,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["disable", "medium"],
		reasoningEffort: "medium",
		preserveReasoning: true,
		inputPrice: 1.4,
		outputPrice: 4.4,
		cacheReadsPrice: 0.26,
		description:
			"GLM-5.1 is Zhipu's most capable model with a 200k context window, 128k max output, and built-in thinking capabilities. Available via the Opencode Go plan.",
	},
	"glm-5.3": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["low", "high", "max"],
		reasoningEffort: "max",
		preserveReasoning: true,
		inputPrice: 1.4,
		outputPrice: 4.4,
		cacheReadsPrice: 0.26,
		description:
			"GLM-5.3 is Zhipu's flagship coding and agent model with a 1M context window, 128k max output, and always-on reasoning with configurable effort (Low/High/Max). Available via the Opencode Go plan.",
	},
	"glm-5.3-flash": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["low", "high", "max"],
		reasoningEffort: "max",
		preserveReasoning: true,
		inputPrice: 0.075,
		outputPrice: 0.25,
		cacheReadsPrice: 0.015,
		description:
			"GLM-5.3 Flash is Zhipu's fast multimodal coding and agent model with a 1M context window and configurable reasoning effort. Available via the Opencode Go plan.",
	},
	"glm-5.2": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["disable", "high", "max"],
		reasoningEffort: "high",
		preserveReasoning: true,
		// Go pricing matches GLM-5.1 ($1.4 / $0.26 cache / $4.4 out per 1M tokens).
		inputPrice: 1.4,
		outputPrice: 4.4,
		cacheReadsPrice: 0.26,
		description:
			"GLM-5.2 is Zhipu's flagship model with a 1M context window, 128k max output, and dual thinking-effort modes (High/Max). It delivers top-tier long-context reasoning, coding, and agentic performance. Available via the Opencode Go plan.",
	},

	// --- Moonshot Kimi ---
	"kimi-k3": {
		maxTokens: 131_072, // Default max_completion_tokens (configurable up to 1,048,576)
		contextWindow: 1_048_576,
		supportsImages: false,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["low", "high", "max"], // Always reasons; default "max"
		reasoningEffort: "max",
		preserveReasoning: true,
		defaultTemperature: 1.0,
		// Go pricing matches Moonshot direct ($3 in / $0.30 cache / $15 out per 1M tokens).
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheReadsPrice: 0.3,
		description:
			"Kimi K3 is Moonshot AI's flagship model with 2.8 trillion parameters, a 1M context window, and always-on reasoning with configurable effort (low/high/max). Available via the Opencode Go plan.",
	},
	"kimi-k2.5": {
		maxTokens: 16_384,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: true,
		supportsTemperature: true,
		defaultTemperature: 1.0,
		inputPrice: 0.6,
		outputPrice: 3.0,
		cacheReadsPrice: 0.1,
		description:
			"Kimi K2.5 is the latest generation of Moonshot AI's Kimi series, featuring improved reasoning capabilities. Available via the Opencode Go plan.",
	},
	"kimi-k2.6": {
		maxTokens: 16_384,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: true,
		supportsTemperature: true,
		defaultTemperature: 1.0,
		inputPrice: 0.95,
		outputPrice: 4.0,
		cacheReadsPrice: 0.16,
		description:
			"Kimi K2.6 is Moonshot AI's native multimodal agentic MoE model with a 256k context window, built for long-horizon coding and tool use. Available via the Opencode Go plan.",
	},
	"kimi-k2.7-code": {
		maxTokens: 262_144,
		contextWindow: 262_144,
		supportsImages: true,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		preserveReasoning: true,
		defaultTemperature: 1.0,
		inputPrice: 0.95,
		outputPrice: 4.0,
		cacheReadsPrice: 0.19,
		description:
			"Kimi K2.7 Code is Moonshot AI's coding model for long-context programming tasks, with multimodal input and a 256k context window. Available via the Opencode Go plan.",
	},

	// --- Meituan LongCat ---
	"longcat-2.0": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningBinary: true,
		preserveReasoning: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheReadsPrice: 0.006,
		description:
			"LongCat 2.0 is Meituan's long-context reasoning and coding model with a 1M context window. Available via the Opencode Go plan.",
	},

	// --- Xiaomi MiMo ---
	"mimo-v2.5": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.14,
		outputPrice: 0.28,
		cacheReadsPrice: 0.0028,
		longContextPricing: {
			thresholdTokens: 256_000,
			inputPriceMultiplier: 2,
			outputPriceMultiplier: 2,
			cacheReadsPriceMultiplier: 2,
		},
		description:
			"MiMo V2.5 - Xiaomi's full-modal understanding model (text, image, audio, video) with 1M context, deep thinking, and tool calling. Available via the Opencode Go plan.",
	},
	"mimo-v2.5-pro": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: false,
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 1.74,
		outputPrice: 3.48,
		cacheReadsPrice: 0.0145,
		longContextPricing: {
			thresholdTokens: 256_000,
			inputPriceMultiplier: 2,
			outputPriceMultiplier: 2,
			cacheReadsPriceMultiplier: 2,
		},
		description:
			"MiMo V2.5 Pro - Xiaomi's flagship reasoning model with 1M context, deep thinking, and tool calling. Available via the Opencode Go plan.",
	},
	"mimo-v2-pro": {
		maxTokens: 128_000,
		contextWindow: 1_048_576,
		supportsImages: false,
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 1.0,
		outputPrice: 3.0,
		cacheReadsPrice: 0.2,
		longContextPricing: {
			thresholdTokens: 256_000,
			inputPriceMultiplier: 2,
			outputPriceMultiplier: 2,
			cacheReadsPriceMultiplier: 2,
		},
		description:
			"MiMo V2 Pro is Xiaomi's text reasoning and coding model with a 1M context window. Available via the Opencode Go plan.",
	},
	"mimo-v2-omni": {
		maxTokens: 128_000,
		contextWindow: 262_144,
		supportsImages: true,
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.4,
		outputPrice: 2.0,
		cacheReadsPrice: 0.08,
		description:
			"MiMo V2 Omni is Xiaomi's multimodal reasoning model with a 256k context window. Available via the Opencode Go plan.",
	},

	// --- MiniMax ---
	"minimax-m2.5": {
		maxTokens: 16_384,
		contextWindow: 204_800,
		supportsImages: false,
		supportsPromptCache: true,
		includedTools: ["search_and_replace"],
		excludedTools: ["apply_diff"],
		preserveReasoning: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.06,
		description:
			"MiniMax M2.5, the latest MiniMax model with enhanced coding and agentic capabilities. Available via the Opencode Go plan.",
	},
	"minimax-m2.7": {
		maxTokens: 16_384,
		contextWindow: 204_800,
		supportsImages: false,
		supportsPromptCache: true,
		includedTools: ["search_and_replace"],
		excludedTools: ["apply_diff"],
		preserveReasoning: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.06,
		description:
			"MiniMax M2.7, the latest MiniMax model with recursive self-improvement capabilities. Available via the Opencode Go plan.",
	},
	"minimax-m3": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		includedTools: ["search_and_replace"],
		excludedTools: ["apply_diff"],
		preserveReasoning: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		// M3 routes through the Anthropic Messages path with client-side
		// cache_control injection active, so cache_creation_input_tokens are
		// reported and billed. Matches the MiniMax write price shared by
		// M2.5/M2.7 (same vendor/pricing tier: $0.3 in / $1.2 out / $0.06
		// cache read).
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.06,
		description:
			"MiniMax M3, a frontier multimodal coding model with a 1M context window, agentic reasoning, and tool use. Available via the Opencode Go plan.",
	},

	// --- Alibaba Qwen ---
	"qwen3.5-plus": {
		maxTokens: 65_536,
		contextWindow: 262_144,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningBudget: true,
		supportsReasoningBinary: true,
		preserveReasoning: true,
		inputPrice: 0.2,
		outputPrice: 1.2,
		cacheReadsPrice: 0.02,
		cacheWritesPrice: 0.25,
		description:
			"Qwen3.5 Plus is Alibaba's multimodal reasoning model with a 256k context window. Available via the Opencode Go plan.",
	},
	"qwen3.6-plus": {
		maxTokens: 65_536,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		inputPrice: 0.5,
		outputPrice: 3.0,
		cacheReadsPrice: 0.05,
		cacheWritesPrice: 0.625,
		longContextPricing: {
			thresholdTokens: 256_000,
			inputPriceMultiplier: 4,
			outputPriceMultiplier: 2,
			cacheReadsPriceMultiplier: 4,
			cacheWritesPriceMultiplier: 4,
		},
		description:
			"Qwen3.6 Plus - Alibaba's balanced coding and reasoning model with a 1M context window. Available via the Opencode Go plan.",
	},
	"qwen3.7-plus": {
		maxTokens: 65_536,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		preserveReasoning: true,
		inputPrice: 0.4,
		outputPrice: 1.6,
		cacheReadsPrice: 0.04,
		cacheWritesPrice: 0.5,
		longContextPricing: {
			thresholdTokens: 256_000,
			inputPriceMultiplier: 3,
			outputPriceMultiplier: 3,
			cacheReadsPriceMultiplier: 3,
			cacheWritesPriceMultiplier: 3,
		},
		description:
			"Qwen3.7 Plus - Alibaba's multimodal reasoning model with a 1M context window and low-cost agentic coding. Available via the Opencode Go plan.",
	},
	"qwen3.7-max": {
		maxTokens: 65_536,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		inputPrice: 2.5,
		outputPrice: 7.5,
		cacheReadsPrice: 0.5,
		cacheWritesPrice: 3.125,
		description:
			"Qwen3.7 Max - Alibaba's flagship text-only reasoning agent model with a 1M context window, designed for long-horizon agent workflows. Available via the Opencode Go plan.",
	},
	"qwen3.8-max": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		inputPrice: 2.0,
		outputPrice: 6.0,
		cacheReadsPrice: 0.25,
		cacheWritesPrice: 2.5,
		description:
			"Qwen3.8 Max - Alibaba's flagship multimodal reasoning model with a 1M context window, 128k max output, and long-horizon coding and agentic capabilities. Available via the Opencode Go plan.",
	},
	"qwen3.8-flash": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningBudget: true,
		supportsReasoningBinary: true,
		preserveReasoning: true,
		inputPrice: 0.15,
		outputPrice: 0.47,
		cacheReadsPrice: 0.016,
		cacheWritesPrice: 0.2,
		description:
			"Qwen3.8 Flash is Alibaba's fast multimodal reasoning model with a 1M context window. Available via the Opencode Go plan.",
	},

	// --- DeepSeek ---
	"deepseek-v4-pro": {
		displayName: "DeepSeek V4 Pro 0813",
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		// DeepSeek advertises a large, explicit max-output ceiling (384k), so
		// expose the configurable max-output slider like GLM. Without this the
		// slider is hidden and the effective default is the 20% context-window
		// clamp (200k); with it, users can raise the budget up to the model's
		// 384k ceiling.
		supportsMaxTokens: true,
		supportsReasoningEffort: ["disable", "low", "medium", "high", "xhigh"],
		preserveReasoning: true,
		reasoningEffort: "high",
		inputPrice: 0.435,
		outputPrice: 0.87,
		cacheReadsPrice: 0.003625,
		description:
			"DeepSeek-V4-Pro-0813 is DeepSeek's strongest V4 model for reasoning, coding, long-context, and agentic workloads. Available via the Opencode Go plan.",
	},
	"deepseek-v4-flash": {
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["disable", "low", "medium", "high", "xhigh"],
		preserveReasoning: true,
		reasoningEffort: "high",
		inputPrice: 0.14,
		outputPrice: 0.28,
		cacheReadsPrice: 0.0028,
		description:
			"DeepSeek-V4-Flash is DeepSeek's fast, cost-efficient V4 model supporting thinking and non-thinking modes. Available via the Opencode Go plan.",
	},
	"deepseek-v4-flash-vision-exp": {
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["disable", "low", "high", "max"],
		reasoningEffort: "high",
		preserveReasoning: true,
		inputPrice: 0.22,
		outputPrice: 0.66,
		cacheReadsPrice: 0.007,
		description:
			"DeepSeek V4 Flash Vision Experimental is a fast multimodal reasoning model with a 1M context window. Available via the Opencode Go plan.",
	},

	// --- Tencent Hunyuan ---
	"hy4-preview": {
		maxTokens: 64_000,
		contextWindow: 1_024_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["disable", "high"],
		reasoningEffort: "high",
		preserveReasoning: true,
		inputPrice: 0.834,
		outputPrice: 2.501,
		cacheReadsPrice: 0.042,
		description:
			"Hunyuan 4 Preview is Tencent's long-context reasoning and coding model with a 1M context window. Available via the Opencode Go plan.",
	},
	hy3: {
		maxTokens: 64_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["disable", "low", "high"],
		reasoningEffort: "high",
		preserveReasoning: true,
		inputPrice: 0.0175,
		outputPrice: 0.0725,
		cacheReadsPrice: 0.004375,
		description:
			"Hunyuan 3 is Tencent's reasoning and coding model with a 256k context window. Available via the Opencode Go plan.",
	},
	"hy3-preview": {
		// The live endpoint still lists this historical alias; it shares HY3's limits and pricing.
		maxTokens: 64_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["disable", "low", "high"],
		reasoningEffort: "high",
		preserveReasoning: true,
		inputPrice: 0.0175,
		outputPrice: 0.0725,
		cacheReadsPrice: 0.004375,
		description:
			"Hunyuan 3 Preview is Tencent's preview reasoning and coding model with a 256k context window. Available via the Opencode Go plan.",
	},

	// --- OpenAI Responses ---
	// Luna is curated here because the Go gateway's model catalogue does not
	// currently provide its capability metadata. These values intentionally
	// describe the Go Responses route, not the OpenAI-native or Codex routes.
	"gpt-5.6-luna": {
		maxTokens: 128_000,
		contextWindow: 1_050_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
		reasoningEffort: "medium",
		inputPrice: 0.2,
		outputPrice: 1.2,
		cacheWritesPrice: 0.25,
		cacheReadsPrice: 0.02,
		longContextPricing: {
			thresholdTokens: 272_000,
			inputPriceMultiplier: 2,
			outputPriceMultiplier: 1.5,
			cacheWritesPriceMultiplier: 2,
			cacheReadsPriceMultiplier: 2,
		},
		description:
			"GPT-5.6 Luna is OpenAI's fast reasoning model with a 1M context window. Available via the Opencode Go plan.",
	},
	"grok-4.5": {
		maxTokens: 500_000,
		contextWindow: 500_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["low", "medium", "high"],
		reasoningEffort: "high",
		inputPrice: 2.0,
		outputPrice: 6.0,
		cacheReadsPrice: 0.3,
		longContextPricing: {
			thresholdTokens: 200_000,
			inputPriceMultiplier: 2,
			outputPriceMultiplier: 2,
			cacheReadsPriceMultiplier: 2,
		},
		description:
			"Grok 4.5 is xAI's multimodal reasoning and agent model with a 500k context window. Available via the Opencode Go plan.",
	},
	"grok-4.6": {
		maxTokens: 500_000,
		contextWindow: 500_000,
		supportsImages: true,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
		reasoningEffort: "high",
		inputPrice: 2.0,
		outputPrice: 6.0,
		cacheReadsPrice: 0.5,
		longContextPricing: {
			thresholdTokens: 200_000,
			inputPriceMultiplier: 2,
			outputPriceMultiplier: 2,
			cacheReadsPriceMultiplier: 2,
		},
		description:
			"Grok 4.6 is xAI's multimodal reasoning and agent model with a 500k context window. Available via the Opencode Go plan.",
	},
	"muse-spark-1.2-contributor": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		supportsReasoningEffort: ["minimal", "low", "medium", "high", "xhigh"],
		reasoningEffort: "medium",
		inputPrice: 0.1,
		outputPrice: 0.2,
		cacheReadsPrice: 0.002,
		description:
			"Muse Spark 1.2 Contributor is Meta's multimodal coding model with a 1M context window. Available via the Opencode Go plan.",
	},
}

/**
 * OpenCode Go models that are only reachable via the Anthropic Messages wire
 * format (`/v1/messages`), not the OpenAI-compatible chat completions format
 * (`/v1/chat/completions` — referred to by the gateway as "oa-compat").
 *
 * The Go gateway maps every model to exactly one wire format (see the model
 * table at https://opencode.ai/docs/go). Models listed here use
 * `@ai-sdk/anthropic`; every other curated model uses
 * `@ai-sdk/openai-compatible`. Sending an Anthropic-format model to the
 * OpenAI chat completions endpoint is rejected with:
 *
 *   401 Model <id> is not supported for format oa-compat
 *
 * This is the set that drives format routing in the handler — keep it in sync
 * with the Go model table.
 */
export const OPENCODE_GO_ANTHROPIC_FORMAT_MODELS = new Set<string>([
	// --- Alibaba Qwen ---
	"qwen3.8-max",
	"qwen3.8-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.6-plus",
	// --- MiniMax ---
	"minimax-m3",
	"minimax-m2.7",
	"minimax-m2.5",
])

/**
 * OpenCode Go models that must be requested via the OpenAI Responses API
 * (`/v1/responses`), not the OpenAI-compatible Chat Completions endpoint
 * (`/v1/chat/completions`).
 *
 * The Go gateway maps every model to exactly one wire format. Some models
 * (currently only `gpt-5.6-luna`) are Responses-only and are also explicitly
 * curated in `opencodeGoModels`: the gateway's
 * `/v1/chat/completions` adapter for them fails with an opaque HTTP 500
 * (`{"type":"error","error":{"type":"error","message":"Internal server error"}}`),
 * while `/v1/responses` succeeds (Zoo-Code-Org/Zoo-Code#1431).
 *
 * Drive routing from this set rather than from the model ID string so the
 * gateway's protocol contract stays explicit, testable, and easy to extend
 * when the next Responses-only model lands. Unknown model IDs default to the
 * OpenAI-compatible chat completions format.
 */
export const OPENCODE_GO_RESPONSES_FORMAT_MODELS = new Set<string>([
	// --- OpenAI ---
	"gpt-5.6-luna",
])

/**
 * Returns `true` when the given Go-plan model ID must be requested via the
 * Anthropic Messages format (`/v1/messages`) rather than the OpenAI-compatible
 * chat completions format. Unknown model IDs default to the OpenAI-compatible
 * format, matching the gateway's default routing.
 */
export function isOpencodeGoAnthropicFormatModel(modelId: string): boolean {
	return OPENCODE_GO_ANTHROPIC_FORMAT_MODELS.has(modelId)
}

/**
 * Returns `true` when the given Go-plan model ID must be requested via the
 * OpenAI Responses API (`/v1/responses`) rather than the OpenAI-compatible
 * chat completions format. Unknown model IDs default to the OpenAI-compatible
 * format, matching the gateway's default routing.
 */
export function isOpencodeGoResponsesFormatModel(modelId: string): boolean {
	return OPENCODE_GO_RESPONSES_FORMAT_MODELS.has(modelId)
}

/**
 * Returns the native {@link ModelInfo} for a Go-plan model ID, or `undefined`
 * when the ID is not part of the curated registry. Callers should fall back to
 * {@link opencodeGoDefaultModelInfo} when this returns `undefined`.
 */
export function getOpencodeGoModelInfo(modelId: string): ModelInfo | undefined {
	return opencodeGoModels[modelId]
}
