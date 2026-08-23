import type { ModelInfo, ProviderSettings } from "@roo-code/types"

import { computeThinkingEffortDisplay, THINKING_EFFORT_ADAPTIVE_LEVEL } from "../thinkingEffort"

describe("computeThinkingEffortDisplay (DTE series 4/5)", () => {
	const modelWithLevels: ModelInfo = {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsPromptCache: true,
		supportsReasoningEffort: ["disable", "low", "medium", "high", "max"],
		reasoningEffort: "medium",
	}

	const modelAdaptive: ModelInfo = {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsPromptCache: false,
		supportsReasoningEffort: true,
	}

	const modelNone: ModelInfo = { contextWindow: 1_000_000, maxTokens: 128_000, supportsPromptCache: false }

	it("returns null when the dynamic-thinking-effort experiment is disabled", () => {
		expect(computeThinkingEffortDisplay({ experiments: {}, model: modelWithLevels })).toBeNull()
		expect(
			computeThinkingEffortDisplay({ experiments: { dynamicThinkingEffort: false }, model: modelWithLevels }),
		).toBeNull()
		expect(computeThinkingEffortDisplay({ experiments: undefined, model: modelWithLevels })).toBeNull()
	})

	it("returns null when the model does not advertise effort support", () => {
		expect(
			computeThinkingEffortDisplay({ experiments: { dynamicThinkingEffort: true }, model: modelNone }),
		).toBeNull()
		expect(
			computeThinkingEffortDisplay({ experiments: { dynamicThinkingEffort: true }, model: undefined }),
		).toBeNull()
	})

	it("returns null when the capability array only advertises the disable sentinel", () => {
		const disableOnly: ModelInfo = {
			contextWindow: 1,
			maxTokens: 1,
			supportsPromptCache: false,
			supportsReasoningEffort: ["disable"],
		}
		expect(
			computeThinkingEffortDisplay({ experiments: { dynamicThinkingEffort: true }, model: disableOnly }),
		).toBeNull()
	})

	it("excludes the disable sentinel from the supported levels", () => {
		const display = computeThinkingEffortDisplay({
			experiments: { dynamicThinkingEffort: true },
			model: modelWithLevels,
		})
		expect(display?.supportedLevels).toEqual(["low", "medium", "high", "max"])
		expect(display?.isAdaptiveClass).toBe(false)
	})

	it("resolves a task-local override with source 'you'", () => {
		const display = computeThinkingEffortDisplay({
			experiments: { dynamicThinkingEffort: true },
			apiConfiguration: { reasoningEffort: "low" } as ProviderSettings,
			model: modelWithLevels,
			taskThinkingEffort: { effort: "max", source: "you" },
		})
		expect(display?.effort).toBe("max")
		expect(display?.source).toBe("you")
	})

	it("resolves task-local overrides from model/parent sources as auto", () => {
		for (const source of ["model", "parent"]) {
			const display = computeThinkingEffortDisplay({
				experiments: { dynamicThinkingEffort: true },
				model: modelWithLevels,
				taskThinkingEffort: { effort: "high", source },
			})
			expect(display?.effort).toBe("high")
			expect(display?.source).toBe("auto")
		}
	})

	it("resolves an unrecognized task-local source as default", () => {
		const display = computeThinkingEffortDisplay({
			experiments: { dynamicThinkingEffort: true },
			model: modelWithLevels,
			taskThinkingEffort: { effort: "high", source: "unknown-origin" },
		})
		expect(display?.source).toBe("default")
	})

	it("resolves the settings effort with source 'default' when no override is active", () => {
		const display = computeThinkingEffortDisplay({
			experiments: { dynamicThinkingEffort: true },
			apiConfiguration: { reasoningEffort: "low" } as ProviderSettings,
			model: modelWithLevels,
		})
		expect(display?.effort).toBe("low")
		expect(display?.source).toBe("default")
	})

	it("treats the settings 'disable' sentinel as unset and falls through", () => {
		const display = computeThinkingEffortDisplay({
			experiments: { dynamicThinkingEffort: true },
			apiConfiguration: { reasoningEffort: "disable" } as ProviderSettings,
			model: modelWithLevels,
		})
		expect(display?.effort).toBe("medium")
		expect(display?.source).toBe("default")
	})

	it("falls back to the model default effort", () => {
		const display = computeThinkingEffortDisplay({
			experiments: { dynamicThinkingEffort: true },
			model: modelWithLevels,
		})
		expect(display?.effort).toBe("medium")
		expect(display?.source).toBe("default")
	})

	it("returns null for a level-array model with no settings or model default", () => {
		const noDefault: ModelInfo = { ...modelWithLevels, reasoningEffort: undefined }
		expect(
			computeThinkingEffortDisplay({ experiments: { dynamicThinkingEffort: true }, model: noDefault }),
		).toBeNull()
	})

	it("resolves boolean/adaptive-class models to the adaptive soft-guidance level", () => {
		const display = computeThinkingEffortDisplay({
			experiments: { dynamicThinkingEffort: true },
			apiConfiguration: { reasoningEffort: "disable" } as ProviderSettings,
			model: modelAdaptive,
		})
		expect(display?.effort).toBe(THINKING_EFFORT_ADAPTIVE_LEVEL)
		expect(display?.source).toBe("auto")
		expect(display?.supportedLevels).toEqual([THINKING_EFFORT_ADAPTIVE_LEVEL])
		expect(display?.isAdaptiveClass).toBe(true)
	})

	it("lets a task-local override win over the adaptive fallback", () => {
		const display = computeThinkingEffortDisplay({
			experiments: { dynamicThinkingEffort: true },
			model: modelAdaptive,
			taskThinkingEffort: { effort: "adaptive", source: "you" },
		})
		expect(display?.effort).toBe("adaptive")
		expect(display?.source).toBe("you")
	})
})
