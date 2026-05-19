import type { ModelInfo } from "../model.js"

// https://dev.mi.com/
export type MimoModelId = keyof typeof mimoModels

export const mimoDefaultModelId: MimoModelId = "mimo-7b-rl"

export const mimoModels = {
	"mimo-7b-rl": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0,
		outputPrice: 0,
		cacheReadsPrice: 0,
		supportsReasoningBudget: true,
		requiredReasoningBudget: true,
		supportsTemperature: false,
		description:
			"MiMo-7B-RL is a reasoning-focused language model developed by Xiaomi. Built on a 7B parameter base with reinforcement learning training, it excels at complex reasoning, coding, and mathematical problem-solving tasks.",
	},
	"mimo-7b-sft": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0,
		outputPrice: 0,
		cacheReadsPrice: 0,
		supportsTemperature: true,
		defaultTemperature: 0.7,
		description:
			"MiMo-7B-SFT is a supervised fine-tuned language model from Xiaomi's MiMo family. It provides strong general-purpose instruction following capabilities with efficient inference at 7B parameters.",
	},
	"mimo-7b-base": {
		maxTokens: 16_384,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0,
		outputPrice: 0,
		cacheReadsPrice: 0,
		supportsTemperature: true,
		defaultTemperature: 1.0,
		description:
			"MiMo-7B-Base is the foundation model of Xiaomi's MiMo family. A 7B parameter pre-trained model suitable for further fine-tuning or direct use with appropriate prompting strategies.",
	},
} as const satisfies Record<string, ModelInfo>

export const MIMO_DEFAULT_TEMPERATURE = 0.7
