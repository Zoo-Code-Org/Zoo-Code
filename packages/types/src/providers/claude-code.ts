import type { ModelInfo } from "../model.js"

/**
 * Claude Code (Subscription) Provider
 *
 * This provider shells out to the user's own locally-installed and
 * already-authenticated `claude` CLI (Pro/Max/Team/Enterprise subscription),
 * instead of an Anthropic API key. No credentials are read, stored, or
 * transmitted by this extension.
 *
 * Key differences from anthropic:
 * - Uses the local CLI session instead of API keys
 * - Subscription-based pricing (no per-token costs)
 * - Model availability depends on the authenticated subscription
 *
 * Pricing below (0 at runtime) mirrors the real per-token list prices from
 * `anthropic.ts` as of 2026-07-04, for reference only.
 *
 * contextWindow/maxTokens are grounded against live `claude --model <id>
 * --output-format json` output (`modelUsage[id].contextWindow` /
 * `.maxOutputTokens`) rather than copied from `anthropic.ts`, since the
 * Agent SDK/CLI path reports different max output caps than the direct API
 * for the same model name (e.g. 64K here vs. 128K direct for Opus/Sonnet 5/
 * Fable 5, 32K here vs. 64K direct for Haiku 4.5/Sonnet 4.6).
 *
 * `claude-sonnet-4-6[1m]` is a distinct, explicitly-selected model key (not
 * a flag) that reports contextWindow: 1_000_000 vs. 200_000 for the bare
 * `claude-sonnet-4-6` id. `claude-opus-4-6[1m]` was tried and did not
 * resolve to a model (empty modelUsage), so no 1M variant is listed for it.
 */

export type ClaudeCodeModelId = keyof typeof claudeCodeModels

export const claudeCodeDefaultModelId: ClaudeCodeModelId = "claude-sonnet-5"

/**
 * Models available through the Claude Code CLI subscription flow.
 * Costs are 0 as they are covered by the subscription.
 */
export const claudeCodeModels = {
	"claude-fable-5": {
		maxTokens: 64_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		// List price: $10/$50 per million in/out, $12.50 cache write, $1.00 cache read.
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		supportsReasoningBudget: true,
		supportsReasoningBinary: true,
		supportsTemperature: false,
		description: "Claude Fable 5 via Claude Code subscription (Pro/Max/Team/Enterprise).",
	},
	"claude-opus-4-8": {
		maxTokens: 64_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		// List price: $5/$25 per million in/out, $6.25 cache write, $0.50 cache read.
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		supportsReasoningBudget: true,
		supportsReasoningBinary: true,
		supportsTemperature: false,
		description: "Claude Opus 4.8 via Claude Code subscription (Pro/Max/Team/Enterprise).",
	},
	"claude-opus-4-7": {
		maxTokens: 64_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		// List price: $5/$25 per million in/out, $6.25 cache write, $0.50 cache read.
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		supportsReasoningBudget: true,
		supportsReasoningBinary: true,
		supportsTemperature: false,
		description: "Claude Opus 4.7 via Claude Code subscription (Pro/Max/Team/Enterprise).",
	},
	"claude-opus-4-6": {
		maxTokens: 64_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		// List price: $5/$25 per million in/out, $6.25 cache write, $0.50 cache read.
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		supportsReasoningBudget: true,
		description: "Claude Opus 4.6 via Claude Code subscription (Pro/Max/Team/Enterprise).",
	},
	"claude-sonnet-5": {
		maxTokens: 64_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		// List price: $2/$10 per million in/out (introductory, through Aug 31, 2026),
		// $2.50 cache write, $0.20 cache read.
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		supportsReasoningBudget: true,
		supportsReasoningBinary: true,
		supportsTemperature: false,
		description: "Claude Sonnet 5 via Claude Code subscription (Pro/Max/Team/Enterprise).",
	},
	"claude-sonnet-4-6": {
		maxTokens: 32_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		// List price: $3/$15 per million in/out, $3.75 cache write, $0.30 cache read.
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		supportsReasoningBudget: true,
		description: "Claude Sonnet 4.6 via Claude Code subscription (Pro/Max/Team/Enterprise).",
	},
	"claude-sonnet-4-6[1m]": {
		maxTokens: 32_000,
		contextWindow: 1_000_000,
		supportsImages: true,
		supportsPromptCache: true,
		// Same list price as claude-sonnet-4-6; [1m] only changes context window.
		// Tiered pricing above 200K would apply on the direct Anthropic API path
		// but subscription usage is $0 either way.
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		supportsReasoningBudget: true,
		description: "Claude Sonnet 4.6 (1M context) via Claude Code subscription (Pro/Max/Team/Enterprise).",
	},
	"claude-haiku-4-5-20251001": {
		maxTokens: 32_000,
		contextWindow: 200_000,
		supportsImages: true,
		supportsPromptCache: true,
		// List price: $1/$5 per million in/out, $1.25 cache write, $0.10 cache read.
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		supportsReasoningBudget: true,
		description: "Claude Haiku 4.5 via Claude Code subscription (Pro/Max/Team/Enterprise).",
	},
} as const satisfies Record<string, ModelInfo>
