import { type ModelInfo, type ProviderSettings, type ReasoningEffortExtended, reasoningEfforts } from "@roo-code/types"

// "disable" turns reasoning off entirely; "none" is a real reasoning level.
// Both render with the same "None" label in the UI, and arrays from
// supportsReasoningEffort may include "disable" (e.g. Z.ai GLM).
export type ReasoningEffortOption = ReasoningEffortExtended | "disable"

export interface ReasoningEffortSelection {
	isReasoningEffortSupported: boolean
	availableOptions: ReadonlyArray<ReasoningEffortOption>
	currentReasoningEffort: ReasoningEffortOption
	storedReasoningEffort: ReasoningEffortOption | undefined
}

/**
 * Computes the reasoning-effort dropdown state shared by every selector in the
 * app (Providers settings tab, per-provider settings, chat input bar). All
 * selectors must agree on the option set and clamping so they never show
 * different values for the same stored field.
 *
 * Capability surface:
 * - modelInfo.supportsReasoningEffort: true → options ["low","medium","high"]
 * - array → options are exactly the provided values
 * - "disable" is prepended only when supportsReasoningEffort is boolean true
 *   and requiredReasoningEffort is not set; explicit arrays are respected as-is.
 *
 * The stored value is clamped to the option set so the trigger always renders
 * a valid option.
 */
export function getReasoningEffortSelection(
	apiConfiguration: ProviderSettings | undefined,
	modelInfo: ModelInfo | undefined,
): ReasoningEffortSelection {
	const isReasoningEffortSupported = !!modelInfo && !!modelInfo.supportsReasoningEffort

	const supports = modelInfo?.supportsReasoningEffort
	const baseAvailableOptions: ReadonlyArray<ReasoningEffortOption> =
		supports === true
			? (reasoningEfforts as readonly ReasoningEffortOption[])
			: Array.isArray(supports)
				? (supports as ReadonlyArray<ReasoningEffortOption>)
				: (reasoningEfforts as readonly ReasoningEffortOption[])

	// Add "disable" option only when:
	// 1. requiredReasoningEffort is not true, AND
	// 2. supportsReasoningEffort is boolean true (not an explicit array)
	// When the model provides an explicit array, respect those exact values.
	const shouldAutoAddDisable =
		!modelInfo?.requiredReasoningEffort && supports === true && !baseAvailableOptions.includes("disable")
	const availableOptions: ReadonlyArray<ReasoningEffortOption> = shouldAutoAddDisable
		? ["disable", ...baseAvailableOptions]
		: baseAvailableOptions

	// Default reasoning effort - use model's default if available
	// GPT-5 models have "medium" as their default in the model configuration
	const modelDefaultReasoningEffort = modelInfo?.reasoningEffort as ReasoningEffortExtended | undefined
	const defaultReasoningEffort: ReasoningEffortOption = modelInfo?.requiredReasoningEffort
		? modelDefaultReasoningEffort || "medium"
		: "disable"
	// Current reasoning effort from settings, or fall back to default.
	// Clamp to availableOptions so the Select trigger always renders a valid option.
	const storedReasoningEffort = apiConfiguration?.reasoningEffort as ReasoningEffortOption | undefined
	const rawReasoningEffort: ReasoningEffortOption = storedReasoningEffort || defaultReasoningEffort
	const fallbackReasoningEffort = availableOptions.includes(defaultReasoningEffort)
		? defaultReasoningEffort
		: (availableOptions[0] ?? rawReasoningEffort)
	const currentReasoningEffort: ReasoningEffortOption = availableOptions.includes(rawReasoningEffort)
		? rawReasoningEffort
		: fallbackReasoningEffort

	return { isReasoningEffortSupported, availableOptions, currentReasoningEffort, storedReasoningEffort }
}

/**
 * Maps a reasoning-effort option to its translation key. Both "disable" and
 * "none" display as "None" per UX, but "disable" omits reasoning parameters
 * while "none" sends an explicit none level.
 */
export function getReasoningEffortTranslationKey(option: ReasoningEffortOption): string {
	return option === "none" || option === "disable"
		? "settings:providers.reasoningEffort.none"
		: `settings:providers.reasoningEffort.${option}`
}
