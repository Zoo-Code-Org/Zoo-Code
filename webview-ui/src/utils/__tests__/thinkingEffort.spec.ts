import type { ModelInfo, ProviderSettings } from "@roo-code/types"

import {
	computeThinkingEffortDisplay,
	resolveReasoningEffortCapability,
	THINKING_EFFORT_ADAPTIVE_LEVEL,
} from "../thinkingEffort"

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

	it("resolves the display for capable models without the experiment flag", () => {
		// The manual surfaces are normal features: resolution is gated only by
		// model capability. Settings effort wins over the model default.
		const settings = computeThinkingEffortDisplay({
			apiConfiguration: { reasoningEffort: "low" } as ProviderSettings,
			model: modelWithLevels,
		})
		expect(settings?.effort).toBe("low")
		expect(settings?.source).toBe("default")
		// Model default.
		const modelDefault = computeThinkingEffortDisplay({ model: modelWithLevels })
		expect(modelDefault?.effort).toBe("medium")
		expect(modelDefault?.source).toBe("default")
		// Boolean/adaptive-class model.
		const adaptive = computeThinkingEffortDisplay({ model: modelAdaptive })
		expect(adaptive?.effort).toBe(THINKING_EFFORT_ADAPTIVE_LEVEL)
		expect(adaptive?.source).toBe("auto")
	})

	it("shows the task-local value with source 'you' when the experiment flag is absent", () => {
		const display = computeThinkingEffortDisplay({
			model: modelWithLevels,
			taskThinkingEffort: { effort: "max", source: "you" },
		})
		expect(display?.effort).toBe("max")
		expect(display?.source).toBe("you")
	})

	it("returns null when the model does not advertise effort support", () => {
		expect(computeThinkingEffortDisplay({ model: modelNone })).toBeNull()
		expect(computeThinkingEffortDisplay({ model: undefined })).toBeNull()
	})

	it("returns null when the capability array only advertises the disable sentinel", () => {
		const disableOnly: ModelInfo = {
			contextWindow: 1,
			maxTokens: 1,
			supportsPromptCache: false,
			supportsReasoningEffort: ["disable"],
		}
		expect(computeThinkingEffortDisplay({ model: disableOnly })).toBeNull()
	})

	it("excludes the disable sentinel from the supported levels", () => {
		const display = computeThinkingEffortDisplay({ model: modelWithLevels })
		expect(display?.supportedLevels).toEqual(["low", "medium", "high", "max"])
		expect(display?.isAdaptiveClass).toBe(false)
	})

	it("resolves a task-local override with source 'you'", () => {
		const display = computeThinkingEffortDisplay({
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
				model: modelWithLevels,
				taskThinkingEffort: { effort: "high", source },
			})
			expect(display?.effort).toBe("high")
			expect(display?.source).toBe("auto")
		}
	})

	it("shows a user-set task-local effort as default when it equals the model default", () => {
		const display = computeThinkingEffortDisplay({
			model: modelWithLevels,
			taskThinkingEffort: { effort: "medium", source: "you" },
		})
		expect(display?.effort).toBe("medium")
		expect(display?.source).toBe("default")
	})

	it("shows a user-set task-local effort as default when it equals the settings effort", () => {
		const display = computeThinkingEffortDisplay({
			apiConfiguration: { reasoningEffort: "low" } as ProviderSettings,
			model: modelWithLevels,
			taskThinkingEffort: { effort: "low", source: "you" },
		})
		expect(display?.effort).toBe("low")
		expect(display?.source).toBe("default")
	})

	it("keeps the user badge when the task-local effort differs from the resolved default", () => {
		const display = computeThinkingEffortDisplay({
			apiConfiguration: { reasoningEffort: "low" } as ProviderSettings,
			model: modelWithLevels,
			taskThinkingEffort: { effort: "high", source: "you" },
		})
		expect(display?.effort).toBe("high")
		expect(display?.source).toBe("you")
	})

	it("resolves an unrecognized task-local source as default", () => {
		const display = computeThinkingEffortDisplay({
			model: modelWithLevels,
			taskThinkingEffort: { effort: "high", source: "unknown-origin" },
		})
		expect(display?.source).toBe("default")
	})

	it("resolves the settings effort with source 'default' when no override is active", () => {
		const display = computeThinkingEffortDisplay({
			apiConfiguration: { reasoningEffort: "low" } as ProviderSettings,
			model: modelWithLevels,
		})
		expect(display?.effort).toBe("low")
		expect(display?.source).toBe("default")
	})

	it("treats the settings 'disable' sentinel as unset and falls through", () => {
		const display = computeThinkingEffortDisplay({
			apiConfiguration: { reasoningEffort: "disable" } as ProviderSettings,
			model: modelWithLevels,
		})
		expect(display?.effort).toBe("medium")
		expect(display?.source).toBe("default")
	})

	it("falls back to the model default effort", () => {
		const display = computeThinkingEffortDisplay({ model: modelWithLevels })
		expect(display?.effort).toBe("medium")
		expect(display?.source).toBe("default")
	})

	it("returns null for a level-array model with no settings or model default", () => {
		const noDefault: ModelInfo = { ...modelWithLevels, reasoningEffort: undefined }
		expect(computeThinkingEffortDisplay({ model: noDefault })).toBeNull()
	})

	it("resolves boolean/adaptive-class models to the adaptive soft-guidance level", () => {
		const display = computeThinkingEffortDisplay({
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
			model: modelAdaptive,
			taskThinkingEffort: { effort: "adaptive", source: "you" },
		})
		expect(display?.effort).toBe("adaptive")
		expect(display?.source).toBe("you")
	})
})

