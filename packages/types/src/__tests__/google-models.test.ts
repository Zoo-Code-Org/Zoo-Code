import { geminiModels } from "../providers/gemini.js"
import { vertexModels } from "../providers/vertex.js"

describe.each([
	["Gemini API", geminiModels["gemini-3.7-flash"]],
	["Vertex AI", vertexModels["gemini-3.7-flash"]],
])("Gemini 3.7 Flash on %s", (_provider, model) => {
	it("exposes the supported thinking levels and introductory cache storage price", () => {
		expect(model.supportsReasoningEffort).toEqual(["low", "medium", "high"])
		expect(model.cacheWritesPrice).toBe(0.5)
	})
})

describe.each([
	["gemini-3.5-flash-lite", geminiModels["gemini-3.5-flash-lite"]],
	["gemini-3.1-flash-lite", geminiModels["gemini-3.1-flash-lite"]],
])("Gemini 3.x Flash Lite model %s", (_modelId, model) => {
	it("is registered with the documented limits and multimodal support", () => {
		expect(model.maxTokens).toBe(65_536)
		expect(model.contextWindow).toBe(1_048_576)
		expect(model.supportsImages).toBe(true)
		expect(model.supportsPromptCache).toBe(true)
		expect(model.supportsReasoningBudget).toBe(false)
	})
})

it("exposes the documented thinking levels and pricing for Gemini 3.5 Flash Lite", () => {
	const model = geminiModels["gemini-3.5-flash-lite"]
	expect(model.supportsReasoningEffort).toEqual(["minimal", "low", "medium", "high"])
	expect(model.inputPrice).toBe(0.3)
	expect(model.outputPrice).toBe(2.5)
	expect(model.cacheReadsPrice).toBe(0.03)
	expect(model.cacheWritesPrice).toBe(1.0)
})

it("exposes the documented thinking levels and pricing for Gemini 3.1 Flash Lite", () => {
	const model = geminiModels["gemini-3.1-flash-lite"]
	// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-lite
	// "choosing from minimal, low, medium, or high thinking levels"
	expect(model.supportsReasoningEffort).toEqual(["minimal", "low", "medium", "high"])
	expect(model.inputPrice).toBe(0.25)
	expect(model.outputPrice).toBe(1.5)
	expect(model.cacheReadsPrice).toBe(0.025)
	expect(model.cacheWritesPrice).toBe(1.0)
})
