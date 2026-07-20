import type { ModelInfo } from "../model.js"

// https://docs.litellm.ai/
export const litellmDefaultModelId = "claude-3-7-sonnet-20250219"

export const litellmDefaultModelInfo: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 3.0,
	outputPrice: 15.0,
	cacheWritesPrice: 3.75,
	cacheReadsPrice: 0.3,
}

/**
 * LiteLLM is a gateway: it fronts arbitrary underlying models and its
 * `/v1/model/info` response carries no reasoning-related capability flags
 * (no `preserveReasoning` equivalent). The underlying model identity is only
 * visible as text in the model alias (`model_name`) or the routed target
 * (`litellm_params.model`, e.g. `deepseek/deepseek-reasoner`,
 * `bedrock/moonshot.kimi-k2-thinking`, `fireworks_ai/.../kimi-k2p7-code`).
 *
 * Rather than matching model-family substrings with a regex (which can
 * over-match unrelated aliases, e.g. a family fragment appearing inside a
 * longer unrelated model id), this is an explicit list of the exact model
 * ids that set `preserveReasoning: true` in their native provider config
 * (see deepseek.ts, mimo.ts, moonshot.ts, bedrock.ts, fireworks.ts, zai.ts,
 * minimax.ts, opencode-go.ts). The same behavior is inferred for a
 * LiteLLM-routed alias of the same underlying model. Keep this list in sync
 * with those registries. This is still best-effort: unrecognized aliases or
 * renamed deployments will not match, and callers should treat it as a
 * heuristic, not a source of truth.
 */
export const LITELLM_PRESERVE_REASONING_MODEL_IDS = [
	// deepseek.ts
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"deepseek-reasoner",

	// mimo.ts, opencode-go.ts
	"mimo-v2.5",
	"mimo-v2.5-pro",

	// moonshot.ts, bedrock.ts, fireworks.ts
	"kimi-k2-thinking",
	"moonshot.kimi-k2-thinking",
	"kimi-k2p7-code",

	// zai.ts
	"glm-4.7",
	"glm-5",
	"glm-5.1",
	"glm-5.2",
	"glm-5-turbo",

	// bedrock.ts, minimax.ts, opencode-go.ts
	"minimax.minimax-m2",
	"minimax-m2",
	"minimax-m2-stable",
	"minimax-m2.1",
	"minimax-m2.1-highspeed",
	"minimax-m2.5",
	"minimax-m2.5-highspeed",
	"minimax-m2.7",
	"minimax-m2.7-highspeed",
	"minimax-m3",

	// opencode-go.ts
	"qwen3.6-plus",
	"qwen3.7-plus",
	"qwen3.7-max",
] as const

const LITELLM_PRESERVE_REASONING_MODEL_ID_SET = new Set<string>(LITELLM_PRESERVE_REASONING_MODEL_IDS)

/**
 * Checks whether `modelName` (a LiteLLM alias or routed `litellm_params.model`
 * value) identifies a model that requires `preserveReasoning: true`.
 * Provider-prefixed routed names (e.g. `deepseek/deepseek-reasoner`,
 * `fireworks_ai/accounts/fireworks/models/kimi-k2p7-code`) are matched by
 * their final slash-delimited segment.
 */
export function isLiteLLMPreserveReasoningModel(modelName: string | undefined): boolean {
	const normalized = modelName?.trim().toLowerCase()

	if (!normalized) {
		return false
	}

	const modelId = normalized.split("/").pop()

	return modelId !== undefined && LITELLM_PRESERVE_REASONING_MODEL_ID_SET.has(modelId)
}
