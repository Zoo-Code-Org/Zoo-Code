import { basetenModels, deepSeekModels, fireworksModels, opencodeGoModels } from "../providers/index.js"

describe("DeepSeek V4 Pro 0813 provider catalogs", () => {
	it.each([
		["DeepSeek", deepSeekModels["deepseek-v4-pro"]],
		["Fireworks AI", fireworksModels["accounts/fireworks/models/deepseek-v4-pro"]],
		["OpenCode Go", opencodeGoModels["deepseek-v4-pro"]],
		["Baseten", basetenModels["deepseek-ai/DeepSeek-V4-Pro"]],
	])("exposes the release through %s", (_provider, model) => {
		expect(model).toBeDefined()
		expect(model?.displayName).toBe("DeepSeek V4 Pro 0813")
		expect(model?.contextWindow).toBeGreaterThanOrEqual(1_000_000)
	})
})