describe("resolveReasoningEffortCapability (F7)", () => {
	const modelNoCapability: ModelInfo = {
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		supportsPromptCache: false,
	}

	it("fills in the declared levels when the model has no capability of its own", () => {
		const result = resolveReasoningEffortCapability(modelNoCapability, {
			supportedReasoningEfforts: ["low", "high", "max"],
		} as ProviderSettings)
		expect(result?.supportsReasoningEffort).toEqual(["low", "high", "max"])
		// Other model fields pass through unchanged.
		expect(result?.contextWindow).toBe(1_000_000)
	})

	it("never overrides a registry capability (registry wins over declaration)", () => {
		const registryModel: ModelInfo = {
			...modelNoCapability,
			supportsReasoningEffort: ["low", "medium"],
		}
		const result = resolveReasoningEffortCapability(registryModel, {
			supportedReasoningEfforts: ["low", "high", "max"],
		} as ProviderSettings)
		expect(result).toBe(registryModel)
		expect(result?.supportsReasoningEffort).toEqual(["low", "medium"])
	})

	it("never overrides a boolean registry capability", () => {
		const adaptiveModel: ModelInfo = { ...modelNoCapability, supportsReasoningEffort: true }
		const result = resolveReasoningEffortCapability(adaptiveModel, {
			supportedReasoningEfforts: ["low", "high"],
		} as ProviderSettings)
		expect(result).toBe(adaptiveModel)
		expect(result?.supportsReasoningEffort).toBe(true)
	})

	it("returns the model unchanged without a declaration or with an empty one", () => {
		expect(resolveReasoningEffortCapability(modelNoCapability, undefined)).toBe(modelNoCapability)
		expect(resolveReasoningEffortCapability(modelNoCapability, {} as ProviderSettings)).toBe(modelNoCapability)
		expect(
			resolveReasoningEffortCapability(modelNoCapability, { supportedReasoningEfforts: [] } as ProviderSettings),
		).toBe(modelNoCapability)
	})

	it("synthesizes a minimal model from the declaration when no model info reaches the webview", () => {
		// Self-hosted providers can resolve `model` to undefined when their model
		// list is empty; the profile declaration is then the only capability source.
		const result = resolveReasoningEffortCapability(undefined, {
			supportedReasoningEfforts: ["low", "high"],
		} as ProviderSettings)
		expect(result?.supportsReasoningEffort).toEqual(["low", "high"])
		// Minimal ModelInfo shape: the required fields are present, nothing else implied.
		expect(result?.contextWindow).toBe(0)
		expect(result?.supportsPromptCache).toBe(false)
	})

	it("returns undefined for an undefined model without a declaration", () => {
		expect(resolveReasoningEffortCapability(undefined, undefined)).toBeUndefined()
		expect(resolveReasoningEffortCapability(undefined, {} as ProviderSettings)).toBeUndefined()
		expect(
			resolveReasoningEffortCapability(undefined, { supportedReasoningEfforts: [] } as ProviderSettings),
		).toBeUndefined()
	})

	it("does not mutate the input model or share the declared array", () => {
		const declaredLevels: string[] = ["low", "high"]
		const result = resolveReasoningEffortCapability(modelNoCapability, {
			supportedReasoningEfforts: declaredLevels as ProviderSettings["supportedReasoningEfforts"],
		})
		expect(result).not.toBe(modelNoCapability)
		expect(modelNoCapability.supportsReasoningEffort).toBeUndefined()
		expect(result?.supportsReasoningEffort).not.toBe(declaredLevels)
	})
})

describe("computeThinkingEffortDisplay with declared capability (F7)", () => {
	const selfHostedModel: ModelInfo = {
		contextWindow: 32_768,
		maxTokens: 8_192,
		supportsPromptCache: false,
	}

	it("resolves with the declared levels when the model has no capability of its own", () => {
		const display = computeThinkingEffortDisplay({
			model: selfHostedModel,
			apiConfiguration: {
				reasoningEffort: "high",
				supportedReasoningEfforts: ["low", "high", "max"],
			} as ProviderSettings,
		})
		expect(display?.supportedLevels).toEqual(["low", "high", "max"])
		expect(display?.effort).toBe("high")
		expect(display?.isAdaptiveClass).toBe(false)
	})

	it("excludes the disable sentinel from declared levels", () => {
		// "disable" cannot be declared (not a canonical level), but the menu must
		// still stay sentinel-free for arrays carrying it defensively.
		const display = computeThinkingEffortDisplay({
			model: selfHostedModel,
			apiConfiguration: {
				supportedReasoningEfforts: ["low", "high"],
			} as ProviderSettings,
			taskThinkingEffort: { effort: "high", source: "you" },
		})
		expect(display?.supportedLevels).toEqual(["low", "high"])
	})

	it("keeps the registry capability over the declaration", () => {
		const registryModel: ModelInfo = {
			...selfHostedModel,
			supportsReasoningEffort: ["low", "medium"],
			reasoningEffort: "medium",
		}
		const display = computeThinkingEffortDisplay({
			model: registryModel,
			apiConfiguration: {
				supportedReasoningEfforts: ["low", "high", "max"],
			} as ProviderSettings,
		})
		expect(display?.supportedLevels).toEqual(["low", "medium"])
		expect(display?.effort).toBe("medium")
	})

	it("returns null without a declaration (existing behavior)", () => {
		expect(computeThinkingEffortDisplay({ model: selfHostedModel })).toBeNull()
	})
})
