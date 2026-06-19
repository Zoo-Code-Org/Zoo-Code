import {
	opencodeGoDefaultModelId,
	opencodeGoDefaultModelInfo,
	opencodeGoModels,
	OPENCODE_GO_DEFAULT_TEMPERATURE,
	OPENCODE_GO_ANTHROPIC_FORMAT_MODELS,
	isOpencodeGoAnthropicFormatModel,
	getOpencodeGoModelInfo,
} from "../providers/opencode-go.js"

describe("opencode-go registry", () => {
	const anthropicFormatModels = [
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
		"kimi-k2.5",
		"kimi-k2.6",
		"mimo-v2.5",
		"mimo-v2.5-pro",
		"deepseek-v4-pro",
		"deepseek-v4-flash",
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

	describe("opencodeGoModels registry invariants", () => {
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
