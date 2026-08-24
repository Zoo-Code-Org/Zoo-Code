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
 * F7: webview-side mirror of the extension fill-in
 * (`withDeclaredReasoningEffort` in src/api/model-capabilities.ts).
 *
 * Self-hosted / OpenAI-compatible models do not advertise
 * `supportsReasoningEffort` in the model registry, so the webview state
 * ModelInfo has no capability of its own and the DTE surfaces are hidden.
 * When the profile declares a non-empty `supportedReasoningEfforts` and the
 * model has no value of its own (`undefined`), the model is treated as
 * supporting exactly that array. Registry values are NEVER overridden
 * (fill-in-the-gap only), so models that already advertise a capability
 * (boolean or array) keep it.
 *
 * Pure and non-mutating: returns the original model when nothing is filled in.
 */
export function resolveReasoningEffortCapability(
	model: ModelInfo | undefined,
	apiConfiguration: ProviderSettings | undefined,
): ModelInfo | undefined {
	if (!model || model.supportsReasoningEffort !== undefined) {
		return model
	}

	const declared = apiConfiguration?.supportedReasoningEfforts
	if (!Array.isArray(declared) || declared.length === 0) {
		return model
	}

	return { ...model, supportsReasoningEffort: [...declared] }
}

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
 *
 * Source-label rule: a task-local override that lands exactly on the resolved
 * default (settings effort, else model default) is displayed with source
 * "default" — the "you" badge only marks a non-default choice.
 */
export function computeThinkingEffortDisplay(args: {
	apiConfiguration?: ProviderSettings
	model?: ModelInfo
	taskThinkingEffort?: { effort: string; source: string }
}): ThinkingEffortDisplay | null {
	const { apiConfiguration, model, taskThinkingEffort } = args

	// F7: apply the profile-declared reasoning effort capability fill-in so the
	// composer toggle and TaskHeader chip render for models whose registry entry
	// does not advertise the capability (OpenAI-compatible / self-hosted).
	const effectiveModel = resolveReasoningEffortCapability(model, apiConfiguration)

	const capability = effectiveModel?.supportsReasoningEffort
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

	// Settings-derived effort (provider profile). The "disable" sentinel means
	// "no effort" for the per-request envelope resolution. Resolved before the
	// task-local branch so the default-source rule can compare against it.
	const settingsEffort = apiConfiguration?.reasoningEffort as ReasoningEffortExtended | "disable" | undefined
	const resolvedDefault = settingsEffort && settingsEffort !== "disable" ? settingsEffort : model?.reasoningEffort

	// 1. Task-local override (authoritative extension push).
	if (taskThinkingEffort?.effort) {
		const isAtResolvedDefault = resolvedDefault !== undefined && taskThinkingEffort.effort === resolvedDefault
		const source: ThinkingEffortSource =
			taskThinkingEffort.source === "you" && !isAtResolvedDefault
				? "you"
				: taskThinkingEffort.source === "model" || taskThinkingEffort.source === "parent"
					? "auto"
					: "default"
		return { effort: taskThinkingEffort.effort, source, supportedLevels, isAdaptiveClass }
	}

	// 2. Settings-derived effort (provider profile).
	if (settingsEffort && settingsEffort !== "disable") {
		return { effort: settingsEffort, source: "default", supportedLevels, isAdaptiveClass }
	}

	// 3. Model default / adaptive soft guidance.
	if (isAdaptiveClass) {
		return { effort: THINKING_EFFORT_ADAPTIVE_LEVEL, source: "auto", supportedLevels, isAdaptiveClass }
	}
	if (effectiveModel?.reasoningEffort) {
		return { effort: effectiveModel.reasoningEffort, source: "default", supportedLevels, isAdaptiveClass }
	}
	return null
}
