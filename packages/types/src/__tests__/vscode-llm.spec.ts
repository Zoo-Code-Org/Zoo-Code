import { describe, it, expect } from "vitest"
import { vscodeLlmModels, vscodeLlmDefaultModelId } from "../providers/vscode-llm.js"

describe("vscodeLlmModels", () => {
	it("exposes the opus-4.8 row with its measured maxInputTokens and contextWindow", () => {
		// The two values differ for this row, so pin the exact stored values rather than forcing equality.
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
		["claude-opus-5.5", "Claude Opus 5.5", 871793, 677108],
		["claude-opus-5", "Claude Opus 5", 935793, 680456],
		["claude-sonnet-5", "Claude Sonnet 5", 925449, 925449],
		["gpt-5.6-luna", "GPT-5.6 Luna", 199753, 199753],
		["gpt-5.6-sol", "GPT-5.6 Sol", 271785, 271785],
		["gpt-5.6-terra", "GPT-5.6 Terra", 271785, 271785],
		["gemini-3.8-flash", "Gemini 3.8 Flash", 982833, 955113],
		["gemini-3.7-flash", "Gemini 3.7 Flash", 935793, 935783],
		["gemini-3.6-flash", "Gemini 3.6 Flash", 935793, 935785],
	] as const)("preserves measured row %s (%s)", (family, name, contextWindow, maxInputTokens) => {
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
		["grok-4.5", "Grok 4.5", 199783],
		["grok-4.6", "Grok 4.6", 199784],
	] as const)("keeps %s image input disabled pending evidence", (family, name, maxInputTokens) => {
		expect(vscodeLlmModels[family]).toEqual({
			contextWindow: 424794,
			supportsImages: false,
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

	it("records Astra's measured budget minus a 5K safety margin without unmeasured prices", () => {
		expect(vscodeLlmModels["gpt-6-astra"]).toEqual({
			contextWindow: 921793,
			supportsImages: true,
			supportsPromptCache: false,
			family: "gpt-6-astra",
			version: "gpt-6-astra",
			name: "GPT-6 Astra",
			supportsToolCalling: true,
			maxInputTokens: 266789,
		})
		expect(vscodeLlmModels["gpt-6-astra"]).not.toHaveProperty("inputPrice")
		expect(vscodeLlmModels["gpt-6-astra"]).not.toHaveProperty("outputPrice")
	})

	it.each([
		["claude-sonnet-5.5", "Claude Sonnet 5.5", 871793, 680552, true],
		["claude-haiku-5.5", "Claude Haiku 5.5", 871793, 99784, true],
		["grok-4.7", "Grok 4.7", 424794, 199751, false],
		["gemini-4-argon", "Gemini 4 Argon", 982833, 953064, true],
		["vscModelF", "MAI-Code-2-Flash (Preview)", 921790, 921736, true],
		["oswe-vscode-modelD", "MAI-Code-1.1-Flash", 127790, 127783, true],
		["gpt-6.1-sol", "GPT-6.1 Sol", 921793, 269903, true],
		["gpt-5.6-sol-fast", "GPT-5.6 Sol Fast (Internal only)", 921793, 269903, true],
		["gpt-6.1-terra", "GPT-6.1 Terra", 871793, 269123, true],
		["gpt-6-luna", "GPT-6 Luna", 871793, 269122, true],
		["gpt-6-sol", "GPT-6 Sol", 871793, 269122, true],
		["claude-fable-5.1", "Claude Fable 5.1", 935793, 660686, true],
		["claude-fable-5", "Claude Fable 5", 935793, 658785, true],
	] as const)(
		"records the October capture for %s without unmeasured prices",
		(family, name, contextWindow, maxInputTokens, supportsImages) => {
			expect(vscodeLlmModels[family]).toEqual({
				contextWindow,
				maxInputTokens,
				supportsImages,
				supportsPromptCache: false,
				family,
				version: family,
				name,
				supportsToolCalling: true,
			})
			expect(vscodeLlmModels[family]).not.toHaveProperty("inputPrice")
			expect(vscodeLlmModels[family]).not.toHaveProperty("outputPrice")
		},
	)

	it("assigns Fable 5.5 the requested Fable 5.1 values rather than claiming a measurement", () => {
		expect(vscodeLlmModels["claude-fable-5.5"]).toEqual({
			...vscodeLlmModels["claude-fable-5.1"],
			family: "claude-fable-5.5",
			version: "claude-fable-5.5",
			name: "Claude Fable 5.5",
		})
		expect(vscodeLlmModels["claude-fable-5.5"].contextWindow).toBe(935793)
		expect(vscodeLlmModels["claude-fable-5.5"].maxInputTokens).toBe(660686)
	})

	it.each([
		["claude-opus-5.5", "claude-opus-5", "claude-opus-4.8"],
		["gpt-6-astra", "gpt-5.6-luna"],
		["grok-4.6", "grok-4.5", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"],
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
