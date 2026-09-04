import type { ModelInfo } from "../model.js"

// NeuronPool — OpenAI-compatible social compute / public marketplace.
// Live catalog: GET {baseURL}/models  (default https://neuronpool.damnknee.workers.dev/v1)
export type NeuronPoolModelId =
	| "gpt-oss-20b"
	| "llama-3.2-1b-instruct"
	| "llama-3.1-8b-instruct"
	| "qwen2.5-7b-instruct"
	| "gemma-3-12b-it"
	| "qwen3-30b-a3b"
	| "neuronpool-tiny-chat"

export const neuronpoolDefaultModelId: NeuronPoolModelId = "gpt-oss-20b"

const chatDefaults = {
	supportsImages: false,
	supportsPromptCache: false,
	maxTokens: 4096,
} as const

export const neuronpoolDefaultModelInfo: ModelInfo = {
	...chatDefaults,
	contextWindow: 131_072,
	inputPrice: 0.015,
	outputPrice: 0.07,
	description: "gpt-oss-20b via NeuronPool (OpenAI-compatible chat + tools).",
}

export const neuronpoolModels = {
	"gpt-oss-20b": {
		...chatDefaults,
		contextWindow: 131_072,
		inputPrice: 0.015,
		outputPrice: 0.07,
		description: "gpt-oss-20b via NeuronPool.",
	},
	"llama-3.2-1b-instruct": {
		...chatDefaults,
		contextWindow: 131_072,
		inputPrice: 0.005,
		outputPrice: 0.01,
		description: "Llama 3.2 1B Instruct via NeuronPool.",
	},
	"llama-3.1-8b-instruct": {
		...chatDefaults,
		contextWindow: 131_072,
		inputPrice: 0.02,
		outputPrice: 0.03,
		description: "Llama 3.1 8B Instruct via NeuronPool.",
	},
	"qwen2.5-7b-instruct": {
		...chatDefaults,
		contextWindow: 32_768,
		inputPrice: 0.02,
		outputPrice: 0.03,
		description: "Qwen2.5 7B Instruct via NeuronPool.",
	},
	"gemma-3-12b-it": {
		...chatDefaults,
		contextWindow: 131_072,
		inputPrice: 0.04,
		outputPrice: 0.06,
		description: "Gemma 3 12B IT via NeuronPool.",
	},
	"qwen3-30b-a3b": {
		...chatDefaults,
		contextWindow: 32_768,
		inputPrice: 0.06,
		outputPrice: 0.09,
		description: "Qwen3 30B A3B via NeuronPool.",
	},
	"neuronpool-tiny-chat": {
		...chatDefaults,
		contextWindow: 4096,
		inputPrice: 0.001,
		outputPrice: 0.002,
		description: "In-house tiny chat model for smoke tests.",
	},
} as const satisfies Record<NeuronPoolModelId, ModelInfo>
