import type { ModelInfo } from "../model.js"
import { MOONSHOT_DEFAULT_TEMPERATURE, moonshotDefaultModelId, moonshotModels } from "../providers/moonshot.js"

const modelEntries: [string, ModelInfo][] = Object.entries(moonshotModels)
const modelInfos: ModelInfo[] = Object.values(moonshotModels)

describe("moonshot registry", () => {
	describe("moonshotModels registry invariants", () => {
		it("every entry has a positive maxTokens and contextWindow", () => {
			for (const [id, info] of modelEntries) {
				expect(info.maxTokens).toBeGreaterThan(0)
				expect(info.contextWindow).toBeGreaterThan(0)
				// Sanity: max output must not exceed the context window.
				expect(info.maxTokens).toBeLessThanOrEqual(info.contextWindow)
				void id
			}
		})

		it("every entry declares supportsImages and supportsPromptCache", () => {
			for (const info of modelInfos) {
				expect(typeof info.supportsImages).toBe("boolean")
				expect(typeof info.supportsPromptCache).toBe("boolean")
			}
		})

		it("models with an array supportsReasoningEffort expose a non-empty allow-list", () => {
			for (const info of modelInfos) {
				if (Array.isArray(info.supportsReasoningEffort)) {
					expect(info.supportsReasoningEffort.length).toBeGreaterThan(0)
				}
			}
		})

		it("every entry declares a reasoningEffort that is covered by its allow-list", () => {
			for (const info of modelInfos) {
				if (Array.isArray(info.supportsReasoningEffort) && info.reasoningEffort !== undefined) {
					expect(info.supportsReasoningEffort).toContain(info.reasoningEffort)
				}
			}
		})
	})

	describe("kimi-k3", () => {
		it("exposes always-on reasoning with effort allow-list and reasoning preservation", () => {
			const info = moonshotModels["kimi-k3"]
			expect(info).toBeDefined()
			expect(info.maxTokens).toBe(131_072)
			expect(info.contextWindow).toBe(1_048_576)
			expect(info.supportsImages).toBe(true)
			expect(info.supportsPromptCache).toBe(true)
			expect(info.supportsReasoningEffort).toEqual(["low", "high", "max"])
			expect(info.reasoningEffort).toBe("max")
			expect(info.preserveReasoning).toBe(true)
			expect(info.defaultTemperature).toBe(1.0)
			expect(info.inputPrice).toBe(3.0)
			expect(info.outputPrice).toBe(15.0)
			expect(info.cacheWritesPrice).toBe(0)
			expect(info.cacheReadsPrice).toBe(0.3)
		})
	})

	describe("defaults", () => {
		it("the default model id is a curated registry entry", () => {
			expect(moonshotDefaultModelId).toBe("kimi-k2-0905-preview")
			expect(moonshotModels[moonshotDefaultModelId]).toBeDefined()
		})

		it("exposes a deterministic default temperature", () => {
			expect(MOONSHOT_DEFAULT_TEMPERATURE).toBe(0.6)
		})
	})
})
