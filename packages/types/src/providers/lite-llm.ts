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
 * Each fragment below matches a model-family substring that requires
 * `preserveReasoning: true` in its native provider config (see deepseek.ts,
 * mimo.ts, moonshot.ts, bedrock.ts, fireworks.ts, zai.ts, minimax.ts,
 * opencode-go.ts), so the same behavior can be inferred for a LiteLLM-routed
 * alias of the same underlying model. This is best-effort: unrecognized
 * aliases or renamed deployments will not match, and callers should treat
 * it as a heuristic, not a source of truth.
 */
const LITELLM_PRESERVE_REASONING_FRAGMENTS = [
	String.raw`deepseek-v4-(flash|pro)`, // deepseek.ts
	String.raw`deepseek-reasoner`, // deepseek.ts (legacy alias)
	String.raw`mimo-v2\.5(-pro)?`, // mimo.ts
	String.raw`kimi-k2-thinking`, // moonshot.ts, bedrock.ts, fireworks.ts
	String.raw`kimi-k2p7-code`, // fireworks.ts (dash-separated id)
	String.raw`kimi-k2\.7-code`, // fireworks.ts (dotted alias variant)
	String.raw`minimax[.-]?m[23](\.\d+)?(-highspeed|-stable)?\b`, // bedrock.ts, minimax.ts, opencode-go.ts
	String.raw`glm-4\.7(?!-flash)\b`, // zai.ts (excludes glm-4.7-flash(x))
	String.raw`glm-5(\.[12])?(-turbo)?(?!-flash)\b`, // zai.ts, opencode-go.ts
	String.raw`qwen3\.[67]-(plus|max)`, // opencode-go.ts
]

export const LITELLM_PRESERVE_REASONING_PATTERN = new RegExp(LITELLM_PRESERVE_REASONING_FRAGMENTS.join("|"), "i")
