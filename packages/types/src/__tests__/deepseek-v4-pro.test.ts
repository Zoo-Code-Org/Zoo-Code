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

	it("uses first-party capabilities and OpenCode Go pricing", () => {
		expect(deepSeekModels["deepseek-v4-pro"].supportsImages).toBe(false)
		expect(opencodeGoModels["deepseek-v4-pro"]).toMatchObject({
			inputPrice: 0.435,
			outputPrice: 0.87,
			cacheReadsPrice: 0.003625,
		})
	})

	// Self-hosted providers serve the published preview weights, not the checkpoint behind DeepSeek's API alias.
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

	it("does not infer an unverified Baseten cache-write price", () => {
		expect(basetenModels["deepseek-ai/DeepSeek-V4-Pro"]).not.toHaveProperty("cacheWritesPrice")
	})
})
