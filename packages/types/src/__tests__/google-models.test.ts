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
