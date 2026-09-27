import { openAiCodexModels } from "../providers/openai-codex.js"
import { openAiNativeDefaultModelId, openAiNativeModels } from "../providers/openai.js"

describe("OpenAI native models", () => {
	it("describes GPT-6 Astra without changing the provider default", () => {
		expect(openAiNativeDefaultModelId).toBe("gpt-5.6-sol")
		expect(openAiNativeModels["gpt-6-astra"]).toMatchObject({
			maxTokens: 128_000,
			contextWindow: 1_050_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
			requiredReasoningEffort: true,
			reasoningEffort: "medium",
			supportsTemperature: false,
			inputPrice: 10,
			cacheWritesPrice: 12.5,
			cacheReadsPrice: 1,
			outputPrice: 50,
			longContextPricing: {
				thresholdTokens: 272_000,
				inputPriceMultiplier: 2,
				outputPriceMultiplier: 1.5,
				cacheWritesPriceMultiplier: 2,
				cacheReadsPriceMultiplier: 2,
				appliesToServiceTiers: ["default", "flex", "priority"],
			},
		})

		expect(openAiNativeModels["gpt-6-astra"].tiers).toEqual([
			{
				name: "flex",
				contextWindow: 1_050_000,
				inputPrice: 5,
				outputPrice: 25,
				cacheWritesPrice: 6.25,
				cacheReadsPrice: 0.5,
			},
			{
				name: "priority",
				contextWindow: 1_050_000,
				inputPrice: 20,
				outputPrice: 100,
				cacheWritesPrice: 25,
				cacheReadsPrice: 2,
			},
		])
	})

	it("describes GPT-6 Sol and Luna with verified pricing and context metadata", () => {
		expect(openAiNativeModels["gpt-6-sol"]).toEqual({
			maxTokens: 128_000,
			contextWindow: 1_050_000,
			includedTools: ["apply_patch"],
			excludedTools: ["apply_diff", "write_to_file"],
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
			reasoningEffort: "medium",
			inputPrice: 2,
			outputPrice: 10,
			cacheWritesPrice: 2.5,
			cacheReadsPrice: 0.2,
			longContextPricing: {
				thresholdTokens: 272_000,
				inputPriceMultiplier: 2,
				outputPriceMultiplier: 1.5,
				cacheWritesPriceMultiplier: 2,
				cacheReadsPriceMultiplier: 2,
				appliesToServiceTiers: ["default", "flex", "priority"],
			},
			supportsVerbosity: true,
			supportsTemperature: false,
			tiers: [
				{
					name: "flex",
					contextWindow: 1_050_000,
					inputPrice: 1,
					outputPrice: 5,
					cacheWritesPrice: 1.25,
					cacheReadsPrice: 0.1,
				},
				{
					name: "priority",
					contextWindow: 1_050_000,
					inputPrice: 4,
					outputPrice: 20,
					cacheWritesPrice: 5,
					cacheReadsPrice: 0.4,
				},
			],
			description: "GPT-6 Sol: OpenAI's cost-efficient frontier model for complex coding and agentic workflows",
		})

		expect(openAiNativeModels["gpt-6-luna"]).toEqual({
			maxTokens: 128_000,
			contextWindow: 1_050_000,
			includedTools: ["apply_patch"],
			excludedTools: ["apply_diff", "write_to_file"],
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
			reasoningEffort: "medium",
			inputPrice: 0.1,
			outputPrice: 0.5,
			cacheWritesPrice: 0.125,
			cacheReadsPrice: 0.01,
			longContextPricing: {
				thresholdTokens: 272_000,
				inputPriceMultiplier: 2,
				outputPriceMultiplier: 1.5,
				cacheWritesPriceMultiplier: 2,
				cacheReadsPriceMultiplier: 2,
				appliesToServiceTiers: ["default", "flex", "priority"],
			},
			supportsVerbosity: true,
			supportsTemperature: false,
			tiers: [
				{
					name: "flex",
					contextWindow: 1_050_000,
					inputPrice: 0.05,
					outputPrice: 0.25,
					cacheWritesPrice: 0.0625,
					cacheReadsPrice: 0.005,
				},
				{
					name: "priority",
					contextWindow: 1_050_000,
					inputPrice: 0.2,
					outputPrice: 1,
					cacheWritesPrice: 0.25,
					cacheReadsPrice: 0.02,
				},
			],
			description: "GPT-6 Luna: The fastest, most affordable member of the GPT-6 family",
		})
	})

	it("uses current GPT-5.6 base pricing and context metadata", () => {
		expect(openAiNativeModels["gpt-5.6-sol"]).toMatchObject({
			contextWindow: 1_050_000,
			inputPrice: 4,
			cacheWritesPrice: 5,
			cacheReadsPrice: 0.4,
			outputPrice: 20,
		})
		expect(openAiNativeModels["gpt-5.6-terra"]).toMatchObject({
			contextWindow: 1_050_000,
			inputPrice: 2,
			cacheWritesPrice: 2.5,
			cacheReadsPrice: 0.2,
			outputPrice: 12,
		})
		expect(openAiNativeModels["gpt-5.6-luna"]).toMatchObject({
			contextWindow: 1_050_000,
			inputPrice: 0.2,
			cacheWritesPrice: 0.25,
			cacheReadsPrice: 0.02,
			outputPrice: 1.2,
		})
	})
})

describe("OpenAI Codex models", () => {
	it("describes GPT-6 Sol and Luna subscription contracts", () => {
		expect(openAiCodexModels["gpt-6-sol"]).toEqual({
			maxTokens: 128_000,
			contextWindow: 372_000,
			includedTools: ["apply_patch"],
			excludedTools: ["apply_diff", "write_to_file"],
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
			reasoningEffort: "medium",
			inputPrice: 0,
			outputPrice: 0,
			supportsVerbosity: true,
			supportsTemperature: false,
			description:
				"GPT-6 Sol: OpenAI's cost-efficient frontier model for complex coding and agentic workflows via ChatGPT subscription",
		})

		expect(openAiCodexModels["gpt-6-luna"]).toEqual({
			maxTokens: 128_000,
			contextWindow: 372_000,
			includedTools: ["apply_patch"],
			excludedTools: ["apply_diff", "write_to_file"],
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
			reasoningEffort: "medium",
			inputPrice: 0,
			outputPrice: 0,
			supportsVerbosity: true,
			supportsTemperature: false,
			description: "GPT-6 Luna: The fastest, most affordable member of the GPT-6 family via ChatGPT subscription",
		})
	})
})
