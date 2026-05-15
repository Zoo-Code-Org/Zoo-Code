import type { ModelInfo } from "../model.js"

export type AetherapiModelId = keyof typeof aetherapiModels

export const aetherapiDefaultModelId: AetherapiModelId = "kimi-k2.6"

export const aetherapiModels = {
	"kimi-k2.6": {
		maxTokens: 8192,
		contextWindow: 262_144,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.42,
		outputPrice: 1.96,
		description:
			"Kimi K2.6 is a state-of-the-art multimodal language model with vision and tool calling capabilities, featuring a 262K context window.",
	},
} as const satisfies Record<string, ModelInfo>
