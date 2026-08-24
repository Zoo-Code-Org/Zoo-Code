import type { ModelInfo, ProviderSettings, ReasoningEffortExtended } from "@roo-code/types"

export type ThinkingEffortSource = "default" | "auto" | "you"

export interface ThinkingEffortDisplay {
	effort: string
	source: ThinkingEffortSource
	/** Levels the model advertises (menu entries); "adaptive" for boolean-class models. */
	supportedLevels: string[]
	/** True for boolean/adaptive-class models (soft guidance). */
	isAdaptiveClass: boolean
}

export const THINKING_EFFORT_ADAPTIVE_LEVEL = "adaptive"

/**
 * DTE series 4/5: webview-side computation of the current effective thinking
 * effort and its source, shared by the TaskHeader chip and the composer
 * bottom-bar toggle.
 *
 * Resolution (strongest first): task-local override (authoritative
 * extension-side push via `taskThinkingEffort`) → settings `reasoningEffort`
 * (provider profile) → model default (`model.reasoningEffort`); boolean/
 * adaptive-class models fall back to the "adaptive" soft-guidance display.
 * Returns `null` when the model does not advertise per-request effort support.
 */
export function computeThinkingEffortDisplay(args: {
	apiConfiguration?: ProviderSettings
	model?: ModelInfo
	taskThinkingEffort?: { effort: string; source: string }
}): ThinkingEffortDisplay | null {
	const { apiConfiguration, model, taskThinkingEffort } = args

	const capability = model?.supportsReasoningEffort
	const isAdaptiveClass = capability === true
	// The "disable" sentinel is a UI off-switch (settings value), not a level a
	// task can be set to — keep it out of the menu even when a model advertises it.
	const supportedLevels = Array.isArray(capability)
		? capability.filter((level) => level !== "disable")
		: isAdaptiveClass
			? [THINKING_EFFORT_ADAPTIVE_LEVEL]
			: []
	if (supportedLevels.length === 0) {
		return null
	}

	// 1. Task-local override (authoritative extension push).
	if (taskThinkingEffort?.effort) {
		const source: ThinkingEffortSource =
			taskThinkingEffort.source === "you"
				? "you"
				: taskThinkingEffort.source === "model" || taskThinkingEffort.source === "parent"
					? "auto"
					: "default"
		return { effort: taskThinkingEffort.effort, source, supportedLevels, isAdaptiveClass }
	}

	// 2. Settings-derived effort (provider profile). The "disable" sentinel
	// means "no effort" for the per-request envelope resolution.
	const settingsEffort = apiConfiguration?.reasoningEffort as ReasoningEffortExtended | "disable" | undefined
	if (settingsEffort && settingsEffort !== "disable") {
		return { effort: settingsEffort, source: "default", supportedLevels, isAdaptiveClass }
	}

	// 3. Model default / adaptive soft guidance.
	if (isAdaptiveClass) {
		return { effort: THINKING_EFFORT_ADAPTIVE_LEVEL, source: "auto", supportedLevels, isAdaptiveClass }
	}
	if (model?.reasoningEffort) {
		return { effort: model.reasoningEffort, source: "default", supportedLevels, isAdaptiveClass }
	}
	return null
}
