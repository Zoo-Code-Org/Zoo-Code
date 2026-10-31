import type { ModelInfo } from "../model.js"
import { mistralModels } from "../providers/mistral.js"

const modelEntries: [string, ModelInfo][] = Object.entries(mistralModels)

describe("mistral registry cache pricing", () => {
	it("covers all nine catalog entries", () => {
		expect(modelEntries).toHaveLength(9)
	})

	it.each(modelEntries)("%s bills cache reads at 10%% of its input price", (id, info) => {
		expect(id).toBeTruthy()
		expect(info.inputPrice).toBeGreaterThan(0)
		expect(info.cacheReadsPrice).toBeDefined()
		// Mistral bills cached prompt tokens at 10% of the standard input price.
		expect(info.cacheReadsPrice).toBeCloseTo((info.inputPrice as number) * 0.1, 10)
	})

	it.each(modelEntries)("%s keeps the request-side cache marker off", (id, info) => {
		// Mistral takes no cache_control markers in the request body, so the flag
		// that gates marker insertion stays false even though reads are reported.
		expect(id).toBeTruthy()
		expect(info.supportsPromptCache).toBe(false)
	})
})
