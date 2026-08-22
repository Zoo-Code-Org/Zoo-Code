// npx vitest src/utils/__tests__/reasoning-effort.spec.ts

import { describe, expect, it } from "vitest"

import type { ModelInfo, ProviderSettings } from "@roo-code/types"

import { getReasoningEffortSelection, normalizeReasoningEffortOnModelChange } from "@src/utils/reasoning-effort"

// Capability arrays the fetcher advertises per model family (see
// src/api/providers/fetchers/ollama.ts getOllamaThinkingEfforts). gpt-oss
// ignores think: false and accepts only low/medium/high, so its array omits
// "disable" and "max" — unlike disable-capable thinking models (e.g. qwen3 →
// ["disable","low","medium","high","max"]).
const gptOssModel: ModelInfo = {
	contextWindow: 131072,
	supportsPromptCache: true,
	supportsReasoningEffort: ["low", "medium", "high"],
	reasoningEffort: "medium",
}

describe("normalizeReasoningEffortOnModelChange", () => {
	it("returns undefined when no stored value is set (fresh profile)", () => {
		const selection = getReasoningEffortSelection(undefined, gptOssModel)
		expect(normalizeReasoningEffortOnModelChange(selection)).toBeUndefined()
	})

	it("returns undefined when the stored value is still a valid option", () => {
		const apiConfiguration = { reasoningEffort: "medium" } as ProviderSettings
		const selection = getReasoningEffortSelection(apiConfiguration, gptOssModel)
		expect(normalizeReasoningEffortOnModelChange(selection)).toBeUndefined()
	})

	it("persists the clamped fallback when switching from a disable-capable model to gpt-oss with reasoningEffort: disable", () => {
		// Regression: the user saved "disable" on qwen3 (which honors think:
		// false), then switched to gpt-oss (which omits "disable" from its
		// capability array). getReasoningEffortSelection clamps the *displayed*
		// effort to the fallback (gpt-oss's first option "low", since gpt-oss is
		// not required-reasoning so the default is "disable" which is itself
		// invalid, falling through to availableOptions[0] = "low"), but without
		// normalization the *stored* value stays "disable" — so the native
		// request mapper would send think: false while the UI shows "Low". The
		// helper returns the clamped value to persist so the stored effort, the
		// displayed effort, and the request stay in sync.
		const apiConfiguration = { reasoningEffort: "disable" } as ProviderSettings
		const selection = getReasoningEffortSelection(apiConfiguration, gptOssModel)

		// Sanity: the display clamped away from "disable"...
		expect(selection.currentReasoningEffort).not.toBe("disable")
		// ...and the stored value is no longer valid for gpt-oss's array.
		expect(selection.storedReasoningEffort).toBe("disable")
		expect(gptOssModel.supportsReasoningEffort).not.toContain("disable")

		// The helper returns the clamped fallback ("low") to persist.
		expect(normalizeReasoningEffortOnModelChange(selection)).toBe(selection.currentReasoningEffort)
		expect(normalizeReasoningEffortOnModelChange(selection)).toBe("low")
	})

	it("clamps 'max' to the fallback when switching from a max-capable model to gpt-oss", () => {
		// Symmetric case: "max" is valid for qwen3 but not gpt-oss. Switching
		// models should normalize the stored "max" to gpt-oss's first option.
		const apiConfiguration = { reasoningEffort: "max" } as ProviderSettings
		const selection = getReasoningEffortSelection(apiConfiguration, gptOssModel)

		expect(normalizeReasoningEffortOnModelChange(selection)).toBe("low")
	})

	it("does not normalize when switching back to a model that still supports the stored value", () => {
		// "low" is valid for both qwen3 and gpt-oss, so switching between them
		// must not trigger a write.
		const apiConfiguration = { reasoningEffort: "low" } as ProviderSettings
		const selection = getReasoningEffortSelection(apiConfiguration, gptOssModel)
		expect(normalizeReasoningEffortOnModelChange(selection)).toBeUndefined()
	})
})
