import { describe, it, expect } from "vitest"
import { vscodeLlmModels, vscodeLlmDefaultModelId } from "../providers/vscode-llm.js"

describe("vscodeLlmModels", () => {
	it("exposes the opus-4.8 row with its measured maxInputTokens and contextWindow", () => {
		// claude-opus-4.8 intentionally diverges: maxInputTokens (197897) is the enforced ceiling the
		// UI reads, contextWindow (679560) the advertised window. Assert the on-disk literals as a tripwire.
		expect(vscodeLlmModels).toHaveProperty("claude-opus-4.8")
		expect(vscodeLlmModels["claude-opus-4.8"].contextWindow).toBe(679560)
		expect(vscodeLlmModels["claude-opus-4.8"].maxInputTokens).toBe(197897)
	})
	it("preserves the real window for models captured with a smaller maxInputTokens", () => {
		expect(vscodeLlmModels["gpt-4o-mini"].maxInputTokens).toBe(12078)
		expect(vscodeLlmModels["gpt-4o-mini"].contextWindow).toBe(12078)
		expect(vscodeLlmModels["gemini-2.5-pro"].contextWindow).toBe(108594)
		expect(vscodeLlmModels["gemini-2.5-pro"].maxInputTokens).toBe(108594)
	})
	it("keeps both window fields populated and positive for every row", () => {
		for (const [family, model] of Object.entries(vscodeLlmModels)) {
			expect(model.contextWindow, `${family}: contextWindow must be a positive integer`).toBeGreaterThan(0)
			expect(model.maxInputTokens, `${family}: maxInputTokens must be a positive integer`).toBeGreaterThan(0)
		}
	})
	it("excludes fabricated/internal/alias families and the dropped legacy rows", () => {
		expect(vscodeLlmModels).not.toHaveProperty("claude-opus-4.7-high")
		expect(vscodeLlmModels).not.toHaveProperty("claude-3.5-sonnet")
		expect(vscodeLlmModels).not.toHaveProperty("claude-4-sonnet")
	})
	it("defaults to a model id that exists in the table", () => {
		expect(vscodeLlmDefaultModelId).toBe("claude-sonnet-4.5")
		expect(vscodeLlmModels).toHaveProperty(vscodeLlmDefaultModelId)
	})
})
