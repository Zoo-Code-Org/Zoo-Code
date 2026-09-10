import { basetenModels, deepSeekModels, fireworksModels, opencodeGoModels } from "../providers/index.js"

describe("DeepSeek V4 Pro 0813 provider catalogs", () => {
	it.each([
		["DeepSeek", deepSeekModels["deepseek-v4-pro"]],
		["OpenCode Go", opencodeGoModels["deepseek-v4-pro"]],
	])("labels the first-party API checkpoint through %s", (_provider, model) => {
		expect(model).toBeDefined()
		expect(model?.displayName).toBe("DeepSeek V4 Pro 0813")
		expect(model?.contextWindow).toBeGreaterThanOrEqual(1_000_000)
	})

	it("uses peak first-party pricing and unchanged OpenCode Go pricing", () => {
		expect(deepSeekModels["deepseek-v4-flash"]).toMatchObject({
			supportsImages: false,
			outputPrice: 1.32,
			cacheWritesPrice: 0.44,
			cacheReadsPrice: 0.014,
		})
		expect(deepSeekModels["deepseek-v4-pro"].supportsImages).toBe(false)
		expect(deepSeekModels["deepseek-v4-pro"]).toMatchObject({
			outputPrice: 3.96,
			cacheWritesPrice: 1.32,
			cacheReadsPrice: 0.044,
		})
		expect(opencodeGoModels["deepseek-v4-pro"]).toMatchObject({
			inputPrice: 0.435,
			outputPrice: 0.87,
			cacheReadsPrice: 0.003625,
		})
		expect(opencodeGoModels["deepseek-v4-flash"]).toMatchObject({
			inputPrice: 0.14,
			outputPrice: 0.28,
			cacheReadsPrice: 0.0028,
		})
	})

	it("marks deepseek-v4-flash-vision-exp as a vision-capable model", () => {
		const model = deepSeekModels["deepseek-v4-flash-vision-exp"]
		expect(model).toBeDefined()
		expect(model.supportsImages).toBe(true)
		expect(model.supportsPromptCache).toBe(true)
		expect(model.contextWindow).toBeGreaterThanOrEqual(1_000_000)
		expect(model.supportsReasoningEffort).toEqual(["disable", "low", "high", "max"])
	})

	// Self-hosted providers retain separate IDs for the preview weights and 0813 checkpoint.
	it.each([
		["Fireworks AI", fireworksModels["accounts/fireworks/models/deepseek-v4-pro"]],
		["Baseten", basetenModels["deepseek-ai/DeepSeek-V4-Pro"]],
	])("does not apply the API checkpoint label to %s", (_provider, model) => {
		expect(model).toBeDefined()
		expect("displayName" in model && typeof model.displayName === "string" ? model.displayName : "").not.toContain(
			"0813",
		)
		expect(model?.contextWindow).toBeGreaterThanOrEqual(1_000_000)
	})

	it.each([
		[
			"Fireworks AI",
			fireworksModels["accounts/fireworks/models/deepseek-v4-pro-0813"],
			{ inputPrice: 1.32, outputPrice: 3.96, cacheReadsPrice: 0.044 },
		],
		[
			"Baseten",
			basetenModels["deepseek-ai/DeepSeek-V4-Pro-0813"],
			{ inputPrice: 1.32, outputPrice: 3.96, cacheReadsPrice: 0.132 },
		],
	])("publishes the dated checkpoint and provider-specific pricing for %s", (_provider, model, pricing) => {
		expect(model).toMatchObject({
			displayName: "DeepSeek V4 Pro 0813",
			...pricing,
		})
	})

	it("keeps preview pricing separate and omits unverified cache-write prices", () => {
		expect(fireworksModels["accounts/fireworks/models/deepseek-v4-pro"]).toMatchObject({
			inputPrice: 1.74,
			outputPrice: 3.48,
			cacheReadsPrice: 0.145,
		})
		expect(basetenModels["deepseek-ai/DeepSeek-V4-Pro"]).toMatchObject({
			inputPrice: 1.74,
			outputPrice: 3.48,
			cacheReadsPrice: 0.145,
		})
		expect(basetenModels["deepseek-ai/DeepSeek-V4-Pro"]).not.toHaveProperty("cacheWritesPrice")
		expect(basetenModels["deepseek-ai/DeepSeek-V4-Pro-0813"]).not.toHaveProperty("cacheWritesPrice")
	})
})
