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
