import type { ModelInfo } from "../model.js"
import { bedrockModels } from "../providers/bedrock.js"
import { vertexModels } from "../providers/vertex.js"
import { anthropicModels } from "../providers/anthropic.js"

// The Bedrock and Vertex registries are hand-maintained, so entries are copy-pasted and the
// pre-adaptive-thinking `maxTokens: 8192` default silently drifts onto new Claude models.
const REFERENCE_MODEL_ID = "anthropic.claude-fable-5-1"
const VERTEX_REFERENCE_MODEL_ID = "claude-fable-5-1"
const ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS = 128_000

describe("bedrockModels adaptive-thinking output ceilings", () => {
	it("keeps the reference model at the documented 128K ceiling", () => {
		expect(bedrockModels[REFERENCE_MODEL_ID].maxTokens).toBe(ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS)
	})

	it.each([
		["anthropic.claude-opus-5", ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS],
		["anthropic.claude-sonnet-5", ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS],
		["anthropic.claude-fable-5", ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS],
		["anthropic.claude-fable-5-1", ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS],
		["anthropic.claude-opus-4-7", ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS],
		["anthropic.claude-opus-4-8", ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS],
	] as const)("declares maxTokens %s = %i", (modelId, expected) => {
		expect(bedrockModels[modelId].maxTokens).toBe(expected)
	})

	it("gives every adaptive-thinking model the same ceiling as the reference model", () => {
		// Widening to ModelInfo: the const literal's inferred type only carries
		// `supportsReasoningBinary` on the members that declare it.
		const entries = Object.entries(bedrockModels as Record<string, ModelInfo>)
		const adaptiveThinkingEntries = entries.filter(([, info]) => info.supportsReasoningBinary === true)

		// If the flag is ever renamed, an empty list must not pass silently.
		expect(adaptiveThinkingEntries.length).toBeGreaterThanOrEqual(4)

		for (const [modelId, info] of adaptiveThinkingEntries) {
			expect(info.maxTokens, `${modelId} must share the adaptive-thinking output ceiling`).toBe(
				ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS,
			)
		}
	})

	it.each([
		["anthropic.claude-opus-5", "claude-opus-5"],
		["anthropic.claude-sonnet-5", "claude-sonnet-5"],
		["anthropic.claude-fable-5", "claude-fable-5"],
		["anthropic.claude-fable-5-1", "claude-fable-5-1"],
		["anthropic.claude-opus-4-7", "claude-opus-4-7"],
		["anthropic.claude-opus-4-8", "claude-opus-4-8"],
	] as const)("matches the Anthropic direct-API ceiling for %s", (bedrockId, anthropicId) => {
		expect(bedrockModels[bedrockId].maxTokens).toBe(anthropicModels[anthropicId].maxTokens)
	})

	it.each([
		["anthropic.claude-opus-4-7"],
		["anthropic.claude-opus-4-8"],
		["anthropic.claude-opus-5"],
		["anthropic.claude-sonnet-5"],
		["anthropic.claude-fable-5"],
		["anthropic.claude-fable-5-1"],
	] as const)("marks %s as binary-reasoning", (modelId) => {
		expect(bedrockModels[modelId].supportsReasoningBinary).toBe(true)
	})

	it("lets the user override the output budget on every adaptive-thinking model", () => {
		const entries = Object.entries(bedrockModels as Record<string, ModelInfo>)
		const adaptiveThinkingEntries = entries.filter(([, info]) => info.supportsReasoningBinary === true)

		expect(adaptiveThinkingEntries.length).toBeGreaterThanOrEqual(4)

		for (const [modelId, info] of adaptiveThinkingEntries) {
			expect(info.supportsMaxTokens, `${modelId} must expose a configurable output budget`).toBe(true)
		}
	})
})

// Vertex is a second hand-maintained registry that drifts independently of Bedrock.
describe("vertexModels adaptive-thinking output ceilings", () => {
	it("keeps the reference model at the documented 128K ceiling", () => {
		expect(vertexModels[VERTEX_REFERENCE_MODEL_ID].maxTokens).toBe(ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS)
	})

	it.each([
		["claude-opus-5", ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS],
		["claude-sonnet-5", ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS],
		["claude-fable-5", ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS],
		["claude-fable-5-1", ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS],
		["claude-opus-4-7", ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS],
		["claude-opus-4-8", ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS],
	] as const)("declares maxTokens %s = %i", (modelId, expected) => {
		expect(vertexModels[modelId].maxTokens).toBe(expected)
	})

	it("gives every adaptive-thinking model the same ceiling as the reference model", () => {
		const entries = Object.entries(vertexModels as Record<string, ModelInfo>)
		const adaptiveThinkingEntries = entries.filter(([, info]) => info.supportsReasoningBinary === true)

		expect(adaptiveThinkingEntries.length).toBeGreaterThanOrEqual(4)

		for (const [modelId, info] of adaptiveThinkingEntries) {
			expect(info.maxTokens, `${modelId} must share the adaptive-thinking output ceiling`).toBe(
				ADAPTIVE_THINKING_MAX_OUTPUT_TOKENS,
			)
		}
	})

	it.each([
		["claude-opus-5"],
		["claude-sonnet-5"],
		["claude-fable-5"],
		["claude-fable-5-1"],
		["claude-opus-4-7"],
		["claude-opus-4-8"],
	] as const)("matches the Anthropic direct-API ceiling for %s", (modelId) => {
		expect(vertexModels[modelId].maxTokens).toBe(anthropicModels[modelId].maxTokens)
	})

	it("lets the user override the output budget on every adaptive-thinking model", () => {
		const entries = Object.entries(vertexModels as Record<string, ModelInfo>)
		const adaptiveThinkingEntries = entries.filter(([, info]) => info.supportsReasoningBinary === true)

		expect(adaptiveThinkingEntries.length).toBeGreaterThanOrEqual(4)

		for (const [modelId, info] of adaptiveThinkingEntries) {
			expect(info.supportsMaxTokens, `${modelId} must expose a configurable output budget`).toBe(true)
		}
	})
})
