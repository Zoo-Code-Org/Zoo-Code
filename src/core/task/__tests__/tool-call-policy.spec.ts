import { describe, it, expect } from "vitest"
import { resolveToolCallPolicy } from "../../../api"
import type { ModelInfo } from "@roo-code/types"
import { mimoModels } from "@roo-code/types"

describe("resolveToolCallPolicy", () => {
	// Helper: create a minimal ModelInfo with only the fields needed for testing.
	function makeModelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
		return {
			contextWindow: 200_000,
			supportsPromptCache: false,
			...overrides,
		}
	}

	describe("MiMo models", () => {
		it("resolves mimo-v2.5-pro to single generation with maxCallsPerTurn=1", () => {
			const modelInfo = mimoModels["mimo-v2.5-pro"] as ModelInfo
			const policy = resolveToolCallPolicy(modelInfo, "mimo")

			expect(policy.generation).toBe("single")
			expect(policy.maxCallsPerTurn).toBe(1)
			expect(policy.source).toBe("model-capability")
		})

		it("resolves mimo-v2.5 to single generation with maxCallsPerTurn=1", () => {
			const modelInfo = mimoModels["mimo-v2.5"] as ModelInfo
			const policy = resolveToolCallPolicy(modelInfo, "mimo")

			expect(policy.generation).toBe("single")
			expect(policy.maxCallsPerTurn).toBe(1)
			expect(policy.source).toBe("model-capability")
		})

		it("uses local enforcement when request control is 'none'", () => {
			const modelInfo = mimoModels["mimo-v2.5-pro"] as ModelInfo
			const policy = resolveToolCallPolicy(modelInfo, "mimo")

			expect(policy.enforcement).toBe("local")
		})
	})

	describe("OpenAI-capable models", () => {
		it("resolves to parallel generation with unbounded maxCallsPerTurn", () => {
			const modelInfo = makeModelInfo({
				toolCallCapabilities: {
					supportsParallelToolCalls: true,
					parallelToolCallsRequestControl: "openai",
				},
			})
			const policy = resolveToolCallPolicy(modelInfo, "openai")

			expect(policy.generation).toBe("parallel")
			expect(policy.maxCallsPerTurn).toBe("unbounded")
			expect(policy.enforcement).toBe("provider")
			expect(policy.source).toBe("model-capability")
		})
	})

	describe("Anthropic-capable models", () => {
		it("resolves to parallel generation with provider enforcement", () => {
			const modelInfo = makeModelInfo({
				toolCallCapabilities: {
					supportsParallelToolCalls: true,
					parallelToolCallsRequestControl: "anthropic",
				},
			})
			const policy = resolveToolCallPolicy(modelInfo, "anthropic")

			expect(policy.generation).toBe("parallel")
			expect(policy.maxCallsPerTurn).toBe("unbounded")
			expect(policy.enforcement).toBe("provider")
			expect(policy.source).toBe("model-capability")
		})
	})

	describe("Unknown models (no toolCallCapabilities)", () => {
		it("resolves to conservative single generation", () => {
			const modelInfo = makeModelInfo()
			const policy = resolveToolCallPolicy(modelInfo, "openai")

			expect(policy.generation).toBe("single")
			expect(policy.maxCallsPerTurn).toBe(1)
			expect(policy.enforcement).toBe("local")
			expect(policy.source).toBe("provider-default")
		})

		it("resolves to conservative single when capabilities are 'unknown'", () => {
			const modelInfo = makeModelInfo({
				toolCallCapabilities: {
					supportsParallelToolCalls: "unknown",
					parallelToolCallsRequestControl: "unknown",
				},
			})
			const policy = resolveToolCallPolicy(modelInfo, "openai")

			expect(policy.generation).toBe("single")
			expect(policy.maxCallsPerTurn).toBe(1)
			expect(policy.enforcement).toBe("local")
			expect(policy.source).toBe("provider-default")
		})
	})

	describe("Model with supportsParallelToolCalls=false but request control set", () => {
		it("uses provider-and-local enforcement when request control is 'openai'", () => {
			const modelInfo = makeModelInfo({
				toolCallCapabilities: {
					supportsParallelToolCalls: false,
					parallelToolCallsRequestControl: "openai",
				},
			})
			const policy = resolveToolCallPolicy(modelInfo, "openai")

			expect(policy.generation).toBe("single")
			expect(policy.maxCallsPerTurn).toBe(1)
			expect(policy.enforcement).toBe("provider-and-local")
			expect(policy.source).toBe("model-capability")
		})

		it("uses provider-and-local enforcement when request control is 'anthropic'", () => {
			const modelInfo = makeModelInfo({
				toolCallCapabilities: {
					supportsParallelToolCalls: false,
					parallelToolCallsRequestControl: "anthropic",
				},
			})
			const policy = resolveToolCallPolicy(modelInfo, "anthropic")

			expect(policy.generation).toBe("single")
			expect(policy.maxCallsPerTurn).toBe(1)
			expect(policy.enforcement).toBe("provider-and-local")
			expect(policy.source).toBe("model-capability")
		})
	})

	describe("Pure function properties", () => {
		it("returns the same result for the same input", () => {
			const modelInfo = mimoModels["mimo-v2.5-pro"] as ModelInfo
			const policy1 = resolveToolCallPolicy(modelInfo, "mimo")
			const policy2 = resolveToolCallPolicy(modelInfo, "mimo")

			expect(policy1).toEqual(policy2)
		})

		it("does not mutate the input modelInfo", () => {
			const modelInfo = makeModelInfo({
				toolCallCapabilities: {
					supportsParallelToolCalls: true,
					parallelToolCallsRequestControl: "openai",
				},
			})
			const original = JSON.parse(JSON.stringify(modelInfo))
			resolveToolCallPolicy(modelInfo, "openai")

			expect(JSON.parse(JSON.stringify(modelInfo))).toEqual(original)
		})
	})
})
