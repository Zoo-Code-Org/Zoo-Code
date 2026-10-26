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
	it.each([
		["claude-opus-5", "Claude Opus 5", 935793, 197897],
		["claude-sonnet-5", "Claude Sonnet 5", 925449, 925449],
		["gpt-5.6-luna", "GPT-5.6 Luna", 199753, 199753],
		["gpt-5.6-sol", "GPT-5.6 Sol", 271785, 271785],
		["gpt-5.6-terra", "GPT-5.6 Terra", 271785, 271785],
		["gemini-3.6-flash", "Gemini 3.6 Flash", 935793, 197897],
	] as const)("preserves PR #13 row %s (%s) with PR #14 ceilings", (family, name, contextWindow, maxInputTokens) => {
		expect(vscodeLlmModels[family]).toEqual({
			contextWindow,
			supportsImages: true,
			supportsPromptCache: false,
			inputPrice: 0,
			outputPrice: 0,
			family,
			version: family,
			name,
			supportsToolCalling: true,
			maxInputTokens,
		})
	})

	it.each([
		["claude-opus-5", "claude-opus-4.8"],
		["claude-sonnet-5", "claude-sonnet-4.6"],
		["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"],
		["gemini-3.6-flash", "gemini-3.1-pro-preview"],
	])("preserves upstream ordering starting with %s", (...families) => {
		const modelIds = Object.keys(vscodeLlmModels)
		const startIndex = modelIds.indexOf(families[0])
		expect(startIndex).toBeGreaterThanOrEqual(0)
		expect(modelIds.slice(startIndex, startIndex + families.length)).toEqual(families)
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
		expect(vscodeLlmModels).not.toHaveProperty("auto")
		expect(vscodeLlmModels).not.toHaveProperty("copilot-utility")
		expect(vscodeLlmModels).not.toHaveProperty("copilot-utility-small")
	})
	it("defaults to a model id that exists in the table", () => {
		expect(vscodeLlmDefaultModelId).toBe("claude-sonnet-4.5")
		expect(vscodeLlmModels).toHaveProperty(vscodeLlmDefaultModelId)
	})
})
