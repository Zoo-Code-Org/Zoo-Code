import {
	opencodeGoDefaultModelId,
	opencodeGoDefaultModelInfo,
	opencodeGoModels,
	OPENCODE_GO_DEFAULT_TEMPERATURE,
	OPENCODE_GO_ANTHROPIC_FORMAT_MODELS,
	OPENCODE_GO_RESPONSES_FORMAT_MODELS,
	isOpencodeGoAnthropicFormatModel,
	isOpencodeGoResponsesFormatModel,
	getOpencodeGoModelInfo,
} from "../providers/opencode-go.js"

describe("opencode-go registry", () => {
	const anthropicFormatModels = [
		"qwen3.8-max",
		"qwen3.8-flash",
		"qwen3.7-max",
		"qwen3.7-plus",
		"qwen3.6-plus",
		"minimax-m3",
		"minimax-m2.7",
		"minimax-m2.5",
	]
	const openaiFormatModels = [
		"glm-5",
		"glm-5.1",
		"glm-5.2",
		"glm-5.3",
		"kimi-k3",
		"kimi-k2.5",
		"kimi-k2.6",
		"mimo-v2.5",
		"mimo-v2.5-pro",
		"deepseek-v4-pro",
		"deepseek-v4-flash",
	]
	const responsesFormatModels = [
		"gpt-5.6-luna",
		"grok-4.5",
		"grok-4.6",
		"muse-spark-1.3-contributor",
		"muse-spark-1.2-contributor",
	]

	describe("isOpencodeGoAnthropicFormatModel", () => {
		it("classifies Qwen and MiniMax models as Anthropic-format", () => {
			for (const id of anthropicFormatModels) {
				expect(isOpencodeGoAnthropicFormatModel(id)).toBe(true)
			}
		})

		it("classifies GLM/Kimi/MiMo/DeepSeek models as OpenAI-compatible", () => {
			for (const id of openaiFormatModels) {
				expect(isOpencodeGoAnthropicFormatModel(id)).toBe(false)
			}
		})

		it("defaults unknown model IDs to the OpenAI-compatible format", () => {
			expect(isOpencodeGoAnthropicFormatModel("some-future-model")).toBe(false)
			expect(isOpencodeGoAnthropicFormatModel("")).toBe(false)
		})
	})

	describe("getOpencodeGoModelInfo", () => {
		it("returns the native ModelInfo for a curated model", () => {
			const info = getOpencodeGoModelInfo("qwen3.7-max")
			expect(info).toBeDefined()
			expect(info?.maxTokens).toBe(65_536)
			expect(info?.contextWindow).toBe(1_000_000)
			expect(info?.supportsPromptCache).toBe(true)
		})

		it("returns undefined for an unknown model ID", () => {
			expect(getOpencodeGoModelInfo("not-a-real-go-model")).toBeUndefined()
		})

		it("kimi-k3 exposes always-on reasoning with effort allow-list and reasoning preservation", () => {
			const info = getOpencodeGoModelInfo("kimi-k3")
			expect(info).toBeDefined()
			expect(info?.maxTokens).toBe(131_072)
			expect(info?.contextWindow).toBe(1_048_576)
			expect(info?.supportsReasoningEffort).toEqual(["low", "high", "max"])
			expect(info?.reasoningEffort).toBe("max")
			expect(info?.preserveReasoning).toBe(true)
			expect(info?.defaultTemperature).toBe(1.0)
			expect(info?.supportsPromptCache).toBe(true)
			expect(info?.supportsMaxTokens).toBe(true)
			expect(info?.supportsImages).toBe(false)
			expect(info?.inputPrice).toBe(3.0)
			expect(info?.outputPrice).toBe(15.0)
			expect(info?.cacheReadsPrice).toBe(0.3)
		})

		it("exposes current Qwen3.8 Max capabilities and Go pricing", () => {
			const info = getOpencodeGoModelInfo("qwen3.8-max")
			expect(info).toMatchObject({
				maxTokens: 131_072,
				contextWindow: 1_000_000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsMaxTokens: true,
				inputPrice: 2.0,
				outputPrice: 6.0,
				cacheReadsPrice: 0.25,
				cacheWritesPrice: 2.5,
			})
			expect(info?.preserveReasoning).toBeUndefined()
		})

		it("glm-5.3 exposes its native context, pricing, and always-on reasoning levels", () => {
			const info = getOpencodeGoModelInfo("glm-5.3")
			expect(info).toBeDefined()
			expect(info?.maxTokens).toBe(131_072)
			expect(info?.contextWindow).toBe(1_000_000)
			expect(info?.supportsImages).toBe(false)
			expect(info?.supportsPromptCache).toBe(true)
			expect(info?.supportsMaxTokens).toBe(true)
			expect(info?.supportsReasoningEffort).toEqual(["low", "high", "max"])
			expect(info?.reasoningEffort).toBe("max")
			expect(info?.preserveReasoning).toBe(true)
			expect(info?.inputPrice).toBe(1.4)
			expect(info?.outputPrice).toBe(4.4)
			expect(info?.cacheReadsPrice).toBe(0.26)
		})
	})

	describe("OPENCODE_GO_ANTHROPIC_FORMAT_MODELS", () => {
		it("contains exactly the Qwen and MiniMax models", () => {
			expect([...OPENCODE_GO_ANTHROPIC_FORMAT_MODELS].sort()).toEqual([...anthropicFormatModels].sort())
		})

		// The PR description calls out that the format-routing set must stay in
		// sync with the Go model table — every routed model must have a native
		// registry entry so capability flags and pricing resolve correctly.
		it("every Anthropic-format model has a native registry entry", () => {
			for (const id of OPENCODE_GO_ANTHROPIC_FORMAT_MODELS) {
				expect(opencodeGoModels[id]).toBeDefined()
			}
		})
	})

	describe("OPENCODE_GO_RESPONSES_FORMAT_MODELS", () => {
		it("contains exactly the Responses-only models", () => {
			expect([...OPENCODE_GO_RESPONSES_FORMAT_MODELS].sort()).toEqual([...responsesFormatModels].sort())
		})

		it("classifies every Responses-only model as Responses-format", () => {
			for (const id of responsesFormatModels) {
				expect(isOpencodeGoResponsesFormatModel(id)).toBe(true)
			}
		})

		it("classifies Anthropic-format and OpenAI-compatible models as non-Responses-format", () => {
			for (const id of anthropicFormatModels) {
				expect(isOpencodeGoResponsesFormatModel(id)).toBe(false)
			}
			for (const id of openaiFormatModels) {
				expect(isOpencodeGoResponsesFormatModel(id)).toBe(false)
			}
		})

		it("defaults unknown model IDs to the OpenAI-compatible format", () => {
			expect(isOpencodeGoResponsesFormatModel("some-future-model")).toBe(false)
			expect(isOpencodeGoResponsesFormatModel("")).toBe(false)
		})

		it("curates gpt-5.6-luna with its Go Responses capabilities", () => {
			expect(getOpencodeGoModelInfo("gpt-5.6-luna")).toMatchObject({
				supportsMaxTokens: true,
				maxTokens: 128_000,
				contextWindow: 1_050_000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
				reasoningEffort: "medium",
				inputPrice: 0.2,
				outputPrice: 1.2,
				cacheWritesPrice: 0.25,
				cacheReadsPrice: 0.02,
				longContextPricing: {
					thresholdTokens: 272_000,
					inputPriceMultiplier: 2,
					outputPriceMultiplier: 1.5,
					cacheWritesPriceMultiplier: 2,
					cacheReadsPriceMultiplier: 2,
				},
			})
		})

		it("is disjoint from the Anthropic-format set", () => {
			for (const id of OPENCODE_GO_RESPONSES_FORMAT_MODELS) {
				expect(OPENCODE_GO_ANTHROPIC_FORMAT_MODELS.has(id)).toBe(false)
			}
		})
	})

	describe("opencodeGoModels registry invariants", () => {
		it.each([
			{
				id: "glm-5.3-flash",
				expected: {
					maxTokens: 131_072,
					contextWindow: 1_000_000,
					supportsImages: true,
					supportsPromptCache: true,
					supportsMaxTokens: true,
					supportsReasoningEffort: ["low", "high", "max"],
					inputPrice: 0.075,
					outputPrice: 0.25,
					cacheReadsPrice: 0.015,
				},
			},
			{
				id: "kimi-k2.7-code",
				expected: {
					maxTokens: 262_144,
					contextWindow: 262_144,
					supportsImages: true,
					supportsPromptCache: true,
					supportsMaxTokens: true,
					inputPrice: 0.95,
					outputPrice: 4,
					cacheReadsPrice: 0.19,
				},
			},
			{
				id: "longcat-2.0",
				expected: {
					maxTokens: 131_072,
					contextWindow: 1_000_000,
					supportsImages: false,
					supportsReasoningBinary: true,
					inputPrice: 0.3,
					outputPrice: 1.2,
					cacheReadsPrice: 0.006,
				},
			},
			{
				id: "mimo-v2-pro",
				expected: {
					maxTokens: 128_000,
					contextWindow: 1_048_576,
					supportsImages: false,
					supportsPromptCache: false,
					inputPrice: 1,
					outputPrice: 3,
					cacheReadsPrice: 0.2,
					longContextPricing: {
						thresholdTokens: 256_000,
						inputPriceMultiplier: 2,
						outputPriceMultiplier: 2,
						cacheReadsPriceMultiplier: 2,
					},
				},
			},
			{
				id: "mimo-v2-omni",
				expected: {
					maxTokens: 128_000,
					contextWindow: 262_144,
					supportsImages: true,
					supportsPromptCache: false,
					inputPrice: 0.4,
					outputPrice: 2,
					cacheReadsPrice: 0.08,
				},
			},
			{
				id: "qwen3.5-plus",
				expected: {
					maxTokens: 65_536,
					contextWindow: 262_144,
					supportsImages: true,
					supportsReasoningBudget: true,
					supportsReasoningBinary: true,
					inputPrice: 0.2,
					outputPrice: 1.2,
					cacheReadsPrice: 0.02,
					cacheWritesPrice: 0.25,
				},
			},
			{
				id: "qwen3.8-flash",
				expected: {
					maxTokens: 131_072,
					contextWindow: 1_000_000,
					supportsImages: true,
					supportsMaxTokens: true,
					supportsReasoningBudget: true,
					supportsReasoningBinary: true,
					inputPrice: 0.15,
					outputPrice: 0.47,
					cacheReadsPrice: 0.016,
					cacheWritesPrice: 0.2,
				},
			},
			{
				id: "deepseek-v4-flash-vision-exp",
				expected: {
					maxTokens: 384_000,
					contextWindow: 1_000_000,
					supportsImages: true,
					supportsReasoningEffort: ["disable", "low", "high", "max"],
					inputPrice: 0.22,
					outputPrice: 0.66,
					cacheReadsPrice: 0.007,
				},
			},
			{
				id: "hy4-preview",
				expected: {
					maxTokens: 64_000,
					contextWindow: 1_024_000,
					supportsImages: false,
					supportsReasoningEffort: ["disable", "high"],
					inputPrice: 0.834,
					outputPrice: 2.501,
					cacheReadsPrice: 0.042,
				},
			},
			...(["hy3", "hy3-preview"] as const).map((id) => ({
				id,
				expected: {
					maxTokens: 64_000,
					contextWindow: 256_000,
					supportsImages: false,
					supportsReasoningEffort: ["disable", "low", "high"],
					inputPrice: 0.0175,
					outputPrice: 0.0725,
					cacheReadsPrice: 0.004375,
				},
			})),
			{
				id: "grok-4.5",
				expected: {
					maxTokens: 500_000,
					contextWindow: 500_000,
					supportsImages: true,
					supportsReasoningEffort: ["low", "medium", "high"],
					inputPrice: 2,
					outputPrice: 6,
					cacheReadsPrice: 0.3,
					longContextPricing: {
						thresholdTokens: 200_000,
						inputPriceMultiplier: 2,
						outputPriceMultiplier: 2,
						cacheReadsPriceMultiplier: 2,
					},
				},
			},
			{
				id: "grok-4.6",
				expected: {
					maxTokens: 500_000,
					contextWindow: 500_000,
					supportsImages: true,
					supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
					inputPrice: 2,
					outputPrice: 6,
					cacheReadsPrice: 0.5,
					longContextPricing: {
						thresholdTokens: 200_000,
						inputPriceMultiplier: 2,
						outputPriceMultiplier: 2,
						cacheReadsPriceMultiplier: 2,
					},
				},
			},
			...(["muse-spark-1.3-contributor", "muse-spark-1.2-contributor"] as const).map((id) => ({
				id,
				expected: {
					maxTokens: 131_072,
					contextWindow: 1_048_576,
					supportsImages: true,
					supportsPromptCache: true,
					supportsMaxTokens: true,
					supportsReasoningEffort: ["minimal", "low", "medium", "high", "xhigh"],
					inputPrice: 0.1,
					outputPrice: 0.2,
					cacheReadsPrice: 0.002,
				},
			})),
		])("keeps independently asserted metadata for $id", ({ id, expected }) => {
			expect(getOpencodeGoModelInfo(id)).toMatchObject(expected)
		})

		it("every entry has a positive maxTokens and contextWindow", () => {
			for (const [id, info] of Object.entries(opencodeGoModels)) {
				expect(info.maxTokens).toBeGreaterThan(0)
				expect(info.contextWindow).toBeGreaterThan(0)
				// Sanity: max output must not exceed the context window.
				expect(info.maxTokens).toBeLessThanOrEqual(info.contextWindow)
				void id
			}
		})

		it("every entry declares supportsImages", () => {
			for (const info of Object.values(opencodeGoModels)) {
				expect(typeof info.supportsImages).toBe("boolean")
			}
		})

		it("models with an array supportsReasoningEffort expose a non-empty allow-list", () => {
			for (const info of Object.values(opencodeGoModels)) {
				if (Array.isArray(info.supportsReasoningEffort)) {
					expect(info.supportsReasoningEffort.length).toBeGreaterThan(0)
				}
			}
		})

		it("every Anthropic-format model with prompt-cache injection declares a cacheWritesPrice", () => {
			// MiniMax/Qwen route through /v1/messages with client-side
			// cache_control breakpoints, so cache_creation_input_tokens are
			// reported and billed — each must carry a cacheWritesPrice or the
			// write cost is silently reported as $0.
			for (const id of OPENCODE_GO_ANTHROPIC_FORMAT_MODELS) {
				const info = getOpencodeGoModelInfo(id)
				expect(info).toBeDefined()
				if (info?.supportsPromptCache) {
					expect(info.cacheWritesPrice).toBeDefined()
					expect(info.cacheReadsPrice).toBeDefined()
				}
			}
		})

		it("DeepSeek entries expose supportsMaxTokens so the max-output slider is available", () => {
			expect(getOpencodeGoModelInfo("deepseek-v4-pro")?.supportsMaxTokens).toBe(true)
			expect(getOpencodeGoModelInfo("deepseek-v4-flash")?.supportsMaxTokens).toBe(true)
		})
	})

	describe("defaults", () => {
		it("the default model id is a curated OpenAI-compatible model", () => {
			expect(opencodeGoDefaultModelId).toBe("glm-5.2")
			expect(opencodeGoModels[opencodeGoDefaultModelId]).toBeDefined()
			expect(isOpencodeGoAnthropicFormatModel(opencodeGoDefaultModelId)).toBe(false)
		})

		it("exposes a fully-populated default ModelInfo fallback", () => {
			expect(opencodeGoDefaultModelInfo.maxTokens).toBeGreaterThan(0)
			expect(opencodeGoDefaultModelInfo.contextWindow).toBeGreaterThan(0)
			expect(opencodeGoDefaultModelInfo.supportsPromptCache).toBe(false)
			expect(opencodeGoDefaultModelInfo.description).toBeTruthy()
		})

		it("exposes a deterministic default temperature", () => {
			expect(OPENCODE_GO_DEFAULT_TEMPERATURE).toBe(0)
		})
	})
})
