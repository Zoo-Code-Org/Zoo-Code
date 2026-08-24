import type { ModelInfo, ProviderSettings } from "@roo-code/types"

import { withDeclaredReasoningEffort } from "../model-capabilities"

describe("withDeclaredReasoningEffort (F7)", () => {
	const baseModel: ModelInfo = {
		contextWindow: 128_000,
		maxTokens: 8_192,
		supportsPromptCache: false,
	}

	const declared: ProviderSettings["supportedReasoningEfforts"] = ["low", "high", "max"]

	it("fills in the declared levels when the model has no capability of its own", () => {
		const result = withDeclaredReasoningEffort(baseModel, { supportedReasoningEfforts: declared })
		expect(result.supportsReasoningEffort).toEqual(["low", "high", "max"])
		// Remaining model fields pass through unchanged.
		expect(result.contextWindow).toBe(128_000)
		expect(result.maxTokens).toBe(8_192)
	})

	it("never overrides a registry array capability (registry wins)", () => {
		const model: ModelInfo = {
			...baseModel,
			supportsReasoningEffort: ["disable", "low", "medium"],
		}
		const result = withDeclaredReasoningEffort(model, { supportedReasoningEfforts: declared })
		expect(result).toBe(model)
		expect(result.supportsReasoningEffort).toEqual(["disable", "low", "medium"])
	})

	it("never overrides a boolean registry capability", () => {
		for (const capability of [true, false] as const) {
			const model: ModelInfo = { ...baseModel, supportsReasoningEffort: capability }
			const result = withDeclaredReasoningEffort(model, { supportedReasoningEfforts: declared })
			expect(result).toBe(model)
			expect(result.supportsReasoningEffort).toBe(capability)
		}
	})

	it("returns the model unchanged when no declaration is present", () => {
		expect(withDeclaredReasoningEffort(baseModel, undefined)).toBe(baseModel)
		expect(withDeclaredReasoningEffort(baseModel, {})).toBe(baseModel)
	})

	it("returns the model unchanged when the declaration is empty", () => {
		expect(withDeclaredReasoningEffort(baseModel, { supportedReasoningEfforts: [] })).toBe(baseModel)
	})

	it("returns a fresh object with its own copy of the declared array (no shared mutation)", () => {
		const declaredLevels: string[] = ["low", "high", "max"]
		const result = withDeclaredReasoningEffort(baseModel, {
			supportedReasoningEfforts: declaredLevels as ProviderSettings["supportedReasoningEfforts"],
		})
		expect(result).not.toBe(baseModel)
		expect(baseModel.supportsReasoningEffort).toBeUndefined()
		const filled = result.supportsReasoningEffort as string[]
		expect(filled).not.toBe(declaredLevels)
		expect(filled).toEqual(["low", "high", "max"])
	})
})
